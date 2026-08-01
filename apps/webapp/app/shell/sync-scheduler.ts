import type { OhmailEngine } from "@ohmail/client-engine";

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
 * It is deliberately not part of `OhmailEngine`. The engine owning no timers is what makes
 * `engine.tsx`'s mode-change teardown correct — a live→demo navigation drops the reference
 * and there is nothing to cancel. Scheduling lives with the thing that has a lifecycle to
 * hang it on, which is the React effect.
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
}

/** A live engine before its first tick, and the permanent value for the demo. */
export const SYNC_SETTLED: SyncStatus = { bootstrapping: false, failures: 0 };
export const SYNC_BOOTSTRAPPING: SyncStatus = { bootstrapping: true, failures: 0 };

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
 * Full jitter (`random() * ceiling`), not `ceiling` and not `ceiling/2 + jitter`.
 *
 * The ceiling doubles whether or not the draw is small, so a run of low draws cannot become
 * a tight loop — it can only spend the first few (sub-second) steps quickly. What full jitter
 * buys is that N tabs, or N accounts knocked offline by the same upstream blip, do not come
 * back in a synchronised wave at t+1s, t+2s, t+4s.
 */
export function backoffDelay(
  failures: number,
  opts: { base?: number; cap?: number; random?: () => number } = {},
): number {
  const base = opts.base ?? BACKOFF_BASE_MS;
  const cap = opts.cap ?? BACKOFF_CAP_MS;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(base * 2 ** Math.max(0, failures - 1), cap);
  return Math.floor(random() * ceiling);
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
 * That gate covers the FIRST drain too, hydration included. A tab that mounts hidden holds an
 * empty shell nobody is looking at until the moment somebody looks, which is the point.
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

  // No `document` at all (SSR, a non-browser host) is treated as visible: the gate exists to
  // stop hidden TABS, and something with no visibility model has none to hide.
  const visible = (): boolean => visibility === null || visibility.visibilityState === "visible";

  const publish = (): void => {
    if (stopped) return;
    options.onStatus?.({ bootstrapping, failures });
  };

  const disarm = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const arm = (ms: number): void => {
    disarm();
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  async function tick(): Promise<void> {
    if (stopped || running) return;
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
      }
      await engine.syncOnce();
      if (stopped) return;
      failures = 0;
      bootstrapping = false;
      arm(pollMs);
    } catch (err) {
      if (stopped) return;
      failures += 1;
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
    if (stopped || running) return;
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
