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
import {
  FixturesAdapter,
  HttpAdapter,
  IndexedDbMirrorStore,
  MailohEngine,
  type EntityReader,
} from "@mailoh/client-engine";

const EngineContext = createContext<MailohEngine | null>(null);

function createEngine(demo: boolean): MailohEngine {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE;
  if (!demo && apiBase) {
    const store =
      typeof indexedDB !== "undefined" ? new IndexedDbMirrorStore() : undefined;
    return new MailohEngine({
      adapter: new HttpAdapter({ baseUrl: apiBase }),
      ...(store ? { store } : {}),
    });
  }
  return new MailohEngine({ adapter: new FixturesAdapter() });
}

export function EngineProvider({
  demo,
  children,
}: {
  demo: boolean;
  children: ReactNode;
}) {
  const [engine] = useState(() => createEngine(demo));
  useEffect(() => {
    void engine.start().catch(() => {
      /* Fixtures never throw; the HTTP path retries on the next wake signal. */
    });
  }, [engine]);
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine(): MailohEngine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("useEngine must be used inside <EngineProvider>");
  return engine;
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
