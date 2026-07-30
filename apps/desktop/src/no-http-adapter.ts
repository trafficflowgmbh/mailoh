/**
 * The Cloud sync client, absent.
 *
 * `@mailoh/client-engine`'s barrel re-exports `HttpAdapter` — the `/sync`
 * protocol client for mailoh Cloud. The desktop tier has no account, no server
 * and no network, so `vite.config.ts` aliases the real module to this file. The
 * consequences are the point:
 *
 *  · the emitted bundle contains no request builder, no CSRF header, no
 *    idempotency key, no cursor protocol — grep it and there is nothing to find;
 *  · `scripts/publish-desktop.mjs` therefore does not publish
 *    `packages/client-engine/src/adapters/http-adapter.ts`, so the public
 *    repository does not contain the Cloud protocol either;
 *  · if a future edit makes the shell reach for it, this throws on construction
 *    instead of quietly opening a socket.
 *
 * ── why this file imports nothing ──
 *
 * It is published to TWO paths in the public mirror: here, because
 * `vite.config.ts` aliases to it, and over the top of
 * `packages/client-engine/src/adapters/http-adapter.ts`, because `tsc` does not
 * read Vite aliases and the barrel's `export … from "./adapters/http-adapter.js"`
 * has to resolve to something. One file, two locations, so any relative import
 * would be wrong in at least one of them.
 *
 * The types below are therefore declared rather than imported. That costs
 * nothing in safety: `sync` and `mutate` are class methods, whose parameters are
 * bivariant, so `unknown` in and `Promise<never>` out stays assignable to
 * `EngineAdapter` — the shell's `new MailohEngine({ adapter })` still typechecks
 * against the real interface, and would still fail if that interface changed
 * shape in a way this could not satisfy.
 */

export type FetchLike = (url: string, init?: unknown) => Promise<unknown>;

export interface HttpAdapterOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  getCookie?: (name: string) => string | null;
  csrfCookieName?: string;
  headers?: () => Record<string, string>;
}

const REFUSAL =
  "mailoh Desktop is standalone: there is no Cloud sync client in this build. " +
  "The HTTP adapter is aliased away at bundle time (apps/desktop/vite.config.ts).";

export class HttpAdapter {
  /** Present because the real adapter has it; never advances. */
  lastSyncSeq: number | null = null;

  constructor(_options: HttpAdapterOptions = {}) {
    throw new Error(REFUSAL);
  }

  eventsUrl(): string {
    throw new Error(REFUSAL);
  }

  async sync(_params: unknown): Promise<never> {
    throw new Error(REFUSAL);
  }

  async mutate(_mutation: unknown, _opts: unknown): Promise<never> {
    throw new Error(REFUSAL);
  }
}
