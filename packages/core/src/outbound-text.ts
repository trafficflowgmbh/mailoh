/**
 * PLAIN TEXT → THE TWO HALVES OF ONE OUTBOUND MESSAGE.
 *
 * A drafter answers with prose: `DraftResult` is `{subject, body, rationale}`, and `body` is
 * text. A stored draft has room for two halves — `drafts.body` and `drafts.html` — and the send
 * path puts BOTH on the wire as a `multipart/alternative` when the second one is present. Until
 * this module existed the second one was never written on a generated draft, so a reply the
 * model wrote left the building as `text/plain` while the person who sent it had been editing
 * it in a rich editor. Two shipped capabilities that never met.
 *
 * ── WHY THE SERVER PROMOTES, RATHER THAN THE MODEL EMITTING MARKUP ───────────────────────
 *
 * Asking the model for html as well would make the two halves two independent answers, and the
 * promise a `multipart/alternative` makes is that its parts say the same thing. It would also
 * make the shape of a reply a property of a prompt, which is the least testable place to put
 * it. Deriving the markup from the words the model actually wrote keeps one source of truth and
 * changes no model behaviour at all: nothing in the drafting question moves.
 *
 * ── THE GRAMMAR IS THE SMALLEST ONE THAT SURVIVES THE ROUND TRIP ─────────────────────────
 *
 * `<p>` per paragraph, `<br />` between the lines inside one, `<p></p>` for a blank line
 * between two. Nothing else — no emphasis, no lists, no links, because the source is text and
 * inventing structure out of it would put formatting in a message that its author never wrote.
 * Punctuation that happens to look like markup stays punctuation: `&`, `<` and `>` are escaped,
 * so a reply containing `a < b` is a reply containing `a < b` and not a message with a mangled
 * tag in it.
 *
 * Every one of those four constructs is inside the outbound sanitizer's allow-list by
 * construction, so promotion cannot widen what a composed message may contain — a property the
 * suite asserts as a fixed point (`sanitize(html) === html`) rather than leaving as a reading
 * of two files.
 *
 * ── THE TEXT HALF IS RETURNED, NOT ASSUMED ───────────────────────────────────────────────
 *
 * `plainTextToOutboundBody` hands back BOTH halves for the same reason `prepareOutboundBody`
 * does: a caller that took the markup from here and the words from somewhere else could ship a
 * message whose two parts disagree. The text it returns is the NORMALIZED source — line endings
 * unified, runs of whitespace inside a line collapsed to one space, blank runs collapsed to a
 * single blank line, both ends trimmed — because that is exactly what a renderer does to the
 * markup, in a browser and in `htmlToPlainText` alike. Handing back the raw source instead would
 * hand back a text half that no reader of the html half will ever see.
 *
 * That normalization is the only way the promoted body differs from what the model wrote, and
 * it is invisible in every case that matters: html collapses whitespace when it is displayed, so
 * the alternative that keeps it would be the one that disagreed.
 *
 * It lives in `core` with no dependency at all because both generated-draft writers need it and
 * they are in different packages — the request path in `services`, the workflow step in `core`.
 * A second copy is how the two would come to write two different messages from one model answer.
 */

/** The two halves of one message, derived together and never separately. */
export interface PromotedBody {
  /** The markup half. `""` when the source has no words in it — then there is nothing to promote. */
  html: string;
  /** The text/plain half: the normalized source the markup above was built from. */
  text: string;
}

/**
 * The three characters that are markup rather than punctuation.
 *
 * `"` and `'` are deliberately absent: nothing here emits an attribute, so a quote in a
 * sentence is a quote in a sentence. It is also what the sanitizer's own text escaper does, and
 * the two must agree or the fixed-point property below fails on ordinary prose.
 */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Promote a plain-text body to `{html, text}`.
 *
 * Empty in, empty out — a whitespace-only body promotes to `{html: "", text: ""}` rather than to
 * an empty paragraph, so a caller can tell "there is nothing here" from "here is a blank
 * message" and store no html at all.
 */
export function plainTextToOutboundBody(source: string): PromotedBody {
  // Line endings first. A model answer is not guaranteed to use `\n`, and a stray `\r` left in
  // the text half would be a byte the html half cannot possibly carry.
  const normalized = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // `\s+`, not `[ \t]+`: a renderer collapses every kind of whitespace, non-breaking spaces
    // and form feeds included, and the text half has to say what the markup will show.
    .map((line) => line.replace(/\s+/g, " ").trim());

  // Blank runs collapse to ONE blank line and both ends lose theirs — again because that is
  // what the markup renders as, and a text half holding six trailing blank lines reads as a
  // mistake somebody made rather than as spacing somebody chose.
  const lines: string[] = [];
  for (const line of normalized) {
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { html: "", text: "" };

  let html = "";
  let paragraph: string[] = [];
  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    // `<br />`, not `<br>`, because that is the form the sanitizer re-serializes a break into.
    // The two spellings render identically; only one of them is a fixed point.
    html += `<p>${paragraph.join("<br />")}</p>`;
    paragraph = [];
  };

  for (const line of lines) {
    if (line === "") {
      closeParagraph();
      // An EMPTY PARAGRAPH is how a rich editor holds the gap between two paragraphs, and it is
      // the one construct `htmlToPlainText` renders back as a blank line. Expressing the gap as
      // paragraph margins instead would look right and would lose the blank line on the way
      // back to text — the two halves would then disagree about where the message breathes.
      html += "<p></p>";
      continue;
    }
    paragraph.push(escapeText(line));
  }
  closeParagraph();

  return { html, text: lines.join("\n") };
}
