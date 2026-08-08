#!/usr/bin/env node
/**
 * build-engine-app.mjs — build the ENGINE-BEARING desktop app, with all three halves selected
 * together and none of them selectable separately.
 *
 *     node scripts/build-engine-app.mjs [--bundles dmg,app] [-- <extra tauri args>]
 *
 * ── WHY THIS IS A FILE AND NOT THREE FLAGS IN A WORKFLOW ──────────────────────────────────
 *
 * The engine-bearing artifact is selected by THREE things that must agree, and every mismatch
 * produces a build that succeeds:
 *
 *   1. `OHMAIL_LOCAL_ENGINE=1` for the UI bundle — the real client and the bridge, instead of the
 *      fixture world with its offline guard;
 *   2. `--features local-engine` for the Rust binary — the engine's lifecycle, the six commands and
 *      the keystore, instead of a window with no bridge;
 *   3. `--config tauri.engine.conf.json` for the bundler — the engine and the runtime as resources,
 *      instead of an app with nothing to spawn.
 *
 * Two of the three mismatches were already documented in `src-tauri/Cargo.toml` and in
 * `package.json`, because they had already happened: a bundle with a bridge and no commands to call,
 * or commands with nothing to call them. The third is worse than either, because it is invisible
 * until the app is opened on a machine that is not the one that built it — the binary has the whole
 * engine lifecycle compiled in and the resources it looks for are simply not in the bundle, so it
 * reports itself as the interface preview and is believed.
 *
 * A workflow that spells the three by hand is a workflow where a later edit fixes two of them. So
 * the three live here, in one place, and CI calls this and nothing else.
 *
 * ── AND THE ENGINE IS STAGED HERE TOO, DELIBERATELY ───────────────────────────────────────
 *
 * `bundle.resources` points at a staging directory, which means a `tauri build` will happily package
 * whatever was in that directory from last time. An app built after an engine source change but
 * before a re-bundle carries last week's engine under this week's version — and nothing about the
 * artifact says so. Staging is therefore part of this script rather than a step beside it, and it
 * refuses rather than falling back when a piece is missing.
 *
 * What this does NOT do is build the engine bundle or vendor the runtime: both need tools that are
 * deliberately not workspace dependencies (a pinned esbuild, a checksum-verified download), and both
 * are slow. It checks their output is there and current enough to stage, and says exactly which
 * command produces what is missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(APP, "..", "..");

const argv = process.argv.slice(2);
const passThrough = argv.indexOf("--") >= 0 ? argv.slice(argv.indexOf("--") + 1) : [];
const own = argv.indexOf("--") >= 0 ? argv.slice(0, argv.indexOf("--")) : argv;
const bundlesAt = own.indexOf("--bundles");
const bundles = bundlesAt >= 0 ? own[bundlesAt + 1] : null;

const say = (m) => process.stdout.write(`\n\x1b[1m${m}\x1b[0m\n`);
function die(m) {
  process.stderr.write(`\nbuild-engine-app: ${m}\n`);
  process.exit(1);
}

/** Run, inheriting stdio, and stop on a non-zero status. Never through a shell, never through a pipe
 *  — a pipeline reports the LAST command's status, which is how a died build reports success. */
function run(cmd, args, cwd) {
  const shown = [cmd, ...args].join(" ");
  process.stdout.write(`  $ ${shown}\n`);
  try {
    execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  } catch (err) {
    die(`\`${shown}\` failed (status ${err.status ?? "unknown"})`);
  }
}

if (!existsSync(join(ROOT, "build", "engine", "bin", "ohmail-engine.mjs"))) {
  die("there is no engine bundle to package.\n" +
      "    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)\n" +
      "    OHMAIL_ESBUILD_FROM=$D node scripts/build-engine.mjs");
}
if (!existsSync(join(ROOT, "build", "vendor"))) {
  die("there is no vendored Node runtime to package.\n" +
      "    node scripts/vendor-node.mjs");
}

say("1/3 · stage the engine and its runtime");
run(process.execPath, [join(ROOT, "scripts", "stage-desktop-resources.mjs")], ROOT);

say("2/3 · build the engine-bearing UI bundle");
run(process.execPath, [join(APP, "scripts", "build-ui.mjs"), "--engine"], APP);
/* …and read what came out. The engine bundle carries a surface the preview must not have at all —
 * the pane that points this install at a model of its own, and the Screener control that uses it —
 * and a bundle built with the wrong flag is exactly how the two halves of this app end up
 * mismatched with nothing failing until somebody opens the window. Cheap, and it runs where the
 * artifact is made rather than where somebody remembers to check it. */
run(process.execPath, [join(APP, "scripts", "scan-artifact.mjs"), "--expect", "engine"], APP);

say("3/3 · build the app");
/* `tauri` from this package's own `node_modules/.bin`, resolved through node rather than named as a
 * shell command: the launcher is `tauri` on Unix and `tauri.cmd` on Windows, and reaching for it
 * through a shell to paper over that is the quoting problem `build-ui.mjs` exists to avoid. */
const cli = join(APP, "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(cli)) die(`the Tauri CLI is not installed at ${cli} — run \`npm install\` in apps/desktop`);
run(process.execPath, [
  cli, "build",
  "--features", "local-engine",
  "--config", join(APP, "src-tauri", "tauri.engine.conf.json"),
  ...(bundles ? ["--bundles", bundles] : []),
  ...passThrough,
], APP);
