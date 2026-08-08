#!/usr/bin/env node
/**
 * scan-artifact.mjs — what is in the built bundle, and which of the two bundles it is.
 *
 * Two artifacts come out of this directory. The INTERFACE PREVIEW shows an invented mailbox, opens
 * nothing and has no engine behind it. The ENGINE build carries the bridge to a mail engine on this
 * machine, and with it a surface the preview must not contain at all: a pane for pointing this
 * install at a model of your own, and a Screener control that asks that model about waiting
 * senders. Neither means anything without an engine, and shipping either in the preview would put a
 * settings pane for a key nobody can store into a build with nowhere to store it.
 *
 * Tree-shaking is what removes them — everything reachable only from the gate is behind a
 * build-time literal — but tree-shaking is the MECHANISM and not the evidence. The one time this
 * class of thing was checked by reading the config rather than the output, a shipped Linux binary
 * answered `strings` with a subscription price. So this reads the emitted bytes.
 *
 * ── IT CHECKS BOTH DIRECTIONS, WHICH IS WHY IT IS ONE SCRIPT AND NOT TWO ────────────────────
 *
 * A guard that only proves absence goes green when the feature is deleted, and a guard that only
 * proves presence says nothing about the artifact that must not have it. So the caller SAYS which
 * artifact it built, and the surface is required to be present exactly when it should be. Delete
 * the feature and the engine build fails; leak it and the preview fails.
 *
 * ── AND THE ARTIFACT IS DECLARED, NOT SNIFFED ───────────────────────────────────────────────
 *
 * The first version of this read the bundle for the bridge command and decided for itself which of
 * the two it was looking at. That is wrong in the exact case the script exists for: a leak reaches
 * the local settings client, which reaches the bridge, so the bytes that prove the leak also flip
 * the identification — and the preview was reported as an engine build with pieces missing. True,
 * loud, and about the wrong artifact. The thing that knows which one it built is the thing that
 * built it, so it passes `--expect`.
 *
 *   node scripts/scan-artifact.mjs --expect preview|engine [--dist dist]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const at = args.indexOf("--dist");
const DIST = path.resolve(APP, at >= 0 ? (args[at + 1] ?? "dist") : "dist");
const expectAt = args.indexOf("--expect");
const EXPECT = expectAt >= 0 ? args[expectAt + 1] : null;

if (EXPECT !== "preview" && EXPECT !== "engine") {
  process.stderr.write("scan: --expect preview|engine is required\n");
  process.exit(1);
}

if (!fs.existsSync(DIST)) {
  process.stderr.write(`scan: no bundle at ${DIST}\n  Build one first:  npm run ui:build\n`);
  process.exit(1);
}

/** Every emitted byte a string could hide in. */
function bundleText(dir) {
  let text = "";
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|css|html)$/.test(e.name)) text += fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return text;
}

const text = bundleText(DIST);

const wantsEngine = EXPECT === "engine";

/**
 * The bridge command is in the engine build and cannot be in the preview — the preview has no
 * shell to call and no commands to call it with. Checked here as well as by the smoke, because a
 * bundle that disagrees with the flag it was built under makes everything below meaningless.
 */
const hasBridge = text.includes("engine_request");

/**
 * THE LOCAL-MODEL SURFACE, as strings that survive minification.
 *
 * Route paths and provider names, because those are what a bundle would have to carry to reach
 * either provider, and one sentence from the control, because copy is the half a reader recognises.
 * Every one of them is absent from the preview today and present in the engine build.
 */
const MARKERS = ["local/ai", "anthropic", "ollama", "Set up a model"];

const present = MARKERS.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
const absent = MARKERS.filter((m) => !present.includes(m));

/* Captured into variables and compared, never piped into a matcher: a producer that dies inside a
   pipe looks exactly like a producer that found nothing, and "found nothing" is the answer half of
   this script is hoping for. */
const failures = [];
if (hasBridge !== wantsEngine) {
  failures.push(
    wantsEngine
      ? "this was built as the engine bundle and carries no bridge to an engine"
      : "the interface preview carries the bridge to a local engine",
  );
}
if (wantsEngine) {
  if (absent.length > 0) {
    failures.push(`the engine bundle is missing the local-model surface: ${absent.join(", ")}`);
  }
} else if (present.length > 0) {
  failures.push(`the interface preview carries the local-model surface: ${present.join(", ")}`);
}

const which = wantsEngine ? "engine build" : "interface preview";
if (failures.length) {
  process.stderr.write(`\nSCAN FAILED (${which}, ${DIST})\n`);
  for (const f of failures) process.stderr.write(`  x ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `SCAN OK — ${which}: the local-model surface is ${wantsEngine ? "present" : "absent"} ` +
    `(${MARKERS.length} markers checked)\n`,
);
