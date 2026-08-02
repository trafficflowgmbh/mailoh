import {
  MutationRejectedError,
  type EngineAdapter,
  type MutationOutcome,
  type OhmailEngine,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * P16 — THE WAKE SIGNAL THIS APP DID NOT HAVE.
 *
 * `EngineProvider` used to call `engine.start()` once and that was every drain the tab would
 * ever perform. Three failures followed from the one omission, all of them observed against
 * production: new mail never arrived without a manual reload; a single transient throw left a
 * permanently empty mailbox, because there was no second attempt; and a ~37-page bootstrap
 * spent twelve to fifteen seconds rendering "0 unread of 0", which is indistinguishable from
 * a broken account.
 *
 * ── WHY A POLL AND NOT AN EventSource ───────────────────────────────────────────────────
 *
 * `/events` exists and the engine has `attachWakeSignal()` for exactly this. It is not used
 * here because SSE is OFF in production: the Cloud API's own default for it is `false` and
 * the `TF_SSE` that would turn it on is absent from the deployed environment. (An
 * unauthenticated `GET /events` answers 401 rather than 503, because the route reads the
 * session before it checks the flag — so probing it proves nothing about whether it is on.)
 *
 * The cost shape also favours polling for this product. A visible tab is ~450 short `/sync`
 * calls an hour; one SSE connection is sixty minutes of open serverless function per hour,
 * multiplied by the per-account connection cap, and billed for abandoned tabs too. Polling
 * scales with attention, which is invariant #10's whole argument. SSE stays behind `TF_SSE`
 * for after the beta.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────────────────
 *
 * It is deliberately not part of `OhmailEngine`. Scheduling lives with the thing that has a
 * lifecycle to hang it on, which is the React effect.
 *
 * This used to add "and the engine owns no timers, so a live→demo navigation drops the reference
 * and there is nothing to cancel". That was the false half, and it cost two critical findings:
 * `syncOnce()` pages internally until `hasMore` is false, so a discarded engine can very much
 * have a ~37-page drain running inside it, and dropping the reference cancels none of it. What
 * makes the teardown correct is now {@link SyncGate}, which refuses the next page — see the
 * block above it.
 *
 * It is also not in `engine.tsx`. That file is a `"use client"` React module, and a loop
 * whose contract is "a hidden tab issues zero requests" has to be driven by fake timers to be
 * believed. Same reason `engine-config.ts` was carved out of the same file, and its header
 * says so: a structural assertion proves the code SAYS the right thing, not that it does it.
 */

/** What the shell may tell the user about the sync loop. Nothing else is exposed. */
export interface SyncStatus {
  /** No drain has yet completed for this engine — the mirror on screen may be partial. */
  bootstrapping: boolean;
  /** Consecutive failed drains. Zero after any success. */
  failures: number;
  /**
   * The loop has STOPPED and will not retry: the server refused this session in a way no
   * amount of waiting fixes (a revoked or deleted account, a 401/403). Distinct from
   * `failures > 0`, which is a mailbox that is still being retried.
   */
  terminal: boolean;
}

/** A live engine before its first tick, and the permanent value for the demo. */
export const SYNC_SETTLED: SyncStatus = { bootstrapping: false, failures: 0, terminal: false };
export const SYNC_BOOTSTRAPPING: SyncStatus = { bootstrapping: true, failures: 0, terminal: false };

/**
 * Eight seconds, and only while the tab is visible.
 *
 * Short enough that mail arriving while somebody is reading feels present, long enough that
 * a person who leaves the app open all day costs ~450 requests an hour rather than a
 * connection held open for sixty minutes of billed function time.
 */
export const POLL_MS = 8_000;
/** First retry ceiling. Doubles per consecutive failure. */
export const BACKOFF_BASE_MS = 1_000;
/**
 * The degraded steady state, not an exhaustion point. A visible tab keeps retrying at up to
 * a minute apart forever: "gave up" is a state a mail client must never enter silently, and
 * the alternative to a slow retry is a mailbox that stays wrong until someone reloads.
 */
export const BACKOFF_CAP_MS = 60_000;

/**
 * The smallest delay any retry may draw, whatever the jitter says. See {@link backoffDelay}.
 */
export const BACKOFF_MIN_MS = 250;
/**
 * The floor as a fraction of the current ceiling. A quarter keeps the useful half of full
 * jitter (a wide, decorrelated window) while making the floor grow with the outage.
 */
export const BACKOFF_FLOOR_RATIO = 0.25;

/**
 * Jitter over a doubling ceiling, with a FLOOR — `floor + random() * (ceiling - floor)`.
 *
 * ── WHY THE ZERO FLOOR HAD TO GO ─────────────────────────────────────────────────────────
 *
 * This was plain full jitter, `random() * ceiling`, and the comment claimed "a run of low draws
 * cannot become a tight loop — it can only spend the first few (sub-second) steps quickly".
 * That is false at the far end, which is the end that matters. The floor was zero at EVERY
 * ceiling, so a permanently failing drain sitting at the 60-second cap could still draw 0 ms,
 * and again, and again: the expected delay is 30 s but nothing bounds a run of small draws, and
 * the ceiling never becomes a minimum. With a permanent `410 CursorExpired` each drain costs
 * two requests (the engine re-bootstraps once, then surfaces the second), so the degraded state
 * a mail client is supposed to be able to sit in forever could instead spin at whatever rate
 * the network allows — invariant #10, paid for by an abandoned tab.
 *
 * The floor is `max(250 ms, ceiling / 4)`, so the window widens with the outage: [250 ms, 1 s]
 * at the first failure, [15 s, 60 s] at the cap. What full jitter buys is kept — N tabs, or N
 * accounts knocked offline by the same upstream blip, still do not come back in a synchronised
 * wave — because the draw is still spread across three quarters of the ceiling.
 */
export function backoffDelay(
  failures: number,
  opts: { base?: number; cap?: number; random?: () => number; min?: number } = {},
): number {
  const base = opts.base ?? BACKOFF_BASE_MS;
  const cap = opts.cap ?? BACKOFF_CAP_MS;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(base * 2 ** Math.max(0, failures - 1), cap);
  const floor = Math.min(ceiling, Math.max(opts.min ?? BACKOFF_MIN_MS, ceiling * BACKOFF_FLOOR_RATIO));
  return Math.floor(floor + random() * (ceiling - floor));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ABORTING A DRAIN BETWEEN PAGES
   ══════════════════════════════════════════════════════════════════════════════════════════

   `engine.syncOnce()` is not one request. It loops internally while `hasMore` is true, and a
   cold Cloud account's first drain is ~37 pages. The visibility gate below decides whether a
   drain STARTS; nothing decided whether it CONTINUES, so hiding or closing a tab thirty seconds
   into a bootstrap left every remaining page to be issued anyway — a background tab issuing
   paid `/sync` calls, which is the one thing invariant #10 says must not happen. Teardown had
   the same hole: `stopped` stops the timer, not the loop already inside the engine.

   The page boundary is the ENGINE'S TRANSPORT — `adapter.sync()`, called once per page — so
   that is where the check belongs. A gate wraps the adapter at construction and refuses the
   next page while the tab is hidden or the scheduler is gone; the refusal throws out of
   `drain()` and the loop stops with the pages it already applied persisted, exactly as a
   network failure mid-drain already does. The cursor is per-page, so the next drain resumes
   rather than restarts.

   `mutate()` is DELIBERATELY NOT GATED. A mutation is the user's own intent and must reach the
   server whatever the tab is doing; the cost objection is about polling, not about the click
   somebody just made. */

/**
 * A drain was cancelled between pages. Not a failure: it must not count against the backoff,
 * must not be reported as an error, and must not arm a retry — the wake that follows the tab
 * coming back is what resumes it.
 */
export class SyncAbortedError extends Error {
  readonly code = "sync_aborted";
  constructor(reason: string) {
    super(`ohmail: sync aborted before the next page (${reason})`);
    this.name = "SyncAbortedError";
  }
}

const isAborted = (err: unknown): err is SyncAbortedError => err instanceof SyncAbortedError;

/**
 * The per-page continuation gate. Built beside the engine's adapter, claimed by the scheduler.
 *
 * A gate NOBODY has claimed never refuses, so the demo engine, the desktop bundle and a bare
 * `engine.start()` are unaffected — the gate only ever narrows a surface a scheduler is
 * actively driving.
 */
export interface SyncGate {
  /** Wrap the engine's transport. Call once, at construction, on the adapter you pass in. */
  guard(adapter: EngineAdapter): EngineAdapter;
  /**
   * Claim the gate for a scheduler's lifetime. There is deliberately no `release`: the
   * predicate a scheduler installs closes ITSELF once that scheduler is stopped (it reads the
   * scheduler's own `stopped` flag), so a teardown aborts its in-flight drain instead of
   * un-gating it. A remount simply claims again and its fresh predicate takes over.
   */
  claim(mayContinue: () => boolean): void;
}

export function createSyncGate(): SyncGate {
  let mayContinue: (() => boolean) | null = null;
  return {
    claim(next) {
      mayContinue = next;
    },
    guard(adapter) {
      return {
        // Kept reachable so "the live engine talks HTTP, the demo talks fixtures" stays an
        // assertion a test can make about the ENGINE rather than about this wrapper —
        // `engine-armed.test.ts` and `demo-zero-network.test.ts` both check exactly that, and a
        // gate that hid the transport would have quietly turned their control cases into
        // tautologies. See {@link transportOf}.
        transport: adapter,
        sync: async (params: SyncParams): Promise<SyncResponse> => {
          if (mayContinue && !mayContinue()) {
            throw new SyncAbortedError("the tab is hidden or its sync loop was torn down");
          }
          return adapter.sync(params);
        },
        mutate: (m, opts): Promise<MutationOutcome> => adapter.mutate(m, opts),
      } satisfies EngineAdapter & { transport: EngineAdapter };
    },
  };
}

/** The real transport behind a gate, or the adapter itself when it was never wrapped. */
export function transportOf(adapter: unknown): unknown {
  return (adapter as { transport?: unknown } | null)?.transport ?? adapter;
}

/**
 * Which gate belongs to which engine.
 *
 * The gate has to be built BEFORE the engine (it wraps the adapter the constructor takes) and
 * is needed AFTER it (the scheduler claims it), and `OhmailEngine` keeps its adapter private —
 * correctly; `packages/client-engine` is not the place to know about tabs. A `WeakMap` beside
 * the scheduler keeps the association without widening either boundary or threading the gate
 * through `createEngine`'s return type and every caller of it. Weak, so an abandoned engine and
 * its gate are collected together.
 */
const GATES = new WeakMap<OhmailEngine, SyncGate>();

/** Register the gate an engine was built with, and hand the engine back. */
export function registerSyncGate(engine: OhmailEngine, gate: SyncGate): OhmailEngine {
  GATES.set(engine, gate);
  return engine;
}

/** The two globals this loop reads, narrowed so a test can hand it neither. */
interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
interface OnlineSource {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

export interface SyncSchedulerOptions {
  /** Called on every settled tick and on the first one, with the value the UI renders. */
  onStatus?: (status: SyncStatus) => void;
  pollMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  random?: () => number;
  /** Defaults to `document` / `window`; `null` means "this environment has neither". */
  visibility?: VisibilitySource | null;
  online?: OnlineSource | null;
  /** Where a failed drain is reported. Defaults to `console.error`. */
  report?: (message: string, err: unknown) => void;
  /**
   * The engine's per-page abort gate. Defaults to the one `createEngine` registered for this
   * engine; pass it explicitly in a test that builds its own engine.
   */
  gate?: SyncGate | null;
}

/**
 * Is this refusal PERMANENT — will no retry ever succeed?
 *
 * The adapter already knows: `HttpAdapter.rejectionOf` reads the wire's `retryable`, defaulting
 * to `status >= 500 || status === 429`, so a 401 or 403 arrives as `retryable: false` and the
 * loop ignored it. "Never gives up while the tab is visible" is the right rule for a mailbox
 * that is merely unreachable and the wrong one for a session that has been revoked or an
 * account that has been deleted: that tab can no longer be served AT ALL, and every retry it
 * makes is an invocation billed against an account with no entitlement behind it (#10).
 *
 * Anything that is not a typed refusal — a network error, a parse failure, an unknown throw —
 * stays retryable. Terminal is a positive claim, made only when the server made it.
 */
function isTerminalRefusal(err: unknown): boolean {
  return err instanceof MutationRejectedError && err.retryable === false;
}

/**
 * Start the sync loop for one engine. Returns the teardown.
 *
 * ── ONE TIMER, ARMED ONLY AFTER THE PREVIOUS DRAIN HAS SETTLED ──────────────────────────
 *
 * `setInterval` is the trap the Cloud API's `/events` route documents for the server side and
 * it is the same trap here: under latency the ticks stack, and what you get is not a faster
 * sync but a queue of drains that each observe a cursor the one before them was about to
 * move. This loop awaits the drain and only then arms the next timeout, so the cadence is
 * "eight seconds of quiet", never "eight seconds since the last attempt began".
 *
 * ── A HIDDEN TAB PERFORMS ZERO SYNCS ────────────────────────────────────────────────────
 *
 * Not "fewer" and not "cheaper ones": the timer is disarmed and no request is issued, because
 * a background tab that keeps a mailbox warm is API cost with no revenue attached to it
 * (invariant #10). Coming back is instant — `visibilitychange` drains immediately rather than
 * waiting out a period — and so is regaining the network, via `online`.
 *
 * It is asked at all THREE points where the answer can have changed, which is the correction
 * this loop needed: before a drain starts, again after hydration's await and before the first
 * request, and — via {@link SyncGate} — before every page of a drain already in flight. The
 * middle one covers a tab that mounts visible and is hidden while IndexedDB opens; the last one
 * covers the ~37-page bootstrap that used to run to completion behind a tab nobody was looking
 * at. The same predicate also reads `stopped`, so teardown cancels rather than merely stops
 * caring: a live→demo navigation aborts the discarded live engine's drain instead of letting it
 * finish paging from behind a page that promises zero egress (invariants #6 and #8).
 *
 * ── EVERYTHING FUNNELS THROUGH `syncOnce()` ─────────────────────────────────────────────
 *
 * Its single-flight (`engine.ts`) returns the in-flight promise to a second caller, so a wake,
 * a retry and a mutation's read-your-writes drain can never stack into two concurrent
 * `/sync` requests. The 410 re-bootstrap stays where it belongs, inside the engine's own
 * `drain()`; this loop never touches the cursor and never calls `resetForBootstrap`.
 *
 * `store.load()` is the one thing here that is not `syncOnce()`. It is the other half of
 * `engine.start()`, split out because the retry path must not re-read the whole IndexedDB
 * mirror on every backoff step while the network is down.
 */
export function startSyncScheduler(
  engine: OhmailEngine,
  options: SyncSchedulerOptions = {},
): () => void {
  const pollMs = options.pollMs ?? POLL_MS;
  const base = options.backoffBaseMs ?? BACKOFF_BASE_MS;
  const cap = options.backoffCapMs ?? BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  const report = options.report
    ?? ((message: string, err: unknown) => { console.error(message, err); });
  const visibility = options.visibility !== undefined
    ? options.visibility
    : (typeof document === "undefined" ? null : document);
  const online = options.online !== undefined
    ? options.online
    : (typeof window === "undefined" ? null : window);

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A drain is in flight. Guards the timer arithmetic, not the request — see `syncOnce()`. */
  let running = false;
  let hydrated = false;
  let bootstrapping = true;
  let failures = 0;
  /** Set once, by a refusal no retry can fix. The loop never runs again after it. */
  let terminal = false;

  // No `document` at all (SSR, a non-browser host) is treated as visible: the gate exists to
  // stop hidden TABS, and something with no visibility model has none to hide.
  const visible = (): boolean => visibility === null || visibility.visibilityState === "visible";

  /**
   * "May a request be issued right now?" — the ONE predicate, read at every await boundary.
   *
   * `tick()` checked it once, before an `await` that can last as long as an IndexedDB open, and
   * the engine's page loop never checked it at all. Both holes are the same missing question.
   */
  const mayRequest = (): boolean => !stopped && !terminal && visible();

  // The gate refuses the engine's NEXT page whenever this scheduler would refuse a new drain.
  // Claimed and never released: the predicate closes itself via `stopped`, so a torn-down
  // scheduler cancels the drain it left behind rather than freeing it to keep paging.
  const gate = options.gate !== undefined ? options.gate : (GATES.get(engine) ?? null);
  gate?.claim(mayRequest);

  const publish = (): void => {
    if (stopped) return;
    options.onStatus?.({ bootstrapping, failures, terminal });
  };

  const disarm = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const arm = (ms: number): void => {
    disarm();
    if (stopped || terminal) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  async function tick(): Promise<void> {
    if (stopped || running || terminal) return;
    if (!visible()) {
      // Nothing armed while hidden. `visibilitychange` is what restarts the loop.
      disarm();
      return;
    }
    running = true;
    try {
      if (!hydrated) {
        await engine.store.load();
        hydrated = true;
        // ── RE-ASK AFTER THE AWAIT, BEFORE THE FIRST PAID REQUEST ──────────────────────
        //
        // `store.load()` opens IndexedDB and reads the whole mirror; on a cold, large account
        // that is hundreds of milliseconds to seconds, and it is the ONE await this loop makes
        // before its first `/sync`. Two things could change underneath it and neither was
        // re-checked:
        //
        //  · the tab was hidden while it ran — so a tab nobody ever looked at still issued a
        //    paid drain, and my "0 syncs while hidden" measurement could not have caught it
        //    because it was taken on an already-hydrated tab (invariant #10);
        //  · the scheduler was TORN DOWN — a live→demo navigation swaps the engine and runs
        //    this cleanup, and the discarded LIVE engine then called `/sync` from behind a
        //    page whose whole promise is that nothing leaves the tab (invariants #6 and #8).
        //
        // Hydration is kept (`hydrated` stays true) — the mirror is loaded and re-reading it
        // on the next wake would be pure waste. Only the REQUEST is withheld.
        if (!mayRequest()) {
          disarm();
          return;
        }
      }
      await engine.syncOnce();
      if (stopped) return;
      failures = 0;
      bootstrapping = false;
      arm(pollMs);
    } catch (err) {
      if (stopped) return;
      if (isAborted(err)) {
        // The gate cancelled this drain between pages, because the tab went away. Not a
        // failure: no count, no report, no retry armed. `visibilitychange` resumes from the
        // cursor the applied pages already advanced.
        disarm();
        return;
      }
      failures += 1;
      if (isTerminalRefusal(err)) {
        // No amount of waiting fixes a revoked session or a deleted account. Stop — and SAY
        // so, rather than going quiet: `terminal` is what lets the shell tell the difference
        // between "your mailbox is having a bad minute" and "this tab can no longer be served".
        terminal = true;
        disarm();
        report("ohmail: this session can no longer sync — sign in again", err);
        return;
      }
      // AUDIBLE, EVERY TIME. The predecessor of this loop swallowed the first rejection and
      // called it "the HTTP path retries on the next wake signal", with no wake signal in the
      // app — one throw, no request, no console entry, no error state.
      report(`ohmail: mailbox sync failed (attempt ${failures}) — retrying`, err);
      arm(backoffDelay(failures, { base, cap, random }));
    } finally {
      running = false;
      publish();
    }
  }

  /**
   * A drain NOW: the tab came back, or the network did. Coalesced into any drain in flight.
   *
   * It does NOT re-check visibility. `tick()` owns that decision and there is exactly one
   * copy of it, deliberately: a second `!visible()` here read as belt-and-braces and was
   * dead weight — removing `tick()`'s gate left every hidden-tab assertion in
   * `sync-liveness.test.ts` red, and removing this one left them all green.
   */
  const wake = (): void => {
    if (stopped || running || terminal) return;
    void tick();
  };

  // Going hidden disarms IMMEDIATELY rather than letting the pending timeout fire into a
  // gate that will refuse it. Same request count either way; the difference is that a
  // backgrounded tab holds no timer, which is the property `vi.getTimerCount()` can see.
  const onVisibility = (): void => {
    if (visible()) wake();
    else disarm();
  };

  visibility?.addEventListener("visibilitychange", onVisibility);
  online?.addEventListener("online", wake);

  publish();
  void tick();

  return () => {
    stopped = true;
    disarm();
    visibility?.removeEventListener("visibilitychange", onVisibility);
    online?.removeEventListener("online", wake);
  };
}
