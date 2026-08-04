"use client";

/**
 * THE TWO HALVES OF A TYPED MESSAGE, AND HOW THEY SURVIVE A DEPLOY.
 *
 * Compose and reply used to hold one string each. A rich editor holds two — the markup the
 * user is looking at, and the plain text it renders as — and both have to survive navigation
 * the way the single string already did, because the scratch buffers are a data-loss guarantee
 * rather than a convenience. That guarantee is the whole reason this module exists separately
 * from the editor component: the storage rules are testable without a DOM, and they are the
 * part that must not break, so they are not mixed into a React component that cannot be
 * reasoned about without mounting one.
 *
 * ── THE LEGACY READ IS SHAPE-BASED, NOT PARSE-BASED ──────────────────────────────────────
 *
 * The reply buffer's key already holds a BARE STRING for anybody who was mid-reply when this
 * shipped, and that text must not be thrown away by a deploy. So a stored value is read as an
 * envelope only if it PARSES to a non-array object whose `text` is a string; anything else is
 * taken verbatim as plain text.
 *
 * "It parsed as JSON" is deliberately not the test, and the case that forces it is real: a
 * person replying with `{"text": "see attached"}` — a fragment of config pasted into an email,
 * which is an ordinary thing to send — would parse, and a parse-based read would silently
 * restore their message as an envelope and lose the braces. The shape check costs one
 * `typeof` and closes it.
 *
 * There is no version field. It would not remove the legacy read (a bundle still has to
 * understand what is in the key TODAY), so it would be a second thing to keep true in
 * exchange for nothing — the same conclusion `readComposeDraft` reached about its own
 * field-wise guards.
 */

/** What the editor holds: the markup, and the plain text it renders as. */
export interface RichValue {
  /** The plain-text rendering, kept for the send path's local checks and the optimistic row. */
  text: string;
  /** The markup, or `""` for a message with no formatting in it. */
  html: string;
}

export const EMPTY_RICH: RichValue = { text: "", html: "" };

/**
 * Is there anything here to send, or to keep?
 *
 * Decided on the TEXT, never on the html. An empty ProseMirror document serialises to
 * `<p></p>`, which is four characters of markup and no message at all — testing the html
 * would make every visit to Compose leave a stored buffer behind and would light up Send on
 * an empty editor.
 */
export const isRichEmpty = (v: RichValue): boolean => v.text.trim() === "";

/**
 * Read a scratch value that may have been written by this bundle or by the one before it.
 *
 * `null`/absent reads as empty. See the header for why the envelope is recognised by shape.
 */
export function parseRichValue(raw: string | null | undefined): RichValue {
  if (raw == null || raw === "") return EMPTY_RICH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all — the ordinary legacy case, and the ordinary answer.
    return { text: raw, html: "" };
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    typeof (parsed as RichValue).text !== "string"
  ) {
    return { text: raw, html: "" };
  }
  const env = parsed as Partial<RichValue>;
  return {
    text: env.text as string,
    // Guarded separately, so an envelope written by a bundle that only knew about `text`
    // still reads, and one written here is still readable by a bundle that ignores `html`.
    html: typeof env.html === "string" ? env.html : "",
  };
}

/**
 * The string to store for a value, or `null` when there is nothing worth storing.
 *
 * A value with no text is stored as nothing at all rather than as an empty envelope: the
 * buffers' own rule has always been that an empty draft removes its key, and writing
 * `{"text":"","html":"<p></p>"}` would resurrect an empty editor on every navigation.
 *
 * A value with text but NO markup is stored as the bare string, not as an envelope. That
 * keeps a plain reply readable by a bundle that predates this module — the same
 * forward/backward courtesy `readComposeDraft`'s field-wise guards extend — and it means the
 * common case does not grow a JSON wrapper for a field that is empty.
 *
 * ── EXCEPT WHEN THE TEXT IS ITSELF ENVELOPE-SHAPED, WHICH IS A REAL BUG THIS CLOSES ──────
 *
 * A person replying with the literal text `{"text":"gotcha"}` — config pasted into an email —
 * stored as a bare string, would be READ BACK by the shape rule above as an envelope, and
 * they would get `gotcha` with their braces gone. The shape rule closes that case coming from
 * an OLD key; this closes it coming from a new write, and the two together are what make the
 * buffer lossless.
 *
 * The condition is the round trip itself rather than a hand-written "does it look like JSON"
 * test. That is deliberate: a second predicate could disagree with {@link parseRichValue},
 * and the disagreement would be invisible until somebody's message came back wrong. Asking
 * the reader is the only check that cannot drift from the reader.
 */
export function serializeRichValue(v: RichValue): string | null {
  if (isRichEmpty(v)) return null;
  if (v.html === "" && parseRichValue(v.text).text === v.text) return v.text;
  return JSON.stringify({ text: v.text, html: v.html });
}
