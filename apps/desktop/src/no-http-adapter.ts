/**
 * The Cloud sync client, absent.
 *
 * `@mailoh/client-engine`'s barrel re-exports `HttpAdapter` — the `/sync`
 * protocol client for MailOh Cloud. The desktop tier has no account, no server
 * and no network, so `vite.config.ts` aliases the real module to this file. The
 * consequences are the point:
 *
 *  · the emitted bundle contains no request builder, no CSRF header, no
 *    idempotency key, no cursor protocol — grep it and there is nothing to find;
 *  · `scripts/publish-desktop.mjs` therefore does not need to publish
 *    `packages/client-engine/src/adapters/http-adapter.ts` at all, so the public
 *    repository does not contain the Cloud protocol either;
 *  · if a future edit makes the shell reach for it, this throws on construction
 *    instead of quietly opening a socket.
 *
 * The shapes below mirror the real module's exports so the alias is transparent
 * to TypeScript and to the shell's `new HttpAdapter({ baseUrl })` call site.
 */
import type { EngineMutation, SyncResponse } from "../../../packages/client-engine/src/types.js";
import type {
  EngineAdapter,
  MutationOutcome,
  SyncParams,
} from "../../../packages/client-engine/src/adapters/adapter.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpAdapterOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  getCookie?: (name: string) => string | null;
  csrfCookieName?: string;
  headers?: () => Record<string, string>;
}

const REFUSAL =
  "MailOh Desktop is standalone: there is no Cloud sync client in this build. " +
  "The HTTP adapter is aliased away at bundle time (apps/desktop/vite.config.ts).";

export class HttpAdapter implements EngineAdapter {
  lastSyncSeq: number | null = null;

  constructor(_options: HttpAdapterOptions = {}) {
    throw new Error(REFUSAL);
  }

  eventsUrl(): string {
    throw new Error(REFUSAL);
  }

  async sync(_params: SyncParams): Promise<SyncResponse> {
    throw new Error(REFUSAL);
  }

  async mutate(
    _mutation: EngineMutation,
    _opts: { idempotencyKey: string },
  ): Promise<MutationOutcome> {
    throw new Error(REFUSAL);
  }
}
