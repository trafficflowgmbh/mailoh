"use client";

/**
 * ── THE MAIL RENDERER. THE HTML PART, SANITIZED, IN A FRAME THAT CANNOT PHONE HOME ──────
 *
 * ── WHAT WAS WRONG, AND IT WAS NOT THE RENDERER ─────────────────────────────────────────
 *
 * An ordinary vendor billing notice, shown from its `text/plain` part, reads like this:
 * `Acme [cdn.example.com/email/logo_chip.p…]`, a call to action flattened to
 * `[tracker.example.com/ls/click?u=…]`, and — as the last visible line —
 * `[tracker.example.com/wf/open?u=…]`, **which is a tracking pixel printed as prose**.
 * Every bracket is `htmlToText` inlining a `src` or an `href` it had nowhere else to put.
 * That output is the `text/plain` ALTERNATIVE of a `multipart/alternative`, and adding
 * paragraphs and linkification to it — which is what the plain-text renderer does — cannot
 * fix a wrong input.
 *
 * The html was there the whole time. `normalizeMime` keeps `htmlBody`; `pipeline.ts` stores
 * it in `message_bodies.html`; `message-service.ts` `getBody` returns it; the route ships
 * it. It died at `http-adapter.ts`, whose `fetchBody` narrowed the wire to `{ text }` with
 * a comment saying html was not read because rendering it "would need a sanitiser, and it
 * is also where a tracking pixel re-enters a product whose spy-pixel blocker is a feature".
 * Both of those objections are what this file is.
 *
 * ── THE SHAPE: SANITIZE, THEN CONTAIN. THEY ARE NOT THE SAME JOB ────────────────────────
 *
 * The sanitizer decides WHAT THE DOCUMENT SAYS: no script, no event handler, no form, no
 * frame, no `javascript:`, no `<base>`, no `<meta refresh>`, and no remote reference of any
 * kind. It is DOMPurify — cure53's, `(MPL-2.0 OR Apache-2.0)`, zero runtime dependencies —
 * chosen over hand-rolling because it parses with the BROWSER'S OWN parser, which is the
 * only way to have no parser differential between what the sanitizer inspects and what the
 * renderer later builds. (Licence check: Apache-2.0 is GPLv3-compatible, so it is safe
 * beside the GPL-3.0 desktop; it is not AGPL, which this repo forbids outright.)
 *
 * The frame decides WHAT THE BROWSER MAY DO: a `sandbox`ed `<iframe srcdoc>` carrying its
 * own `Content-Security-Policy` meta. Not belt-and-braces — a second mechanism answering a
 * different question. The sanitizer cannot contain layout: a `<style>` in the app's own
 * document reaches the app's own chrome, and the one thing a mail must never do is restyle
 * the client around it. And the frame cannot enumerate: it will happily render a `<form>`
 * that asks for a password. Each one is watched failing on its own in `message-body.test.ts`.
 *
 * The frame is also what lets the sender's `<style>` SURVIVE, which is most of why mail
 * looks like mail here at all. A stylesheet that cannot escape its document is not a threat;
 * stripping it is what turns a designed newsletter into a ransom note.
 *
 * ── `sandbox` — EVERY TOKEN, AND WHY THE TWO ABSENT ONES MATTER MOST ────────────────────
 *
 *   allow-same-origin                 the parent must read `contentDocument` to size the
 *                                     frame to the mail. **Safe only because
 *                                     `allow-scripts` is absent**: same-origin without script
 *                                     hands the document no principal that could use it. The
 *                                     pair `allow-scripts allow-same-origin` is the
 *                                     combination that lets a frame remove its own sandbox,
 *                                     and it is exactly the pair this never has.
 *   allow-popups                      a clicked link opens a tab. Nothing can open one
 *                                     WITHOUT a click: `window.open` needs script, and
 *                                     `<meta refresh>` is not an allowed tag.
 *   allow-popups-to-escape-sandbox    the tab a reader chose to open is an ordinary tab.
 *
 *   NOT allow-scripts                 nothing executes. Ever.
 *   NOT allow-forms                   the credential prompt inside a phishing mail submits
 *                                     nowhere.
 *   NOT allow-top-navigation          the mail cannot navigate the app away, with or
 *                                     without a gesture.
 *
 * ── REMOTE CONTENT IS BLOCKED, AND "BLOCKED" MEANS NOT REQUESTED ────────────────────────
 *
 * Opening a message performs ZERO requests to any host the sender named. Not a proxied one,
 * not a cached one, none. Every `src`, `srcset`, `background`, CSS `url()`, `image-set()` and
 * `@import` is removed before the document is built, and the injected `default-src 'none'` is
 * what makes that true for whatever shape of remote reference this file has not thought of
 * yet — a rewriting rule I forgot is a bug; a CSP I forgot is not reachable, because the
 * policy is a deny-list of nothing and an allow-list of `data:`.
 *
 * The last three of those shapes were ADDED on 2026-08-04, and the sentence above was false
 * until then: `image-set("https://…")`, a scheme written in CSS escapes (`url(htt\70 s://…)`)
 * and `@import"…"` with no whitespace each reached Chromium's network stack and were refused
 * by the CSP alone, while the bar counted zero and said nothing. The CSP held. The claim did
 * not, and a claim is the thing under test here.
 *
 * ── AND THE DOCUMENT THE BROWSER BUILDS IS THE ONE THE SANITIZER APPROVED ────────────────
 *
 * That was also untrue until 2026-08-04. The `@import` rewrite ran on a `<style>` element's
 * TEXT after DOMPurify had finished, `<style>` serializes raw, and a DELETION can join the two
 * halves of a close tag that were never adjacent — so `sanitizeMailHtml` returned markup that
 * read as cleared and became a live `<form>` the moment the frame parsed it. The arrangement
 * that closes it is one rule, stated on {@link sanitizeMailHtml}: **text is rewritten only
 * BEFORE the sanitizer; after the sanitizer only attributes change.**
 *
 * This is the promise the product is named for, and until this file it was unkept in the one
 * place it is made: the server-side privacy service and its tracker blocker were built,
 * hardened and tested, and **nothing in the reading path ever called them** — which is why
 * `en.json` still says "Spy pixels, not yet".
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not fetch a blocked image after consent, and the consent button is therefore
 * absent rather than dead. Loading one means routing it through `GET /img` — the
 * server-side proxy, whose whole purpose is that the SENDER never sees the reader's IP —
 * and that route is deliberately unmounted (the image-proxy route is not mounted) with a
 * mutation-watched test keeping it off. Mounting it is a security decision with its own
 * review, not a side effect of a rendering slice. `imageProxy` below is the seam it lands
 * on, and it is exercised by the tests so it is not an untested branch waiting to be wrong.
 *
 * It does not resolve `cid:` images either — those are attachment parts, they cannot phone
 * home, and the endpoint that serves their bytes belongs to the attachment surface.
 *
 * ── NOTHING RENDERED IS STORED ──────────────────────────────────────────────────────────
 *
 * `buildMailDocument` is called during render from the html the engine already holds. No
 * sanitized output is persisted, mirrored, or sent anywhere.
 */

import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalTheme } from "@ohmail/ui";
import { BodyText } from "../shell/BodyText";
import { UI_KEYS, usePersistedIdSet } from "../shell/persisted-ui";
import "./message-body.css";

/**
 * COPY LIVES HERE RATHER THAN IN THE TRANSLATION CATALOGUE — for now, and with one exit.
 *
 * These sentences have no keys in `apps/webapp/messages/en.json` yet, so they are declared
 * locally under the `mailBody` namespace they will take there. Adding the keys and swapping
 * this constant for `useTranslations("mailBody")` is then a one-line change with exactly one
 * place to make it. `AttachmentStrip` carries the same shim for the same reason.
 */
export const COPY = {
  blockedOne: "1 remote image blocked.",
  blockedMany: (n: number) => `${n} remote images blocked.`,
  pixelOne: "One of them is a tracking pixel.",
  pixelMany: (n: number) => `${n} of them are tracking pixels.`,
  pixelOnly: "A tracking pixel was blocked.",
  show: "Show images",
  showing: "Images loaded for this message.",
  /** The dark-viewer toggle. Shown only in a dark theme; flips THIS message between the
   *  adapted (dark) rendering and its original light one, and the choice is remembered. */
  darkOriginal: "Original",
  darkAdapt: "Adapt to dark",
  darkOriginalTitle: "Show this message in its original colours",
  darkAdaptTitle: "Adapt this message to the dark theme",
  frameTitle: "Message content",
  unsupported: "Showing the plain-text version of this message.",
  /**
   * SAID AFTER the image sentence, never before it. The browser-level test of the blocking
   * bar reads the FIRST number in it and holds that against the number of remote images the
   * message names, so a stylesheet count in front would make the check measure the wrong
   * thing.
   */
  sheetOne: "A remote stylesheet was blocked, so this message may look plain.",
  sheetMany: (n: number) =>
    `${n} remote stylesheets were blocked, so this message may look plain.`,
  /** The size fallback. It states the reason, because a bare plain-text render reads as a bug. */
  oversize: "This message's HTML part is too large to render safely. Showing the plain-text version.",
} as const;

// ── the allow-lists ────────────────────────────────────────────────────────────────────

/**
 * THE TAGS A MAIL MAY USE. An allow-list, so a tag nobody has thought about is absent by
 * default rather than present by default.
 *
 * `style` is here and it is the interesting one — see the header: a stylesheet that cannot
 * leave its document is what makes a newsletter look like a newsletter. Its TEXT is still
 * rewritten ({@link neutraliseCss}) so it cannot name a remote url — BEFORE this list is
 * applied, never after. That ordering is the whole of the mutation-XSS rule stated on
 * {@link sanitizeMailHtml}.
 *
 * Everything a mail client's own bug reports are made of is absent BY OMISSION: `script`,
 * `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `form`, `input`, `button`,
 * `select`, `textarea`, `base`, `link`, `meta`, `noscript`, `template`, `svg`, `math`,
 * `audio`, `video`, `source`, `canvas`.
 *
 * ── A `FORBID_TAGS` LIST STOOD HERE AND WAS DELETED, BECAUSE IT COULD NOT BE WATCHED ────
 *
 * It named those same tags a second time. The mutation test says what that was worth:
 * emptying `FORBID_TAGS` altogether left the suite GREEN, because an allow-list already
 * refuses everything it does not name. So it was the shape this repo keeps warning about —
 * "two overlapping guards read as belt-and-braces and behave as neither: deleting one
 * leaves the test green, so neither one is ever proven to do anything". One list, one
 * deletion point: `message-body.test.ts` mutates by ADDING `iframe`, `form` and `object`
 * to this array, and that goes red.
 */
const ALLOWED_TAGS = [
  "a", "abbr", "acronym", "address", "area", "article", "aside", "b", "bdi", "bdo", "big",
  "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "data", "dd",
  "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd",
  "label", "legend", "li", "main", "map", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u",
  "ul", "var", "wbr",
];

/**
 * The four attributes whose value NAMES A RESOURCE. Kept apart from the rest because
 * DOMPurify's URI check applies to every attribute it is not told to exempt — see
 * {@link PRESENTATION_ATTR}.
 */
const URL_ATTR = ["href", "src", "srcset", "background"];

/**
 * The presentational vocabulary bulk mail is actually written in. No `on*` in it.
 *
 * ── THESE MUST BE DECLARED URI-SAFE, AND FINDING THAT OUT COST AN EXPERIMENT ────────────
 *
 * DOMPurify runs `ALLOWED_URI_REGEXP` against the value of EVERY attribute except the ones
 * in its `URI_SAFE_ATTRIBUTES` set (`alt`, `class`, `id`, `style`, `title`, `role`, …). With
 * {@link SAFE_HREF} as that regexp — which is strict, and deliberately so — `width="100%"`,
 * `align="center"`, `bgcolor="#fff"` and `cellpadding="0"` all FAIL it and are stripped.
 *
 * Measured against dompurify 3.4.13: `<table width="100%" align="center" cellpadding="0">`
 * came back as `<table>`, and every fixed-width mail collapsed to a single unstyled column
 * while every security assertion stayed green. That is the failure shape this repo keeps
 * naming — a change that is correct about safety and silently wrong about the product — so
 * it is written down here rather than left as a list somebody has to re-derive.
 */
const PRESENTATION_ATTR = [
  "alt", "title", "width", "height", "align", "valign", "border", "cellpadding",
  "cellspacing", "bgcolor", "style", "class", "id", "colspan", "rowspan", "dir", "lang",
  "type", "start", "value", "size", "color", "face", "abbr", "headers", "scope", "span",
  "role", "aria-label", "aria-hidden", "datetime",
];

const ALLOWED_ATTR = [...URL_ATTR, ...PRESENTATION_ATTR];

/**
 * THE URI GATE — ONE CONSTANT, ENFORCED TWICE, DELETABLE IN ONE PLACE.
 *
 * It is handed to DOMPurify as `ALLOWED_URI_REGEXP` (which strips a failing `href` before
 * this file ever sees the node) AND read again in the hook (which is what decides that a
 * link with no usable href becomes visible-but-inert rather than silently unclickable).
 *
 * That is deliberately NOT two guards. `BodyText`'s header states the rule this follows:
 * "two overlapping guards read as belt-and-braces and behave as neither — deleting one
 * leaves the test green, so neither one is ever proven to do anything". Here there is one
 * value. Widen it to `/./` and BOTH enforcement points open at once, which is exactly the
 * mutation `message-body.test.ts` performs to prove the gate is load-bearing.
 *
 * `cid:` is admitted because it names a part of this very message and cannot leave the
 * machine. `data:` is NOT: a `data:text/html` href navigates to attacker markup, and every
 * legitimate use of `data:` in mail is an image, which is a `src` and handled as one.
 */
const SAFE_HREF = /^(?:https?:|mailto:|tel:|cid:)/i;

/** A scheme that fetches over the network. What "remote" means everywhere in this file. */
const REMOTE_URL = /^https?:\/\//i;

/** A 1×1 fully-transparent GIF. Stands in for every blocked image, including the beacon. */
const BLANK_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// ── what was blocked ───────────────────────────────────────────────────────────────────

export interface BlockedAsset {
  /** The url the sender asked us to fetch. Never fetched; carried so consent can. */
  url: string;
  /** Its host, lowercased — what a reader is shown, and "" if it does not parse. */
  host: string;
  /** Where it was named: an image, a CSS `url()`, or an element's `background` attribute. */
  via: "img" | "css" | "attr";
  /**
   * A beacon rather than a picture. Decided from TWO signals that are in the message itself
   * — declared 1×1/0×0 dimensions, and a beacon-shaped path — and deliberately NOT from a
   * host list. the server's tracker-blocker keeps such a list, it is not
   * importable here (`@trafficflow/core` is a node package: mailparser, `node:crypto`), and
   * a second copy of it would drift. Nothing is blocked BECAUSE of this flag — everything
   * remote is blocked either way — so the only thing it can be wrong about is a sentence.
   */
  pixel: boolean;
}

/**
 * A url shaped like an open-tracking beacon. The common bulk-sender form —
 * `tracker.example.com/wf/open?u=…` — matches on `/wf/open`; the rest of the alternation is
 * the other spellings the same beacon is published under.
 */
const BEACON_PATH =
  /(?:\/(?:wf\/open|open|track|tracking|beacon|pixel|imp|impression)(?:[/?#]|$)|\.(?:gif|png)\?)/i;

/** The host of a url, lowercased, or "" when it will not parse. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** A CSS/HTML length that is 1 or 0 — `"1"`, `"1px"`, `"0"`. `null` when it is not a number. */
function tinyDimension(v: string | null): boolean {
  if (v == null) return false;
  const n = Number(v.replace(/px$/i, "").trim());
  return Number.isFinite(n) && n <= 1;
}

/** True when an `<img>` DECLARES itself invisible — the classic beacon shape. */
function declaresPixel(el: Element): boolean {
  if (tinyDimension(el.getAttribute("width")) && tinyDimension(el.getAttribute("height"))) return true;
  const style = el.getAttribute("style") ?? "";
  const w = /(?:^|;)\s*width\s*:\s*([^;!]+)/i.exec(style);
  const h = /(?:^|;)\s*height\s*:\s*([^;!]+)/i.exec(style);
  return tinyDimension(w?.[1] ?? null) && tinyDimension(h?.[1] ?? null);
}

// ── CSS ────────────────────────────────────────────────────────────────────────────────

/**
 * ── WHAT REPLACES A CUT RULE, AND WHY IT IS NOT THE EMPTY STRING ────────────────────────
 *
 * ONE PASS OVER A STYLESHEET HAS TO BE A FIXED POINT, and an empty replacement is what stops
 * it being one. Deleting `@import q;` from `@im@import q;port"https://…";` leaves
 * `@import"https://…";` — a rule that was nowhere in the input and that this pass has already
 * walked past. Measured 2026-08-04: that stylesheet reached the frame and the sheet was
 * requested. `;` makes the arithmetic impossible instead of merely unlikely, and it is correct
 * CSS in every position an `@import` may appear — an empty statement at the top of a sheet, an
 * empty declaration inside a block, discarded either way.
 *
 * **This is a claim about CSS TOKENS and not about markup.** What keeps a rewrite from
 * inventing an ELEMENT is `sanitizeMailHtml`'s arrangement: this runs BEFORE
 * `purify.sanitize`, on text that the sanitizer then re-parses, so anything it invents is
 * something the allow-list reads and refuses. Saying it twice here would be the shape this
 * repo keeps paying for — two guards that read as belt-and-braces and behave as neither.
 *
 * The watched claim is idempotency: `neutraliseCss(neutraliseCss(x)) === neutraliseCss(x)`,
 * and `message-body-mutation-xss.test.ts` mutates this constant to `""` to prove it.
 */
const CUT = ";";

/**
 * A character an identifier may continue with. `@import` is only `@import` when the at-rule
 * NAME ends there — `@imports` and `@import\75 rl` are different rules and must not be cut.
 * Non-ASCII is an ident character in CSS, hence the `\u0080-` range rather than `[a-z0-9_-]`.
 */
function continuesIdent(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x5c || // \  an escape continues the identifier
    code >= 0x80
  );
}

/**
 * The three token starts this file understands, found in ONE forward scan.
 *
 * ── IT IS A TOKEN FINDER, NOT A TOKEN MATCHER, AND THAT IS THE POINT ────────────────────
 *
 * The rule this replaces was `/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi`, and `[^'")]+` cannot
 * cross `)` — so on an input with no `)` at all, EVERY `url(` start scans to the end of the
 * string before failing. That is quadratic, it runs synchronously inside `useMemo` on the
 * main thread during render, and it was measured at 125 KB → 6.1 s, 500 KB → 95.3 s. A
 * 500 KB marketing email is an ordinary marketing email.
 *
 * This pattern has no quantifier that can backtrack; every terminator below is found with a
 * single `indexOf` from a position that only ever moves forward, so the whole pass is linear
 * in the length of the stylesheet. An unterminated token ends the scan and the remainder is
 * copied verbatim — a token the browser will not parse either.
 */
const CSS_TOKEN = /@import|(?:-webkit-)?image-set\(|url\(/gi;

/**
 * `\70` is `p`. `url(htt\70 s://evil.example/x)` is `https://` to the CSS tokenizer and is
 * fetched; it is not `https://` to a regexp reading the raw text, which is how that shape
 * reached the network and was still counted as zero blocked.
 *
 * Decoding is used ONLY to decide whether a token is remote. Nothing decoded is ever emitted,
 * so a decoding this gets wrong can cost a picture and can never manufacture a url.
 */
function decodeCssEscapes(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g,
    (_m, hex: string | undefined, literal: string | undefined) => {
      if (hex === undefined) return literal ?? "";
      const cp = Number.parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff) return "\uFFFD";
      try {
        return String.fromCodePoint(cp);
      } catch {
        return "\uFFFD";
      }
    },
  );
}

/** A url this file emits into CSS, with the two characters that could leave the string gone. */
function cssString(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, "");
}

/** The `)` that closes the `(` we just consumed, or -1. Quote-aware, single forward pass. */
function closingParen(css: string, from: number): number {
  let depth = 1;
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const close = css.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The body of a `url(` token and the index just past its `)`, or null when it never closes. */
function readUrlToken(css: string, from: number): { raw: string; end: number } | null {
  let i = from;
  while (i < css.length && css.charCodeAt(i) <= 0x20) i++;
  const quote = css[i];
  if (quote === '"' || quote === "'") {
    const close = css.indexOf(quote, i + 1);
    if (close === -1) return null;
    const paren = css.indexOf(")", close + 1);
    if (paren === -1) return null;
    return { raw: css.slice(i + 1, close), end: paren + 1 };
  }
  const paren = css.indexOf(")", i);
  if (paren === -1) return null;
  return { raw: css.slice(i, paren), end: paren + 1 };
}

/**
 * Every REMOTE url a token's body names, in any of the spellings that fetch: a `url()`, or a
 * bare string — which is how `image-set("https://…" 1x)` and `@import"https://…";` name one.
 */
function remoteUrlsIn(inner: string): string[] {
  const urls: string[] = [];
  for (const m of inner.matchAll(/url\(\s*['"]?([^'")]*)/gi)) urls.push(m[1] ?? "");
  for (const m of inner.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) urls.push(m[1] ?? m[2] ?? "");
  return urls.map((u) => decodeCssEscapes(u).trim()).filter((u) => REMOTE_URL.test(u));
}

/**
 * Take everything out of a stylesheet that names a network resource: `@import` outright, and
 * every remote `url(…)` through `onRemote`, which decides what replaces it.
 *
 * WHAT THIS IS FOR, precisely — it is not the enforcement. `default-src 'none'` in the
 * frame's own CSP is what makes a remote `url()` unfetchable, and it holds for CSS shapes
 * this scanner does not understand. This exists so the reader is not shown a broken box where
 * a background was, so the bar can COUNT what the mail tried to fetch, and so a CONSENTED
 * background can be pointed at the proxy like any other image. Delete it and nothing leaks;
 * delete the CSP and everything does. `message-body.test.ts` watches the CSP assertion fail
 * on its own for that reason.
 *
 * ── THREE SHAPES IT USED TO MISS, AND EACH ONE REACHED THE NETWORK ──────────────────────
 *
 *   `@import"…";`           legal CSS, and the old rule required `\s+` after `@import`.
 *   `url(htt\70 s://…)`     the scheme written in CSS escapes; see {@link decodeCssEscapes}.
 *   `image-set("…" 1x)`     names an image with a bare string and no `url()` token at all.
 *
 * All three were requested by Chromium and refused by the frame's CSP, so nothing leaked —
 * and `blocked` stayed empty, so the reader was shown no notice. That is the defect: the
 * accounting layer said a thing had not happened. `image-set()` collapses to `none` rather
 * than being rewritten candidate by candidate, which costs a consented image-set background
 * (there is no consent path mounted today, and the shape is vanishingly rare in mail) and
 * keeps this function's output impossible to get subtly wrong.
 *
 * `@import` is cut whole rather than rewritten: it names a STYLESHEET, and there is no consent
 * story for handing a sender's css through a proxy that only understands images. That is also
 * why it reports through `onSheet` and not through `onRemote`: `blocked` feeds the "Show
 * images" affordance, and an entry in it that can never be consented to would make that button
 * lie. It is still SAID — see {@link COPY.sheetOne} — because an `@import`-only newsletter
 * renders unstyled, and letting the reader guess why is the "blocking silently is its own
 * defect" case in its purest form.
 */
export function neutraliseCss(
  css: string,
  onRemote: (url: string) => string | null,
  onSheet: (url: string) => void = () => {},
): string {
  if (css.length === 0) return css;
  let out = "";
  let copied = 0;
  CSS_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSS_TOKEN.exec(css)) !== null) {
    const start = m.index;
    let end: number;
    let replacement: string;

    if (m[0][0] === "@") {
      // `@import`, and only when the at-rule NAME ends here. An unterminated prelude runs to
      // the end of the sheet — CSS Syntax §5.4.2 ends an at-rule at EOF — so cutting to EOS is
      // not a shortcut, it is the same span the browser would have consumed.
      if (continuesIdent(css.charCodeAt(CSS_TOKEN.lastIndex))) continue;
      const semi = css.indexOf(";", CSS_TOKEN.lastIndex);
      end = semi === -1 ? css.length : semi + 1;
      for (const url of remoteUrlsIn(css.slice(CSS_TOKEN.lastIndex, end))) onSheet(url);
      replacement = CUT;
    } else if (m[0].endsWith("image-set(")) {
      // AN UNCLOSED FUNCTION IS STILL A REFERENCE. CSS Syntax §4.3.6 closes a `url` token at
      // EOF and returns it, so "copy the remainder verbatim and stop" would leave a live,
      // uncounted remote url behind — the DoS-safe answer and the leak-unsafe one. Everything
      // from the token to the end goes.
      const close = closingParen(css, CSS_TOKEN.lastIndex);
      end = close === -1 ? css.length : close + 1;
      const remote = remoteUrlsIn(css.slice(CSS_TOKEN.lastIndex, end));
      for (const url of remote) onRemote(url); // counted even though the whole set is dropped
      replacement = remote.length > 0 || close === -1 ? "none" : css.slice(start, end);
    } else {
      const token = readUrlToken(css, CSS_TOKEN.lastIndex);
      end = token === null ? css.length : token.end;
      const raw = token === null ? css.slice(CSS_TOKEN.lastIndex) : token.raw;
      const url = decodeCssEscapes(raw).trim();
      if (REMOTE_URL.test(url)) {
        const proxied = onRemote(url);
        replacement = proxied === null ? "none" : `url("${cssString(proxied)}")`;
      } else if (token === null) {
        replacement = "none"; // unterminated: the browser reads it to EOF, so so do we
      } else {
        // data: and cid: stay, verbatim. Nothing is fetched by them.
        replacement = css.slice(start, end);
      }
    }

    out += css.slice(copied, start) + replacement;
    copied = end;
    CSS_TOKEN.lastIndex = end;
  }
  return copied === 0 ? css : out + css.slice(copied);
}

/**
 * Rewrite remote `url()` in ONE element's inline `style` by the same rule.
 *
 * This one runs AFTER the sanitizer, and it is allowed to because it writes an ATTRIBUTE: the
 * html serializer quotes every attribute value and escapes `&` and `"` inside it, so a value
 * cannot end its own attribute however it is composed. Element TEXT has no such property,
 * which is the whole of {@link CUT}.
 */
function neutraliseStyleAttr(el: Element, onRemote: (url: string) => string | null): void {
  const style = el.getAttribute("style");
  if (!style || !/url\(|image-set\(|@import/i.test(style)) return;
  el.setAttribute("style", neutraliseCss(style, onRemote));
}

// ── links ──────────────────────────────────────────────────────────────────────────────

/**
 * Does the visible text of this link DISAGREE with where it goes?
 *
 * The case this exists for is the ordinary click-tracked call to action: a link labelled
 * "Manage your subscription" pointing at `tracker.example.com/ls/click?u=…`. A reader cannot
 * tell from the page that the click is counted, and the honest thing is to say the
 * destination out loud rather than to hide it or to refuse the link.
 *
 * The test is deliberately narrow — the visible text NAMES A HOST, and it is not the host
 * the link goes to. Broadening it to "the text is not the url" would flag every ordinary
 * link in every ordinary message, which is a warning that means nothing by the second one.
 */
export function textDisagreesWithHref(text: string, host: string): boolean {
  // BOUNDED BEFORE IT IS MATCHED. The subject is a sender-authored link label, so it can be
  // any size at all, and `(?:[a-z0-9-]+\.)+` over a megabyte of dotted junk is the same class
  // of main-thread stall the CSS scanner above is written to avoid. A link whose visible text
  // names a host names it at the front; 2 KiB is far past any label a reader can see.
  const claimed = /(?:^|\s)(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/\s]|$)/i.exec(
    text.trim().slice(0, 2048),
  );
  if (!claimed) return false;
  const claimedHost = claimed[1]!.toLowerCase();
  if (!host) return true;
  return claimedHost !== host && !host.endsWith(`.${claimedHost}`);
}

// ── the sanitizer ──────────────────────────────────────────────────────────────────────

export interface SanitizeOptions {
  /**
   * How to reach a remote image, or `null` for "you may not". `null` is the default and the
   * only value the product ships today; see the header for why the consent path waits on a
   * route. A function here rewrites every blocked url through it instead of blanking it —
   * which is the ONLY way an image may ever load, because it is what keeps the sender from
   * seeing the reader's address.
   */
  imageProxy?: ((url: string) => string) | null;
}

export interface SanitizedMail {
  /** The body markup, ready to be put in a frame. Never stored, never sent anywhere. */
  html: string;
  /** Every remote resource the sender named and we refused. */
  blocked: BlockedAsset[];
  /**
   * Remote STYLESHEETS, kept apart from {@link blocked} rather than mixed into it.
   *
   * `blocked` is what the "Show images" affordance would load; a sheet can never be loaded
   * through an image proxy, so an entry there would make that button lie about what it does.
   * It is still counted and still said, because an `@import`-only newsletter arrives unstyled
   * and a reader with no sentence to read has been failed twice.
   */
  sheets: string[];
  /**
   * The html part was past {@link MAX_HTML_CHARS} and was not rendered at all. Present only
   * in that case, so an ordinary message carries no flag to test.
   */
  oversize?: true;
}

/**
 * THE FLOOR UNDER THE MAIN THREAD, AND IT IS NOT A PERFORMANCE PREFERENCE.
 *
 * Everything below runs synchronously inside `useMemo` — during render, on the thread that
 * paints the app. Linear is a claim about the shapes measured; a cap is a claim about the
 * shape nobody has measured yet. Crossing it renders the text part with {@link COPY.oversize}
 * saying why, which is the honest outcome; hanging is not an outcome at all.
 *
 * 512 KiB is deliberately generous: `prepareHtmlForStorage` already cuts `message_bodies.html`
 * at 256 KiB, so nothing that arrives through the product can reach this. It exists for the
 * path that does not go through storage and for the day that cap moves.
 */
export const MAX_HTML_CHARS = 512 * 1024;

/** True when this environment has a DOM the sanitizer can parse with. */
export function sanitizerAvailable(): boolean {
  return typeof window !== "undefined" && DOMPurify.isSupported === true;
}

/**
 * Sanitize one message's html.
 *
 * Returns markup, not a document — {@link buildMailDocument} is what wraps it, and keeping
 * the two apart is what lets a test assert on the CSP and on the sanitization separately.
 *
 * THROWS nothing. An input this cannot parse yields empty markup, and the component falls
 * back to the text part, which is the same outcome as a message that had no html at all.
 *
 * ── ONE RULE, AND IT REPLACED A DOMPURIFY HOOK: TEXT BEFORE, ATTRIBUTES AFTER ────────────
 *
 * This used to be a single `afterSanitizeAttributes` hook that did everything. It shipped a
 * mutation-XSS, and the shape of the bug is worth more than the payload: **it edited the
 * sanitizer's output as TEXT.** A `<style>` element serializes raw, so rewriting its text
 * after DOMPurify has approved the document means the browser builds a different document
 * from the one that was approved — see {@link CUT} for the arithmetic and the payload.
 *
 * So the work is split by what it touches, and the split is the invariant:
 *
 *   PRE-PASS   the ONLY text rewrite in this file, and it runs before `purify.sanitize`, on
 *              every `<style>` in the parsed document — head and body alike, because the head
 *              hoist above moves NODES and this walks the result. Whatever markup a rewrite
 *              could invent is therefore markup the sanitizer then reads and refuses. The
 *              sanitizer has the last word by construction rather than by care.
 *
 *   POST-PASS  attributes only, over the document the FRAME will have. That is what closes
 *              the second half of the same finding: the hook could only reach nodes DOMPurify
 *              walked, so an `<a>` that appeared later carried no `rel`, no `target`, no
 *              `data-ohmail-host` and no mismatch marker — every anti-phishing affordance the
 *              slice was built around, silently absent on the one link that was hostile.
 *              "There are no injected nodes" is exactly the assumption that failed, so this
 *              pass assumes nothing and annotates whatever is there.
 *
 * An attribute write cannot re-open the parser the way a text write can: the html serializer
 * quotes every attribute value and escapes `&` and `"` within it, so no composed value ends
 * its own attribute. That asymmetry is the whole reason the line falls where it does.
 *
 * `RETURN_DOM: true` is what makes the post-pass possible without a second parse. Measured
 * against dompurify 3.4.13's own source: the string path is literally `body.innerHTML` of the
 * node this returns (`purify.cjs.js:2389-2414`), so the two are the same document and no
 * behaviour is traded for the seam. It returns `null` for empty input, which is handled.
 */
export function sanitizeMailHtml(html: string, opts: SanitizeOptions = {}): SanitizedMail {
  const blocked: BlockedAsset[] = [];
  const sheets: string[] = [];
  const proxy = opts.imageProxy ?? null;

  if (!sanitizerAvailable()) return { html: "", blocked, sheets };
  if (html.length > MAX_HTML_CHARS) return { html: "", blocked, sheets, oversize: true };

  const seen = new Set<string>();
  const record = (url: string, via: BlockedAsset["via"], pixel: boolean): void => {
    const key = `${via}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocked.push({ url, host: hostOfUrl(url), via, pixel });
  };
  const recordSheet = (url: string): void => {
    if (!sheets.includes(url)) sheets.push(url);
  };

  /**
   * `<style>` LIVES IN `<head>`, AND THE SANITIZER ONLY EVER SEES `<body>`.
   *
   * DOMPurify parses into a body context and returns the body's content, so a stylesheet in
   * the head is silently dropped — which would mean every designed mail arrives unstyled and
   * the whole point of rendering html is lost. So the styles are moved into the body first,
   * in source order, where `<style>` is still valid html and the sanitizer can see them.
   *
   * The head is otherwise discarded, which is how `<base href>` and `<meta http-equiv=
   * refresh>` leave — and they are also in {@link FORBID_TAGS}, because "the parser happened
   * to put it somewhere we throw away" is not a rule anybody can rely on.
   */
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const headStyles = [...parsed.head.querySelectorAll("style")];
  for (const s of headStyles.reverse()) parsed.body.insertBefore(s, parsed.body.firstChild);

  const purify = DOMPurify;

  /**
   * What replaces a remote `url()` in css: the proxy when the reader has consented and the
   * url is not beacon-shaped, `null` (⇒ `none`) otherwise.
   *
   * A css `url()` in a STYLESHEET has no width or height to inspect, so {@link BEACON_PATH} is
   * the only signal there. On an `<img>`'s own inline `style` there IS one, and `declaresPixel`
   * is passed in as `tiny` — otherwise a 1×1 image whose beacon hides in a css background
   * classifies as a picture. That asymmetry is the reason this is a named function rather than
   * an inline lambda: the img branch and this one must agree that a beacon is never fetched,
   * and one place saying it is easier to keep true than two.
   */
  const cssUrl = (url: string, tiny = false): string | null => {
    const beacon = tiny || BEACON_PATH.test(url);
    record(url, "css", beacon);
    return proxy && !beacon ? proxy(url) : null;
  };

  /**
   * THE POST-PASS, ONE ELEMENT AT A TIME. Attributes only — see the header of this function
   * for why that is the line and not a coincidence. It runs over the FINAL document, so what
   * it annotates is what the reader gets, however that element came to be there.
   */
  const onAttributes = (node: Element): void => {
    const tag = node.tagName.toLowerCase();

    // Decided FIRST, and used by both the style-attribute rewrite below and the img branch, so
    // the answer cannot depend on which of them happens to run first.
    const pixel =
      tag === "img" && (declaresPixel(node) || BEACON_PATH.test(node.getAttribute("src") ?? ""));

    neutraliseStyleAttr(node, (url) => cssUrl(url, pixel));

    // `background="…"` on <body>/<table>/<td> is html 3.2 and bulk mail still emits it.
    // Dropped rather than rewritten even under consent: it is a deprecated attribute with no
    // reliable layout meaning left, and nothing in the last fifteen years of mail depends on
    // it rendering. Counted, so the bar still says it was there.
    const bg = node.getAttribute("background");
    if (bg) {
      node.removeAttribute("background");
      if (REMOTE_URL.test(bg)) record(bg, "attr", BEACON_PATH.test(bg));
    }

    if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      // `srcset` is a second, independent way to name a remote image and a blocker that
      // only reads `src` leaves it fetchable. It is dropped whole rather than parsed:
      // there is no consent story for a candidate set.
      const srcset = node.getAttribute("srcset");
      if (srcset) {
        node.removeAttribute("srcset");
        for (const cand of srcset.split(",")) {
          const u = cand.trim().split(/\s+/)[0];
          if (u && REMOTE_URL.test(u)) record(u, "img", pixel);
        }
      }
      if (REMOTE_URL.test(src)) {
        record(src, "img", pixel);
        // ── A BEACON IS NEVER FETCHED, NOT EVEN AFTER CONSENT, NOT EVEN THROUGH THE PROXY ──
        //
        // Found by driving a real browser at a live newsletter with consent granted: the
        // beacon went through the proxy alongside the message's real images. That is not a
        // leak of the READER — the proxy's url-only signature means their IP never travels —
        // but the ESP still learns that this message was opened, at that minute, because
        // somebody asked. "Show images" is a request for the pictures; nobody consents to a
        // beacon, and there is no image behind one to show. So `pixel` overrides `proxy`.
        //
        // It is decided from the two signals in the message itself ({@link declaresPixel},
        // {@link BEACON_PATH}) and it can therefore be wrong in one direction: a 1×1 image
        // that is genuinely a spacer stays blank. That costs a reader nothing.
        if (proxy && !pixel) {
          node.setAttribute("src", proxy(src));
        } else {
          node.setAttribute("src", BLANK_GIF);
          node.setAttribute("data-ohmail-blocked", "1");
        }
      } else if (!src.startsWith("data:")) {
        // `cid:` and anything relative. Neither can be resolved from here, and a browser
        // renders an unresolvable src as a broken-image glyph in the middle of the mail.
        node.setAttribute("src", BLANK_GIF);
        node.setAttribute("data-ohmail-embedded", "1");
      }
      return;
    }

    if (tag === "a") {
      // Already filtered by `ALLOWED_URI_REGEXP`: a `javascript:` href arrives here as the
      // empty string because DOMPurify removed the attribute. Re-reading the same constant
      // is what turns "no usable destination" into something a reader can SEE — the link
      // stays on screen, struck through, saying so — instead of a live-looking link that
      // does nothing when pressed.
      const href = (node.getAttribute("href") ?? "").trim();
      if (!SAFE_HREF.test(href)) {
        node.removeAttribute("href");
        node.setAttribute("data-ohmail-inert", "1");
        return;
      }
      // Forced, not defaulted. A link with no target navigates the FRAME, which would
      // replace the message with the destination — and would do it without the sandbox's
      // top-navigation permission, so the app would look like it had eaten itself.
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
      const host = REMOTE_URL.test(href) ? hostOfUrl(href) : "";
      if (host) {
        node.setAttribute("data-ohmail-host", host);
        node.setAttribute("title", `Goes to ${host}`);
        if (textDisagreesWithHref(node.textContent ?? "", host)) {
          node.setAttribute("data-ohmail-elsewhere", "1");
        }
      }
    }
  };

  /**
   * ── THE PRE-PASS. THE ONLY TEXT REWRITE IN THIS FILE, AND IT IS UPSTREAM OF EVERYTHING ──
   *
   * Every `<style>` in the document, not just the ones in `<body>`: the hoist above moved the
   * head's stylesheets as NODES, so a single walk covers both and there is no second path to
   * remember. Whatever this produces is a STRING the sanitizer then parses, which is what
   * makes "the sanitizer has the last word" a property of the arrangement rather than a
   * promise — see the comment on the `sanitize` call below, which is where that property
   * actually lives.
   */
  for (const el of parsed.querySelectorAll("style")) {
    el.textContent = neutraliseCss(el.textContent ?? "", (u) => cssUrl(u), recordSheet);
  }

  /**
   * ── THE ARGUMENT IS A STRING, AND THAT IS THE LOAD-BEARING PART ─────────────────────────
   *
   * DOMPurify also accepts a NODE (`purify.cjs.js:2291-2296`), and with `RETURN_DOM` it would
   * work — which is why this is written down rather than left to look like a style choice.
   * Handing it `parsed.body` moves the serialize/reparse round-trip from INSIDE the sanitizer
   * to the caller's own `innerHTML` at the end, and a `<style>` text the pre-pass rewrote
   * would then reach the frame without the sanitizer ever having parsed it — the mutation-XSS
   * this file was rearranged to close, restored by a one-token edit that typechecks.
   */
  const sanitized = purify.sanitize(parsed.body.innerHTML, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: SAFE_HREF,
      ADD_URI_SAFE_ATTR: PRESENTATION_ATTR,
      // ── `FORCE_BODY` IS WHY THE SENDER'S STYLESHEET SURVIVES AT ALL ──────────────────
      //
      // Without it, DOMPurify's own `DOMParser` pass hoists a leading `<style>` into
      // `<head>` — the html parser's ordinary behaviour — and DOMPurify returns
      // `body.innerHTML`, so the stylesheet is silently gone. Measured against dompurify
      // 3.4.13: `<style>.a{color:red}</style><p>hi</p>` sanitized to `<p>hi</p>` under
      // FOUR different configurations, including one that named `style` in `ALLOWED_TAGS`
      // and emptied `FORBID_CONTENTS`. With `FORCE_BODY: true` the same input keeps the
      // style. It is the difference between "mail renders like mail" and "every designed
      // message arrives as a single unstyled column", and no security assertion notices.
      //
      // Safe here for the reason the whole shape is safe: the stylesheet lands in a
      // sandboxed frame with `default-src 'none'`, where it can neither fetch nor escape.
      // DOMPurify's own mXSS rule still removes a `<style>` whose text contains element
      // markup (measured: `<style><img src=x onerror=…></style>` → empty string) — and since
      // the pre-pass above, the text that rule inspects is the NEUTRALISED text, which is the
      // text the frame is going to get. Before, it inspected a string nobody shipped.
      FORCE_BODY: true,
      // ── `ALLOW_DATA_ATTR: false` IS THE GATE ON MARKER FORGERY, AND IT IS THE ONLY ONE ──
      //
      // Everything this file marks up with — `data-ohmail-host`, `data-ohmail-elsewhere`,
      // `data-ohmail-inert`, `target`, `rel` — is written by the post-pass, which runs AFTER
      // DOMPurify has filtered every attribute, so none of them needs to be allowed here.
      // A SENDER'S copy of them must not survive: `<a href="mailto:x@y" data-ohmail-host=
      // "paypal.example">` would otherwise print a host of the sender's choosing beside a
      // link that goes somewhere else — and the post-pass cannot overwrite it, because a
      // `mailto:` has no host to write. This line is what refuses it, and it is the ONLY
      // thing that does: the post-pass deliberately does not clear markers it did not set,
      // because a second removal here would leave this flag unwatchable — deleting either one
      // would keep the suite green and neither would ever be proven to do anything.
      //
      // Measured, not assumed: adding `ADD_ATTR: ["data-ohmail-host", "target"]` — the
      // obvious way to break this — leaves the suite GREEN, because the post-pass overwrites
      // both on any http(s) link. Flipping THIS to `true` is what goes red. The mutation in
      // `message-body.test.ts` is therefore on this flag, and the fixture is a `mailto:`.
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: true,
      KEEP_CONTENT: true,
      RETURN_DOM: true,
    }) as unknown as HTMLElement | null;

  // `IS_EMPTY_INPUT` returns null under `RETURN_DOM`, which is a message with no html left.
  if (!sanitized) return { html: "", blocked, sheets };

  // ── THE POST-PASS. Over the document the frame will have, not the one we handed over. ──
  for (const node of sanitized.querySelectorAll("*")) onAttributes(node);

  return { html: sanitized.innerHTML, blocked, sheets };
}

// ── the document ───────────────────────────────────────────────────────────────────────

/**
 * The frame's own Content-Security-Policy.
 *
 * THIS IS THE ENFORCEMENT. Everything above it is presentation and accounting; this line is
 * what makes "opening a message fetches nothing" true for the remote-reference shape nobody
 * has thought of. It is an allow-list of `data:` over a `default-src 'none'`, so a vector
 * this file does not know about is refused by not being mentioned.
 *
 * `img-src` gains `'self'` — and ONLY `'self'` — when images have been consented to: the
 * one place a consented image may come from is our own image proxy, which fetches
 * server-side so the sender never sees the reader. There is no policy under which this
 * frame may name a sender's host.
 *
 * ── THIS POLICY IS AN INTERSECTION WITH THE APP'S OWN, MEASURED IN CHROME ───────────────
 *
 * A `srcdoc` document inherits the embedder's policy container, so what is enforced is the
 * intersection of this and the policy the app itself is served under. Verified in Chrome
 * rather than assumed: a control page rendering a real marketing message RAW inside a plain
 * `srcdoc` frame, under the app's own CSP, produced five requests and the browser reported
 * every one of them as `[FAILED] csp` — the open-tracking beacon among them. The SAME control
 * with the app CSP removed fetched that beacon successfully, `[200]`. So the app's
 * `img-src 'self' data: blob:` is a real second layer, and the consent path could never have
 * worked by pointing at a sender's host even if this file had let it.
 *
 * It was argued that `'self'` belongs in the BLOCKED policy too, so a future
 * `cid:`-attachment url could render. Not taken, and the disagreement is recorded rather
 * than silently dropped: blocked-by-default is the product's central promise, `'self'` in
 * that state would admit any same-origin image url a sanitizer bug let through, and nothing
 * needs it today — `cid:` references are blanked here, not resolved. The slice that resolves
 * them through `GET /attachments/:id` adds `'self'` deliberately, at the moment something
 * uses it.
 */
export function frameCsp(imagesLoaded: boolean): string {
  return [
    "default-src 'none'",
    `img-src data:${imagesLoaded ? " 'self'" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The stylesheet the frame starts from — the sheet the letter is printed on, and nothing
 * more. It must lose to anything the sender declares, which is why every rule here is
 * unqualified and none of them is `!important`.
 *
 * `img:not([width])` rather than a blanket `img{max-width:100%}`: bulk mail lays itself out
 * with `width=` attributes on images inside fixed-width tables, and clamping those collapses
 * the design. What the clamp is FOR is the other case — a photograph someone pasted at its
 * natural 4 000 px — and that one never carries a width attribute.
 */
const FRAME_CSS = `
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
/* THE ONE !important IN THIS FILE, and it is a MEASUREMENT rule rather than a style
   preference: the frame is measured under a fixed probe viewport, so a sender's body{height:100%}
   would report the probe's height and clip a 2000px mail to it. It is no longer what stops the
   runaway — see measure() — which is why it can now afford to lose a fight it once had to win.
   :root rather than html on purpose: a sender's html,body{height:300vh!important} is equal
   specificity and LATER in the document, so it used to win outright. Chrome, not theory. */
:root,:root>body{height:auto !important}
body{margin:0;padding:16px;background:#fff;color:#1b1b1b;
  font:15px/1.62 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow-wrap:break-word}
img{border:0}
img:not([width]){max-width:100%;height:auto}
a{color:#1a56db}
/* A blocked image keeps its space and says what it is, instead of leaving a broken glyph.
   A 1x1 beacon stays 1x1 and therefore stays invisible — a tracker must not be rewarded
   with a visible box for having tried. */
img[data-ohmail-blocked]:not([width="1"]),img[data-ohmail-embedded]:not([width="1"]){
  background:#f4f3ee;outline:1px dashed #d8d5cc;outline-offset:-1px;min-width:14px;min-height:14px}
/* WHERE A LINK ACTUALLY GOES, without a line of script — the frame has none and never will.
   Shown on hover AND on focus, because a keyboard reader is exactly the person who cannot
   see a status bar. \`title\` carries the same sentence for assistive technology. */
a[data-ohmail-host]:hover::after,a[data-ohmail-host]:focus::after{
  content:" \\2192 " attr(data-ohmail-host);font-size:.82em;opacity:.75;white-space:nowrap}
/* Said WITHOUT hovering when the visible text names one place and the link goes to another
   — the click-tracker case, which is the one an unsuspecting reader cannot see. */
a[data-ohmail-elsewhere]::after{
  content:" (" attr(data-ohmail-host) ")";font-size:.82em;opacity:.7;white-space:nowrap}
a[data-ohmail-inert]{text-decoration:line-through;opacity:.75}
/* ── DARK VIEWING, GATED ON ONE ROOT ATTRIBUTE ─────────────────────────────────────────
   The transform is a single filter on the body — invert lightness, then hue-rotate 180° so
   colours land back near where they started rather than as their complements. White paper
   becomes dark, ink becomes light. It ships in EVERY document, dormant, and is switched by
   :root[data-ohmail-dark] alone: the component sets that attribute on the LIVE frame with
   toggleAttribute (see the effect), so flipping theme never rebuilds the srcdoc and never
   re-parses or re-measures the mail. The body's own default background is a light grey that
   INVERTS to the app's dark panel, so a short mail carrying no background of its own meets
   its surround with no seam. This is a lightness transform, not a redesign: a sender who set
   a dark background gets it inverted to light, which is the known cost of the technique and
   the reason the reader can drop back to the original per message. */
:root[data-ohmail-dark] body{background:#e4e4e4;filter:invert(1) hue-rotate(180deg)}
/* Two wrongs make a right: the body filter negated every picture, so negate the pictures
   back — real images keep their real colours while the page around them stays inverted. */
:root[data-ohmail-dark] img{filter:invert(1) hue-rotate(180deg)}
/* A blocked-image placeholder is OUR chrome, not the sender's picture. Leave it inverted
   WITH the page (filter:none cancels the re-inversion above) so its box reads as a quiet
   dark panel rather than flipping to a light one on the dark surface. */
:root[data-ohmail-dark] img[data-ohmail-blocked],
:root[data-ohmail-dark] img[data-ohmail-embedded]{filter:none}
`;

/**
 * Assemble the whole `srcdoc`. A pure string function on purpose: it is what the jsdom
 * tests assert on, while the live browser test asserts on what a real engine does with it.
 *
 * ── `dark` IS ONE ATTRIBUTE AND NOTHING ELSE ────────────────────────────────────────────
 *
 * The dark transform lives entirely in {@link FRAME_CSS}, gated on `:root[data-ohmail-dark]`.
 * All this option does is stamp that attribute on the root element, so the light and dark
 * documents are byte-identical apart from it — which is the property that lets the live flip
 * be a `toggleAttribute` on the frame's own `documentElement` rather than a rebuilt srcdoc.
 * `message-body.test.ts` pins that: strip the attribute from the dark output and it must equal
 * the light output exactly, so a dark path that wrapped or re-sheeted the body would go red.
 */
export function buildMailDocument(
  bodyHtml: string,
  opts: { imagesLoaded?: boolean; dark?: boolean } = {},
): string {
  return [
    `<!doctype html><html${opts.dark === true ? " data-ohmail-dark=\"1\"" : ""}><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(opts.imagesLoaded === true)}">`,
    // Belongs to the same promise as the CSP: if a consented image is ever fetched through
    // the proxy, not even the path of the page the reader is on travels with it.
    "<meta name=\"referrer\" content=\"no-referrer\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<style>${FRAME_CSS}</style></head><body>`,
    bodyHtml,
    "</body></html>",
  ].join("");
}

/** The sandbox tokens, as one string, so the test and the element read the same source. */
export const FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * THE VIEWPORT EVERY MEASUREMENT IS TAKEN UNDER — a constant, which is the entire point.
 *
 * `vh`, `vw` and a percentage height all resolve against the frame's own box, and that box is
 * what this component WRITES. Pinning it to one number for the duration of the read turns the
 * measurement into a pure function of the content, so there is no loop to damp. 600 px is
 * chosen to be a plausible reading viewport rather than a degenerate one: `100vh` in a mail
 * then renders as something a person would recognise, and `0` would collapse it.
 */
const PROBE_PX = 600;

/**
 * THE CEILING, AND THE SENDER HAS NO SAY IN IT.
 *
 * Measured on the shipped build: a `150vh` child drove `frame.style.height` to 33 554 400 px
 * and the host page's `scrollHeight` to 33 554 432. {@link PROBE_PX} is what stops that
 * arithmetic; this is what stops the arithmetic nobody has thought of. 20 000 px is roughly
 * twenty-five screens — past any newsletter, short of anything that hurts.
 */
const MAX_FRAME_PX = 20_000;

/**
 * THE SCROLLABLE ANCESTORS OF THE FRAME, nearest first, plus the document scroller.
 *
 * {@link measure} sizes the frame by briefly SHRINKING it to {@link PROBE_PX}. Anything that
 * scrolls above the frame — the reading pane, the app column, the page itself — has its own
 * `scrollHeight` drop by the difference the instant the frame shrinks, and the browser clamps
 * that element's `scrollTop` to the new, smaller maximum during the forced layout the probe
 * read triggers. Restoring the frame's height does NOT unclamp it. These are the elements
 * whose `scrollTop` the probe must capture and put back, or a reader who has scrolled down is
 * yanked toward the top on every reflow: every remote image that loads, every column resize.
 *
 * jsdom performs no layout, so `scrollHeight`/`clientHeight` are both 0 there and this returns
 * `[]` — the whole preservation is a no-op under the unit suite and only does work in a real
 * engine, which is why #95's acceptance is a browser check, not a jsdom one.
 */
function scrollAncestors(el: Element): Element[] {
  const out: Element[] = [];
  let node: Element | null = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (
      (oy === "auto" || oy === "scroll" || oy === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      out.push(node);
    }
    node = node.parentElement;
  }
  const se = el.ownerDocument.scrollingElement;
  if (se && !out.includes(se) && se.scrollHeight > se.clientHeight) out.push(se);
  return out;
}

// ── the component ──────────────────────────────────────────────────────────────────────

export interface MessageBodyProps {
  /**
   * WHICH MESSAGE THIS IS — carried only so the dark-viewer "original" override can be
   * remembered PER MESSAGE. Absent ⇒ the override still works for the session but is not
   * persisted (the desktop shell, a bare test mount). Nothing else reads it, and it never
   * touches the sanitize/srcdoc pipeline.
   */
  messageId?: string;
  /** The sensitivity-redacted text part. Always present; the fallback when there is no html. */
  text: string;
  /** The stored `text/html` part, or `null`. Sensitive mail stores none (pipeline.ts). */
  html?: string | null;
  /** Whether the reader has already consented to remote content for THIS message. */
  remoteLoaded?: boolean;
  /**
   * Turn a sender's image url into one this app may load. Absent ⇒ there is no way to load
   * an image, so no button is offered. See the header: the proxy route is not mounted.
   */
  imageProxy?: ((url: string) => string) | null;
  /** Called when the reader asks for images. Absent ⇒ no button. */
  onLoadRemote?: () => void;
}

/**
 * ONE COMPONENT, EVERY SURFACE THAT RENDERS A MESSAGE. `BodyText`'s header says why: "the
 * fix landing on the pane while the thread below it keeps dumping raw text is a shape this
 * repo has shipped five times". The plain-text path is delegated to `BodyText` verbatim
 * rather than reimplemented, so a message with no html renders exactly as it does today.
 */
export function MessageBody({
  messageId,
  text,
  html,
  remoteLoaded = false,
  imageProxy = null,
  onLoadRemote,
}: MessageBodyProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * ── DARK VIEWING — READ THE THEME, LET THE READER OVERRIDE IT PER MESSAGE ────────────────
   *
   * `useOptionalTheme` and not `useTheme`: this component renders bare (the desktop shell,
   * `message-body.test.ts`), and `null` there means light, the same default the provider
   * itself starts from. The transform only ever engages in a dark theme.
   *
   * A message can be dropped back to its original light rendering — a dark-mode invert is a
   * lightness transform, and some mail (a poster, a logo-heavy newsletter) is worse for it.
   * That decision is per message and remembered: `usePersistedIdSet` holds the ids the reader
   * chose to keep original, in one capped key. Without a `messageId` the override is
   * session-only, which is the right amount for a surface that cannot name the message.
   */
  const theme = useOptionalTheme();
  const themeDark = theme?.resolved === "dark";
  const overrides = usePersistedIdSet(UI_KEYS.mailOriginal);
  const [sessionOriginal, setSessionOriginal] = useState(false);
  const original = messageId ? overrides.has(messageId) : sessionOriginal;
  const setOriginal = useCallback(
    (on: boolean) => {
      if (messageId) overrides.set(messageId, on);
      else setSessionOriginal(on);
    },
    [messageId, overrides],
  );
  /** The transform is on when the theme is dark AND the reader has not asked for the original. */
  const dark = themeDark && !original;
  /**
   * FIRST CLIENT RENDER MUST MATCH THE SERVER RENDER, OR REACT THROWS AWAY THE TREE.
   *
   * `"use client"` does not mean "client only" — Next executes this component on the
   * server for the first paint, where {@link sanitizerAvailable} is false and the text
   * fallback renders. Deciding straight off `sanitizerAvailable()` would make the
   * client's FIRST render a frame where the server sent a paragraph, which is a
   * hydration mismatch: React 18 discards the subtree and re-renders it client-side,
   * and logs an error doing it.
   *
   * So the frame appears on the render AFTER mount, deliberately. The cost is one extra
   * render; the practical flash is none, because the body is hydrated by an engine that
   * only exists in the browser — `html` is null during every real server render.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const proxy = remoteLoaded ? imageProxy : null;

  const mail = useMemo(() => {
    if (!html) return null;
    if (!mounted || !sanitizerAvailable()) return { state: "unsupported" as const };
    const { html: clean, blocked, sheets, oversize } = sanitizeMailHtml(html, { imageProxy: proxy });
    // A message too large to neutralise renders as TEXT, with a reason. Never as a blank
    // frame, and never by taking however long the neutralising would have taken.
    if (oversize) return { state: "oversize" as const };
    if (clean.trim().length === 0) return null;
    return {
      state: "ok" as const,
      // `dark` is baked in for the FIRST paint (no flash), then never rebuilt: every later
      // flip goes through the toggleAttribute effect below. It is deliberately NOT a dep —
      // rebuilding the srcdoc on a theme change would re-parse and re-measure the whole mail,
      // which is exactly what the attribute mechanism exists to avoid. A rebuild driven by a
      // real dep (html/proxy/mount) reads the current `dark` here, so the two never diverge.
      doc: buildMailDocument(clean, { imagesLoaded: proxy != null, dark }),
      blocked,
      sheets,
    };
    // `dark` is intentionally omitted — it is applied live via toggleAttribute, never by
    // rebuilding the frame; see the note on `doc` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, proxy, mounted]);

  /**
   * FLIP THE DARK TRANSFORM ON THE LIVE DOCUMENT — never by rebuilding the srcdoc.
   *
   * The transform is gated on `:root[data-ohmail-dark]` in the frame's own sheet, so switching
   * it on or off is one attribute write on the frame's `documentElement`. A rebuild would
   * re-parse the sender's html and force a fresh measurement pass; this does neither, so a
   * theme change (or the reader's per-message override) is instant and motionless.
   *
   * `ready` and `mail` are deps so the attribute is re-asserted after the frame (re)loads —
   * a new srcdoc starts from whatever `dark` was baked in, and this keeps the live document in
   * step with the current value. In jsdom `contentDocument` is null, so this is a no-op there,
   * which is why the dark transform's real proof is a browser check and not this file.
   */
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    doc.documentElement.toggleAttribute("data-ohmail-dark", dark);
  }, [dark, ready, mail]);

  /**
   * SIZE THE FRAME TO THE MAIL — AND THE OBVIOUS WAY TO DO IT RUNS AWAY.
   *
   * A fixed-height frame with its own scrollbar is the thing every reader hates about webmail;
   * a mail client's message is as tall as the message and the PANE scrolls. Reading
   * `contentDocument` is what `allow-same-origin` is for, and it is safe for the reason in the
   * header — there is no script inside to abuse it.
   *
   * ── THE RUNAWAY, MEASURED IN A REAL BROWSER (2026-08-04) ────────────────────────────────
   *
   * This was `Math.max(documentElement.scrollHeight, body.scrollHeight)`, re-run from a
   * `ResizeObserver` that observed the IFRAME. Both halves of that are wrong, and together
   * they are a monotonic growth loop. Measured on a real newsletter in a 390 px column, 2.5 s
   * after load:
   *
   *   frame.style.height   899px  ·  documentElement.scrollHeight  899  ·  body.scrollHeight  634
   *   (hostile fixture)   1617px  ·                               1617  ·                     159
   *
   * `documentElement.scrollHeight` is `max(content, VIEWPORT)`, and inside a frame the
   * viewport IS the height we just set — so every measurement returned at least the previous
   * answer, the observer on the iframe fired on our own write, and the frame grew forever. A
   * 159 px message occupied 1 617 px of the pane and climbing.
   *
   * **No unit test could have seen this.** jsdom performs no layout: every one of those
   * numbers is 0 there, and `message-body.test.ts` can only assert that no fixed `height`
   * attribute is set. It took driving Chrome at the acceptance fixture.
   *
   * ── AND `height:auto!important` DID NOT CLOSE IT. MEASURED AGAIN, 2026-08-04 ─────────────
   *
   * That rule says nothing about a CHILD. `<div style="height:150vh">` measured
   * `frame.style.height` = **33 554 400 px** — Chrome's own layout ceiling — because inside the
   * frame the viewport IS the height written a moment earlier, so 150vh grows with every pass.
   * And `<style>html,body{height:300vh!important}</style>` reached the same number by beating
   * the rule head-on: equal specificity, later in the document. The host page's `scrollHeight`
   * reached 33 554 432. A message is not allowed to do that to the tab it is opened in.
   *
   * ── SO THE MEASUREMENT STOPS READING A VIEWPORT THE SENDER CAN MOVE ─────────────────────
   *
   *  1. The frame is set to {@link PROBE_PX} — a CONSTANT — and read under it. Every viewport
   *     unit in the mail then resolves against a number this component chose and the sender
   *     cannot influence, so the reading is a pure function of the content and the column
   *     width. There is no feedback edge left to run away along.
   *  2. `documentElement.offsetHeight` — the html box, content-sized, never clamped up to the
   *     viewport the way `scrollHeight` is.
   *  3. {@link MAX_FRAME_PX}, which the sender also cannot influence. A mail that still wants
   *     more than that gets the frame's own scrollbar, which is a bad reading experience and
   *     not a hung tab.
   *  4. The observer watches the mail's `body` (its content reflowing) and this component's
   *     own container (the app's column changing width). It must NEVER watch the iframe,
   *     because the iframe's size is what this function WRITES.
   *
   * ── THE PROBE AND THE FINAL WRITE ARE ONE STRAIGHT LINE, AND NOTHING MAY SIT BETWEEN ────
   *
   * `ResizeObserver` reports against the box it last reported, and both writes happen inside
   * one task — so the probe is never observed and (4) stays safe. An early `return` in between
   * would leave the frame AT the probe height and start a permanent oscillation, which is why
   * the only branch here is on the write itself.
   *
   * The 1 px epsilon and the remembered height are both GONE with the feedback edge that
   * needed them: the reading is a pure function of the content, so a re-measure that changes
   * nothing writes the same string, and that is a no-op.
   */
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement) return;
    // ── PRESERVE THE PANE'S SCROLL ACROSS THE PROBE ────────────────────────────────────
    // Capture the scroll offset of every scrollable ancestor BEFORE the probe shrinks the
    // frame, and restore each AFTER the final height is written. Without this, the probe's
    // forced layout clamps a scrolled-down pane's scrollTop to the shrunken maximum and the
    // restore never puts it back — see {@link scrollAncestors}. Reading `.scrollTop` in the
    // restore flushes layout at the FINAL height first, so the assignment lands against the
    // full scroll range, not the probe's. Both writes stay in one task so nothing paints in
    // between and the reader sees no motion.
    const scrollers = scrollAncestors(frame);
    const tops = scrollers.map((el) => el.scrollTop);

    const restore = frame.style.height;
    frame.style.height = `${PROBE_PX}px`;
    const raw = Math.ceil(doc.documentElement.offsetHeight);
    const h = Math.min(raw, MAX_FRAME_PX);
    frame.style.height = h > 0 ? `${h}px` : restore;

    for (let i = 0; i < scrollers.length; i++) {
      if (scrollers[i]!.scrollTop !== tops[i]) scrollers[i]!.scrollTop = tops[i]!;
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    measure();
    const frame = frameRef.current;
    const shell = shellRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    // The mail's own content, and the column it sits in. Deliberately NOT `frame`.
    const body = frame.contentDocument?.body;
    if (body) ro.observe(body);
    if (shell) ro.observe(shell);
    return () => ro.disconnect();
  }, [ready, measure, mail]);

  // ── no html, or nothing left after sanitizing: the text part, unchanged ──
  if (!mail) return <BodyText text={text} />;

  // ── a DOM the sanitizer could not use (a server render), or an html part past the size
  //    cap. Both render the text WITH THE REASON — never the raw html, never a blank frame. ──
  if (mail.state !== "ok") {
    return (
      <>
        <BodyText text={text} />
        <p className="mb-note">
          {mail.state === "oversize" ? COPY.oversize : COPY.unsupported}
        </p>
      </>
    );
  }

  const remote = mail.blocked;
  const sheets = mail.sheets;
  const pixels = remote.filter((b) => b.pixel).length;
  const hasBlocked = remote.length > 0 || sheets.length > 0;
  // The bar also carries the dark-viewer toggle, so it appears in a dark theme even when there
  // is nothing blocked to report. The empty text span below still takes the flex space, which
  // is what pushes the toggle to the right whether or not the blocked-content sentence is there.
  const showBar = hasBlocked || themeDark;
  const canLoad = imageProxy != null && onLoadRemote != null && !remoteLoaded;

  return (
    <div className="mb" ref={shellRef}>
      {showBar ? (
        <div className="mb-bar" role="status">
          {hasBlocked ? (
            <svg className="mb-bar-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4Z" />
              <circle cx="8" cy="8" r="1.7" />
              <path d="m3 13 10-10" />
            </svg>
          ) : null}
          <span className="mb-bar-text">
            {remote.length === 0
              ? null
              : remoteLoaded
                ? COPY.showing
                : remote.length === pixels && pixels > 0
                  ? COPY.pixelOnly
                  : remote.length === 1
                    ? COPY.blockedOne
                    : COPY.blockedMany(remote.length)}
            {!remoteLoaded && pixels > 0 && remote.length !== pixels ? (
              <>
                {" "}
                <span className="mb-bar-hit">
                  {pixels === 1 ? COPY.pixelOne : COPY.pixelMany(pixels)}
                </span>
              </>
            ) : null}
            {/* LAST, ALWAYS. The browser-level test of this bar reads the FIRST number in it
                and holds that against the remote images the message names; a stylesheet count
                in front of that would make the guard measure the wrong thing. */}
            {sheets.length > 0 ? (
              <>
                {remote.length > 0 ? " " : null}
                {sheets.length === 1 ? COPY.sheetOne : COPY.sheetMany(sheets.length)}
              </>
            ) : null}
          </span>
          {canLoad ? (
            <button type="button" className="mb-bar-btn" onClick={onLoadRemote}>
              {COPY.show}
            </button>
          ) : null}
          {/* The dark-viewer toggle. Only meaningful in a dark theme — in light there is
              nothing to adapt — so it is absent otherwise. `aria-pressed` reports whether the
              reader has forced the original light rendering for this message. */}
          {themeDark ? (
            <button
              type="button"
              className="mb-bar-btn"
              aria-pressed={original}
              title={original ? COPY.darkAdaptTitle : COPY.darkOriginalTitle}
              onClick={() => setOriginal(!original)}
            >
              {original ? COPY.darkAdapt : COPY.darkOriginal}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* `data-dark` themes the sheet the frame sits on — the chrome this file owns — to match
          the transform inside the frame, so a short mail's surround does not read as a light
          hole in a dark panel. It follows the per-message override, not just the theme. */}
      <div className="mb-sheet" data-dark={dark ? "1" : undefined}>
        <iframe
          ref={frameRef}
          className="mb-frame"
          title={COPY.frameTitle}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={mail.doc}
          onLoad={() => { setReady(true); measure(); }}
        />
      </div>
    </div>
  );
}
