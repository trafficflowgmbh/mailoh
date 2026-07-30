/**
 * THE DEMO DECISION — one function, fail-SAFE toward the demo (invariants #6 / #8).
 *
 * `?demo=1` is a PROMISE: fixtures only, zero network, nothing leaves the tab. The failure
 * that matters is therefore not "the demo did not open" but "a URL presented as the demo
 * booted the HttpAdapter against a signed-in user's real mailbox". Two ways that happened
 * before this file existed:
 *
 *  1. **repeated parameters.** `searchParams.demo` was typed `string` and compared with
 *     `=== "1"`. Next hands a repeated key an ARRAY, so `/?demo=1&demo=0` produced
 *     `["1","0"] === "1"` → false → live. A link anyone can write turned the demo into the
 *     real client. Here EVERY value is inspected and ANY of them asking for the demo wins;
 *     the attacker's extra value can only ever be ignored.
 *  2. **a build-time gate.** A server component only sees the query string when the page is
 *     RENDERED PER REQUEST. Under `output: "export"` (or any future prerender of `/`) the
 *     one emitted `index.html` is built with `searchParams = {}`, so the runtime `?demo=1`
 *     never reaches the server at all. That is why {@link isDemoRequested} also accepts a
 *     raw query STRING: the client re-derives the answer from `window.location.search`
 *     before the engine is constructed, and the client is the only place the real URL is
 *     guaranteed to exist. See `app/shell/engine.tsx`.
 *
 * The rule is deliberately one-directional: the client may turn the demo ON, never OFF. A
 * server that already decided "demo" (NEXT_PUBLIC_DEMO, or a per-request render that saw
 * the query) cannot be downgraded to the network engine by anything in the URL.
 */

/** The query parameter that opens the demo. */
export const DEMO_PARAM = "demo";

/**
 * Values that mean "yes". `""` covers a bare `/?demo`, which a human plainly means as a
 * request for the demo; anything else (`0`, `false`, `no`, a typo) is not a demo request
 * and falls through to the ordinary gate.
 */
const TRUTHY = new Set(["1", "true", "yes", "on", ""]);

/** Next's `searchParams` shape: a repeated key arrives as an array. */
export type SearchParamsLike = Record<string, string | string[] | undefined>;

const asks = (value: string): boolean => TRUTHY.has(value.trim().toLowerCase());

/**
 * Does this URL ask for the demo?
 *
 * Accepts every shape the answer can arrive in — Next's `searchParams` record (server), a
 * `URLSearchParams`, or the raw `window.location.search` (client) — because the SAME rule
 * has to hold on both sides of hydration or the two disagree and one of them is wrong.
 */
export function isDemoRequested(
  input: SearchParamsLike | URLSearchParams | string | null | undefined,
): boolean {
  if (input == null) return false;

  if (typeof input === "string") {
    return isDemoRequested(new URLSearchParams(input.startsWith("?") ? input.slice(1) : input));
  }
  if (input instanceof URLSearchParams) {
    // `getAll` is what makes `?demo=0&demo=1` a demo: every occurrence is considered.
    return input.getAll(DEMO_PARAM).some(asks);
  }
  const raw = input[DEMO_PARAM];
  if (raw === undefined) return false;
  return (Array.isArray(raw) ? raw : [raw]).some(asks);
}

/** `NEXT_PUBLIC_DEMO` — the build-time forcing of demo mode (Stage 1's default). */
export function isDemoBuild(env: Record<string, string | undefined>): boolean {
  const v = (env.NEXT_PUBLIC_DEMO ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}
