/**
 * A1 — WHAT IS HAPPENING TO MY MAIL, SAID IN SIX WAYS INSTEAD OF ONE WRONG WAY.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * The product had exactly ONE sentence for every state a first sync can be in:
 * `mailboxes.syncPending`, "Waiting for first sync", rendered by a spinner in Settings →
 * Mailboxes whenever `lastSyncAt` was null. Measured on the agent's own account on
 * 2026-08-03: it was on screen for THIRTY MINUTES while 495 messages arrived, still climbing
 * at 27 messages per 20 seconds when checked. It is not merely unhelpful — it is the only
 * thing the product says during the period in which it is working hardest, and it kept
 * saying it after mail WAS flowing.
 *
 * ── WHY `lastSyncAt` CANNOT BE THE PROGRESS SIGNAL, IN EITHER DIRECTION ─────────────────
 *
 * Two things were read out of the worker rather than assumed, and each one on its own
 * disqualifies the column:
 *
 *  · **It is shared.** `stampMailboxSync` (`apps/worker/src/mailboxes.ts:979-984`) is ONE
 *    `UPDATE … WHERE id IN (…)` for every mailbox the cycle served. Both production mailbox
 *    rows were read on 2026-08-03 and reported an IDENTICAL 207 seconds of age, so the column
 *    cannot distinguish one mailbox's progress from another's.
 *  · **It lands EARLY.** `apps/worker/src/index.ts:1281` pushes the mailbox into `synced`
 *    after each successful cycle *whether or not* `hasBacklog` is true. So a mailbox
 *    thirty seconds into a thirty-minute import already carries a stamp.
 *
 * And separately it lands LATE: the first attach was measured at 358 s and again at 373 s for
 * a 1 712-message mailbox, twice, in production, and attaches are serial — so a second
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
 * `SyncBar.tsx` records that P17's failure sentence was found three times, because each fix
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
 * A CLOSED set with a CHECK constraint behind it, owned by
 * `packages/db/src/mailbox-errors.ts` → `MAILBOX_SYNC_BLOCK_REASONS`. It is re-declared here
 * rather than imported for the same reason `api-client.ts` re-declares `errorCode`: this
 * module ships in the Desktop mirror (`scripts/publish-desktop.mjs` DENYs `packages/db`), so
 * an import would break a build that has no server in it at all.
 *
 * Re-declaring a closed set is how the two drift, and A0b's brief names the exact failure it
 * produced once already: a fourth `status` value would have rendered the literal key path
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
 * ONE mailbox, as the shared shell is allowed to know it.
 *
 * Structural and shell-owned, NOT `MailboxDTO`. `apps/webapp/app/api-client.ts` is DENYd from
 * the Desktop mirror, so this file may not name its types; and narrowing to the six fields the
 * ladder reads is the honest declaration of what the derivation is entitled to consult.
 * Anything the Cloud client can see and this interface does not name is a fact the copy may
 * not assert.
 */
export interface MailboxFacts {
  address: string;
  /** The 3-member lifecycle union, widened to `string` because the wire is a string. */
  status: string;
  /** Null unless `status === 'error'`. A stable key; the wording lives in `messages/*.json`. */
  errorCode: string | null;
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
 * A DURATION and not a count of polls, for the reason A0b's `syncBlockGraceMs` is one: a count
 * is a proxy for time that silently retunes the moment `POLL_MS` changes.
 */
export const GROWTH_WINDOW_MS = 30_000;

/**
 * How much a run of rises must add before it is called an IMPORT rather than the post.
 *
 * Without this the strip appears for one decay window every time any mail arrives, on every
 * busy morning, for ever — which is precisely the "permanent chrome nobody reads" that
 * `SyncBar.tsx` was built to avoid. Twenty-five messages is crossed in ~19 s at the measured
 * import rate (27 messages / 20 s) and is not crossed by a thread burst.
 *
 * It is only ONE of three ways in — see {@link isImporting}. The first import of a mailbox
 * does not have to reach it, because an episode that starts from an EMPTY mirror is
 * unambiguous.
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
}

/**
 * The seed. `lastRiseAt: -Infinity` and not `Date.now()`, deliberately.
 *
 * The mirror persists into IndexedDB, so a tab that opens onto a settled mailbox starts at
 * 495 rather than at 0. Seeding the clock with "now" would make the next arrival look like the
 * second rise of a run that never had a first, so every reload of a healthy mailbox would
 * announce an import. `-Infinity` makes the first rise unambiguously a first rise.
 */
export function seedGrowth(count: number): MirrorGrowth {
  return { count, lastRiseAt: -Infinity, rises: 0, runStartCount: count };
}

/**
 * Fold one observation of the mirror's size in.
 *
 * A FALL — a delete, a move out of the mirror — moves the baseline and touches nothing else.
 * It is not a rise, and it is not evidence that the previous rise did not happen.
 */
export function growthStep(prev: MirrorGrowth, count: number, now: number): MirrorGrowth {
  if (count === prev.count) return prev;
  if (count < prev.count) return { ...prev, count };
  const continues = now - prev.lastRiseAt <= GROWTH_WINDOW_MS;
  return {
    count,
    lastRiseAt: now,
    rises: continues ? prev.rises + 1 : 1,
    // A new run starts from the count BEFORE this rise — so a run that begins on an empty
    // mirror has `runStartCount === 0`, which is what identifies a first import.
    runStartCount: continues ? prev.runStartCount : prev.count,
  };
}

/** Two rises, the second of them recent. Nothing else counts as growth. */
export function isGrowing(g: MirrorGrowth, now: number): boolean {
  return g.rises >= 2 && now - g.lastRiseAt < GROWTH_WINDOW_MS;
}

/**
 * Is this growth an IMPORT worth interrupting the screen for? Three ways in, all client facts:
 *
 *  1. the run started on an EMPTY mirror — a first import, the A1 defect itself;
 *  2. the tab's first drain has not completed — P16: a new device repopulating its mirror;
 *  3. the run has added {@link IMPORT_MIN_DELTA} or more — a mid-import stall that resumed at
 *     count 300 is still an import, and this is the only arm that can see it.
 *
 * Not one of them reads a timestamp the server wrote. That is WORKLIST.md:510 verbatim.
 */
export function isImporting(g: MirrorGrowth, bootstrapping: boolean, now: number): boolean {
  if (!isGrowing(g, now)) return false;
  return g.runStartCount === 0 || bootstrapping || g.count - g.runStartCount >= IMPORT_MIN_DELTA;
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
 *                     syncs, never on a stamp. Counts, never a percentage.
 *  3. `screenerOnly`  emitted as {@link MailState.screenerCandidate}, not as a key: mail has
 *                     landed, the mirror is settled and nothing is wrong. The OHBOX pane
 *                     combines it with its own emptiness — a fresh account is mostly Screener
 *                     by design, so this is where an empty Ohbox is CORRECT and needs saying.
 *  4. `blocked`       our own infrastructure is declining to serve the mailbox
 *                     (`syncBlockedReason`, mail 0029). The UI half of A0b.
 *  5. `mailboxError`  the mailbox itself refused us (`status === 'error'`, `errorCode`).
 *  6. `noMailbox`     the probe answered, and there are none. Distinct from "we cannot see".
 *
 * ── AND THE TWO THAT ARE NOT A1'S ───────────────────────────────────────────────────────
 *
 * `stopped` and `failing` are P17's, unchanged, and they OUTRANK all six. The reason is the
 * rule `OhboxView`'s counter already followed and this one inherits: once the drains are
 * failing the mirror count is FROZEN, so every claim below about growth is a claim about a
 * number that cannot move. A frozen counter is the same lie in a new font.
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
   * `blocked` only. A member of {@link SYNC_BLOCK_REASONS}, or `null` when the server sent a
   * reason this build does not know — the state still fires, with generic copy. Silence would
   * re-create mail 0029's "unobservable by design" one layer up.
   */
  reason: SyncBlockReason | null;
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
};

/**
 * When a first import has taken longer than one is measured to take.
 *
 * TEN minutes, and the number is set against a measurement rather than a feeling:
 * `mailbox_attach_started → mailbox_attached` took 358 s and 373 s for a 1 712-message
 * mailbox, twice, in production. So SIX minutes with an empty mirror is NORMAL, and escalating
 * at three would dress a healthy large-mailbox import as a fault — the opposite defect to the
 * one this slice fixes, and just as false. Attaches are serial, so a second mailbox waits
 * behind the first; ten leaves room for that.
 *
 * **It must stay under the `syncLag` alert threshold (15 minutes,
 * `packages/db/src/alerts.ts`), and `mail-state.test.ts` asserts that against the real
 * constant.** This is A0b's `syncBlockGraceMs < syncLagMs` argument one layer up: if we page
 * ourselves before the screen has escalated, the user is again the last to know — which is
 * exactly the 32 minutes of 2026-08-03.
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
  /** `useSyncStatus()` — what the tab's own drain loop is doing. */
  sync: { bootstrapping: boolean; failures: number; terminal: boolean };
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
 * WHAT TO SAY, from what the client can see. Pure. First match wins.
 *
 * The order below is PRECEDENCE and is deliberately not the order the states are numbered in.
 * Each step says why it outranks the next.
 */
export function deriveMailState(input: MailStateInputs): MailState {
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
  if (sync.failures >= failureStreak) return { ...QUIET, key: "failing" };

  // "We cannot see mailboxes" — not "there are none". Everything from here reads them.
  if (mailboxes === null) return QUIET;

  const live = mailboxes.filter((m) => m.status !== "disabled");

  // ── 4. BLOCKED — our own infrastructure is declining to serve it (mail 0029) ────────────
  //
  // Above the error and progress states both. The mailbox is `connected` and has no
  // `errorCode` — that is the entire design of the column — so nothing else on this ladder
  // would notice it; and if a mailbox is not being synced at all, "syncing" is false even
  // when a second mailbox happens to be growing the mirror.
  //
  // The test is `!== null`, NOT `isSyncBlockReason`. A server that grows a fourth reason must
  // get generic copy, not silence: narrowing here would restore exactly the invisibility this
  // column was migrated to end.
  const blocked = live.find((m) => m.syncBlockedReason !== null);
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
   * would put "nothing has arrived" over a mirror holding 1 700 messages from the other
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
