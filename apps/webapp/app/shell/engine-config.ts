import {
  FixturesAdapter,
  HttpAdapter,
  IndexedDbMirrorStore,
  OhmailEngine,
} from "@ohmail/client-engine";

/**
 * Stage-2 S12 — THE ENGINE DECISION, extracted so it can be TESTED rather than described.
 *
 * This function used to live inside `engine.tsx`, which is a `"use client"` module that
 * pulls in React and the whole provider. `demo-gate.test.ts` could therefore only assert
 * the demo promise STRUCTURALLY — by matching source text — which proves the code says the
 * right thing and not that it does it. The promise is "`?demo=1` ⇒ fixtures only, zero
 * network, nothing leaves this tab" (invariants #6 and #8), and that is a claim about
 * BEHAVIOUR: the only convincing test constructs the engine, runs it, and watches the
 * network.
 *
 * So the decision moved here, to a plain module with no React in it, and
 * `demo-zero-network.test.ts` drives it: build with `demo: true`, `start()`, mutate, and
 * assert that `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` were touched exactly
 * zero times — with a control that builds the LIVE engine and proves the same assertions
 * would have caught a request. `engine.tsx` imports this and is otherwise unchanged; the
 * "the client may turn the demo ON, never OFF" rule still lives there, where the URL is.
 *
 * ── `env` IS A PARAMETER ────────────────────────────────────────────────────────────────
 *
 * Next inlines `process.env.NEXT_PUBLIC_API_BASE` at BUILD time, so in a bundle it is a
 * literal and cannot be varied. Taking it as an argument (defaulted to the inlined value)
 * changes nothing about the shipped behaviour and is what lets a test exercise both
 * branches in one process — including the branch that must NEVER be taken under `?demo=1`,
 * which is the one that matters.
 */
export interface EngineEnv {
  NEXT_PUBLIC_API_BASE?: string;
}

/** The build-time API base, read once. `undefined` ⇒ this build has no server. */
const BUILD_ENV: EngineEnv = { NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE };

/**
 * Build the engine for a resolved mode.
 *
 * `demo` WINS over everything. It is checked first and there is no configuration, no
 * environment variable and no argument that can make a `demo: true` call return an engine
 * with an `HttpAdapter` — which is the whole safety property, and the reason the condition
 * is `!demo && apiBase` rather than `apiBase && !demo` or any arrangement where the base
 * is consulted first.
 *
 * The demo engine also gets NO mirror store: `IndexedDbMirrorStore` would persist a
 * fixture world into the visitor's browser, and "nothing leaves this tab" should also mean
 * "nothing stays behind in it".
 */
export function createEngine(demo: boolean, env: EngineEnv = BUILD_ENV): OhmailEngine {
  const apiBase = env.NEXT_PUBLIC_API_BASE;
  if (!demo && apiBase) {
    const store = typeof indexedDB !== "undefined" ? new IndexedDbMirrorStore() : undefined;
    return new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: apiBase }),
      ...(store ? { store } : {}),
    });
  }
  return new OhmailEngine({ adapter: new FixturesAdapter() });
}
