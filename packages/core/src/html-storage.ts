/**
 * ── BOUNDING WHAT `message_bodies.html` MAY COST, SHAPED BY THE OUTAGE THAT FORCED IT ──
 *
 * One ordinary mailbox filled a half-gigabyte Postgres database and the server began answering
 * `53100 disk_full`. The shape of that database, taken from a representative mailbox before any
 * change, is the whole argument:
 *
 *   · `message_bodies` was almost all of the database — the low nineties as a percentage.
 *   · Inside it, `html` was about three quarters of the table. `headers`, `text` and the
 *     full-text index together were the remaining quarter.
 *   · `html` barely COMPRESSED. Postgres stored it at roughly 1.3x, where `text` in the same
 *     table managed about 1.8x, and a few hundred rows were stored completely UNCOMPRESSED —
 *     pglz abandons input it cannot shrink by 25%. Those few hundred rows held most of the
 *     stored html bytes on their own.
 *   · Well under one percent of the rows accounted for roughly half the entire database, and the
 *     largest single html value was tens of megabytes.
 *
 * That last line is the property this module exists for: the cost is not spread across mail, it
 * is concentrated in a tail. The cause is in {@link ../mime.ts} — mailparser was base64-inlining
 * whole image ATTACHMENTS into the html, and base64 of an already-compressed image is
 * incompressible, which is why the bytes neither shrank nor stayed put.
 *
 * `mime.ts` now passes `keepCidLinks: true`, which stops us MANUFACTURING that bloat. This
 * module is the second line, and it is not redundant with the first: **a sender can author a
 * `data:` URI in their own html**, and `keepCidLinks` has no opinion about those. Rows carrying
 * a `;base64,` payload were a small minority and held the overwhelming majority of all html
 * bytes — the same concentration, arriving from the sender instead of from us.
 *
 * ── WHY BOTH A STRIP AND A CAP, IN THAT ORDER ─────────────────────────────────────────────
 *
 * STRIP FIRST, TRUNCATE SECOND, and the order is the whole point. A 500 KB inline image sitting
 * in the first paragraph would, under truncate-first, cost the reader every word after it.
 * Stripping the payload keeps the entire message and throws away only bytes that are an
 * attachment wearing a URI. Truncation is the backstop for html that is genuinely, textually
 * enormous — it should almost never fire.
 *
 * ── THE NUMBERS THIS PICKS, AND WHY ───────────────────────────────────────────────────────
 *
 * Taken from a representative mailbox's html rows AFTER stripping `data:` payloads, the size
 * distribution is: median around 20 KB, p90 around 50 KB, p99 around 100 KB, and the largest
 * value under half a megabyte. {@link STORED_HTML_CAP_BYTES} at 256 KiB therefore sits at
 * roughly two and a half times the 99th percentile, so it fires on the extreme tail and never
 * on ordinary mail. It is a tripwire, not a routine haircut.
 *
 * {@link STRIP_DATA_URI_MIN_CHARS} at 512 exists so the strip targets bloat and nothing else: a
 * sender's 200-byte inline bullet-point icon is not what filled a database, and rewriting it
 * would damage a legible message for no measurable gain. Only payloads big enough to matter go.
 *
 * ── THE RECONCILIATION POINT IS THE CHECK CONSTRAINT, NOT A SHARED IMPLEMENTATION ─────────
 *
 * `message_bodies_html_cap` (mail `0022`) asserts `octet_length(html) <= 262144` in the
 * database. This module is what keeps that constraint from ever firing; the constraint is what
 * makes a regression in this module LOUD instead of silent. Deliberately NOT shared code with
 * the SQL — a migration freezes the moment it is applied, so the two cannot be kept identical
 * by construction. {@link STORED_HTML_CAP_BYTES} is pinned to the constraint's literal by a test
 * instead.
 *
 * Named consequence, so it is not discovered during an incident: `apps/worker/src/sync.ts` has
 * no per-message catch, so if the constraint ever DOES fire it quarantines that mailbox as a
 * poison-message loop. That is the intended failure. The alternative is silent re-bloat until
 * Postgres quarantines the whole DATABASE, which is the incident this module exists because of.
 */

/**
 * The hard ceiling on a stored html body, in BYTES — the same literal the
 * `message_bodies_html_cap` CHECK constraint asserts. 256 KiB.
 *
 * Bytes and not characters, because that is what storage costs and what `octet_length()`
 * measures. A char-based cap is a 4x lie on a body of astral-plane text.
 */
export const STORED_HTML_CAP_BYTES = 262_144;

/**
 * The shortest base64 `data:` payload worth stripping, in characters.
 *
 * Below this a `data:` URI is an icon or a spacer, not the reason a database filled up. See the
 * module header: the target is bloat, and a threshold is what keeps this from mangling small
 * legitimate inline art.
 */
export const STRIP_DATA_URI_MIN_CHARS = 512;

/**
 * What a stripped inline payload is replaced BY.
 *
 * A `cid:` reference rather than an empty `src` or a removed tag, because `cid:` is the shape
 * the rest of the system already understands — `packages/core/src/privacy/tracker-blocker.ts`
 * deliberately leaves `cid:` alone (it is embedded, so it cannot phone home), and the
 * `attachments` row for that part still carries `contentId` and `inline` for a client to resolve
 * through `GET /attachments/:id`.
 *
 * It is deliberately a DISTINCT, greppable marker rather than a plausible-looking cid: the
 * original cid is genuinely unrecoverable once mailparser has overwritten it, and inventing one
 * by correlating against `attachments.content_id` is exactly the guess this project's rule for
 * ambiguous data forbids: refuse and make a human look. A row that was stripped can be found with
 * `WHERE html LIKE '%ohmail-stripped%'`, and the honest repair is a re-fetch from IMAP — the
 * mailbox is the master and still holds the original with its real `cid:` links.
 */
export const STRIPPED_DATA_URI = "cid:ohmail-stripped";

/** Appended to a body that hit {@link STORED_HTML_CAP_BYTES}, so the truncation is not silent. */
export const HTML_TRUNCATION_MARKER =
  "\n<!-- ohmail: body truncated at the storage cap; the full message is in your mailbox -->";

/**
 * Any base64 `data:` URI. The SIZE test is applied in the replacer, not here — see below.
 *
 * The payload class is `[A-Za-z0-9+/=]` with NO whitespace: base64 produced by
 * `Buffer.toString('base64')` contains none, and admitting `\s` makes the class over-eat in an
 * unquoted `src=` context — `src=data:image/png;base64,AAAA and then some text` would match
 * straight through the following words and delete the sentence.
 *
 * ── WHY `+` AND A REPLACER, NOT `{512,}` ──────────────────────────────────────────────────
 *
 * The obvious spelling puts the minimum in the pattern: `[A-Za-z0-9+/=]{512,}`. It is WRONG,
 * and its own unit test found it. The JavaScript regex engine compiles a `{n,}` min-count
 * quantifier recursively, so on a sufficiently long match it throws `RangeError: Maximum call
 * stack size exceeded` — measured here: fine at 5,000,000 payload characters, THROWS at
 * 19,000,000. A body with whole attachments base64-inlined reaches tens of megabytes, which is
 * the header's story above, so the pathological input is not hypothetical — it is the exact
 * kind of message that took the database down. A throw here propagates out of `normalizeMime`
 * into the sync cycle, which has no per-message catch — so the "safety" net would have
 * quarantined the mailbox.
 *
 * A plain `+` is compiled as a loop and handles the same input in ~11 ms. The minimum
 * length is therefore enforced where it costs nothing: on the matched string.
 */
const DATA_URI = /data:[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** The literal that separates a `data:` URI's declared type from its payload. */
const BASE64_SEP = ";base64,";

/**
 * Replace every OVERSIZED base64 `data:` payload with {@link STRIPPED_DATA_URI}, leaving small
 * ones (icons, spacers) exactly as they were.
 *
 * Idempotent: the replacement contains no `data:…;base64,` sequence, so running it twice is the
 * same as running it once.
 */
export function stripInlineDataUris(html: string): string {
  return html.replace(DATA_URI, (match) => {
    const payloadStart = match.indexOf(BASE64_SEP) + BASE64_SEP.length;
    return match.length - payloadStart >= STRIP_DATA_URI_MIN_CHARS ? STRIPPED_DATA_URI : match;
  });
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, which is neither characters nor bytes; a
 * 60,000-"character" slice of CJK or emoji is up to 240,000 bytes. So the cut is made on the
 * byte buffer and then walked BACK over any UTF-8 continuation bytes (`10xxxxxx`) so the last
 * character is either wholly kept or wholly dropped — never half-decoded into U+FFFD.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * The ONLY thing that should ever be written to `message_bodies.html`.
 *
 * Strips oversized inline base64 payloads, then — if what remains is still over the cap —
 * truncates on a character boundary and appends {@link HTML_TRUNCATION_MARKER}. `null` in,
 * `null` out: a body with no html, and a sensitive message (whose html is deliberately never
 * stored at all), both take that path unchanged.
 *
 * The result is guaranteed to satisfy `octet_length(html) <= STORED_HTML_CAP_BYTES`, which is
 * exactly what the `message_bodies_html_cap` CHECK constraint asserts.
 */
export function prepareHtmlForStorage(html: string | null): string | null {
  if (html === null) return null;
  const stripped = stripInlineDataUris(html);
  if (Buffer.byteLength(stripped, "utf8") <= STORED_HTML_CAP_BYTES) return stripped;
  const budget = STORED_HTML_CAP_BYTES - Buffer.byteLength(HTML_TRUNCATION_MARKER, "utf8");
  return truncateToBytes(stripped, budget) + HTML_TRUNCATION_MARKER;
}
