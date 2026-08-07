import type { CloudTokens } from "./cloud-auth.js";
import type { Diagnostic } from "./log.js";

/**
 * SIGNING IN TO THE HOSTED ACCOUNT, from a Cloud-mode install that has no session yet.
 *
 * ── WHY THIS EXISTS, AND WHAT IT REPLACES ─────────────────────────────────────────────────────
 *
 * Cloud mode used to be reachable only by a launch that already carried a token pair in its
 * environment: the shell had to obtain one somewhere else and hand it over. There is nowhere else.
 * A person who installs the app and picks the hosted door has an email address, a password and a
 * six-digit code, and this module is what turns those three into the pair the mirror pulls with.
 *
 * ── THE TWO STEPS, AND THE FIELD NAME THAT IS NOT THE ONE YOU EXPECT ──────────────────────────
 *
 *  1. `POST /auth/login` `{email, password}` → **200** `{status: "twofa_required", loginToken}`.
 *     A 200 here is NOT a session; it is a challenge. Treating it as success is the mistake this
 *     comment exists to prevent.
 *  2. `POST /auth/2fa/totp/verify` `{loginToken, code}` → the session. The parameter is
 *     `loginToken` and not `challengeToken`.
 *
 * ── WHERE THE TOKENS ARE, AND WHY BOTH PLACES HAVE TO BE READ ─────────────────────────────────
 *
 * The hosted API decides per HOST whether it speaks cookies. On a cookie host the session is
 * established with `Set-Cookie` and the token pair is STRIPPED from the JSON body; on a bearer-only
 * host the cookies are omitted and the pair stays in the body. Both are the same session — only the
 * transport differs — so this reads the body first and falls back to the cookies. Reading only one
 * would work against one deployment and silently return "no session" against the other.
 *
 * `tf_session` carries the access token verbatim and `tf_refresh` the refresh token verbatim, so
 * lifting them needs no decoding. `Set-Cookie` must be read with `getSetCookie()`: iterating a
 * `Headers` joins repeated names with `", "`, and a cookie's own `Expires=Wed, 09 Jun 2027` contains
 * a comma, so the joined string cannot be split back apart.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT REACH ──────────────────────────────────────────────
 *
 * No IMAP adapter, no organizer lease, no sync loop — it is `fetch` and JSON and nothing else. It
 * is imported from `cloud-engine.ts`, so the structural census over that file's graph covers it:
 * the sign-in surface cannot become a door into the organizer.
 *
 * ── AND WHAT IT NEVER SAYS OUT LOUD ───────────────────────────────────────────────────────────
 *
 * The address, the password and the code are arguments and never log fields. The diagnostics here
 * carry a step name and an HTTP status, which is everything an operator needs to tell "the server
 * refused" apart from "the server was not there".
 */

/** Why a sign-in did not produce a session. `code` is for the surface; `message` is for a person. */
export class CloudSignInError extends Error {
  readonly code: string;
  /** What this install should answer its own caller with. */
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "CloudSignInError";
    this.code = code;
    this.status = status;
  }
}

export interface CloudSignInRequest {
  email: string;
  password: string;
  /** The six digits from the authenticator app. */
  totp: string;
}

export interface CloudSignInOptions {
  /** e.g. `https://api.ohmail.app`. A trailing slash is trimmed. */
  baseUrl: string;
  /** Injected for tests; production dials the real hosted API. */
  fetchImpl?: typeof fetch;
  log?: Diagnostic;
}

/**
 * The token pair a `Set-Cookie` set carries, or null when the response set no session cookies.
 *
 * Exported because it is the half of the wire most likely to drift: a change to the cookie names or
 * to their contents breaks sign-in and nothing else would notice, so it is asserted directly.
 */
export function tokensFromSetCookie(cookies: readonly string[]): CloudTokens | null {
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  for (const cookie of cookies) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "") continue;
    if (name === "tf_session") accessToken = value;
    else if (name === "tf_refresh") refreshToken = value;
  }
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

/** The token pair a session response carries, from whichever of the two places holds it. */
function tokensFromResponse(body: unknown, res: Response): CloudTokens | null {
  const wire = (body as { tokens?: { accessToken?: unknown; refreshToken?: unknown } } | null)?.tokens;
  if (typeof wire?.accessToken === "string" && typeof wire?.refreshToken === "string") {
    return { accessToken: wire.accessToken, refreshToken: wire.refreshToken };
  }
  return tokensFromSetCookie(res.headers.getSetCookie());
}

/** Parse a JSON body, tolerating a response that carried none. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Sign in to the hosted account and return the pair the mirror pulls with.
 *
 * Throws {@link CloudSignInError} for every refusal, with a `status` this install can answer its own
 * caller with — a wrong password is 401 here because it was 401 there, and a hosted service that is
 * unreachable is 502 because this install is the one reporting it.
 */
export async function cloudSignIn(
  opts: CloudSignInOptions,
  req: CloudSignInRequest,
): Promise<CloudTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const email = trimmed(req.email);
  const password = typeof req.password === "string" ? req.password : "";
  const code = trimmed(req.totp);

  // Refused HERE rather than by the hosted service, because an empty password is a login attempt
  // that counts against a lockout on some deployments and buys nothing.
  if (!email || !password || !code) {
    throw new CloudSignInError(
      "invalid_request",
      400,
      "signing in needs the address, the password and the current six-digit code",
    );
  }

  const post = async (path: string, body: unknown, step: string): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      opts.log?.("cloud_signin_failed", { err, reason: `the hosted service could not be reached at ${step}` });
      throw new CloudSignInError("cloud_unreachable", 502, "the hosted service could not be reached");
    }
  };

  const loginRes = await post("/auth/login", { email, password }, "login");
  const loginBody = await readJson(loginRes);
  if (!loginRes.ok) {
    opts.log?.("cloud_signin_refused", { status: loginRes.status, reason: "the hosted service refused the login" });
    throw new CloudSignInError(
      loginRes.status === 401 || loginRes.status === 400 ? "invalid_credentials" : "hosted_refused",
      loginRes.status === 401 || loginRes.status === 400 ? 401 : 502,
      loginRes.status === 401 || loginRes.status === 400
        ? "that address and password were not accepted"
        : `the hosted service answered HTTP ${loginRes.status} to the login`,
    );
  }

  const status = trimmed((loginBody as { status?: unknown } | null)?.status);
  if (status === "enrollment") {
    // A registered account with no second factor yet. Enrolling one is a browser ceremony — it
    // shows a QR code — and pretending otherwise here would be a half-built enrollment surface
    // inside a mail engine.
    throw new CloudSignInError(
      "enrollment_required",
      409,
      "this account has no authenticator set up yet; finish that on the web and sign in here afterwards",
    );
  }
  const loginToken = trimmed((loginBody as { loginToken?: unknown } | null)?.loginToken);
  if (status !== "twofa_required" || !loginToken) {
    throw new CloudSignInError(
      "unsupported_login_result",
      502,
      "the hosted service answered the login with something this install does not understand",
    );
  }

  // THE FIELD IS `loginToken`. `challengeToken` is the name everybody reaches for and it is not
  // this one; a wrong name here answers 400 and reads exactly like a wrong code.
  const verifyRes = await post("/auth/2fa/totp/verify", { loginToken, code }, "verify");
  const verifyBody = await readJson(verifyRes);
  if (!verifyRes.ok) {
    opts.log?.("cloud_signin_refused", { status: verifyRes.status, reason: "the hosted service refused the code" });
    throw new CloudSignInError(
      verifyRes.status === 401 || verifyRes.status === 400 ? "invalid_code" : "hosted_refused",
      verifyRes.status === 401 || verifyRes.status === 400 ? 401 : 502,
      verifyRes.status === 401 || verifyRes.status === 400
        ? "that code was not accepted; codes last thirty seconds, so try the current one"
        : `the hosted service answered HTTP ${verifyRes.status} to the code`,
    );
  }

  const tokens = tokensFromResponse(verifyBody, verifyRes);
  if (!tokens) {
    throw new CloudSignInError(
      "no_session_returned",
      502,
      "the hosted service accepted the code and returned no session",
    );
  }
  return tokens;
}
