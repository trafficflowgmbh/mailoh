import {
  FixturesAdapter,
  HttpAdapter,
  IndexedDbMirrorStore,
  OhmailEngine,
  purgeLegacyMirror,
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
 *
 * ── `owner` IS THE PERSISTENCE KEY, AND `null` MEANS "DO NOT PERSIST" ────────────────────
 *
 * This function used to build `new IndexedDbMirrorStore()` with no arguments, which took
 * the store's default database name — ONE name, `ohmail-mirror`, for every account that
 * ever signed in on a given browser. The option's own doc comment said "one mirror per
 * account should use a distinct name" and nothing supplied one. Two accounts on a shared
 * browser therefore shared a cursor and a set of persisted records; `/sync` is
 * account-filtered but it only MERGES pages, so nothing removed the first account's mail
 * and it rendered to the second.
 *
 * So the account id is now a REQUIRED argument for the persistent path, and it must be one
 * the SERVER confirmed — `app/shell/engine.tsx` gets it from `GET /auth/session` and does
 * not render the shell until it has it. Passing `null` is legal and gives a live engine
 * with an in-memory mirror: correct for a session whose owner is not yet known, because
 * nothing it holds outlives the tab. It is never the shipped path.
 */
export function createEngine(
  demo: boolean,
  env: EngineEnv = BUILD_ENV,
  owner: string | null = null,
): OhmailEngine {
  const apiBase = env.NEXT_PUBLIC_API_BASE;
  if (!demo && apiBase) {
    const persist = owner !== null && typeof indexedDB !== "undefined";
    if (persist) {
      // Fire-and-forget, once per engine: the pre-repair database is not ours to read and
      // is not something to leave lying on the origin. It is never opened, only deleted.
      void purgeLegacyMirror().catch(() => {
        /* blocked by another tab, or storage refused — hygiene, not an invariant */
      });
    }
    return new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: apiBase }),
      ...(persist ? { store: new IndexedDbMirrorStore({ owner: owner! }) } : {}),
    });
  }
  return new OhmailEngine({ adapter: new FixturesAdapter() });
}
