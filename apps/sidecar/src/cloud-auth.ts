import { readFileSync, writeFileSync } from "node:fs";
import type { KeyProvider } from "@trafficflow/core/mail";
import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD BEARER CLIENT — a plain `Authorization: Bearer` fetch against the hosted API, with a
 * single-flight refresh on 401 and a sealed-to-disk token store.
 *
 * ── WHY A NEW CLIENT AND NOT `HttpAdapter` ────────────────────────────────────────────────────
 *
 * `packages/client-engine`'s `HttpAdapter` is browser-shaped: it reads a `tf_csrf` cookie, echoes
 * an `X-CSRF-Token` on unsafe methods, and assumes an ambient cookie jar. None of that exists here
 * — this is a Node child talking to `api.ohmail.app` over `fetch`, authenticating with a token the
 * shell handed it, and the hosted API accepts a bearer on any host (`middleware.ts` prefers the
 * `Authorization` header, and a bearer caller is exempt from CSRF by construction). So the correct
 * client is the small one below: no cookie jar, no CSRF, one header.
 *
 * ── THE 401 REFRESH IS SINGLE-FLIGHT ──────────────────────────────────────────────────────────
 *
 * The pull loop can have several requests in flight (a `/sync` page and a `/messages/bodies` page
 * overlap across cycles), and an access token expiring makes all of them 401 at once. Refreshing
 * once per 401 would rotate the refresh-token family several times in a burst — the hosted API
 * treats a reused refresh token as a compromise signal and revokes the family, so a naive
 * per-request refresh would log the install out. {@link createCloudAuth} therefore shares ONE
 * in-flight refresh promise: the first 401 starts it, every concurrent 401 awaits the same one, and
 * all of them retry with the single rotated access token.
 *
 * `POST /auth/refresh` has a NATIVE body branch — `{ refreshToken }` in the body answers
 * `200 { tokens }` (`routes/core.ts`) — so no cookie is involved on this path either.
 */

export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
}

/** Raised when the session cannot be renewed — the refresh token is spent, rotated past, or reused. */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthError";
  }
}

export interface CloudAuthConfig {
  /** e.g. `https://api.ohmail.app`. A trailing slash is trimmed. */
  baseUrl: string;
  /** The tokens this launch starts with — resolved store-wins-over-environment by the caller. */
  tokens: CloudTokens;
  /** Injected for tests; production uses the platform's own `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * THE TOKEN SEAL. When present, a rotated token pair is written back through this provider so a
   * later launch resumes without an environment token — the same store-wins precedence the IMAP
   * credential follows. Absent (no durable key) ⇒ tokens live in memory only and this launch's
   * environment token is the sole source, exactly as an IMAP install with no key re-reads its
   * password every launch.
   */
  keyProvider?: KeyProvider;
  /** Where the sealed token pair lives — `<dataDir>/cloud-tokens.seal`. Absent ⇒ no seal. */
  sealPath?: string;
  now?: () => Date;
  log?: Diagnostic;
}

export interface CloudAuth {
  /** A bearer-authenticated fetch of `<baseUrl><path>`, with a single-flight refresh + retry on 401. */
  authedFetch(path: string, init?: RequestInit): Promise<Response>;
  /** The tokens currently in play, after any rotation. */
  currentTokens(): CloudTokens;
}

interface SealedTokenFile {
  ciphertext: string;
  keyVersion: number;
}

/**
 * Seal a token pair under the install's key and write it beside the cursor.
 *
 * The same envelope shape the IMAP credential uses (`mailbox_credentials.secret_enc`), so one
 * key ring wraps both. Mode `0600`: the file is a live credential and no other user may read it.
 */
export async function sealTokens(path: string, keyProvider: KeyProvider, tokens: CloudTokens): Promise<void> {
  const sealed = await keyProvider.encrypt(JSON.stringify(tokens));
  writeFileSync(
    path,
    JSON.stringify({ ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion } satisfies SealedTokenFile),
    { mode: 0o600 },
  );
}

/**
 * Read the sealed token pair, or null when there is none / it cannot be opened.
 *
 * A row this key cannot decrypt is `null`, not an error: the recovery is the same as the IMAP
 * side's — the shell supplies a fresh token in the environment and the launch re-seals it. Nothing
 * is logged from here; the thrown value comes from AES-GCM via a provider that also carries key
 * material, and the only fact the caller needs is "this key does not open that file".
 */
export async function loadSealedTokens(path: string, keyProvider: KeyProvider): Promise<CloudTokens | null> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const file = JSON.parse(raw) as SealedTokenFile;
    const plain = await keyProvider.decrypt(file.ciphertext, file.keyVersion);
    const tokens = JSON.parse(plain) as CloudTokens;
    if (typeof tokens.accessToken === "string" && typeof tokens.refreshToken === "string") return tokens;
    return null;
  } catch {
    return null;
  }
}

export function createCloudAuth(cfg: CloudAuthConfig): CloudAuth {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  let tokens = cfg.tokens;
  /** The clone defence, single-flight: one in-flight refresh serves every concurrent 401. */
  let refreshing: Promise<CloudTokens> | null = null;

  const persist = async (next: CloudTokens): Promise<void> => {
    if (!cfg.keyProvider || !cfg.sealPath) return;
    try {
      await sealTokens(cfg.sealPath, cfg.keyProvider, next);
    } catch (err) {
      cfg.log?.("cloud_refresh_failed", {
        err,
        reason: "the rotated session could not be sealed to disk; it is held in memory for this " +
          "launch and the next launch reads the environment token instead",
      });
    }
  };

  const refresh = async (): Promise<CloudTokens> => {
    const res = await fetchImpl(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!res.ok) throw new CloudAuthError(`the hosted API refused to renew the session (HTTP ${res.status})`);
    const wire = (await res.json()) as { tokens?: { accessToken?: string; refreshToken?: string } };
    const next = wire.tokens;
    if (!next?.accessToken || !next?.refreshToken) {
      throw new CloudAuthError("the refresh response carried no token pair");
    }
    tokens = { accessToken: next.accessToken, refreshToken: next.refreshToken };
    await persist(tokens);
    return tokens;
  };

  const refreshOnce = (): Promise<CloudTokens> => {
    // `??=` is the single-flight: the first caller installs the promise, everyone else awaits it,
    // and `finally` clears it so the NEXT expiry starts a fresh one.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const withBearer = (init: RequestInit | undefined, access: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${access}`);
    return { ...init, headers };
  };

  const authedFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await fetchImpl(`${base}${path}`, withBearer(init, tokens.accessToken));
    if (res.status !== 401) return res;
    let renewed: CloudTokens;
    try {
      renewed = await refreshOnce();
    } catch (err) {
      cfg.log?.("cloud_refresh_failed", {
        err,
        reason: "the session could not be renewed, so the mirror pauses until the shell supplies a " +
          "fresh token; nothing local is lost",
      });
      return res;
    }
    return fetchImpl(`${base}${path}`, withBearer(init, renewed.accessToken));
  };

  return { authedFetch, currentTokens: () => tokens };
}
