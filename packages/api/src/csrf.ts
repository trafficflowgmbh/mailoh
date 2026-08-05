import { createHash } from "node:crypto";

/**
 * THE CSRF TOKEN IS DERIVED FROM THE SESSION IT PROTECTS, NOT DRAWN AT RANDOM.
 *
 * A double-submit guard that only asks whether the `tf_csrf` cookie and the `X-CSRF-Token`
 * header are EQUAL TO EACH OTHER accepts any pair of equal values. The token is then never tied
 * to the session that arrived with it, and the check can be satisfied with a value the attacker
 * chose.
 *
 * That is exploitable without touching the session cookie, which is the part worth spelling out.
 * `tf_session` is host-only by deliberate design — never `Domain=` — and cannot be widened, but
 * the CSRF cookie is a different cookie: script on an allowed same-site SIBLING origin can plant
 * a parent-domain copy of it, the browser then sends both, cookie parsing keeps the last (the
 * planted one), and the sibling posts that same value in the header. The victim's host-only
 * session cookie rides along as ambient authority and a mutating route runs: send a draft, move
 * mail, delete it. The session cookie was never widened; the guard in front of it was answering
 * the wrong question.
 *
 * So the expected value is a function of the session token, and the request guard RECOMPUTES it
 * rather than comparing two client-supplied strings. A planted cookie matches nothing.
 *
 * ── WHY A PLAIN DIGEST AND NOT AN HMAC UNDER A DEPLOYMENT SECRET ──────────────────────────
 *
 * An HMAC would need a new required secret, and "absent configuration selects the permissive
 * branch" is the failure shape this codebase refuses by policy: a deployment that forgot to set
 * it would either reject every mutation or, far worse, fall back to the comparison above. There
 * is no need for one. The value's unguessability comes from the ACCESS TOKEN, which is 32 random
 * bytes behind `HttpOnly` — an attacker who cannot read the session cookie cannot compute this,
 * and an attacker who can read it does not need CSRF at all. The digest is domain-separated, so
 * the result can never be mistaken for, or replayed as, the session token itself.
 *
 * It also rotates for free: every refresh mints a new access token, so the pair moves together
 * and there is no stored state to expire.
 *
 * ── WHY THIS IS ITS OWN MODULE, BESIDE THE GUARD RATHER THAN THE COOKIE SET ────────────────
 *
 * Verifying is not minting. Recomputing this value is work the request pipeline does on every
 * unsafe cookie-authenticated request, so it belongs to the pipeline that every host runs.
 * Issuing the session cookies belongs to whatever performed a sign-in, which is not something
 * every host does — a single-user local host authenticates by bearer token and has no sign-in
 * ceremony at all. Splitting the derivation out is what lets the shared pipeline keep its CSRF
 * check without the session-issuing half travelling with it.
 *
 * The guard is compiled in even where it cannot fire. A host that consults no cookie can never
 * reach it (the credential is never `"cookie"`), and that is a structural fact about the
 * deployment rather than a switch: a host that DOES accept cookies cannot be configured into
 * having no CSRF check.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`ohmail-csrf:v1:${sessionToken}`).digest("base64url");
}
