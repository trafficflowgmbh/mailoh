import { MimeParseError, MimeTooLargeError, type NativeLocator } from "@trafficflow/core/mail";
import { parseRef } from "@trafficflow/core/adapters/imap";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PER-MESSAGE TERMINAL-FAILURE LEDGER
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A batch contains ordinary message A, unprocessable message P, and later message B. Until this
 * file existed, a throw out of `planChange(P)` or `commitChange(P)` exited the ingest `for` loop:
 * no folder cursor advanced, nothing recorded that P had failed, and nothing declared it consumed.
 * The next cycle re-selected the same P and threw again, for ever. **B and every message behind it
 * were never processed** — one malformed message stopped organizing a mailbox permanently.
 *
 * THE MISSING PIECE WAS NOT A RETRY. Six of X1H's eight findings already retry; retrying is
 * precisely what turns a one-message defect into an indefinite outage. What was missing is a way
 * to record that something could not be done and MOVE PAST IT.
 *
 * ── WHY THE LEDGER IS IN MEMORY, AND WHAT THAT COSTS ──────────────────────────────────────
 *
 * A durable record keyed `(mailbox_id, folder, uid_validity, uid)` needs a table, and a migration
 * is a separate decision, deliberately not taken here: a failure record that needs a column is a
 * schema change, and this module was written to avoid forcing one.
 * So the DECISION is process-local and the EVIDENCE is durable: every terminal skip writes an
 * `audit_log` row and an error-level log line carrying the folder, the epoch, the UID, and a
 * closed-set code — never a subject, a sender, or a byte of the message.
 *
 * The residual, stated plainly: a restart re-attempts every skipped UID once. For the five
 * enumerated folders that is a FEATURE — the known-set diff would re-offer them anyway, so a
 * deploy carrying a parser fix ingests them without an operator doing anything. For the Sent
 * folder, whose cursor IS a UID watermark, a skipped message that the watermark has passed is not
 * re-offered after a restart. That is the one place this design loses a message rather than
 * delaying it, and it is what the owed durable table fixes.
 *
 * ── THE SKIPPED UID JOINS THE KNOWN-SET, AND THAT IS NOT AN OPTIMISATION ──────────────────
 *
 * `buildCursor` merges {@link DeadLetterLedger.knownFor} into each folder's known-set. Without it
 * the skipped UID stays "unknown" for ever, so the adapter re-FETCHES its body every cycle and
 * spends the batch budget on it; at the batch cap that sets `hasBacklog` on every pass and the
 * worker re-kicks itself in a tight loop. Joining the known-set is what makes "moved past" true
 * of the fetch as well as of the commit.
 */

/**
 * WHY A MESSAGE COULD NOT BE INGESTED — a CLOSED set, and never free text.
 *
 * Same contract `mailboxes.error_detail` is held to (GOALS #9): a throw out of the ingest path can
 * embed RFC822 header bytes, a Postgres data-exception message quotes the offending row, and both
 * reach an `audit_log` payload the account owner's own tooling reads. Membership cannot be forged
 * by a mail server; a shape test can.
 */
export type MessageFailureCode =
  /** Raw source over {@link MimeTooLargeError}'s ceiling. Deterministic in the bytes. */
  | "mime_too_large"
  /** mailparser refused the source. Deterministic in the bytes. */
  | "mime_unparseable"
  /** Postgres class 22 — a VALUE the message carried is unstorable (a NUL, a bad date). */
  | "data_exception"
  /** Postgres class 23 — a constraint refused the row. NOT assumed deterministic. */
  | "constraint_violation"
  /** Anything we cannot name. Retried before it is ever skipped. */
  | "unclassified";

/** One terminally-skipped, or still-retrying, message. Content-free by construction. */
export interface MessageFailure {
  folder: string;
  uidValidity: string;
  uid: number;
  code: MessageFailureCode;
  attempts: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  /** True once the item has been declared consumed and the cursor may cross it. */
  terminal: boolean;
}

/**
 * WHOSE FAULT IS THIS THROW — the message's, or the infrastructure's?
 *
 * Getting this wrong in either direction loses something. Call a database outage "message-local"
 * and a shared incident silently writes off everybody's mail (X1H finding 6 is the mailbox-level
 * version of the same mistake). Call a poison message "infrastructure" and it is retried for ever,
 * which is the bug this whole file exists to end.
 */
export type IngestFault =
  | { domain: "infrastructure" }
  | { domain: "message"; code: MessageFailureCode; deterministic: boolean };

/**
 * Postgres SQLSTATE prefixes that mean OUR storage or connection failed.
 *
 * Deliberately by CLASS and not by individual code, the way `index.ts` exempts
 * `ClassifierFaultError` by class: a new member of class 08 that nobody has enumerated must land
 * on the infrastructure side by default, because the failure mode of guessing wrong there is
 * discarding somebody's mail.
 */
const INFRA_SQLSTATE_CLASSES: readonly string[] = [
  "08",   // connection_exception
  "25",   // invalid_transaction_state
  "40",   // transaction_rollback (serialization failure, deadlock) — retryable, never terminal
  "53",   // insufficient_resources (disk_full 53100 — the 2026-08-01 outage)
  "54",   // program_limit_exceeded (kept on the infra side; see `STORAGE_SQLSTATES`, mailboxes.ts)
  "57",   // operator_intervention (query_canceled, admin_shutdown)
  "58",   // system_error
  "XX",   // internal_error
];

/**
 * postgres.js's OWN non-SQLSTATE codes — unambiguously the database, whoever is asking.
 *
 * `CONNECT_TIMEOUT` is deliberately NOT here: imapflow@1.5.0 uses that exact string for a provider
 * dial that timed out (see `TIMEOUT_ERRNOS`, mailboxes.ts), so it cannot identify a domain on its
 * own.
 */
const PG_DRIVER_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECTION_CONNECT_TIMEOUT",
  "NOT_TAGGED_ERROR", "MAX_PARAMETERS_EXCEEDED",
]);

/**
 * Raw socket errnos. THESE DO NOT NAME A DOMAIN BY THEMSELVES, and that is the whole reason
 * {@link isDatabaseFault} exists separately from {@link classifyIngestFault}.
 *
 * On the INGEST path the only socket in play is the database's, so treating them as infrastructure
 * is right. At `attach()` the socket in play is the CUSTOMER'S PROVIDER, and an `ECONNREFUSED` from
 * a mailbox's own host is the most ordinary per-mailbox failure there is — `classifyMailboxError`
 * has always called it `connect` and quarantined that mailbox. Four worker tests caught exactly
 * this confusion the first time the two questions shared one predicate.
 */
const TRANSPORT_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "CONNECT_TIMEOUT",
]);

const sqlStateClass = (code: string): string | null =>
  /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : null;

const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
};

/**
 * Classify one ingest throw. It MAY read the error's message; it may never store it — the output
 * is a five-value enum, exactly as `classifyMailboxError` is a seven-value one.
 *
 * Note what is NOT here: `ClassifierFaultError` and `LeaseUnavailableError`. Those are exempted BY
 * CLASS at their own arms in `index.ts` and must keep propagating untouched, so `sync.ts` rethrows
 * them before this function is ever called. Adding them here would convert a model outage into a
 * write-off of the mail it was asked to route.
 */
export function classifyIngestFault(err: unknown): IngestFault {
  // Deterministic in the raw bytes, by the contract on `mime.ts`'s two typed errors: "the same
  // source fails the same way every time … what makes them safe for a quarantine record to treat
  // as permanent". This is the first consumer that contract was written for.
  if (err instanceof MimeTooLargeError) {
    return { domain: "message", code: "mime_too_large", deterministic: true };
  }
  if (err instanceof MimeParseError) {
    return { domain: "message", code: "mime_unparseable", deterministic: true };
  }

  const code = codeOf(err);
  if (code) {
    // Both sets, because on the ingest path the only socket is the database's.
    if (PG_DRIVER_CODES.has(code) || TRANSPORT_ERRNOS.has(code)) return { domain: "infrastructure" };
    const cls = sqlStateClass(code);
    if (cls) {
      if (INFRA_SQLSTATE_CLASSES.includes(cls)) return { domain: "infrastructure" };
      // Class 22 is a DATA exception: the value this message carried cannot be stored (a decoded
      // NUL in a subject, a date outside the timestamp range). Deterministic in the bytes, so it
      // needs no second attempt to prove itself.
      if (cls === "22") return { domain: "message", code: "data_exception", deterministic: true };
      // Class 23 is a constraint. `23505` can also be a concurrent second ingest of the same mail
      // rather than a defect in it, so this one earns its retries before it is written off.
      if (cls === "23") return { domain: "message", code: "constraint_violation", deterministic: false };
    }
  }

  // Everything else, INCLUDING a bug in our own pipeline. Retried first, and skipped only under
  // {@link MAX_DEAD_LETTERS_PER_CYCLE} — see the cap for why a broken build must not go green.
  return { domain: "message", code: "unclassified", deterministic: false };
}

/**
 * Is this throw UNAMBIGUOUSLY THE DATABASE'S — not one mailbox's provider?
 *
 * `attach()` is the consumer. The credential read now sits inside that function's
 * isolation boundary, so without an exemption one Neon blip would quarantine every mailbox of the
 * shard in turn and write `status='error'` on each — the 2026-08-01 incident's shape.
 *
 * It is deliberately NARROWER than {@link classifyIngestFault}'s infrastructure domain, and the
 * narrowness is load-bearing: SQLSTATEs and postgres.js's own code names only, never a raw errno.
 * At this seam an `ECONNREFUSED` is far more likely to be the customer's IMAP host than our
 * database, and treating it as ours would stop quarantining genuinely unreachable mailboxes.
 *
 * The residual, stated: postgres.js surfaces a bare `ECONNREFUSED` when Postgres itself is down, so
 * a total database outage at this line is still rendered as a per-mailbox connect failure. That is
 * X1H finding 6's territory and is unchanged by this slice — it is self-clearing, and mis-blaming
 * a reachable mailbox for our outage is strictly less harmful than refusing to quarantine an
 * unreachable one.
 */
export function isDatabaseFault(err: unknown): boolean {
  const code = codeOf(err);
  if (!code) return false;
  if (PG_DRIVER_CODES.has(code)) return true;
  const cls = sqlStateClass(code);
  return cls !== null && INFRA_SQLSTATE_CLASSES.includes(cls);
}

/**
 * How many times a NON-deterministic message-local failure is retried before it is written off.
 *
 * Two, not three, and the arithmetic is deliberate: `DEFAULT_MAX_SYNC_FAILURES` is 3, so a poison
 * message that defers on cycle 1 and goes terminal on cycle 2 never reaches the mailbox-level
 * quarantine threshold. At three attempts the terminal cycle and the quarantine cycle collide and
 * whether the mailbox is detached depends on which counter is compared first.
 */
export const DEFAULT_MAX_MESSAGE_ATTEMPTS = 2;

/**
 * THE SAFETY VALVE: how many messages ONE cycle may terminally skip.
 *
 * Without it, a bug in our own pipeline that throws for every message would — after
 * {@link DEFAULT_MAX_MESSAGE_ATTEMPTS} cycles — write off the entire batch, advance the cursor,
 * and report SUCCESS. The mailbox would go green in Settings while dropping every message that
 * arrived. Beyond this cap the surplus stays deferred (not consumed), the folder cursor is held,
 * and the cycle fails — so `maxSyncFailures` quarantines the mailbox and an operator sees it.
 *
 * Five and not one, because a mailbox with a handful of genuinely poison messages must still
 * drain: the cap bounds how much a single cycle can write off, not how much ever can.
 */
export const MAX_DEAD_LETTERS_PER_CYCLE = 5;

const keyOf = (folder: string, uidValidity: string, uid: number): string =>
  `${folder}${uidValidity}${uid}`;

/**
 * The ledger itself: per mailbox, held on the `MailboxRuntime`'s `SyncDeps` so it lives as long as
 * the attachment does.
 */
export class DeadLetterLedger {
  private readonly items = new Map<string, MessageFailure>();
  private readonly maxAttempts: number;
  private readonly perCycleCap: number;
  /** Terminal decisions taken in the CURRENT cycle; reset by {@link beginCycle}. */
  private thisCycle = 0;

  constructor(opts: { maxAttempts?: number; perCycleCap?: number } = {}) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_MESSAGE_ATTEMPTS);
    this.perCycleCap = Math.max(1, opts.perCycleCap ?? MAX_DEAD_LETTERS_PER_CYCLE);
  }

  /** Called once at the top of every sync cycle, so the per-cycle cap is per cycle. */
  beginCycle(): void { this.thisCycle = 0; }

  /**
   * Record one failed change. Returns `"skip"` when the item is now CONSUMED — the batch may
   * continue past it and the folder cursor may cross it — or `"retry"` when it is not, in which
   * case the caller must hold that folder's cursor and fail the cycle.
   */
  record(locator: NativeLocator, fault: { code: MessageFailureCode; deterministic: boolean }): "skip" | "retry" {
    const { uidValidity, uid } = parseRef(locator.ref);
    const key = keyOf(locator.folder, uidValidity, uid);
    const now = new Date();
    const prev = this.items.get(key);
    const item: MessageFailure = prev
      ? { ...prev, code: fault.code, attempts: prev.attempts + 1, lastFailedAt: now }
      : {
        folder: locator.folder, uidValidity, uid: Number.isFinite(uid) ? uid : 0,
        code: fault.code, attempts: 1, firstFailedAt: now, lastFailedAt: now, terminal: false,
      };
    this.items.set(key, item);

    if (item.terminal) return "skip";                       // already written off; do not re-count
    const exhausted = fault.deterministic || item.attempts >= this.maxAttempts;
    if (!exhausted) return "retry";
    if (this.thisCycle >= this.perCycleCap) return "retry";  // the safety valve, above
    this.thisCycle++;
    item.terminal = true;
    return "skip";
  }

  /** Is this UID already written off? */
  has(folder: string, uidValidity: string, uid: number): boolean {
    return this.items.get(keyOf(folder, uidValidity, uid))?.terminal === true;
  }

  /**
   * The terminally-skipped UIDs of one folder AT ONE EPOCH, shaped for the adapter's known-set.
   *
   * Epoch-filtered for the same reason `buildCursor` filters real locators (finding 2): a UID
   * number written off under one UID epoch must not silence a different message that reuses that
   * number under a later epoch.
   *
   * `messageId: null` deliberately — we never parsed the message, so we have no Message-ID, and
   * inventing one would let `correlateMoves` pair a skipped UID with an unrelated create.
   */
  knownFor(folder: string, uidValidity: string): Array<{ uid: number; messageId: string | null }> {
    const out: Array<{ uid: number; messageId: string | null }> = [];
    for (const it of this.items.values()) {
      if (it.terminal && it.folder === folder && it.uidValidity === uidValidity) {
        out.push({ uid: it.uid, messageId: null });
      }
    }
    return out;
  }

  /** How many messages this mailbox has written off. Evidence for `/health` and the logs. */
  get skipped(): number {
    let n = 0;
    for (const it of this.items.values()) if (it.terminal) n++;
    return n;
  }

  entries(): MessageFailure[] { return [...this.items.values()]; }
}
