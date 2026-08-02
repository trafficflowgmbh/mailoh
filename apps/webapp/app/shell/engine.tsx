"use client";

/**
 * Engine wiring: ONE OhmailEngine per tab, boots in an effect, and the
 * UI reads it through useSyncExternalStore so every selector recomputes
 * exactly when the mirror (or the optimistic overlay) changes.
 *
 * Demo mode: FixturesAdapter + in-memory mirror — boots instantly, zero
 * network. Stage 2: HttpAdapter + IndexedDB mirror behind
 * NEXT_PUBLIC_API_BASE, same engine, same UI.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { OhmailEngine, type EntityReader } from "@ohmail/client-engine";
import { isDemoRequested } from "../demo-mode";
import { createEngine, EngineUnarmedError } from "./engine-config";
import {
  startSyncScheduler,
  SYNC_BOOTSTRAPPING,
  SYNC_SETTLED,
  type SyncStatus,
} from "./sync-scheduler";

/**
 * "Whose mailbox is this?", as a function the SHELL does not know how to answer.
 *
 * Resolves to a server-verified account id, or `null` for every refusal — expired,
 * revoked, enrollment-scoped, unreachable. It is a PROP rather than an import because this
 * file is shared: `apps/desktop` renders the same `AppShell` from a bundle that has no
 * account, no server and no `/auth` client at all (`scripts/publish-desktop.mjs` DENYs
 * `app/api-client`, and `vite.config.ts` aliases the sync adapter to a stub that throws).
 * Importing the Cloud's session client here would drag both into a tier that must not have
 * them. The Cloud client passes its implementation from `(product)/mailbox/CloudShell.tsx`;
 * the desktop passes nothing and never leaves the demo.
 */
export type OwnerResolver = () => Promise<string | null>;

interface EngineBinding {
  engine: OhmailEngine;
  /** The mode the ENGINE was actually built in — client truth, never the server's guess. */
  demo: boolean;
  /** What the server rendered with, so hydration has a snapshot that matches the markup. */
  serverDemo: boolean;
  /** What the sync loop is doing, for the views that must say so. Always settled in demo. */
  sync: SyncStatus;
}

/**
 * WHAT THIS TAB HAS, and the two states that are not an engine.
 *
 * The live engine can no longer be built at first render, and that is the fix rather than
 * a regression. Its mirror persists into IndexedDB, and a persistent mirror has to be
 * NAMED for the account it holds — `engine-config.ts` explains the cross-account leak that
 * a single un-owned database produced. The account id comes from `GET /auth/session`, which
 * is a network round trip, so between mount and that answer there is no engine and there is
 * nothing honest to render: an empty shell would be a signed-in-looking chrome around a
 * mirror that may belong to somebody else.
 *
 * So the shell WAITS, and then either renders or says why it cannot. The demo is
 * unaffected — it has no account, no persistence and no network, and is still built
 * synchronously in the first-render initializer.
 */
type Binding =
  | { status: "ready"; demo: boolean; engine: OhmailEngine }
  /** Live: the account id has been asked for and has not come back. */
  | { status: "resolving" }
  /** Live: the API would not confirm a full session for this browser. */
  | { status: "unauthenticated" };

const EngineContext = createContext<EngineBinding | null>(null);

/**
 * THE mode decision, taken where the real URL is guaranteed to exist.
 *
 * `serverDemo` is a floor, never a ceiling: the client may turn the demo ON (the server
 * cannot see a query string it was never rendered with — see `app/demo-mode.ts`) and may
 * never turn it OFF (a URL must not be able to downgrade a `NEXT_PUBLIC_DEMO` build into a
 * network client). On the server `window` is absent and the answer is simply `serverDemo`.
 */
function resolveDemo(serverDemo: boolean): boolean {
  if (serverDemo) return true;
  if (typeof window === "undefined") return false;
  return isDemoRequested(window.location.search);
}

export function EngineProvider({
  demo: serverDemo,
  resolveOwner,
  children,
}: {
  demo: boolean;
  resolveOwner?: OwnerResolver;
  children: ReactNode;
}) {
  /**
   * The initializer runs during the FIRST render on each side — which on the client is the
   * hydration render, where `window.location` is already the user's real URL. So the DEMO
   * engine is built from the resolved mode before a single effect (and therefore before a
   * single request) can run: there is no window in which a `?demo=1` page holds an
   * HttpAdapter, and the demo still paints without waiting for anything.
   *
   * The LIVE engine is deliberately not built here. It cannot be: its mirror is named for
   * the account it holds and the account id has not been asked for yet. `"resolving"` is
   * that fact, spelled.
   */
  const [binding, setBinding] = useState<Binding>(() => {
    const demo = resolveDemo(serverDemo);
    return demo ? { status: "ready", demo, engine: createEngine(demo) } : { status: "resolving" };
  });

  // A mode change after mount (a client-side navigation from `/` to `/?demo=1`, or the
  // reverse) must REPLACE the engine, not keep the one built for the other mode. Capturing
  // it once was how a live→demo navigation kept the network engine alive behind a page that
  // says "nothing leaves this tab". Turning the demo OFF drops back to `"resolving"` rather
  // than to a live engine, because the account id has to be re-established before anything
  // may touch persistence again.
  const desired = resolveDemo(serverDemo);
  useEffect(() => {
    if (binding.status === "ready" ? desired === binding.demo : !desired) return;
    // TWO TEARDOWNS, and only one of them is this line's.
    //
    // The engine owns no TIMERS — nothing schedules a drain from inside it, and
    // `attachWakeSignal()` is a hook this app does not use. It can nevertheless be BUSY: a
    // drain pages until `hasMore` is false, which on a cold account is ~37 requests over ten
    // seconds or more. So "replacing the reference is safe because there is nothing running
    // inside the object being dropped" — which is what stood here — was false, and it is
    // exactly how a live→demo navigation kept issuing live `/sync` calls from behind a page
    // that promises zero egress (invariants #6 and #8).
    //
    // The SCHEDULER is where the timer and the two window listeners live, and it is torn down
    // by the effect below rather than by this assignment. Its dependency is `engine`, so React
    // runs that cleanup before the new engine's scheduler starts — and that cleanup now closes
    // the engine's per-page abort gate (`sync-scheduler.ts`), so the in-flight drain stops at
    // its next page boundary. A live→demo navigation cancels the poll AND the drain on the way
    // out; it does not merely stop caring about them.
    setBinding(
      desired ? { status: "ready", demo: true, engine: createEngine(true) } : { status: "resolving" },
    );
  }, [desired, binding]);

  /**
   * ASK WHOSE MAILBOX THIS IS, then build the engine that persists it.
   *
   * {@link OwnerResolver} asks the same question `middleware.ts` already answered before
   * this route was served, and asking it again from the browser is not redundant: the
   * middleware proved a session existed at request time and told the shell nothing about
   * WHO, and the account id is what names the mirror. It is also the honest re-check — a
   * session revoked between the two is a session this tab must not open a mailbox for.
   *
   * Every refusal, and every failure, lands on `"unauthenticated"`. That is a rendered
   * explanation and a link, NOT an automatic redirect: middleware and this call reach the
   * API by different routes (edge → `api.ohmail.app` directly, browser → the `/api` rewrite),
   * so a disagreement between them is possible, and a redirect on disagreement is an
   * infinite loop between `/` and `/`.
   */
  useEffect(() => {
    if (binding.status !== "resolving") return;
    // No resolver ⇒ this build cannot establish an owner, so it cannot open a persistent
    // mailbox. Refusing is the only correct answer; guessing an owner is the bug.
    if (!resolveOwner) {
      setBinding({ status: "unauthenticated" });
      return;
    }
    let cancelled = false;
    void resolveOwner()
      .then((owner) => {
        if (cancelled) return;
        if (typeof owner !== "string" || owner === "") {
          setBinding({ status: "unauthenticated" });
          return;
        }
        setBinding({ status: "ready", demo: false, engine: createEngine(false, undefined, owner) });
      })
      .catch((err: unknown) => {
        // A build with no API base is NOT "we could not prove who you are" — it is a broken
        // deployment, and rendering the session screen for it would be the same silent lie
        // `EngineUnarmedError` exists to end: a signed-in user told their session expired
        // when the truth is that this bundle was never wired to a server. Let it escape to
        // the error boundary and the console instead of dressing it as an auth outcome.
        if (err instanceof EngineUnarmedError) throw err;
        if (!cancelled) setBinding({ status: "unauthenticated" });
      });
    return () => {
      cancelled = true;
    };
  }, [binding.status, resolveOwner]);

  /**
   * What the sync loop is doing. Only a LIVE engine ever moves it off its resting value —
   * the demo drains once, from fixtures, and has nothing to report.
   *
   * The updater returns `prev` when nothing changed, which is a bail-out rather than a
   * micro-optimisation: a healthy tab settles a drain every eight seconds forever, and
   * without it every one of those would re-render the whole shell to publish a value
   * identical to the one already on screen.
   */
  const [sync, setSync] = useState<SyncStatus>(SYNC_BOOTSTRAPPING);
  const onSyncStatus = useCallback((next: SyncStatus) => {
    setSync((prev) =>
      prev.bootstrapping === next.bootstrapping && prev.failures === next.failures ? prev : next,
    );
  }, []);

  const engine = binding.status === "ready" ? binding.engine : null;
  const live = binding.status === "ready" && binding.demo === false;
  useEffect(() => {
    if (!engine) return;
    /**
     * THE WAKE SIGNAL, AND WHY IT IS HERE RATHER THAN IN A PROP.
     *
     * This was one `engine.start()` and nothing else — the only drain the tab would ever
     * perform. The comment that stood here reported a failed first drain to the console and
     * called that "deliberately only the first half", on the reasoning that the HTTP path
     * would retry on the next wake signal. There was no next wake signal: no EventSource, no
     * interval, no `visibilitychange`, nothing. So one throw produced a permanently empty
     * mailbox, new mail never arrived without a manual reload, and a thirty-seven page
     * bootstrap rendered "0 unread of 0" for twelve to fifteen seconds. All three shipped.
     *
     * `sync-scheduler.ts` is the second half: a serialized poll while the tab is visible,
     * an immediate drain when it comes back or the network does, and jittered exponential
     * backoff on failure. Read that file for the poll-versus-SSE decision and the cost
     * argument behind the visibility gate.
     *
     * It is wired HERE, inside the provider, and not passed down from
     * `(product)/mailbox/CloudShell.tsx` the way `resolveOwner` is. That seam exists to keep
     * `app/api-client` out of the offline desktop bundle; a scheduler imports nothing but
     * `setTimeout`, `document` and the engine it was handed, so it costs the desktop build
     * nothing. A prop would buy only a silent-omission mode — a shell that forgets to pass
     * one loads fine and then never syncs again, which is this exact bug re-created as a
     * wiring bug.
     *
     * The demo keeps the single `start()`. It has fixtures, no server and no cursor to
     * advance, and polling it would be a timer that can only ever find the same world
     * (invariant #6: nothing leaves this tab, and nothing needs to).
     */
    if (!live) {
      void engine.start().catch((err: unknown) => {
        console.error("ohmail: the mailbox sync engine failed to start", err);
      });
      return;
    }
    return startSyncScheduler(engine, { onStatus: onSyncStatus });
  }, [engine, live, onSyncStatus]);

  if (binding.status !== "ready") return <SessionScreen status={binding.status} />;

  return (
    <EngineContext.Provider
      value={{
        engine: binding.engine,
        demo: binding.demo,
        serverDemo,
        sync: live ? sync : SYNC_SETTLED,
      }}
    >
      {children}
    </EngineContext.Provider>
  );
}

/**
 * The two states that are not a mailbox.
 *
 * Same markup as `mailbox/page.tsx`'s honest gate — `.gate` / `.gate-card` in `app.css` —
 * so a visitor who lands here sees the product's own furniture rather than a stray spinner
 * in an unstyled page. `resolving` carries no text at all: it is normally two or three
 * hundred milliseconds, and a sentence that flashes is worse than a quiet frame.
 */
function SessionScreen({ status }: { status: "resolving" | "unauthenticated" }) {
  const t = useTranslations("session");
  if (status === "resolving") {
    return <div className="gate" aria-busy="true" aria-live="polite" />;
  }
  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>{t("endedTitle")}</h1>
        <p>{t("endedBody")}</p>
        <div className="gate-actions">
          <a className="btn primary" href="/login">
            {t("signIn")}
          </a>
          <a className="btn" href="/?demo=1">
            {t("openDemo")}
          </a>
        </div>
      </div>
    </div>
  );
}

function useBinding(): EngineBinding {
  const binding = useContext(EngineContext);
  if (!binding) throw new Error("useEngine must be used inside <EngineProvider>");
  return binding;
}

export function useEngine(): OhmailEngine {
  return useBinding().engine;
}

/**
 * What the sync loop is doing, for the one view that has to say so.
 *
 * A hook rather than a prop threaded through `AppShell` for the same reason the scheduler is
 * not a prop: `OhboxView` is the only consumer today, and passing this down four levels would
 * make forgetting it the default. The demo and the desktop read a permanently settled value,
 * so neither renders anything new.
 */
export function useSyncStatus(): SyncStatus {
  return useBinding().sync;
}

/** Nothing to subscribe to — the mode is decided once per engine, at construction. */
const NEVER_CHANGES = (): (() => void) => () => {};

/**
 * The mode the UI should render, hydration-safe.
 *
 * `useSyncExternalStore`'s third argument is the SERVER snapshot: React renders that during
 * hydration (so the markup matches byte for byte, no mismatch warning) and switches to the
 * client snapshot in the very next render. The engine is already the client's, so the only
 * thing this defers by one render is chrome — the demo ribbon and the frozen demo clock.
 */
export function useDemoMode(): boolean {
  const { demo, serverDemo } = useBinding();
  return useSyncExternalStore(NEVER_CHANGES, () => demo, () => serverDemo);
}

/**
 * Subscribe to the engine; returns the overlay-aware mirror version so
 * memoized selectors recompute on every change (and only then).
 */
export function useEngineVersion(): number {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(
    subscribe,
    () => engine.read().version(),
    () => 0,
  );
}

/** The overlay-merged reader (stable object; version() tracks change). */
export function useReader(): EntityReader {
  return useEngine().read();
}
