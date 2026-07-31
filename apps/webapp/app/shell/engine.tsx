"use client";

/**
 * Engine wiring: ONE MailohEngine per tab, boots in an effect, and the
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
import { MailohEngine, type EntityReader } from "@mailoh/client-engine";
import { isDemoRequested } from "../demo-mode";
import { createEngine } from "./engine-config";

interface EngineBinding {
  engine: MailohEngine;
  /** The mode the ENGINE was actually built in — client truth, never the server's guess. */
  demo: boolean;
  /** What the server rendered with, so hydration has a snapshot that matches the markup. */
  serverDemo: boolean;
}

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
  children,
}: {
  demo: boolean;
  children: ReactNode;
}) {
  /**
   * The initializer runs during the FIRST render on each side — which on the client is the
   * hydration render, where `window.location` is already the user's real URL. So the engine
   * is built from the resolved mode before a single effect (and therefore before a single
   * request) can run: there is no window in which a `?demo=1` page holds an HttpAdapter.
   */
  const [binding, setBinding] = useState<{ demo: boolean; engine: MailohEngine }>(() => {
    const demo = resolveDemo(serverDemo);
    return { demo, engine: createEngine(demo) };
  });

  // A mode change after mount (a client-side navigation from `/` to `/?demo=1`, or the
  // reverse) must REPLACE the engine, not keep the one built for the other mode. Capturing
  // it once was how a live→demo navigation kept the network engine alive behind a page that
  // says "nothing leaves this tab".
  const desired = resolveDemo(serverDemo);
  useEffect(() => {
    if (desired === binding.demo) return;
    // The engine owns no timers and no open sockets (`start()` is one drain; SSE is
    // attached by the caller and this app never attaches one), so dropping the reference
    // IS the teardown — there is nothing left running to cancel.
    setBinding({ demo: desired, engine: createEngine(desired) });
  }, [desired, binding]);

  const engine = binding.engine;
  useEffect(() => {
    void engine.start().catch(() => {
      /* Fixtures never throw; the HTTP path retries on the next wake signal. */
    });
  }, [engine]);

  return (
    <EngineContext.Provider value={{ engine, demo: binding.demo, serverDemo }}>
      {children}
    </EngineContext.Provider>
  );
}

function useBinding(): EngineBinding {
  const binding = useContext(EngineContext);
  if (!binding) throw new Error("useEngine must be used inside <EngineProvider>");
  return binding;
}

export function useEngine(): MailohEngine {
  return useBinding().engine;
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
