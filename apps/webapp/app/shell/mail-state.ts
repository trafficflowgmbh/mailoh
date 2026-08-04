/**
 * WHAT IS HAPPENING TO MY MAIL, SAID IN SIX WAYS INSTEAD OF ONE WRONG WAY.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * The product had exactly ONE sentence for every state a first sync can be in:
 * `mailboxes.syncPending`, "Waiting for first sync", rendered by a spinner in Settings →
 * Mailboxes whenever `lastSyncAt` was null. Observed on a real first import: it stayed on
 * screen for half an hour while hundreds of messages arrived, and was still climbing when it
 * was checked. It is not merely unhelpful — it is the only
 * thing the product says during the period in which it is working hardest, and it kept
 * saying it after mail WAS flowing.
 *
 * ── WHY `lastSyncAt` CANNOT BE THE PROGRESS SIGNAL, IN EITHER DIRECTION ─────────────────
 *
 * Two things were read out of the worker rather than assumed, and each one on its own
 * disqualifies the column:
 *
 *  · **It is shared.** The server stamps it in ONE `UPDATE … WHERE id IN (…)` covering every
 *    mailbox the cycle served. Two mailboxes on one account were measured reporting an
 *    IDENTICAL 207 seconds of age, so the column cannot distinguish one mailbox's progress
 *    from another's.
 *  · **It lands EARLY.** The server moves a mailbox into `synced` after each successful cycle
 *    *whether or not* it still has a backlog. So a mailbox thirty seconds into a thirty-minute
 *    import already carries a stamp.
 *
 * And separately it lands LATE: the first attach has been measured at around six minutes,
 * twice, on a mailbox of a few thousand messages, and attaches are serial — so a second
 * mailbox legitimately waits behind the first with a null stamp the whole time.
 *
 * **Therefore the growing state keys on THE MIRROR GROWING — the client's own message count
 * rising across syncs — and on nothing the server timestamps.** `lastSyncAt` is consulted in
 * exactly one place ({@link deriveMailState}'s `awaiting` arm) and only as `=== null`, which
 * is the one reading the two defects above leave intact: only ids in `synced` are ever
 * stamped, so a null really does mean "not one cycle has completed for this mailbox yet". The
 * POSITIVE reading — "this mailbox synced 207 seconds ago" — is the worthless one, and it is
 * never taken.
 *
 * ── WHY THE DERIVATION IS HERE AND NOT IN A VIEW ────────────────────────────────────────
 *
 * `SyncBar.tsx` records that the failure sentence was found three times, because each fix
 * was written as another branch inside a view and a view can only speak about itself. This
 * module is the same lesson applied to the progress sentence: ONE pure function, no React, no
 * DOM, no network, run ONCE per shell. Three surfaces render its answer — the shell's strip,
 * the Ohbox's empty pane and the Settings → Mailboxes rows — and not one of them decides
 * anything. A fourth surface added later gets the same answer for free.
 *
 * The growth sampler is STATEFUL, which is the other half of "run once": two consumers each
 * running their own sampler could disagree about whether the mirror is growing, which is this
 * bug again with extra steps.
 */

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHAT THE CLIENT CAN ACTUALLY OBSERVE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The ways OUR OWN infrastructure declines to serve a mailbox (mail 0029).
 *
 * A CLOSED set with a CHECK constraint behind it, owned server-side as
 * `MAILBOX_SYNC_BLOCK_REASONS`. It is re-declared here rather than imported for the same reason
 * `api-client.ts` re-declares `errorCode`: this module ships in the Desktop app, which is built
 * without the server packages, so an import would break a build that has no server in it at all.
 *
 * Re-declaring a closed set is how the two drift, and it has produced a failure once already: a fourth `status` value would have rendered the literal key path
 * `status_xxx` in the product. Two things stop that here. `mail-state.test.ts` asserts, FROM
 * `@trafficflow/db`, that this array and that one are the same array and that `en.json`
 * carries a sentence for every member — so drift is a red test. And at RUNTIME an unrecognised
 * reason still produces the `blocked` state with generic copy (see {@link deriveMailState}),
 * because a server that grows a fourth reason must not be answered with silence.
 */
export const SYNC_BLOCK_REASONS = [
  "lease_unreadable",
  "awaiting_credentials",
  "at_capacity",
] as const;
export type SyncBlockReason = (typeof SYNC_BLOCK_REASONS)[number];

export function isSyncBlockReason(v: unknown): v is SyncBlockReason {
  return typeof v === "string" && (SYNC_BLOCK_REASONS as readonly string[]).includes(v);
}

/**
 * THE ORGANIZER LEASE'S VERDICT, AS COPY TOKENS.
 *
 * `mailboxes.disabled_reason` is the other closed set on this row: `MAILBOX_DISABLED_REASONS`,
 * three members, its own CHECK constraint, owned server-side. It says why a
 * mailbox is `disabled` when the LEASE decided it rather than a person — and it used to be on
 * no wire at all, which is how a mailbox could read "disconnected", "No mail yet — added 3
 * minutes ago" and "No mailbox connected, so nothing can arrive" at the same moment.
 *
 * ── THE VALUES HERE ARE NOT THE WIRE'S VALUES, AND THAT IS DELIBERATE ───────────────────
 *
 * The wire tokens carry a colon (`organized_elsewhere:local`). {@link MailState.reason} is
 * documented as COPY — `SyncBar` interpolates it straight into `t(\`blocked_${reason}\`)` — so
 * whatever lands in that field becomes an i18n key. Mapping here keeps a SERVER-OWNED string out
 * of the message namespace entirely, which is a stronger guarantee than "a colon happens to
 * resolve" (it does; that was measured before this map replaced it). {@link standDownToken} is
 * the only place the two vocabularies meet, and `mailbox-stand-down.test.tsx` reconciles this
 * table against `MAILBOX_DISABLED_REASONS` read out of the owning module — the same guard
 * `SYNC_BLOCK_REASONS` already carries, for the same drift.
 */
export const STAND_DOWN_REASONS = [
  "organized_elsewhere_cloud",
  "organized_elsewhere_local",
  "organized_elsewhere_unknown",
] as const;
export type StandDownReason = (typeof STAND_DOWN_REASONS)[number];

/**
 * A `disabled_reason` off the wire, as the copy token for it.
 *
 * `null` in, `null` out — that is the ORDINARY DISCONNECT and it must stay distinguishable, or
 * a mailbox the user removed on purpose gets told another install has claimed it.
 *
 * Anything else in, `organized_elsewhere_unknown` out. The server already narrows an
 * unrecognised member to `:unknown` on the way out (`mailbox-service.ts`), so this is the second
 * line rather than the first — but it is the line that matters during a deploy, and answering a
 * member this build has never heard of with `null` would file a newer worker's stand-down as
 * "the user disconnected this" — a mistake this codebase has made once already, transposed onto
 * a column with no timestamp beside it. That is why this function never returns `null` for a non-null input.
 */
export function standDownToken(wire: string | null): StandDownReason | null {
  if (wire === null) return null;
  if (wire === "organized_elsewhere:cloud") return "organized_elsewhere_cloud";
  if (wire === "organized_elsewhere:local") return "organized_elsewhere_local";
  return "organized_elsewhere_unknown";
}

/**
 * ONE mailbox, as the shared shell is allowed to know it.
 *
 * Structural and shell-owned, NOT `MailboxDTO`. The Cloud client's API layer is not part of the
 * Desktop app, so this file may not name its types; and narrowing to the fields the
 * ladder reads is the honest declaration of what the derivation is entitled to consult.
 * Anything the Cloud client can see and this interface does not name is a fact the copy may
 * not assert.
 */
export interface MailboxFacts {
  /**
   * WHICH mailbox this is — added for the From seam, NOT for the ladder.
   *
   * `deriveMailState` must never read it, and does not: every state below is about the account
   * or about one mailbox already in hand, and an id is not a fact any sentence can assert. It
   * is here because `compose-from.ts` needs a stable, non-address handle — the From selector's
   * value is a mailbox id and never an address string, so that an alias landing later cannot
   * turn one address into two mailboxes' worth of ambiguity.
   */
  id: string;
  address: string;
  /** The 3-member lifecycle union, widened to `string` because the wire is a string. */
  status: string;
  /** Null unless `status === 'error'`. A stable key; the wording lives in `messages/*.json`. */
  errorCode: string | null;
  /**
   * WHY a `disabled` mailbox is disabled, when the ORGANIZER LEASE decided it (mail 0027).
   *
   * The raw wire token, colon and all — {@link standDownToken} is what turns it into copy. Null
   * is the ordinary disconnect, and under `status === 'disabled'` that distinction is the whole
   * of what separates "you removed this" from "somebody else has claimed it".
   */
  disabledReason: string | null;
  /** WHY a `connected` mailbox is not being synced (mail 0029). Null is the healthy case. */
  syncBlockedReason: string | null;
  /** When the CURRENT block began. `coalesce`d server-side, so it does not restart per pass. */
  syncBlockedSince: string | null;
  /** End of a completed worker cycle. Read ONLY as `=== null`. See the header. */
  lastSyncAt: string | null;
  /** When this mailbox was connected. The one per-mailbox clock that is not shared. */
  createdAt: string;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   IS THE MIRROR GROWING? — a pure reducer over two or more observations
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How long a rise keeps counting, and how close two rises must be to belong to one run.
 *
 * Thirty seconds. It has to survive ONE missed 8 s poll plus its backoff jitter plus the
 * lumpiness of a worker writing an import in batches — a window of one or two poll periods
 * would flap between "syncing" and silence every time a large message took a moment, which is
 * worse than either sentence alone. It also has to be orders of magnitude below "this mailbox
 * finished importing three hours ago", which it is.
 *
 * A DURATION and not a count of polls, for the reason `syncBlockGraceMs` is one: a count
 * is a proxy for time that silently retunes the moment `POLL_MS` changes.
 *
 * ── IT BOUNDS THE RUN, NOT THE EPISODE ──────────────────────────────────────────────────
 *
 * The paragraph above predicted a flap if this window were one or two poll periods. It was the
 * right argument aimed at the wrong clock, and the flap happened anyway at thirty seconds: the
 * gap that governs mid-import is not the CLIENT's 8 s poll, it is the SERVER's cycle — a poll
 * interval of 60 s by default. No 30 s window can span one of those, so every server cycle tore
 * the run down and the strip had to start again.
 *
 * This constant still decides what counts as ONE RUN of rises, which is the evidence that an
 * import has BEGUN. What outlives it is the episode — see {@link IMPORT_END_IDLE_MS}.
 */
export const GROWTH_WINDOW_MS = 30_000;

/**
 * How long an import EPISODE survives a mirror that is not moving.
 *
 * ── THE DEFECT THIS NUMBER EXISTS FOR ───────────────────────────────────────────────────
 *
 * Observed in a real import: three worker drains with 45 s of idle between them showed
 * the strip FIVE times, with 31-second quiet gaps inside a single import. Every one of those
 * gaps is longer than {@link GROWTH_WINDOW_MS}, so each one ended the run — and with the run
 * gone the strip had to re-earn two rises AND the delta before it could speak again.
 *
 * ── WHY NINETY SECONDS ──────────────────────────────────────────────────────────────────
 *
 * The quiet gap mid-import is ONE SERVER CYCLE. The server kicks that cycle on a poll interval
 * that defaults to 60 s, and the client then needs up to one 8 s `POLL_MS` to see what the cycle
 * wrote — a floor of 68 s. The largest gap actually measured was 45 s. Ninety clears both with
 * room for a cycle that overruns, and `mail-state.test.ts` asserts the relation against the
 * server's own constant rather than against this sentence.
 *
 * ── AND WHAT IT COSTS, SAID OUT LOUD ────────────────────────────────────────────────────
 *
 * The strip now lingers up to 90 s after the last message instead of 30 s, over a count that has
 * stopped moving — and `SyncBar.tsx`'s spinner keeps turning for all of it. That is a real cost,
 * accepted, because there is NO end-of-import signal to replace it with: `lastSyncAt` cannot be
 * read positively (see the file header, both defects), and `/sync` answers `hasMore` about one
 * DRAIN, never about the import. A tail of stale-but-true beats a strip that appears five times,
 * which is the defect that was actually filed.
 */
export const IMPORT_END_IDLE_MS = 90_000;

/**
 * How much a run of rises must add before it is called an IMPORT rather than the post.
 *
 * Without this the strip appears for one decay window every time any mail arrives, on every
 * busy morning, for ever — which is precisely the "permanent chrome nobody reads" that
 * `SyncBar.tsx` was built to avoid. Twenty-five messages is crossed in ~19 s at the measured
 * import rate (27 messages / 20 s) and is not crossed by a thread burst.
 *
 * It is measured against {@link MirrorGrowth.added} — what the run ADDED — and no longer against
 * `count - runStartCount`, which was a NET delta a single delete could walk back. That was the
 * first defect; the field's own doc has the mechanism.
 *
 * The first import of a mailbox does not have to reach it, because a run that starts from an
 * EMPTY mirror is unambiguous. See {@link isImporting}.
 */
export const IMPORT_MIN_DELTA = 25;

/**
 * What the sampler remembers. Two observations are the minimum evidence for "growing", so a
 * single arrival can never make the claim.
 */
export interface MirrorGrowth {
  /** The last count observed. */
  count: number;
  /** When the count last ROSE. `-Infinity` until it ever has — never `Date.now()`. */
  lastRiseAt: number;
  /** Rises in the CURRENT run. `growing` needs two; one rise is an arrival, not an import. */
  rises: number;
  /** The count this run started from. Zero means "this mirror was empty", i.e. a first import. */
  runStartCount: number;
  /**
   * Messages the current run has ADDED. Cumulative, and never reduced — the first defect.
   *
   * The qualifier used to be `count - runStartCount`, a NET delta, and a fall moves `count` while
   * deliberately leaving `runStartCount` alone ({@link growthStep} says why). So every delete, and
   * every message a Screener backfill moved out of the mirror, SHRANK the evidence that an import
   * was under way: the net delta walked back and forth across {@link IMPORT_MIN_DELTA} and the
   * strip followed it, on and off, for as long as the backfill ran.
   *
   * `added === count - runStartCount` exactly when no fall has happened in the run — which is the
   * whole "and nothing else changed" claim, and is asserted rather than asserted-in-a-comment.
   */
  added: number;
  /**
   * THE EPISODE LATCH — the second and third defects, which are the same defect.
   *
   * True from the moment a run first qualifies as an import until the mirror has been still for
   * {@link IMPORT_END_IDLE_MS}. It is deliberately NOT cleared when a RUN ends, and that is the
   * point: both qualifiers that can start an episode are effectively single-use in a session.
   * `runStartCount === 0` can only hold before the first gap, because {@link growthStep} moves the
   * baseline off zero and never back; and `bootstrapping` goes false on this tab's first
   * successful drain (`sync-scheduler.ts`) and never returns. So without a latch, an import that
   * pauses for 31 seconds has to re-earn two rises AND twenty-five messages before the strip may
   * speak again — five times during one import, which is what was measured.
   *
   * A boolean and not a timestamp: nothing reads WHEN the episode began, and everything
   * time-based reads `lastRiseAt`, which is the fact that actually decays. A field nobody reads
   * is a claim under test that fails.
   */
  importing: boolean;
}

/**
 * The seed. `lastRiseAt: -Infinity` and not `Date.now()`, deliberately.
 *
 * The mirror persists into IndexedDB, so a tab that opens onto a settled mailbox starts at
 * 495 rather than at 0. Seeding the clock with "now" would make the next arrival look like the
 * second rise of a run that never had a first, so every reload of a healthy mailbox would
 * announce an import. `-Infinity` makes the first rise unambiguously a first rise.
 *
 * `importing: false` for the same reason, and it is the one place the latch does not survive: a
 * tab opening mid-import cannot tell itself apart from a tab opening onto a settled mailbox, so
 * it must claim nothing. It re-enters through `bootstrapping` while its own first drain runs, and
 * after that needs {@link IMPORT_MIN_DELTA} more messages to latch — the cold-start behaviour this
 * module always had, and the episode timeout above does not change it.
 */
export function seedGrowth(count: number): MirrorGrowth {
  return {
    count,
    lastRiseAt: -Infinity,
    rises: 0,
    runStartCount: count,
    added: 0,
    importing: false,
  };
}

/**
 * Fold one observation of the mirror's size in.
 *
 * A FALL — a delete, a move out of the mirror — moves the baseline and touches nothing else.
 * It is not a rise, and it is not evidence that the previous rise did not happen. That was
 * already true and already deliberate; what changed is that it now MATTERS, because `added`
 * is the qualifier and a fall may not reduce it.
 */
export function growthStep(prev: MirrorGrowth, count: number, now: number): MirrorGrowth {
  if (count === prev.count) return prev;
  if (count < prev.count) return { ...prev, count };
  const continues = now - prev.lastRiseAt <= GROWTH_WINDOW_MS;
  const rises = continues ? prev.rises + 1 : 1;
  // A new run starts from the count BEFORE this rise — so a run that begins on an empty
  // mirror has `runStartCount === 0`, which is what identifies a first import.
  const runStartCount = continues ? prev.runStartCount : prev.count;
  const added = (continues ? prev.added : 0) + (count - prev.count);
  // THE EPISODE OUTLIVES THE RUN. A 31 s gap ends the run — it is longer than GROWTH_WINDOW_MS —
  // and must not end the import, because the worker's cycle is 60 s and a gap of that size is
  // simply what the middle of an import looks like from a client that can only see its mirror.
  const held = prev.importing && now - prev.lastRiseAt < IMPORT_END_IDLE_MS;
  const qualifies = rises >= 2 && (runStartCount === 0 || added >= IMPORT_MIN_DELTA);
  return { count, lastRiseAt: now, rises, runStartCount, added, importing: held || qualifies };
}

/**
 * Two rises, the second of them recent. Nothing else counts as growth.
 *
 * It is the ENTRY evidence, and {@link isImporting} bypasses it entirely once an episode has
 * latched — which is the most surprising line in this file, so it is said in both places. A
 * latched episode is not required to keep proving that the mirror is growing right now; it is
 * required only not to have been still for {@link IMPORT_END_IDLE_MS}.
 */
export function isGrowing(g: MirrorGrowth, now: number): boolean {
  return g.rises >= 2 && now - g.lastRiseAt < GROWTH_WINDOW_MS;
}

/**
 * Is this growth an IMPORT worth interrupting the screen for? Two ways in, all client facts.
 *
 * ── 1. THE EPISODE IS LATCHED ───────────────────────────────────────────────────────────
 *
 * {@link growthStep} set {@link MirrorGrowth.importing} when a run first qualified — it started
 * from an EMPTY mirror (a first import, the original defect itself), or it added
 * {@link IMPORT_MIN_DELTA} or more (a mid-import stall that resumed at count 300 is still an
 * import). The only question left here is whether the mirror has gone still for
 * {@link IMPORT_END_IDLE_MS}, which is the whole of the fix: the qualifiers are evaluated once,
 * at the rise that earns them, and never re-litigated between two worker cycles.
 *
 * ── 2. THIS TAB'S FIRST DRAIN HAS NOT COMPLETED ─────────────────────────────────────────
 *
 * A new device repopulating its own mirror. It is the one arm that CANNOT latch, because
 * `growthStep` is not told about `bootstrapping` — and it is not told because that would mean
 * changing `MailStateProvider.tsx`'s call, which is out of this module's reach. It does not need to
 * latch: it is true for seconds, it covers exactly the cold-start window `seedGrowth` describes,
 * and a run that matters outlives it by qualifying on its own.
 *
 * Not one of them reads a timestamp the server wrote. That is WORKLIST.md:510 verbatim.
 */
export function isImporting(g: MirrorGrowth, bootstrapping: boolean, now: number): boolean {
  if (g.importing) return now - g.lastRiseAt < IMPORT_END_IDLE_MS;
  return isGrowing(g, now) && bootstrapping;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE LADDER
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ── THE SIX STATES ──────────────────────────────────────────────────────────────────────
 *
 *  1. `awaiting`      a mailbox is connected, no cycle has completed and the mirror is EMPTY.
 *                     The honest replacement for "Waiting for first sync" — often the correct
 *                     thing to say (a first attach was measured at ~6 minutes), and it says
 *                     how long, so it can never be a frozen spinner.
 *  2. `importing`     **THE MIRROR IS GROWING.** Keyed on the client's own count rising across
 *                     syncs, never on a stamp. Counts, never a percentage. An EPISODE rather
 *                     than a run of rises, because the worker writes an import in cycles a
 *                     minute apart and a state that re-qualified between them flapped.
 *  3. `screenerOnly`  emitted as {@link MailState.screenerCandidate}, not as a key: mail has
 *                     landed, the mirror is settled and nothing is wrong. The OHBOX pane
 *                     combines it with its own emptiness — a fresh account is mostly Screener
 *                     by design, so this is where an empty Ohbox is CORRECT and needs saying.
 *  4. `blocked`       our own infrastructure is declining to serve the mailbox
 *                     (`syncBlockedReason`, mail 0029) — the UI half of the block the
 *                     server records on the row.
 *  5. `mailboxError`  the mailbox itself refused us (`status === 'error'`, `errorCode`).
 *  6. `noMailbox`     the probe answered, and there are none. Distinct from "we cannot see".
 *
 * ── AND THE TWO THAT ARE NOT THIS LADDER'S ──────────────────────────────────────────────
 *
 * `stopped` and `failing` belong to the failure strip and they OUTRANK all six. The reason is the rule
 * `OhboxView`'s counter already followed and this one inherits: once the drains are failing the
 * mirror count is FROZEN, so every claim below about growth is a claim about a number that
 * cannot move. A frozen counter is the same lie in a new font.
 *
 * `failing` has a SECOND cause. It is reached by the failure streak, as before, and
 * also by a single coded 401/403 that the server has not yet re-made (`sync.refused`). Both mean
 * the same thing about the mirror, which is why they share a state and a sentence: the loop is
 * not draining and it intends to try again. What the second one must not do is reach `stopped`,
 * because that sentence tells a signed-in user they are signed out on one request's evidence.
 *
 * `quiet` is the resting value and it is most of the time. There is no permanent "everything
 * is fine" chrome to learn to ignore.
 */
export type MailStateKey =
  | "stopped"
  | "failing"
  | "blocked"
  | "mailboxError"
  | "noMailbox"
  | "importing"
  | "awaiting"
  | "quiet";

export interface MailState {
  key: MailStateKey;
  /**
   * Does this state's copy depend on ELAPSED TIME rather than on a mirror change?
   *
   * If it does, the surface must run its own clock or the sentence freezes: a healthy tab
   * publishes an identical `SyncStatus` every eight seconds and `engine.tsx` deliberately
   * bails out of re-rendering for it, so nothing else would ever re-paint. See
   * `MailStateProvider.tsx`.
   */
  clock: boolean;
  /** Messages in the MIRROR. `importing` renders it; the others carry it for context. */
  count: number;
  /**
   * `blocked` only, and it is a COPY TOKEN rather than a wire value — `SyncBar` interpolates it
   * into `t(\`blocked_${reason}\`)`.
   *
   * A member of {@link SYNC_BLOCK_REASONS} (mail 0029, our infrastructure declining to serve a
   * `connected` mailbox) or of {@link STAND_DOWN_REASONS} (mail 0027, the organizer lease
   * declining to serve a `disabled` one), or `null` when the server sent a sync-block reason
   * this build does not know — the state still fires, with generic copy. Silence would re-create
   * mail 0029's "unobservable by design" one layer up.
   *
   * The two sets share one field and one state because they are one sentence to a reader: this
   * mailbox is not syncing, and here is why. They are kept apart at the SOURCE — different
   * columns, different closed sets, different writers — and joined only here, where the only
   * remaining question is which sentence to render. A stand-down never yields `null`: see
   * {@link standDownToken}.
   */
  reason: SyncBlockReason | StandDownReason | null;
  /** `mailboxError` only — the `errorCode` key whose sentence lives in `mailboxes.err_*`. */
  errorCode: string | null;
  /** The mailbox the state is ABOUT, when it is about exactly one. */
  address: string | null;
  /**
   * Whole minutes this state has been true, and WHICH clock differs per state because the
   * useful number does:
   *
   *  · `blocked`  — since `syncBlockedSince`, the server's own record of the block.
   *  · `awaiting` — since the mailbox was CONNECTED (`createdAt`). The one per-mailbox clock
   *                 that is not shared between rows, and the honest answer to "how long have
   *                 I been looking at this".
   *
   * `null` when the stamp behind it is absent or unparseable.
   */
  minutes: number | null;
  /**
   * `awaiting` only — has this outlasted what a first import is measured to take?
   *
   * Not a different state: the same fact, said without the explanation, plus the one action
   * that exists. It never claims an error, because at this point nothing has failed.
   */
  slow: boolean;
  /**
   * Mail has landed, the mirror is settled, and nothing is wrong — so IF a list is empty, the
   * mail is in the Screener and that is worth saying.
   *
   * A flag and not a key, because it is a statement about the OHBOX. Rendered by the shell
   * strip it would tell somebody standing in the Screener that everything is in the Screener.
   * The rule `SyncBar.tsx` enforces is one DERIVATION, not one DOM node: this is derived here,
   * once, and the pane may only combine it with the row count it is already the authority on.
   * The pane may not re-derive it.
   */
  screenerCandidate: boolean;
  /**
   * **MAY AN EMPTY LIST BE STATED AS A SETTLED FACT?**
   *
   * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
   *
   * Reported from real use: opening ohmail.app signed in, over a slow connection, shows "no
   * messages". Reproduced against the shipped shell with `/sync` held
   * open — the first paint and the paint five seconds later are the same three sentences:
   *
   *     Ohbox · 0 unread of 0 messages · All clear · ✉ Nothing in your Ohbox.
   *
   * Every one of them is a claim about the user's own mail, made in the product's voice, before
   * the product has finished looking. "Empty", "not loaded yet" and "the read failed" are three
   * different facts and the panes had one rendering for all three.
   *
   * ── WHAT IT IS, AND WHY IT IS NOT A KEY ─────────────────────────────────────────────────
   *
   * `screenerCandidate`'s shape exactly, for `screenerCandidate`'s reason: it is a
   * QUALIFICATION of a fact each PANE owns ("my list is empty"), not an account-wide sentence.
   * The strip already has `awaiting` and `importing` for account-level progress; a seventh key
   * here would put a sentence on screen for the ~200 ms a fast connection takes, and
   * `engine.tsx` has already ruled that a sentence that flashes is worse than a quiet frame.
   * The panes, by contrast, are ALREADY rendering something in that slot — replacing a false
   * sentence with a true one adds no chrome.
   *
   * ── THE DERIVATION READS THE LADDER'S VERDICT, NOT THE LADDER'S CONDITIONS ──────────────
   *
   * `!bootstrapping || key === "stopped" || key === "failing"`, and the second half is
   * deliberately expressed as KEYS rather than as `terminal || failures >= streak || refused`.
   * Those are the same thing today ({@link deriveMailState}'s first two arms), and writing the
   * conditions out again would be a second copy of a precedence rule that lives twenty lines
   * away — the exact drift this module's header was written to end. A future change to what
   * counts as failing flows through for free.
   *
   * ── WHY `bootstrapping` IS THE RIGHT CLOCK HERE, HAVING BEEN THE WRONG ONE THERE ────────
   *
   * `OhboxView`'s header records that a live COUNT gated on `bootstrapping` was the original defect:
   * it means "this TAB's first drain has not completed", which is seconds, while the WORKER's
   * first import is minutes — so the counter switched itself off and the pane went silent for
   * the whole import. That argument is about DURATION and it is untouched: progress still keys
   * on the mirror growing, and still lives in the strip.
   *
   * This is a different question with a different answer. "Has anything authoritative populated
   * this mirror yet" is exactly what `bootstrapping` means, and seconds is exactly the right
   * length for it — the scheduler hydrates from the device BEFORE it drains, so `!bootstrapping`
   * implies the local copy has already been read too.
   *
   * ── AND IT CANNOT SPIN FOR EVER ─────────────────────────────────────────────────────────
   *
   * A loop that is failing never clears `bootstrapping`, so without the two key arms a mailbox
   * whose network is down would say "still loading" until the tab was closed — one lie traded
   * for another. `stopped` and `failing` are precisely the states in which the strip is already
   * explaining that the mirror is frozen, so from there an empty list is as settled as it is
   * ever going to get and the panes may say so plainly.
   */
  settled: boolean;
}

const QUIET: MailState = {
  key: "quiet",
  clock: false,
  count: 0,
  reason: null,
  errorCode: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  // Overwritten for every state by `deriveMailState`'s wrapper — see {@link MailState.settled}.
  // `true` here so that a `QUIET` used directly as a resting value never withholds a pane's
  // ordinary empty state.
  settled: true,
};

/**
 * When a first import has taken longer than one is measured to take.
 *
 * TEN minutes, and the number is set against a measurement rather than a feeling:
 * `mailbox_attach_started → mailbox_attached` has been timed at around six minutes, twice, on
 * a mailbox of a few thousand messages. So SIX minutes with an empty mirror is NORMAL, and
 * escalating at three would dress a healthy large-mailbox import as a fault — the opposite defect to the
 * one this slice fixes, and just as false. Attaches are serial, so a second mailbox waits
 * behind the first; ten leaves room for that.
 *
 * **It must stay under the server's `syncLag` alert threshold (15 minutes), and
 * `mail-state.test.ts` asserts that against the real constant.** This is the
 * `syncBlockGraceMs < syncLagMs` argument one layer up: if the operators are paged before the
 * screen has escalated, the user is again the last to know — which is exactly the half-hour of
 * silence this whole module exists to end.
 */
export const AWAITING_SLOW_MS = 600_000;

/** Whole minutes since an ISO instant, floored, never negative. */
function minutesSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** The oldest of the given ISO stamps — the one that has been true longest. */
function earliest(stamps: Array<string | null>): string | null {
  let best: { iso: string; t: number } | null = null;
  for (const iso of stamps) {
    if (iso === null) continue;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t < best.t) best = { iso, t };
  }
  return best?.iso ?? null;
}

/** Everything the ladder is allowed to read. Every field is something the CLIENT observes. */
export interface MailStateInputs {
  /**
   * `useSyncStatus()` — what the tab's own drain loop is doing.
   *
   * Structural, and re-declared rather than imported as `SyncStatus`, for the reason
   * {@link MailboxFacts} is: this module ships in the Desktop mirror. The four fields are the
   * whole of what the ladder is entitled to consult. `refused` is a coded 401/403 the server has
   * not yet re-made — weaker than `terminal` and deliberately so.
   */
  sync: { bootstrapping: boolean; failures: number; terminal: boolean; refused: boolean };
  /** `SYNC_FAILURE_STREAK`, passed in so the surfaces cannot drift from the scheduler. */
  failureStreak: number;
  /**
   * `GET /mailboxes`, narrowed — or `null` for "we cannot see mailboxes".
   *
   * **`null` and `[]` ARE DIFFERENT FACTS and the distinction is load-bearing.** `null` is the
   * demo, the Desktop bundle, a probe that has not answered yet, and a probe that FAILED; `[]`
   * is "the server told us there are none". Collapsing a rejected `GET /mailboxes` into `[]`
   * would render "No mailbox connected" to somebody who has five — a 503 turned into a lie
   * about their account.
   */
  mailboxes: MailboxFacts[] | null;
  /** Messages in the MIRROR — every folder, not the Ohbox's rows. */
  mirrored: number;
  /** The growth sampler's memory. THE progress signal. */
  growth: MirrorGrowth;
  /** `Date.now()`, injected so the ladder is pure and the tests need no clock control. */
  now: number;
  /** True in the demo and on the Desktop: a fixture world has no sync to report. */
  demo: boolean;
}

/**
 * WHAT TO SAY, from what the client can see — plus whether the panes may call an empty list
 * empty. Pure.
 *
 * ── THE STAMP IS APPLIED HERE AND NOT INSIDE THE LADDER ─────────────────────────────────
 *
 * {@link MailState.settled} is a property of EVERY state, and `climb` below has ten `return`
 * statements. Stamping it in one place rather than ten is not tidiness: it is what makes the
 * flag impossible to omit, including from the eleventh state somebody adds next year. The same
 * argument `stripSpeaks` makes about keys — the surfaces decide nothing — applied to a field.
 *
 * It is also why the derivation can read `climb`'s KEY: the verdict exists before the stamp
 * does. See {@link MailState.settled} for why that indirection is the point.
 */
export function deriveMailState(input: MailStateInputs): MailState {
  const state = climb(input);
  return {
    ...state,
    settled:
      !input.sync.bootstrapping || state.key === "stopped" || state.key === "failing",
  };
}

/**
 * The ladder itself. First match wins.
 *
 * The order below is PRECEDENCE and is deliberately not the order the states are numbered in.
 * Each step says why it outranks the next.
 */
function climb(input: MailStateInputs): MailState {
  const { sync, failureStreak, mailboxes, mirrored, growth, now, demo } = input;

  // A fixtures engine drains once from local data and is permanently settled. There is no
  // sync here to have a state, and the demo promises that nothing leaves the tab — so it gets
  // the resting value before anything else is even considered.
  if (demo) return QUIET;

  // ── The loop's own health outranks everything, because it invalidates the evidence ──────
  //
  // `terminal` first: the loop has disarmed itself and will not restart, so no count below
  // can move and no mailbox fact below can be refreshed.
  if (sync.terminal) return { ...QUIET, key: "stopped" };
  // And a failing loop means the mirror is FROZEN. `OhboxView`'s counter already stops here;
  // every state below would be reading a number that cannot change.
  //
  // `sync.refused` joins it, and does NOT get its own key. A coded 401/403 the server has
  // not re-made means the loop has stopped draining and has armed one more ask, which is what
  // `failing` already says and already means; a seventh state would need copy of its own for a
  // condition that resolves in sixty seconds either way. It bypasses `failureStreak` because that
  // threshold exists for blips ("one is a dropped packet") and a refusal our own API made about
  // this identity is not one. What it must not do is reach `stopped` above.
  if (sync.failures >= failureStreak || sync.refused) return { ...QUIET, key: "failing" };

  // "We cannot see mailboxes" — not "there are none". Everything from here reads them.
  if (mailboxes === null) return QUIET;

  const live = mailboxes.filter((m) => m.status !== "disabled");

  /* ── 4a. STOOD DOWN — the ORGANIZER LEASE is declining to serve it ──────────────────────
   *
   * ── THE FALSE SENTENCE THIS ARM EXISTS TO DELETE ─────────────────────────────────────
   *
   * Observed on a real Cloud account. A mailbox connect was
   * accepted end to end and then lost the organizer claim to a LOCAL install whose heartbeat was
   * three hours stale, so the worker wrote `status='disabled'` +
   * `disabled_reason='organized_elsewhere:local'`. The `live` filter one line above drops every
   * `disabled` row — which is correct for the six states below it and catastrophic here — and
   * with the account's only mailbox dropped, `live.length === 0` fired and the strip said
   * **"No mailbox connected, so nothing can arrive"** to somebody who had connected one three
   * minutes earlier. Three statements on one screen, no two of them agreeing.
   *
   * ── IT SCANS `mailboxes`, NOT `live`, AND THAT IS THE ENTIRE FIX ─────────────────────
   *
   * A stood-down mailbox IS disabled — the status is honest, `markMailboxStoodDown` wrote it on
   * purpose, and the six states below have no business speaking about a row nothing is syncing.
   * What was missing is that "disabled" has two causes and the product only ever knew one of
   * them. `disabledReason` is the discriminator, and it is why this arm cannot simply relax the
   * filter: an ordinary disconnect must still reach `noMailbox`, because a user who removed
   * their only mailbox HAS no mailbox and telling them so is correct.
   *
   * ── AND IT OUTRANKS `blocked`, NOT THE OTHER WAY ROUND ───────────────────────────────
   *
   * Both say "this mailbox is not syncing". A sync block is our own infrastructure declining and
   * RETRYING — `reconcileSyncBlocks` rewrites it every roster pass and it clears itself when the
   * fault does. A stand-down is terminal from the product's side: `loadEnabledMailboxes` filters
   * `status <> 'disabled'`, so the row is off the roster entirely and no amount of waiting moves
   * it. Between two true sentences, the one that is not going to stop being true wins.
   *
   * Above the growth states for the reason `blocked` already is, verbatim: a mailbox nobody is
   * syncing is not syncing, whatever a second mailbox is doing to the mirror.
   *
   * `minutes` stays null. There is no `disabled_since` column — nothing timestamps a stand-down
   * — and inventing an elapsed time from `createdAt` would be measuring the wrong thing. `Since`
   * renders nothing for a null, which is the path `blockedUnknown` already takes.
   */
  /* `typeof === "string"` AND NOT `!== null`, and the difference is a caught defect. The field
   * is typed `string | null`, but a probe compiled before the field existed — a cached Cloud
   * bundle, a fixture that predates it — simply omits it, and `undefined !== null` is TRUE. That reading
   * turns EVERY ordinary disconnect into an organizer conflict, which is a brand-new false
   * sentence in the place a false sentence was being removed. It went red on exactly that. */
  const stoodDown = mailboxes.find(
    (m) => m.status === "disabled" && typeof m.disabledReason === "string",
  );
  if (stoodDown) {
    return {
      ...QUIET,
      key: "blocked",
      count: mirrored,
      reason: standDownToken(stoodDown.disabledReason),
      address: stoodDown.address,
    };
  }

  // ── 4. BLOCKED — our own infrastructure is declining to serve it (mail 0029) ────────────
  //
  // Above the error and progress states both. The mailbox is `connected` and has no
  // `errorCode` — that is the entire design of the column — so nothing else on this ladder
  // would notice it; and if a mailbox is not being synced at all, "syncing" is false even
  // when a second mailbox happens to be growing the mirror.
  //
  // THE TEST IS `syncBlockedSince !== null`, AND IT IS NOT THE FIELD IT LOOKS LIKE IT SHOULD BE.
  //
  // This line used to read `m.syncBlockedReason !== null` with a comment saying the test is
  // `!== null` and NOT `isSyncBlockReason` — the right rule, aimed one field to the left. The
  // server NARROWS the reason to the closed set and forwards the timestamp UNCONDITIONALLY, so a
  // server that grows a fourth reason emits `{syncBlockedReason: null, syncBlockedSince: <ts>}` —
  // the narrowing has already happened by the time it reaches us, and refusing to narrow again
  // here bought nothing because there was nothing left to narrow. Gating on the reason gave that
  // mailbox silence, which is exactly what this column was added to end.
  //
  // A timestamp is also the safer predicate to have chosen: it cannot carry a server-authored
  // token, so the generic copy below is authored here and nowhere else.
  //
  // COMPLETE only because `reason non-null ⇒ since non-null` — an audit of the server found five
  // writers, each setting and clearing both columns in one statement, and no CHECK enforcing it.
  const blocked = live.find((m) => m.syncBlockedSince !== null);
  if (blocked) {
    return {
      ...QUIET,
      key: "blocked",
      clock: true,
      count: mirrored,
      reason: isSyncBlockReason(blocked.syncBlockedReason) ? blocked.syncBlockedReason : null,
      address: blocked.address,
      minutes: minutesSince(blocked.syncBlockedSince, now),
    };
  }

  // ── 5. MAILBOX ERROR — the mailbox itself refused us ───────────────────────────────────
  //
  // Above the progress states because a mailbox in `error` is quarantined and earning a
  // backoff: whatever the mirror is doing, THIS mailbox is contributing nothing to it.
  const failed = live.find((m) => m.status === "error");
  if (failed) {
    return {
      ...QUIET,
      key: "mailboxError",
      count: mirrored,
      errorCode: failed.errorCode ?? "unknown",
      address: failed.address,
    };
  }

  // ── 6. NO MAILBOX — the probe answered, and there are none ─────────────────────────────
  //
  // Reachable only because `mailboxes` is known to be non-null. Nothing can arrive, and no
  // amount of waiting changes that, so the two progress states below would both be false.
  if (live.length === 0) return { ...QUIET, key: "noMailbox" };

  const connected = live.filter((m) => m.status === "connected");
  if (connected.length === 0) return QUIET;

  // ── 2. IMPORTING — the mirror is growing ───────────────────────────────────────────────
  //
  // Above `awaiting` by construction (`awaiting` requires an empty mirror) and above the
  // Screener pointer, because while mail is still landing "it is all in the Screener" is a
  // claim about a set that is still changing.
  //
  // `now` is the SHELL's clock, beaten every `MAIL_CLOCK_MS` by `MailStateProvider` while
  // `state.clock` is true — which is what ends a latched episode. The reducer only ever runs when
  // the mirror MOVES, so an import that simply stops would otherwise never be told it had.
  if (isImporting(growth, sync.bootstrapping, now)) {
    return { ...QUIET, key: "importing", clock: true, count: mirrored };
  }

  /**
   * HAS ANY CYCLE COMPLETED? The ONE use of `lastSyncAt`, and only as a negative.
   *
   * Sound under BOTH worker defects (see the file header): only ids in `synced` are ever
   * stamped, so a null cannot be somebody else's success and cannot be an early stamp. It
   * means "not one cycle has completed for this mailbox".
   *
   * It is also NECESSARY, not merely safe. A non-null stamp over an empty mirror means a cycle
   * ran and the mailbox is genuinely empty — which must be QUIET (the ordinary empty pane),
   * not "waiting for the first sync" for ever.
   *
   * ── `every` AND NOT `some`, AND THE LIMIT THAT BUYS ─────────────────────────────────────
   *
   * With two mailboxes where one has synced and one never has, `every` is false and the strip
   * stays quiet about the young one. Deliberate, and the division is: the STRIP makes
   * account-wide statements; a per-mailbox statement belongs on the per-mailbox ROW
   * (`(product)/mailbox/MailboxSection.tsx`, in this slice, from this same state). `some`
   * would put "nothing has arrived" over a mirror already full of mail from the other
   * mailbox — a new false claim rather than a missing true one.
   */
  const noCycleYet = connected.every((m) => m.lastSyncAt === null);

  // ── 1. AWAITING — connected, and nothing at all has arrived ────────────────────────────
  //
  // The state the dead string was shown for, and it is often CORRECT. What was wrong was
  // saying it alone, for ever, and saying it while the mirror grew. It carries the elapsed
  // minutes so it cannot be mistaken for a frozen spinner, and escalates past
  // `AWAITING_SLOW_MS` — to a plainer sentence, never to a claim that something failed.
  if (noCycleYet && mirrored === 0) {
    const since = earliest(connected.map((m) => m.createdAt));
    return {
      ...QUIET,
      key: "awaiting",
      clock: true,
      address: connected.length === 1 ? connected[0]!.address : null,
      minutes: minutesSince(since, now),
      slow: since !== null && now - new Date(since).getTime() >= AWAITING_SLOW_MS,
    };
  }

  // ── 3. THE SCREENER POINTER — a candidate, for the OHBOX to finish ─────────────────────
  //
  // Mail has landed, the mirror is settled and nothing above matched. `mirrored > 0` is
  // load-bearing rather than defensive: without it an account that has never received
  // anything would offer to explain where its mail went.
  return { ...QUIET, count: mirrored, screenerCandidate: mirrored > 0 };
}

/**
 * The states the SHELL STRIP renders, in every view.
 *
 * `screenerCandidate` is not among them and never can be — it is not a key. The strip renders
 * account-wide truths; the one view-level truth is finished by the view that owns the fact.
 * Neither surface may re-derive anything.
 */
export function stripSpeaks(key: MailStateKey): boolean {
  return key !== "quiet";
}
