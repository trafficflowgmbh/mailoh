#!/usr/bin/env node
/**
 * smoke.mjs — the render check for the embedded UI bundle.
 *
 * The macOS client has `OhMail --smoke`: it hosts every route offscreen,
 * rasterises it and audits the result. This is its counterpart for the Tauri
 * shell, and it deliberately checks the ARTIFACT rather than the sources —
 * `dist/index.html` and the emitted chunks, exactly the bytes the installers
 * carry — because a bundle that builds and renders nothing is the failure mode
 * a compile step cannot catch.
 *
 * What it proves, per run:
 *   1. the bundle parses and executes to completion, with zero console errors
 *      and zero uncaught exceptions;
 *   2. it draws: the rail, all eight views' entry points and real fixture mail
 *      are in the DOM, not an empty <div id="root">;
 *   3. nothing collapsed: no "N more" style placeholder stands in for mail
 *      (invariant #6 — the same rule the Swift audit enforces);
 *   4. it is offline: the document requested nothing but its own two local
 *      files, and calling `fetch` from inside the page throws.
 *
 * jsdom, not a real browser: this runs on every runner with no download and no
 * display, and layout is not what is at risk here — the Blanc geometry is
 * verified against the design system in packages/ui's own suite and pixel-wise
 * in the macOS `--smoke`.
 *
 *   node scripts/smoke.mjs [--dist dist]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, ResourceLoader } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const distArg = args.indexOf("--dist");
const DIST = path.resolve(APP, distArg >= 0 ? (args[distArg + 1] ?? "dist") : "dist");

const failures = [];
let checks = 0;
const check = (label, ok, detail = "") => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  process.stderr.write(
    `smoke: no bundle at ${DIST}\n  Build it first:  npm run ui:build\n`,
  );
  process.exit(1);
}

/* ─────────────────────────────────────────────── the recording loader ── */
/* Every byte the document asks for passes through here. A request for anything
   that is not a file inside dist/ is refused AND recorded, so "zero network"
   is an assertion about observed behaviour, not a claim about the source. */
const requested = [];
class DistOnlyLoader extends ResourceLoader {
  fetch(url, options) {
    requested.push(url);
    if (!url.startsWith("file://")) return Promise.reject(new Error(`refused: ${url}`));
    const file = fileURLToPath(url);
    if (!file.startsWith(DIST + path.sep)) return Promise.reject(new Error(`outside dist: ${url}`));
    return super.fetch(url, options);
  }
}

/* jsdom has no ESM loader, and the bundle is a single self-contained chunk with
   no import/export statements (vite.config.ts turns the modulepreload polyfill
   off, which is what removes the last `fetch(` from the output). Dropping the
   type attribute is therefore a no-op semantically and lets jsdom run it. */
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const classic = html.replace(/<script\s+type="module"\s+/g, "<script ");
check("index.html has a script to run", classic !== html || /<script /.test(classic));

const consoleErrors = [];
const uncaught = [];
/** Anything the page managed to send before the guard sealed the API. */
const leaked = [];

const dom = new JSDOM(classic, {
  url: pathToFileURL(path.join(DIST, "index.html")).href,
  runScripts: "dangerously",
  resources: new DistOnlyLoader(),
  pretendToBeVisual: true,
  beforeParse(window) {
    /* The three observer APIs jsdom lacks and the design system uses. Stubbed,
       not faked: the seen-on-scroll waterline simply never fires here. */
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    if (!window.matchMedia) {
      window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      });
    }
    window.Element.prototype.scrollIntoView = function () {};
    window.HTMLElement.prototype.scrollTo = function () {};
    if (!window.crypto?.randomUUID) {
      Object.defineProperty(window, "crypto", {
        value: { ...(window.crypto ?? {}), randomUUID: () => globalThis.crypto.randomUUID() },
        configurable: true,
      });
    }
    /* jsdom ships no fetch, EventSource or sendBeacon, and the offline guard
       only replaces what a host actually has — so without this the guard checks
       below would pass vacuously. Install a *working* set first: a real webview
       has all of them, and now a call that slips through is recorded here
       instead of disappearing into a ReferenceError. */
    for (const name of ["fetch", "EventSource"]) {
      window[name] = function () {
        leaked.push(`${name}(${[...arguments].map(String).join(", ")})`);
        return { then() {}, catch() {}, finally() {} };
      };
    }
    window.navigator.sendBeacon = function () {
      leaked.push("navigator.sendBeacon");
      return true;
    };
    for (const name of ["XMLHttpRequest", "WebSocket"]) {
      const real = window[name];
      window[name] = function (...a) {
        leaked.push(`new ${name}(${a.map(String).join(", ")})`);
        return new real(...a);
      };
    }

    window.addEventListener("error", (e) => uncaught.push(String(e.error ?? e.message)));
    window.addEventListener("unhandledrejection", (e) => uncaught.push(String(e.reason)));
    const err = window.console.error.bind(window.console);
    window.console.error = (...a) => {
      consoleErrors.push(a.map(String).join(" "));
      err(...a);
    };
  },
});

/* The engine boots in an effect and drains its first page asynchronously. Give
   the microtask queue and a few timer turns a chance rather than guessing. */
const { window } = dom;
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 25));

const doc = window.document;
const root = doc.getElementById("root");
const text = doc.body.textContent ?? "";

/* ── 1 · it executed cleanly ───────────────────────────────────────────── */
check("no uncaught exceptions", uncaught.length === 0, uncaught.slice(0, 3).join(" | "));
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

/* ── 2 · it drew ───────────────────────────────────────────────────────── */
check("#root exists", root != null);
check("#root is not empty", (root?.children.length ?? 0) > 0);
check("the rail rendered", doc.querySelector(".rail") != null);
check("the wordmark rendered", doc.querySelector(".rail .wordmark") != null);
check("the dock rendered", doc.querySelector(".dock") != null);
check("a list pane rendered", doc.querySelector(".rows") != null);
check("body text is substantial", text.length > 800, `${text.length} chars`);

for (const label of ["Ohbox", "Screener", "Reads", "Receipts", "Answer Later", "Search", "Settings"]) {
  check(`rail names "${label}"`, text.includes(label));
}

/* Real fixture mail, from Mila's world — proves the engine bootstrapped and the
   selectors ran, not just that a chrome shell mounted. */
const rows = doc.querySelectorAll(".rows > *").length;
check("message rows rendered", rows >= 3, `${rows} rows`);
for (const who of ["Giulia", "Ben", "Petra"]) {
  check(`fixture sender "${who}" is on screen`, text.includes(who));
}
check("the demo ribbon is honest about fixtures", /fixtures only/i.test(text));

/* ── 3 · nothing collapsed (invariant #6) ──────────────────────────────── */
const collapsed = text.match(/\b\d+\s+(more|others?|collapsed|hidden)\b/i);
check("no collapsed-mail placeholder", collapsed == null, collapsed?.[0] ?? "");

/* ── 4 · it is offline ─────────────────────────────────────────────────── */
const foreign = requested.filter((u) => !u.startsWith("file://"));
check("no non-file request was made", foreign.length === 0, foreign.slice(0, 3).join(" | "));
const outside = requested
  .filter((u) => u.startsWith("file://"))
  .filter((u) => !fileURLToPath(u).startsWith(DIST + path.sep));
check("no request left dist/", outside.length === 0, outside.slice(0, 3).join(" | "));

check("nothing was sent before the guard ran", leaked.length === 0, leaked.slice(0, 3).join(" | "));

const refuses = (expr) => {
  try {
    window.eval(expr);
    return false;
  } catch (e) {
    return /offline by construction/.test(String(e?.message ?? e));
  }
};
check("the offline guard makes fetch() throw", refuses("fetch('https://example.invalid')"));
check("the offline guard makes navigator.sendBeacon() throw", refuses("navigator.sendBeacon('/x')"));
for (const api of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
  check(`the offline guard makes ${api} throw`, refuses(`new ${api}('wss://example.invalid')`));
}

/* ── verdict ───────────────────────────────────────────────────────────── */
window.close();

if (failures.length) {
  process.stderr.write(`\nSMOKE FAILED (${failures.length}/${checks})\n`);
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `SMOKE OK (${checks} checks) — ${rows} rows, ${text.length} chars, ` +
    `${requested.length} local file request(s), 0 network\n`,
);
