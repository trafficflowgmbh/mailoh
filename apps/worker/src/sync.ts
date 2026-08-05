import {
  planChange, commitChange,
  type Change, type ClassifierPort, type CreditGate, type Logger,
} from "@trafficflow/core/mail";
import {
  WATCHED_FOLDERS, MessageGoneError, parseRef,
  type ImapCursor, type MailboxAdapter, type PersistedFolderCursor,
} from "@trafficflow/core/adapters/imap";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ClassifierFaultError } from "./classifier-fault.js";
import { DeadLetterLedger, classifyIngestFault } from "./dead-letter.js";

export interface SyncDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** Optional AI classifier (design §5.3). Absent ⇒ Phase-0 routing (no AI branch). */
  classifier?: ClassifierPort;
  /**
   * The AI spend gate for THIS mailbox's account. Absent ⇒ unmetered.
   *
   * It is per-account and built by the worker's entry point from the MAILBOX ROW's `accountId`,
   * never from config: one worker process serves many accounts, and a gate bound to the wrong
   * one would charge the wrong customer.
   */
  credits?: CreditGate;
  /**
   * The per-message terminal-failure ledger, one per attached mailbox.
   *
   * ABSENT ⇒ ONE PER CALL, not "no boundary". `apps/sidecar` imports this loop — the desktop
   * engine and the hosted worker run one pipeline, never two implementations — and several tests
   * call `runSyncCycle` directly; a boundary that only existed when a caller remembered to inject
   * a ledger would leave the wedge in place for every one of them. What a caller-supplied ledger
   * adds is MEMORY ACROSS CYCLES: attempt
   * counts that accumulate, and skipped UIDs that stay out of the known-set so their bodies are
   * not re-fetched every pass. See {@link DeadLetterLedger}.
   */
  deadLetters?: DeadLetterLedger;
  /** Structured log sink. Absent ⇒ a skip is still recorded in `audit_log`, just not logged. */
  log?: Logger;
}

/**
 * Reconstruct the adapter cursor from the DB each cycle (never reuse an in-memory UID across a
 * move).
 *
 * ── THE FOLDER LIST IS THE UNION, NOT `WATCHED_FOLDERS` ────────────────────────────────────
 *
 * The adapter also reads the mailbox's own Sent folder, whose path is server-specific and
 * therefore cannot be a compile-time constant. `changesSince` persists a cursor row for it like
 * any other folder — and if this function only ever rebuilt the six frozen names, that row would
 * be written every cycle and read by none of them. The consequence is not cosmetic: with no
 * `prev`, the Sent branch falls back to its FIRST-SCAN path every single cycle, re-enumerating
 * (and, for anything the `own_copy` rule declines to store, re-FETCHING the body of) the whole
 * history window for the life of the process.
 *
 * Unioning with the persisted rows also means a folder the product stops watching keeps its
 * cursor rather than silently resetting if it is ever watched again.
 *
 * ── THE KNOWN-SET IS EPOCH-PURE, AND THE CURSOR NAMES AN EPOCH ─────────────────────────────
 *
 * A UID number means nothing outside the server epoch that issued it, and this function used to
 * reduce every locator to `{uid, messageId}` — discarding the epoch each one carries. Two
 * independent failures came out of that, and neither needs a race or a Postgres quirk:
 *
 *  1. A locator committed under an epoch V, presented inside a known-set the adapter reads as a
 *     later epoch V′, makes a V′ message whose server REUSED that UID number look already-known.
 *     Its body is never fetched, and once the enumeration drains, the V′ cursor is persisted past
 *     it. Permanent, silent, and likely — a new epoch commonly allocates again from low numbers.
 *  2. The sentinel `uidValidity: "0"` that a cold or truncated drain deliberately persists cannot
 *     express an epoch mismatch AT ALL, so the adapter's `uidValidityChanged` test is blind for
 *     the whole of that drain. When the row is the sentinel the epoch is therefore taken from the
 *     LOCATORS, which do carry one.
 *
 * So: the cursor's `uidValidity` is the epoch this folder's remembered UIDs actually belong to,
 * and only the entries of that epoch are handed over. Entries of any other epoch are dropped —
 * the safe direction, because a dropped entry is re-enumerated and re-fetched, while a wrongly
 * kept one silences real mail.
 */
export async function buildCursor(
  repo: WorkerRepo, mailboxId: string, deadLetters?: DeadLetterLedger,
): Promise<ImapCursor> {
  const folderRows = await repo.getMailboxFolders(mailboxId);
  const known = await repo.listKnownLocators(mailboxId);
  const knownByFolder = new Map<string, Array<{ uid: number; uidValidity: string; messageId: string | null }>>();
  for (const k of known) {
    const arr = knownByFolder.get(k.folder) ?? [];
    arr.push({ uid: k.uid, uidValidity: k.uidValidity, messageId: k.messageId });
    knownByFolder.set(k.folder, arr);
  }
  const names = new Set<string>(WATCHED_FOLDERS);
  for (const r of folderRows) names.add(r.folder);
  const folders: ImapCursor["folders"] = {};
  for (const f of names) {
    const row = folderRows.find((r) => r.folder === f);
    const entries = knownByFolder.get(f) ?? [];
    const rowEpoch = row?.uidValidity ?? "0";
    const epoch = rowEpoch !== "0" ? rowEpoch : soleEpochOf(entries);
    folders[f] = {
      uidValidity: epoch,
      uidNext: row?.uidNext ?? 0,
      highestModseq: row?.highestModseq ?? "0",
      // `epoch === "0"` means no epoch can be named for this folder, so NOTHING remembered may be
      // presented as known — the adapter would read a bare number as belonging to whatever epoch
      // it is looking at.
      known: epoch === "0" ? [] : [
        ...entries.filter((e) => e.uidValidity === epoch).map((e) => ({ uid: e.uid, messageId: e.messageId })),
        // The UIDs this process has written off. They are "known" in the only sense the adapter
        // uses the word — do not fetch this again — and leaving them out is what made one poison
        // message cost a full body fetch on every cycle for ever. Epoch-matched for the same
        // reason the real locators are. See `DeadLetterLedger`.
        ...(deadLetters?.knownFor(f, epoch) ?? []),
      ],
    };
  }
  return { folders };
}

/**
 * The one epoch every remembered locator of a folder agrees on, or `"0"` when there is no such
 * epoch.
 *
 * `"0"` for "none" and for "several" alike, because both mean the same thing to the caller: this
 * folder cannot name an epoch, so no remembered UID may be trusted. "Several" arises in exactly one
 * window — a reset that landed between a truncated drain's per-message commits and its cursor
 * write — and it costs one pass of re-enumeration, because `runSyncCycle` then persists the epoch
 * it observed and the next pass can name it.
 */
function soleEpochOf(entries: ReadonlyArray<{ uidValidity: string }>): string {
  let sole = "";
  for (const e of entries) {
    if (e.uidValidity === "0") return "0";
    if (sole === "") sole = e.uidValidity;
    else if (sole !== e.uidValidity) return "0";
  }
  return sole === "" ? "0" : sole;
}

/** The folder + epoch a change was observed at. */
function siteOf(ch: Change): { folder: string; uidValidity: string; uid: number } {
  const { uidValidity, uid } = parseRef(ch.locator.ref);
  return { folder: ch.locator.folder, uidValidity, uid };
}

/**
 * One sync pass. Returns whether the adapter still owes a backlog: a first sync of a real
 * mailbox is now drained in bounded batches (see `DEFAULT_SYNC_BATCH_MAX_MESSAGES`), and the
 * caller re-kicks instead of waiting out `pollIntervalMs` — which for a mailbox of any size is
 * the difference between one opaque multi-hour cycle and a series of short, observable ones.
 */
export async function runSyncCycle(deps: SyncDeps): Promise<{ hasBacklog: boolean }> {
  const { repo, adapter, accountId, mailboxId, classifier, credits, log } = deps;
  const deadLetters = deps.deadLetters ?? new DeadLetterLedger();
  deadLetters.beginCycle();
  const cursor = await buildCursor(repo, mailboxId, deadLetters);
  const batch = await adapter.changesSince(cursor);

  /**
   * Folders holding a change that FAILED and was NOT consumed. Their cursor is not written and
   * the cycle ends by rethrowing, so nothing is acknowledged past work still owed.
   */
  const deferred = new Set<string>();
  let firstDeferredError: unknown = null;

  /**
   * Per-change failure boundary.
   *
   * The three outcomes are the whole fix. `applied` continues. `skip` records the item durably as
   * evidence, declares it consumed, and continues — the batch reaches B. `retry` holds the
   * folder's cursor and remembers the error to rethrow after the batch, which leaves the mailbox's
   * existing failure counting and quarantine cadence exactly as it was.
   *
   * `ClassifierFaultError` and `LeaseUnavailableError` are rethrown IMMEDIATELY and by class, as
   * they are at the caller's own catch arms: a model outage or an unreadable lease is not evidence
   * about the message, and counting attempts against it would eventually write off good mail
   * because somebody else had an incident.
   */
  async function attempt(ch: Change, run: () => Promise<void>): Promise<void> {
    const site = siteOf(ch);
    if (deadLetters.has(site.folder, site.uidValidity, site.uid)) return;
    try {
      await run();
    } catch (err) {
      if (err instanceof ClassifierFaultError || err instanceof LeaseUnavailableError) throw err;
      const fault = classifyIngestFault(err);
      if (fault.domain === "infrastructure") {
        // Ours, not the message's. Fail the cycle the way a bare throw did before this boundary
        // existed: no attempt counted, no cursor written for this folder, nothing written off.
        //
        // There was a `deferred.add(site.folder)` here and it was DEAD, which matters
        // because it read as load-bearing. The throw is what holds every cursor: the `await
        // attempt(...)` call sites (the `for` loops below) have no `catch` between them and the
        // `deferred.has(folder)` read in the cursor loop, so this throw leaves the function and
        // that read is never reached in this cycle. Deferring one folder was therefore
        // unobservable — and narrower than the truth, since an infrastructure fault must hold
        // ALL folders' cursors, not just this one's. Do not re-add it: it would suggest the
        // cycle continues past this point, and it does not.
        throw err;
      }
      const verdict = deadLetters.record(ch.locator, fault);
      if (verdict === "retry") {
        deferred.add(site.folder);
        if (firstDeferredError === null) firstDeferredError = err;
        log?.warn("sync_message_deferred", {
          mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
          code: fault.code, err,
          reason: "this message failed but has not exhausted its attempts — the folder's cursor is " +
            "held and the cycle fails, so nothing is acknowledged past it",
        });
        return;
      }
      log?.error("sync_message_skipped", {
        mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        code: fault.code, skipped: deadLetters.skipped, err,
        reason: "this message cannot be processed and has been declared consumed — the rest of the " +
          "batch and all later mail continue, which is what one poison message used to prevent",
      });
      // DURABLE EVIDENCE, best-effort, and content-free: folder, epoch, UID, code. Best-effort
      // because a bookkeeping failure must not resurrect the wedge this decision exists to end.
      try {
        await repo.recordAudit(
          accountId, "sync.message_skipped",
          {
            mailboxId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
            code: fault.code,
          },
          null,
        );
      } catch (auditErr) {
        log?.warn("sync_message_skip_audit_failed", {
          mailboxId, accountId, folder: site.folder, uid: site.uid, err: auditErr,
        });
      }
    }
  }

  // ── DISAPPEARANCES FIRST, AND THAT ORDER IS THE POINT ───────────────────────────────────────
  //
  // `batch.deletes` was consumed by NOTHING. It was described as a cursor-only signal, and that
  // description is what left `classifyDedup` unable to tell a user's move from a stranger's
  // delivery: a sender can make a locator APPEAR, only the user can make a stored locator
  // DISAPPEAR, and the disappearance was being thrown away.
  //
  // Recorded BEFORE the ingest loop, so this cycle's deletes are evidence for this cycle's
  // creates. That covers the two shapes `correlateMoves` cannot pair — a message carrying no
  // Message-ID at all (`imap.ts` pairs on it), and a delete and a create landing in different
  // batches — which is exactly the case where requiring a correlated move alone would refuse a
  // REAL user move and `reconcileFolders` would drag it back.
  //
  // ── THE EPOCH GUARD IS "ALL EVIDENCE IS VOID ON A UIDVALIDITY CHANGE" ───────────────────────
  //
  // The adapter emits every prior UID as a delete when a folder's epoch changes, carrying the
  // PRIOR epoch in the ref. Those UIDs did not vanish — they were renumbered, and the adapter
  // re-enumerates every one of them in the same batch. Recording them as disappearances would
  // hand a whole folder's worth of adoption evidence to whatever create is processed first, so a
  // delete is only believed when its epoch is the one the server is reporting NOW.
  //
  // `epochsObserved` is the server's live answer, read off the locators the adapter minted this
  // pass. It has no entry for a folder that produced no create, move or flag — the ordinary case
  // for the SOURCE folder of an external move — so the cursor the adapter just computed is the
  // fallback. Neither available ⇒ no epoch can be named ⇒ skip, which loses evidence rather than
  // inventing it.
  const observedEpochs = epochsObserved(batch);
  for (const ch of batch.deletes) {
    const site = siteOf(ch);
    const live = observedEpochs.get(site.folder) ?? batch.newCursor.folders[site.folder]?.uidValidity;
    if (live === undefined || live === "0" || live !== site.uidValidity) continue;
    await repo.forgetInstanceAt(mailboxId, ch.locator);
  }

  // Two-phase, transaction-safe ingest. PLAN performs the reads +
  // optional classifier network call OUTSIDE any transaction; COMMIT persists the
  // entity rows + change_log inside ONE short transaction (tx-scoped repo, no
  // network). The physical IMAP move runs afterwards in reconcileMailbox, outside
  // the transaction. Only content-bearing changes (create/move carrying RFC822) are
  // ingested; a FLAG is a cursor-only signal, and a DELETE is the move evidence recorded above.
  for (const ch of [...batch.creates, ...batch.moves]) {
    await attempt(ch, async () => {
      const plan = await planChange(ch, { repo, accountId, mailboxId, classifier, credits, routing: repo });
      await repo.transaction((txRepo) =>
        commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId }),
      );
    });
  }

  // INBOUND READ-STATE — the inbound half of read-state mirroring. `flagChanges` was produced by
  // the adapter and consumed by nothing, so a message read in another mail client stayed bold in
  // ohmail forever. Each one is its own short transaction — the entity write and its `change_log`
  // row commit together, and one unresolvable locator cannot roll back the whole batch.
  //
  // `applyExternalFlag` owns the user-wins decision: it declines while OUR write is still
  // pending, so the value the server is about to be told is never overwritten by the value it
  // is still reporting. A locator with no message behind it (a create this batch truncated) is
  // simply skipped — the next cycle sees the flag again.
  //
  // Behind the SAME boundary as ingest, for the same reason ingest has one: one throwing flag
  // exited this loop too, so every later flag in the slice went unapplied and the mailbox
  // retried the same one for ever.
  for (const ch of batch.flagChanges) {
    await attempt(ch, async () => {
      await repo.transaction(async (txRepo) => {
        const outcome = await txRepo.applyExternalFlag(mailboxId, ch.locator, ch.seen ?? false);
        if (!outcome?.changed) return;
        await txRepo.recordChange({
          accountId, entityType: "message", entityId: outcome.messageId, op: "update", meta: null,
        });
      });
    });
  }

  // AFTER the commit loop, deliberately. The adapter holds a truncated folder's cursor at its
  // previous value, so this writes the ADVANCED cursor only for folders that genuinely
  // drained; advancing mid-loop would put `highestModseq` past mail this process has not
  // committed yet, and a crash there loses it permanently. The per-message `commitChange`
  // transactions above are the incremental checkpoint — `buildCursor` rebuilds the known-set
  // from them, so a restart resumes rather than restarting the mailbox.
  //
  // A folder in `deferred` is skipped entirely: it holds a change that failed and was not
  // declared consumed, and a cursor written across that is an acknowledgement of work still owed.
  for (const [folder, fc] of Object.entries(batch.newCursor.folders)) {
    if (deferred.has(folder)) continue;
    await repo.upsertMailboxFolder(mailboxId, folder, epochAware(fc, observedEpochs.get(folder)));
  }

  await reconcileMailbox(deps);
  if (firstDeferredError !== null) throw firstDeferredError;
  return { hasBacklog: batch.hasBacklog ?? false };
}

/**
 * The epoch the SERVER reported for each folder in this batch.
 *
 * Read off the locators the adapter minted — `makeRef(currentUidValidity, uid)` for every create,
 * move and flag change — so it is the server's live answer and not a remembered one. Deletes are
 * excluded deliberately: their refs carry the PRIOR epoch by design.
 */
function epochsObserved(batch: { creates: Change[]; moves: Change[]; flagChanges: Change[] }): Map<string, string> {
  const out = new Map<string, string>();
  for (const ch of [...batch.creates, ...batch.moves, ...batch.flagChanges]) {
    const { folder, uidValidity } = siteOf(ch);
    if (uidValidity !== "0") out.set(folder, uidValidity);
  }
  return out;
}

/**
 * RECORD THE OBSERVED EPOCH EVEN WHILE THE WATERMARKS ARE HELD.
 *
 * A truncated batch holds its folder's cursor at the PREVIOUS value. That is right for
 * `uidNext`/`highestModseq` — advancing them past mail this pass did not return loses it — and
 * wrong for `uidValidity`, which is not a watermark but an identity. Write `V` for the epoch that
 * has just ended and `V′` for the one the server is reporting now. With the old epoch persisted,
 * the next pass hands the adapter a stale `V` cursor, the adapter must again treat every `V` UID
 * as meaningless, and it again returns the same newest `V′` slice. For ever. New mail arrives
 * newest-first and keeps displacing the tail the drain never reaches.
 *
 * So the epoch advances and the watermarks do not. `uidNext: 0` / `highestModseq: "0"` loses
 * nothing: both remembered values were `V` values, meaningless under `V′`, and this is exactly the
 * cursor the adapter itself computes for a folder it has never seen. The next pass then finds
 * `prev.uidValidity === current`, treats the `V′` locators already committed as known, and returns
 * a DISJOINT slice — which is what makes the drain finite instead of a loop.
 *
 * When the cursor the adapter returned already names the epoch it observed — every non-truncated
 * pass, i.e. the ordinary bounded backfill — this is the identity function.
 *
 * ── A `"0" → V` PROMOTION IS NOT A RESET, AND CONFLATING THEM WAS STICKY ────────────────────
 *
 * `observed !== fc.uidValidity` is true for a `V → V′` RESET and equally true for a `"0" → V`
 * PROMOTION — the cursor of a folder that could not yet NAME an epoch. Both used to take the
 * zeroing arm, and the argument above does not cover the second: on `"0" → V` the watermarks are
 * not stale values from a dead epoch, they are values computed under `V` itself this very pass.
 * Zeroing them discards work that was never wrong.
 *
 * Which was not cosmetic. `"0"` is the epoch of the normal COLD START of every mailbox large
 * enough to truncate (the adapter's `prev`-less truncated branch), and `highestModseq: "0"` is the
 * one value at which `canFastPath` is false. Zeroing the baseline the adapter had just published
 * therefore pinned a permanently-truncating folder at `"0"` for ever: no flag pass, no inbound
 * read-state mirror — the inbound read-state defect above, back per folder. So the promotion arm
 * records the epoch and keeps what the adapter handed it; only a genuine `V → V′` reset zeroes.
 *
 * The kept values are the ADAPTER's, not the database's, and neither shape can raise a Sent
 * watermark past mail nobody fetched. Where the adapter published `mb.uidNext` it had left nothing
 * unknown; and where it held `prev.uidNext`, a `fc.uidValidity` of `"0"` means the row named no
 * epoch and no locator could name one either, which in this tree means `uidNext: 0` — the only code
 * that writes these columns is `upsertMailboxFolder` (which persists exactly what this function
 * returns, so a sentinel epoch always arrives beside zeros) and `MailboxService.requestResync`
 * (which nulls `highestmodseq` and touches neither other column); account deletion drops the rows
 * outright. The columns are nullable, so a row written by hand could break that; no code path can.
 */
function epochAware(fc: PersistedFolderCursor, observed: string | undefined): PersistedFolderCursor {
  if (observed === undefined || observed === fc.uidValidity) return fc;
  // A PROMOTION, not a reset — see above. Record the epoch, keep the watermarks.
  if (fc.uidValidity === "0") return { ...fc, uidValidity: observed };
  return { uidValidity: observed, uidNext: 0, highestModseq: "0" };
}

/**
 * Execute OUR intended moves (desired != observed, lastSetBy === 'us') and OUR intended `\Seen`
 * writes. External divergences are left untouched (user always wins). Idempotent + crash-safe:
 * if the message already left its expected source (a prior run moved it before crashing), we
 * defer to the next changesSince, which adopts the completed move.
 */
export async function reconcileMailbox(deps: SyncDeps): Promise<void> {
  await reconcileFolders(deps);
  await reconcileFlags(deps);
}

async function reconcileFolders(deps: SyncDeps): Promise<void> {
  const { repo, adapter, accountId, mailboxId } = deps;
  const pending = await repo.listPendingFolderStates(mailboxId);
  for (const p of pending) {
    if (p.lastSetBy !== "us") continue;                       // user-wins: never revert an external move
    if (p.desiredFolder === p.observedFolder) {
      await repo.upsertFolderState(p.messageId, { desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us" });
      continue;
    }
    if (!p.nativeLocator) continue;
    try {
      const newLoc = await adapter.move(p.nativeLocator, p.desiredFolder);
      await repo.updateLocator(p.messageId, newLoc);
      await repo.upsertFolderState(p.messageId, { desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us" });
      await repo.recordAudit(
        accountId, "reconcile.move",
        { messageId: p.messageId, from: p.nativeLocator, to: p.desiredFolder, newLocator: newLoc },
        { action: "move", locator: newLoc, toFolder: p.nativeLocator.folder },
      );
    } catch (err) {
      if (err instanceof MessageGoneError) {
        // Already moved (crash between IMAP move and DB update). Leave pending; next changesSince adopts it.
        continue;
      }
      // ── ONE MESSAGE'S FAILURE MUST NOT ABANDON THE PASS ──────────────────────────────────
      //
      // This used to rethrow, which took the whole reconcile pass with it: every OTHER pending
      // move, and — because `reconcileFlags` runs after this function — every pending `\Seen`
      // push too. One message the server will not let us move meant nothing else moved either,
      // every cycle, for as long as that message stayed pending.
      //
      // That was survivable only while a stuck move erased itself: the ingest path used to
      // declare such a move complete on seeing its destination copy, so the row stopped being
      // pending. It no longer does — a move is complete when the source is GONE — so a row whose
      // expunge keeps failing now stays in this queue, and rethrowing would make one unhappy
      // message a mailbox-wide outage.
      //
      // The retry itself is cheap and, importantly, no longer destructive: the adapter reads the
      // destination before it writes, so a repeat costs one SEARCH and cannot leave another copy
      // behind. It is unbounded in TIME, though, which is why the failure is recorded rather than
      // swallowed — an audit row per cycle is what makes a permanently stuck message visible
      // instead of silent.
      await repo.recordAudit(
        accountId,
        "reconcile.move.failed",
        {
          messageId: p.messageId,
          from: p.nativeLocator,
          to: p.desiredFolder,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        null,
      );
      continue;
    }
  }
}

/**
 * Push OUR intended read-state to IMAP — the `\Seen` mirror of `reconcileFolders`, and the
 * reason `PATCH /messages` can write intent and stop.
 *
 * The `lastSetBy !== "us"` guard is the SAME user-wins rule, and it is not a formality here: an
 * external row is written by `applyExternalFlag` precisely when the server disagreed with us,
 * so pushing one would mean marking read again a message the user deliberately marked unread
 * in another client. Drop this line and the product argues with its user in a loop.
 *
 * Deliberately AFTER the folder pass: a message that is moving has a locator that is about to
 * change, and `reconcileFolders` has just written the new one, so this reads the fresh value
 * instead of a UID the STORE would miss.
 */
async function reconcileFlags(deps: SyncDeps): Promise<void> {
  const { repo, adapter, accountId, mailboxId } = deps;
  const pending = await repo.listPendingFlagStates(mailboxId);
  for (const p of pending) {
    if (p.lastSetBy !== "us") continue;                       // user-wins: never revert an external \Seen
    if (p.desiredSeen === p.observedSeen) {
      await repo.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" });
      continue;
    }
    if (!p.nativeLocator) continue;
    try {
      await adapter.setFlags(p.nativeLocator, { seen: p.desiredSeen });
      await repo.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" });
      await repo.recordAudit(
        accountId, "reconcile.flags",
        { messageId: p.messageId, locator: p.nativeLocator, seen: p.desiredSeen },
        { action: "setFlags", locator: p.nativeLocator, seen: !p.desiredSeen },
      );
    } catch (err) {
      if (err instanceof MessageGoneError) {
        // The message left this locator between the DB read and the STORE. Leave the row
        // pending — the next changesSince refreshes the locator and this retries.
        continue;
      }
      throw err;
    }
  }
}
