"use client";

/**
 * THE MESSAGE BODY AS PROSE — paragraphs, and real links (slice O11).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Owner, 2026-08-04: reading a message "looks like a plain text code editor" — URLs render as
 * a wall of raw query string, the text overflows the panel, no paragraph rhythm. All three
 * symptoms came out of ONE expression, `<p className="msg-body">{body.text}</p>`: mailparser's
 * `htmlToText` output, dropped into a single `<p>` with no break rule and no block structure.
 *
 * ── WHY THIS IS A RENDER-TIME COMPONENT AND NOT AN INGEST STEP ────────────────────────────
 *
 * `message_bodies.text` is the sensitivity-redacted source for the `body_tsv` generated column
 * (`packages/db/src/schema.ts`), and `canonicalId` hashes `textBody` for dedup
 * (`packages/core/src/mime.ts`). Rewriting the text on the way in would change dedup keys and
 * the search corpus and force a backfill, to buy presentation. The stored shape does not move;
 * the DTO already ships `text`, and turning text into a reading surface is the client's job.
 *
 * ── REACT ELEMENTS ONLY ───────────────────────────────────────────────────────────────────
 *
 * No `dangerouslySetInnerHTML`, no HTML string anywhere in this file — not as an intermediate
 * value, not "just for the links". `security-headers.ts` states that the app "renders no
 * untrusted HTML anywhere" and the CSP rationale is written on top of that sentence; claims are
 * contracts here, so the sentence constrains this file rather than the other way round. The
 * sender's bytes only ever reach the DOM as text nodes and as an `href` this file constructed
 * from a parsed `URL`.
 *
 * Deliberately a plain `<a>` and never `next/link`: `next/link` prefetches, and a message body
 * that fetches anything on render is the tracker-pixel behaviour the product exists to stop.
 */
import type { ReactNode } from "react";

/** A blank line — the one thing in plain-text mail that reliably means "new paragraph". */
const PARAGRAPH_BREAK = /\n[ \t]*\n+/;

/**
 * A CANDIDATE, NOT A DECISION.
 *
 * This matches anything shaped like `scheme:rest`, INCLUDING `javascript:` and `data:`. That is
 * on purpose and it is the whole design: if the pattern itself only ever matched `https?://`,
 * the scheme rule would be an invisible property of a regex nobody can watch fail, and
 * `body-text.test.ts` case 1 would pass vacuously. The rejection happens in one named place
 * ({@link anchorFor}), where it can be deleted and watched go red.
 *
 * The body charset excludes whitespace and the quote/angle characters. Brackets and parens ARE
 * allowed inside — `http://[::1]:8080/x` is a real URL — and are stripped only from the END,
 * which is what unwraps the `text [url]` pairs `htmlToText` emits.
 */
const URL_CANDIDATE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>"'`]+/g;

/** Sentence and bracket punctuation that ended up glued to a URL, never part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"'`]+$/;

/**
 * THE ALLOW-LIST, AND IT IS THE ONLY GATE.
 *
 * There is deliberately no second check (a non-empty host, say) that would also happen to
 * reject `javascript:`. Two overlapping guards read as belt-and-braces and behave as neither:
 * deleting one leaves the test green, so neither one is ever proven to do anything. For
 * `http:`/`https:` the WHATWG parser already guarantees a host — `new URL("https://")` throws
 * — so this line is sufficient on its own, and it is therefore the line the mutation removes.
 */
const SAFE_PROTOCOLS = ["https:", "http:"];

/** How much of the path/query survives in the visible label before the ellipsis. */
const MAX_TAIL = 32;

/**
 * The visible text of a link, DERIVED FROM THE HREF AND NOTHING ELSE — host first, always.
 *
 * `htmlToText` has already flattened every anchor to `text [url]`, and this file linkifies only
 * the URL substring, so a label can never come from sender-controlled anchor text: label and
 * href are the same string by construction. Host-first is what survives the remaining trick,
 * userinfo — `https://bank.example@evil.example/pay` labels as `evil.example/pay`, because
 * `url.host` is the host and `bank.example` is a username.
 */
function labelOf(url: URL): string {
  const tail = `${url.pathname}${url.search}${url.hash}`;
  const rest = tail === "/" ? "" : tail;
  return url.host + (rest.length > MAX_TAIL ? `${rest.slice(0, MAX_TAIL)}…` : rest);
}

/**
 * An anchor for this candidate, or `null` for "leave it as text".
 *
 * THE SAFE BRANCH IS THE DEFAULT BRANCH: every path out of here that is not an explicit
 * `https:`/`http:` returns `null`, including the parse failure. A `catch` that renders the
 * substring as a link anyway is the untested branch that ships `javascript:`.
 */
function anchorFor(candidate: string): { href: string; label: string } | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.includes(url.protocol)) return null;
  return { href: url.href, label: labelOf(url) };
}

/** One paragraph's worth of text, with its safe URLs turned into anchors. */
function linkify(block: string, keyBase: number): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let n = 0;

  for (const match of block.matchAll(URL_CANDIDATE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const candidate = raw.replace(TRAILING_PUNCTUATION, "");
    if (!candidate) continue;
    const anchor = anchorFor(candidate);
    // Rejected: `cursor` is not advanced, so the substring stays inside the surrounding text
    // run and reaches the DOM as a text node — visible, inert, exactly as the sender wrote it.
    if (!anchor) continue;

    if (start > cursor) out.push(block.slice(cursor, start));
    out.push(
      <a
        key={`l${keyBase}-${n++}`}
        className="msg-link"
        href={anchor.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {anchor.label}
      </a>,
    );
    cursor = start + candidate.length;
  }

  if (cursor < block.length) out.push(block.slice(cursor));
  return out;
}

/**
 * The shared body renderer — the focused message in `MessagePane` AND the conversation
 * siblings in `Conversation`.
 *
 * ONE COMPONENT, BOTH SURFACES, on purpose. "Built, tested, unreachable" — the fix landing on
 * the pane while the thread below it keeps dumping raw text — is a shape this repo has shipped
 * five times, and a second copy of this logic is how it happens a sixth.
 *
 * Returns a fragment of `<p>` rather than its own wrapper: the caller owns the container and
 * its class (`.msg-body`, `.hm-body`), which are what the existing pane and screener
 * assertions select on, and what carries the surface's own type scale.
 */
export function BodyText({ text }: { text: string }) {
  const blocks = (text ?? "")
    // CRLF is what an IMAP body actually carries; normalise before splitting, or the blank
    // line between two paragraphs is `\r\n\r\n` and the split misses every one of them.
    .replace(/\r\n?/g, "\n")
    .split(PARAGRAPH_BREAK)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return (
    <>
      {blocks.map((block, i) => (
        <p className="msg-p" key={i}>
          {linkify(block, i)}
        </p>
      ))}
    </>
  );
}
