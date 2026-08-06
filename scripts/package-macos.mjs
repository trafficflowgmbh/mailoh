#!/usr/bin/env node
/**
 * package-macos.mjs — build ohmail.app (and ohmail.dmg) from apps/macos.
 *
 *   node scripts/package-macos.mjs [--arch "arm64 x86_64"] [--sign]
 *                                  [--allow-unrelated-dirt] [--skip-tests]
 *                                  [--keep-staging]
 *
 * ── why this exists, given scripts/package-app.sh already does the assembly ──
 *
 * It does — but only in the PUBLIC MIRROR. `public/ohmail/scripts/package-app.sh`
 * resolves ROOT as its own parent directory and then reads
 * `$ROOT/Resources/{Info.plist,ohmail.icns,FIRST-RUN.txt}`. Those paths exist at
 * github.com/trafficflowhq/ohmail, where publish-desktop.mjs assembles them from
 * `public/ohmail/` plus the icon mapping. In THIS repository there is no root
 * `Resources/` and no `scripts/package-app.sh`, so the bundle could not be built
 * here at all: you had to publish the mirror first and build over there.
 *
 * So this script does not re-implement the bundle. It reconstructs the mirror's
 * SHAPE in a staging directory and runs the mirror's own `package-app.sh` inside
 * it. One recipe, one place to fix it, and running this exercises the exact
 * script the public CI job runs — which nothing in this repository previously
 * did.
 *
 * What it adds around that recipe is what the recipe has no way to know:
 *
 *   · the tree-dirty refusal,
 *   · provenance recorded rather than printed to a scrollback,
 *   · a licence/inventory gate on what the bundle actually conveys,
 *   · `--smoke` against the BUNDLED app instead of the raw binary,
 *   · the claims the download makes about itself, checked against the bytes,
 *   · a real Developer ID + notarisation path that fails loudly when absent.
 *
 * ── what this script does NOT do ──
 *
 * It does not publish, upload, tag or release anything. It writes `build/` and
 * stops, and no release step belongs in it. That is a licence boundary, not a
 * convenience: the public mirror deliberately excludes the engine packages (see
 * `test/desktop-mirror-excludes-the-engine.test.ts`), so distributing a macOS
 * build that carried the engine would be a separate decision made with that in
 * view. Today's bundle carries no engine at all, and the inventory gate below is
 * what keeps that a fact rather than an assumption.
 *
 * Output: build/ohmail.app, build/ohmail.dmg, build/ohmail-<sha>.build.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ─────────────────────────────────────────────────────────────── plumbing ── */

function die(msg) {
  process.stderr.write(`\n\x1b[31m✗ ${msg}\x1b[0m\n\n`);
  process.exit(1);
}
const say = (msg) => process.stdout.write(`${msg}\n`);
const step = (msg) => process.stdout.write(`\n\x1b[1m▸ ${msg}\x1b[0m\n`);

function git(...a) {
  return execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 }).replace(/\s+$/, "");
}
/** Run a command; die with context unless `tolerate`. */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  } catch (e) {
    if (opts.tolerate) return null;
    die(`${cmd} ${args.join(" ")}\n  exited ${e.status}\n${e.stdout || ""}${e.stderr || ""}`);
  }
}
/** Capture stdout; `null` when the command fails. Never dies. */
function capture(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"], ...opts,
    }).replace(/\s+$/, "");
  } catch {
    return null;
  }
}
const plist = (file, key) => capture("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file]);
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const value = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (!v) die(`${name} needs a value`);
  args.splice(i, 2);
  return v;
};

const ALLOW_DIRT = flag("--allow-unrelated-dirt");
const SIGN = flag("--sign");
const SKIP_TESTS = flag("--skip-tests");
const KEEP_STAGING = flag("--keep-staging");
const ARCHS = value("--arch", "arm64 x86_64");
if (args.length) die(`unknown argument: ${args[0]}`);

if (process.platform !== "darwin") {
  die("this builds a macOS .app and needs macOS: hdiutil, codesign and PlistBuddy are Apple's.");
}

/* ── MONOREPO vs PUBLISHED MIRROR ──────────────────────────────────────────────
 * This script reconstructs the mirror's SHAPE in the MONOREPO, where the payload lives under
 * `public/ohmail/` and the icon mapping is read out of `publish-desktop.mjs`. On the PUBLIC MIRROR
 * that shape already exists at the repo root — `Resources/` and `scripts/package-app.sh` are there,
 * the icon is `Resources/ohmail.icns`, and neither `public/ohmail/` nor `publish-desktop.mjs` is
 * published at all. So on the mirror there is nothing to stage: it packages in place, running the
 * mirror's own `package-app.sh` and embedding into its output. The two signals are required to
 * DISAGREE, so a half-populated or unexpected tree is a hard stop rather than a wrong guess — a
 * packaging validation that ran in the wrong layout is exactly how a green build hid a real break. */
const MONOREPO_LAYOUT = fs.existsSync(path.join(REPO, "public/ohmail/Resources"));
const MIRROR_LAYOUT = fs.existsSync(path.join(REPO, "Resources/Info.plist"))
  && fs.existsSync(path.join(REPO, "scripts/package-app.sh"));
if (MONOREPO_LAYOUT === MIRROR_LAYOUT) {
  die(`cannot tell whether this is the monorepo or the published mirror:\n` +
      `  public/ohmail/Resources ${MONOREPO_LAYOUT ? "exists" : "is absent"}; ` +
      `Resources/Info.plist + scripts/package-app.sh ${MIRROR_LAYOUT ? "exist" : "are absent"}.\n` +
      `  Exactly one must hold — a tree where both or neither do is not a layout this can package.`);
}
const MIRROR_MODE = MIRROR_LAYOUT;
say(MIRROR_MODE ? "  layout: published mirror (packaging in place)" : "  layout: monorepo (staging from git archive)");

/* ─────────────────────────────────────────────────── the payload it needs ──
 * Everything the staged tree is built from. This list is also the HARD scope of
 * the dirty refusal below: dirt in any of these changes what the bundle
 * contains, so there is no override for it.
 *
 * `scripts/publish-desktop.mjs` is in here because it IS the icon mapping, which
 * is read out of the archived copy — an uncommitted edit to it would silently
 * change the recipe.
 *
 * This file is deliberately NOT in the list, though it decides the bundle's
 * shape too. node executes the working-tree copy of it whatever HEAD says, so a
 * refusal here could not actually enforce that the packager matches its commit —
 * it would only deadlock the first run of any new version of this script. The
 * manifest records whether it was modified instead, which is a claim that can be
 * true.
 *
 * `packages/tokens/src` is here because `swift test` reads
 * `packages/tokens/src/tokens.ts` — OhMailKitTests resolves the repo root as its
 * own `#filePath` up five levels and compares every colour, radius and spacing
 * token against it numerically. A staging tree without it cannot run the tests,
 * which is exactly what the mirror publishes it for.
 */
const STAGE_ROOTS = [
  "apps/macos",
  "packages/tokens/src",
  "public/ohmail/Resources",
  "public/ohmail/scripts",
  "design/icon/oh",
  "scripts/publish-desktop.mjs",
];
/** This script's own path, recorded rather than refused on — see above. */
const PACKAGER = "scripts/package-macos.mjs";

/* ──────────────────────────────────────────────────── preflight refusals ──
 * Every one fires before a single byte is written anywhere. */

step("preflight");

const status = git("status", "--porcelain");
const dirty = status ? status.split("\n").map((l) => l.slice(3).trim()).filter(Boolean) : [];
const touchesPayload = dirty.filter((f) => STAGE_ROOTS.some((r) => f === r || f.startsWith(`${r}/`)));

if (touchesPayload.length || (dirty.length && !ALLOW_DIRT)) {
  const shown = (touchesPayload.length ? touchesPayload : dirty).slice(0, 20);
  die(`the monorepo working tree is dirty — commit or stash first.\n` +
      `  The build records the monorepo sha it was built from; packaging from a\n` +
      `  dirty tree makes that recorded sha a lie, and a .app is a file someone\n` +
      `  downloads and cannot diff against anything.\n\n` +
      shown.map((f) => `    ${f}`).join("\n") +
      (touchesPayload.length
        ? `\n\n  These paths are IN the bundle payload. There is no override for them:\n` +
          `  the artifact would not be the commit it claims to be.`
        : `\n\n  None of these are in the bundle payload. Re-run with --allow-unrelated-dirt\n` +
          `  to package anyway — the bundle is built from \`git archive HEAD\`, so the\n` +
          `  recorded sha still describes the payload exactly; it just stops\n` +
          `  describing the whole tree.`));
}
if (dirty.length) {
  say(`\x1b[33m! ${dirty.length} uncommitted path(s) outside the payload, allowed by --allow-unrelated-dirt\x1b[0m`);
  for (const f of dirty.slice(0, 10)) say(`    ${f}`);
}

const SHA = git("rev-parse", "HEAD");
const SHORT = SHA.slice(0, 9);
/* package-app.sh derives CFBundleVersion from `git rev-list --count` inside its
 * own ROOT and falls back to 0 when that is not a checkout. The staging tree is
 * a `git archive` extraction and has no .git, so without this the bundle would
 * ship CFBundleVersion 0 — a build number that is not one. */
const BUILD_VERSION = git("rev-list", "--count", "HEAD");
say(`  commit        ${SHORT}`);
say(`  build version ${BUILD_VERSION}`);
say(`  architectures ${ARCHS}`);

/* ── signing: decided here, so a run that cannot sign fails before it builds ──
 *
 * There are no ohmail signing credentials at the time of writing and this script
 * has never signed anything. What it must not do is pretend: `--sign` with no
 * identity is a hard stop naming exactly what a human has to supply, and the
 * default stays ad-hoc and says so. Ad-hoc is not a weaker signature, it is NO
 * statement of provenance — on Apple silicon an unsigned Mach-O will not launch
 * at all, so `codesign -s -` is the floor, not a claim.
 */
const IDENTITY = process.env.OHMAIL_SIGN_IDENTITY || "";
const NOTARY_PROFILE = process.env.OHMAIL_NOTARY_PROFILE || "";

if (SIGN) {
  if (!IDENTITY) {
    die(`--sign was requested but OHMAIL_SIGN_IDENTITY is not set.\n\n` +
        `  A human has to supply, once:\n\n` +
        `    1. An Apple Developer Program membership — an ORGANIZATION account for\n` +
        `       TrafficFlow GmbH. The individual tier cannot ship under a company\n` +
        `       name, and the name is what Gatekeeper shows the user.\n` +
        `    2. A "Developer ID Application" certificate, created in the developer\n` +
        `       portal and installed in the login keychain. Confirm with:\n` +
        `           security find-identity -v -p codesigning\n` +
        `    3. OHMAIL_SIGN_IDENTITY set to that certificate's full common name:\n` +
        `           export OHMAIL_SIGN_IDENTITY="Developer ID Application: TrafficFlow GmbH (TEAMID1234)"\n` +
        `    4. A notarisation keychain profile holding an app-specific password\n` +
        `       for the Apple ID that owns the team:\n` +
        `           xcrun notarytool store-credentials ohmail-notary \\\n` +
        `             --apple-id <apple-id> --team-id <TEAMID1234> --password <app-specific-password>\n` +
        `           export OHMAIL_NOTARY_PROFILE=ohmail-notary\n\n` +
        `  Without --sign this script produces the ad-hoc build it produces today,\n` +
        `  which is honest about being unsigned. It will not fake a signature.`);
  }
  const identities = capture("security", ["find-identity", "-v", "-p", "codesigning"]) || "";
  if (!identities.includes(IDENTITY)) {
    die(`OHMAIL_SIGN_IDENTITY is set to:\n\n    ${IDENTITY}\n\n` +
        `  but no codesigning identity by that name is in the keychain. Found:\n\n` +
        (identities.trim() ? identities.replace(/^/gm, "    ") : "    (none)") +
        `\n\n  The value must be the certificate's common name, exactly.`);
  }
  if (!NOTARY_PROFILE) {
    die(`--sign also requires OHMAIL_NOTARY_PROFILE.\n\n` +
        `  A Developer ID signature that is not notarised still gets a Gatekeeper\n` +
        `  warning on first launch, so signing without notarising buys almost\n` +
        `  nothing. Create the profile with:\n\n` +
        `      xcrun notarytool store-credentials ohmail-notary \\\n` +
        `        --apple-id <apple-id> --team-id <TEAMID> --password <app-specific-password>`);
  }
  say(`  signing       ${IDENTITY}`);
  say(`  notary        keychain profile ${NOTARY_PROFILE}`);
} else {
  say(`  signing       ad-hoc (NOT a Developer ID, NOT notarised) — pass --sign to change`);
}

for (const root of MIRROR_MODE
  ? ["apps/macos", "packages/tokens/src", "Resources/Info.plist", "Resources/ohmail.icns", "scripts/package-app.sh"]
  : STAGE_ROOTS) {
  if (!fs.existsSync(path.join(REPO, root))) die(`missing bundle input${MIRROR_MODE ? " (mirror)" : ""}: ${root}`);
}

/* ────────────────────────────────────────────────────────────── staging ──
 * From `git archive HEAD`, not from the working tree. Two reasons: the build
 * then comes from the commit it claims to come from by construction rather than
 * by the refusal above alone, and it proves the script works from a clean
 * checkout — a working tree can hold untracked files a fresh clone will not, and
 * a build that quietly depends on one is not reproducible.
 */
/* ── the mirror mapping, read rather than restated (MONOREPO only) ─────────
 * The icon is the one asset this script needs that publish-desktop.mjs also
 * maps, and a second copy of that mapping is a second thing to keep in step. It
 * is therefore READ OUT of publish-desktop.mjs — and out of the ARCHIVED copy,
 * so the recipe comes from the same commit as everything else. That script has
 * no main guard, so PAYLOAD is extracted as text and evaluated in a `node:vm`
 * context with no globals rather than imported. Extraction failing is a hard
 * stop, never a fallback to a guessed path. On the mirror this is never called:
 * publish-desktop.mjs is not published there and the icon already sits at
 * Resources/ohmail.icns. */
function iconSource(rawDir) {
  const src = fs.readFileSync(path.join(rawDir, "scripts/publish-desktop.mjs"), "utf8");
  const m = src.match(/const PAYLOAD = \[([\s\S]*?)\n\];/);
  if (!m) die("could not extract PAYLOAD from scripts/publish-desktop.mjs — has its shape changed?");
  const entries = vm.runInNewContext(`[${m[1]}]`);
  if (!Array.isArray(entries) || entries.length < 10) {
    die(`extracted only ${entries?.length} PAYLOAD entries from publish-desktop.mjs —\n` +
        `  the extraction has stopped matching and cannot be trusted.`);
  }
  const hit = entries.find((e) => e && e.to === "Resources/ohmail.icns");
  if (!hit) {
    die(`publish-desktop.mjs no longer maps anything to Resources/ohmail.icns.\n` +
        `  package-app.sh copies $ROOT/Resources/ohmail.icns into the bundle, so this\n` +
        `  script cannot know where the icon lives any more. Fix the mapping, or this.`);
  }
  if (!STAGE_ROOTS.some((r) => hit.from === r || hit.from.startsWith(`${r}/`))) {
    die(`the icon now comes from ${hit.from}, which is outside STAGE_ROOTS —\n` +
        `  it was never archived, and it is not covered by the dirty refusal either.`);
  }
  return hit.from;
}

/* ── STAGE, OR PACKAGE IN PLACE ────────────────────────────────────────────────
 * MONOREPO: reconstruct the mirror shape from `git archive HEAD` — the build then comes from the
 * commit it claims by construction, and it proves the script works from a clean checkout. MIRROR:
 * the shape already exists at the repo root, so `TREE` is the repo itself, `PACKAGE_APP` is the
 * mirror's own script, and there is nothing to stage. The embed/licence/boot/DMG half below is
 * identical in both. */
let STAGE = null;
let TREE;
let PACKAGE_APP;

if (MIRROR_MODE) {
  step("packaging in place (mirror layout — no staging)");
  TREE = REPO;
  PACKAGE_APP = path.join(REPO, "scripts/package-app.sh");
  fs.chmodSync(PACKAGE_APP, 0o755);
  say(`  the mirror carries Resources/ and scripts/package-app.sh at its root; nothing to stage`);
} else {
  step("staging the mirror layout from git archive HEAD");
  STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "ohmail-pkg-"));
  const RAW = path.join(STAGE, "raw");
  TREE = path.join(STAGE, "tree");
  fs.mkdirSync(RAW);
  fs.mkdirSync(TREE);

  const tarball = path.join(STAGE, "payload.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tarball, SHA, "--", ...STAGE_ROOTS], { cwd: REPO });
  execFileSync("tar", ["-xf", tarball, "-C", RAW]);
  fs.rmSync(tarball);

  /* `public/ohmail/*` loses its prefix exactly as publish-desktop.mjs's template
   * copy does; apps/macos and packages/tokens are identity mappings. */
  const STAGE_MAP = [
    { from: "apps/macos", to: "apps/macos" },
    { from: "packages/tokens/src", to: "packages/tokens/src" },
    { from: "public/ohmail/Resources", to: "Resources" },
    { from: "public/ohmail/scripts", to: "scripts" },
    { from: iconSource(RAW), to: "Resources/ohmail.icns" },
  ];

  for (const { from, to } of STAGE_MAP) {
    const src = path.join(RAW, from);
    if (!fs.existsSync(src)) {
      die(`${from} is not in commit ${SHORT} — it is untracked, so a clean checkout\n` +
          `  would not have it and this build is not reproducible.`);
    }
    const dst = path.join(TREE, to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    say(`  ${from}  →  ${to}`);
  }

  PACKAGE_APP = path.join(TREE, "scripts/package-app.sh");
  if (!fs.existsSync(PACKAGE_APP)) die("public/ohmail/scripts/package-app.sh did not land in the staging tree");
  fs.chmodSync(PACKAGE_APP, 0o755);
}

/* ───────────────────────────────────────────── the licence/inventory gate ──
 * Everything vendored is published, and this app is GPL-3.0-or-later. An AGPL
 * dependency anywhere in the bundle would force publishing the whole hosted
 * service, so the question is not "did anyone add one" but "can anyone tell".
 *
 * The gate is structural rather than a blocklist of names: it enumerates what
 * the staging tree actually contains and fails on any file kind that is not one
 * of the handful this bundle is made of. Today `apps/macos/Package.swift`
 * declares no external package dependencies at all, so the honest statement is
 * also the strongest one available — the bundle conveys no third-party code
 * whatsoever, and there is no licence to be compatible with but ohmail's own.
 *
 * That is exactly why this is a gate and not a comment. When the engine seam
 * lands it brings a vendored `node_modules`, a bundled `main.js`, PGlite's WASM
 * and a nested node binary; every one of those trips this, which forces whoever
 * adds them to state their licences here — rather than discovering the problem
 * after a public download exists. (For the record, the engine's own runtime
 * dependencies were checked while writing this: @electric-sql/pglite Apache-2.0,
 * drizzle-orm Apache-2.0, imapflow MIT — and imapflow is a devDependency the
 * sidecar never loads. None of them is AGPL.)
 */
step("licence + inventory gate");

/* `.json` is here for the RECORDED ENGINE CORPUS under `apps/macos/Tests/Fixtures/wire/`, and it
 * is worth saying exactly what that is rather than leaving a reader to infer it from an extension.
 *
 * Those files are the responses a local engine actually gave over one journey, written by a
 * generator that lives with the engine and fails if they stop matching what the engine emits. They
 * are ohmail's own output under ohmail's own licence — there is no third party in them and nothing
 * to be compatible with. The mailbox they record is synthetic: every address in it is under
 * `.test`, which RFC 2606 reserves precisely so that a fixture cannot name somebody's real domain.
 *
 * They are STAGED but never BUNDLED. `apps/macos` is archived whole because `swift test` runs
 * against the staged tree, and `package-app.sh` copies exactly the built binary, `Info.plist` and
 * the icon into the .app — so nothing under `Tests/` reaches a downloader. They are not published
 * to the mirror either: publish-desktop.mjs's `apps/macos/Tests` entry filters to `.swift`, which
 * is why the tests that read the corpus skip in a public checkout.
 *
 * Adding the extension rather than exempting the directory is deliberate. The gate's value is that
 * it enumerates the staging tree and refuses a kind of file nobody has accounted for; a path-shaped
 * exemption would stop it looking at a directory, whereas this still forces the next NEW kind of
 * file to be declared here. The vendored-code refusal below is unaffected and still catches a
 * `node_modules` tree arriving with its own JSON.
 *
 * Until this line existed the packager could not build at all: the corpus landed with the wire
 * decoder and every run since died here, which is a build break rather than a licence finding. */
const ALLOWED_EXT = new Set([".swift", ".plist", ".icns", ".txt", ".sh", ".md", ".ts", ".css", ".json"]);
const ALLOWED_BASENAMES = new Set([".gitignore"]);

function walk(dir, into = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, into);
    else into.push(path.relative(TREE, p));
  }
  return into;
}
/* MONOREPO only: this inventory gate proves the STAGED tree is a clean mirror checkout with no
 * undeclared file kind and no vendored third-party code. On the mirror, TREE is the repo root — it
 * legitimately holds node_modules/ and build/ from the CI steps that ran before this — and the
 * payload it would police was already gated by publish-desktop when it was published. So it does not
 * run here; the embed-side licence gate (THIRD-PARTY-NOTICES) still audits everything the binary
 * actually conveys, in both modes. */
const staged = MIRROR_MODE ? [] : walk(TREE);

const undeclared = staged.filter((rel) =>
  !ALLOWED_BASENAMES.has(path.basename(rel)) && !ALLOWED_EXT.has(path.extname(rel)));
if (undeclared.length) {
  die(`the bundle payload contains file kinds this gate does not know about:\n\n` +
      undeclared.slice(0, 30).map((f) => `    ${f}`).join("\n") +
      `\n\n  Everything vendored is PUBLISHED, and this app is GPL-3.0-or-later. Before\n` +
      `  widening ALLOWED_EXT, state the licence of whatever these come from.\n` +
      `  GPL-3.0-or-later can carry MIT, BSD and Apache-2.0. It CANNOT carry AGPL:\n` +
      `  that would force publishing the hosted service in full. This refuses\n` +
      `  rather than warns for that reason.`);
}
const vendored = staged.filter((rel) => /(^|\/)(node_modules|vendor|Frameworks|\.wasm$)/.test(rel));
if (vendored.length) {
  die(`the bundle payload vendors third-party code:\n\n` +
      vendored.slice(0, 30).map((f) => `    ${f}`).join("\n") +
      `\n\n  Declare every licence, in this file, before allowing it through.`);
}
if (!MIRROR_MODE) {
  say(`  ${staged.length} files staged · no vendored third-party code · no undeclared file kinds`);
  say(`  apps/macos declares no external package dependencies: the bundle conveys only`);
  say(`  ohmail's own GPL-3.0 sources and Apple's system frameworks.`);
}

/* ───────────────────────────────────────────────────────── build and prove ──
 * The public CI job's order, in the public CI job's shape: test, then package.
 * Running the tests HERE rather than only in the monorepo is what proves the
 * staged tree really is a valid mirror checkout — the token-fidelity tests read
 * packages/tokens/src/tokens.ts relative to the tree they were compiled in, so a
 * mis-shaped staging tree fails loudly instead of producing a bundle nobody
 * checked. (The Blanc-prototype comparison XCTSkips when design/proposals is
 * absent, which is exactly what it does on the public runner.)
 */
if (!SKIP_TESTS) {
  step("swift test, in the staged mirror tree");
  run("swift", ["test", "--package-path", path.join(TREE, "apps/macos")], { cwd: TREE, stdio: "inherit" });
} else {
  say(`\n\x1b[33m! --skip-tests: the staged tree was not tested\x1b[0m`);
}

step(`running the mirror's scripts/package-app.sh (${ARCHS})`);
run("bash", [PACKAGE_APP], {
  cwd: TREE,
  stdio: "inherit",
  env: { ...process.env, OHMAIL_ARCHS: ARCHS, OHMAIL_BUILD_VERSION: BUILD_VERSION },
});

const BUILT_APP = path.join(TREE, "build/ohmail.app");
const BUILT_DMG = path.join(TREE, "build/ohmail.dmg");
for (const f of [BUILT_APP, BUILT_DMG]) {
  if (!fs.existsSync(f)) die(`package-app.sh reported success but ${path.basename(f)} is not there.`);
}
const MACHO = path.join(BUILT_APP, "Contents/MacOS/OhMail");
const INFO = path.join(BUILT_APP, "Contents/Info.plist");

/** `--smoke` against the assembled bundle. Stronger than the raw binary: this is
 *  the Mach-O a stranger double-clicks, with its signature and bundle layout. */
function smokeTheBundle(when) {
  step(`--smoke, against the bundled executable (${when})`);
  try {
    say(`  ${execFileSync(MACHO, ["--smoke"], { encoding: "utf8", maxBuffer: 1 << 28 }).trim()}`);
  } catch (e) {
    die(`the BUNDLED app failed --smoke (exit ${e.status}).\n` +
        `  The raw binary passing is not enough: this is the one that ships.\n\n` +
        `${e.stdout || ""}${e.stderr || ""}`);
  }
}
smokeTheBundle("ad-hoc");

/* ══════════════════════════════════════════════════════════════════════════
   THE ENGINE — what turns the preview shell into a mail client.
   ══════════════════════════════════════════════════════════════════════════

   `package-app.sh` assembles the shell — binary, plist, icon — and nothing else,
   because the engine is a build artifact rather than a checked-in file. So the
   engine is embedded HERE, in exactly the layout the boot check proves the bundle
   resolves: `ohmail-engine` beside the shell's own executable, the migration
   journal one level up in `Contents/drizzle`, and the storage engine's WASM
   vendored beside the binary.

   Only the MAIL engine, and the build is what guarantees it: the bundler refuses
   to write `build/engine` at all if the artifact carries anything from the hosted
   half, so what is copied here has already been cleared. */
step("embedding the mail engine");

const ENGINE_ROOT = path.join(REPO, "build", "engine");
const ENGINE_BIN = path.join(ENGINE_ROOT, "MacOS", "ohmail-engine");
const ENGINE_META = `${ENGINE_BIN}.meta.json`;
const ENGINE_NODE_MODULES = path.join(ENGINE_ROOT, "MacOS", "node_modules");
const ENGINE_JOURNAL = path.join(ENGINE_ROOT, "drizzle");
for (const p of [ENGINE_BIN, ENGINE_NODE_MODULES, ENGINE_JOURNAL, ENGINE_META]) {
  if (!fs.existsSync(p)) {
    die(`the engine is not built: ${path.relative(REPO, p)} is missing.\n` +
        `  Build it first (it is census-gated, so a dirty build refuses to write):\n\n` +
        `    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)\n` +
        `    OHMAIL_ESBUILD_FROM=$D node scripts/build-engine.mjs`);
  }
}

/* The copy. `ohmail-engine` beside `OhMail`, its journal one level up, PGlite vendored
 * beside the binary. The `.meta.json` is a build artifact and stays out of the bundle. */
/* `Contents/MacOS` HOLDS ONLY MACH-O CODE, or `codesign` refuses the whole bundle: it descends into
 * anything there and chokes on the first non-code file (a `.d.ts` inside PGlite). So only the engine
 * SCRIPT sits beside the shell — where `EngineProcess.locate` looks for it — and `node_modules` goes
 * ONE LEVEL UP in `Contents/`, which node's bare-specifier resolution still finds by walking up from
 * the engine, and which `codesign` seals as a resource rather than trying to sign. The journal sits
 * beside it, at the `dirname(engine)/../drizzle` the bundle composes. */
const engineDst = path.join(BUILT_APP, "Contents/MacOS/ohmail-engine");
fs.copyFileSync(ENGINE_BIN, engineDst);
fs.chmodSync(engineDst, 0o755);
fs.cpSync(ENGINE_NODE_MODULES, path.join(BUILT_APP, "Contents/node_modules"),
          { recursive: true, dereference: true });
fs.cpSync(ENGINE_JOURNAL, path.join(BUILT_APP, "Contents/drizzle"), { recursive: true });
say(`  ohmail-engine → Contents/MacOS/; node_modules + drizzle → Contents/`);

/* ── THE NODE RUNTIME — what makes the app STANDALONE ────────────────────────────────────
 *
 * The engine is a Node script, so the app carries its own Node rather than asking the user to
 * install one: a download that needs a second install is not standalone, and standalone is worth
 * the ~110 MB the runtime costs. It sits in `Contents/Resources/node` and
 * ``EngineProcess.resolveNode`` prefers it, so a Finder launch never depends on the user's PATH.
 *
 * UNIVERSAL: `build/vendor/node` is `lipo`'d from the official arm64 and x64 macOS builds, matching
 * the shell's own two slices. `scripts/vendor-node-macos.mjs` produces it — a script rather than a
 * paragraph of shell, because a build step only a person can follow is a step CI cannot, and an app
 * assembled by hand is not the one a tag describes. It verifies both archives against the release's
 * published checksums before combining them. The arm64 slice is what runs on Apple silicon; the x64
 * slice is shipped but, like the shell's, is unverified on real Intel hardware.
 *
 * SIGNED INNER, BEFORE THE OUTER BUNDLE. Node's V8 needs writable-then-executable memory, which on
 * an ad-hoc signature requires `com.apple.security.cs.allow-jit` and
 * `com.apple.security.cs.allow-unsigned-executable-memory` on NODE'S OWN Mach-O — not the shell's,
 * which would weaken the outer bundle for a capability it does not use. Nested code signs
 * inside-out: node (with its entitlements) first, the enclosing `.app` last. */
const VENDOR_NODE = path.join(REPO, "build", "vendor", "node");
if (!fs.existsSync(VENDOR_NODE)) {
  die(`the vendored Node runtime is missing: ${path.relative(REPO, VENDOR_NODE)}.\n` +
      `  Fetch it — the script verifies both official builds against the release checksums and\n` +
      `  lipo's them into one universal binary:\n\n` +
      `    node scripts/vendor-node-macos.mjs`);
}
const nodeArchs = (capture("lipo", ["-archs", VENDOR_NODE]) || "").split(/\s+/).filter(Boolean);
for (const a of ARCHS.split(/\s+/).filter(Boolean)) {
  if (!nodeArchs.includes(a)) {
    die(`the vendored Node is missing the ${a} slice (has: ${nodeArchs.join(" ") || "none"}).\n` +
        `  The app ships ${ARCHS}; a Node without every one of those slices is not standalone on all of them.`);
  }
}
const nodeDst = path.join(BUILT_APP, "Contents/Resources/node");
fs.copyFileSync(VENDOR_NODE, nodeDst);
fs.chmodSync(nodeDst, 0o755);
const nodeEntitlements = path.join(STAGE ?? os.tmpdir(), "node.entitlements.plist");
fs.writeFileSync(nodeEntitlements,
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
  `<plist version="1.0"><dict>\n` +
  `  <key>com.apple.security.cs.allow-jit</key><true/>\n` +
  `  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>\n` +
  `</dict></plist>\n`);
run("codesign", ["--force", "--sign", "-", "--timestamp=none",
                 "--entitlements", nodeEntitlements, nodeDst], { stdio: "inherit" });
say(`  Node ${nodeArchs.join("+")} → Contents/Resources/node (ad-hoc, JIT entitlements)`);

/* ── THE INVENTORY GATE, RESHAPED FOR THE ENGINE — and it still MEANS something ──
 *
 * The staging-tree gate above enumerates the shell's own files and refuses a kind it
 * does not know. The engine is a different payload — a bundle of ~68 npm packages plus
 * vendored PGlite — and it needs the licence question asked of THOSE, not of `.swift`
 * files. So this reads the engine's own metafile (the list of packages that actually
 * became bytes), resolves each one's licence from its `package.json`, and REFUSES the
 * build if any is AGPL or unresolved: GPL-3.0-or-later can carry MIT/BSD/Apache/ISC and
 * cannot carry AGPL, which would force publishing the hosted service in full. A new
 * dependency added to the engine trips this until its licence is stated in the notices,
 * which is the whole point — the gate is the thing that makes THIRD-PARTY-NOTICES.txt
 * complete rather than a hand-kept list that drifts. */
writeThirdPartyNotices();

/* Re-ad-hoc-sign: the engine, its journal and PGlite are new members of the bundle, and
 * `codesign --force --sign -` re-seals the whole thing over them. On Apple silicon an
 * unsigned Mach-O will not launch at all, so this is the floor, not a claim of provenance. */
step("re-ad-hoc-signing over the embedded engine");
/* INNER BEFORE OUTER. The engine is a second executable in `Contents/MacOS`, so `codesign` expects
 * it signed in its own right before it will seal the bundle over it; node in `Resources` was already
 * signed (with its JIT entitlements) above. Only then the enclosing `.app`. */
run("codesign", ["--force", "--sign", "-", "--timestamp=none", engineDst], { stdio: "inherit" });
run("codesign", ["--force", "--sign", "-", "--timestamp=none", BUILT_APP], { stdio: "inherit" });
run("codesign", ["--verify", "--verbose=2", BUILT_APP], { stdio: "inherit" });

/* THE ENGINE BOOTS FROM THE BUNDLE IT NOW SITS IN — proven on the assembled app, not on
 * `build/engine`. This is the one check that exercises the shipped `Contents/MacOS` +
 * `Contents/drizzle` relationship; every vitest suite runs the engine from source, where
 * the same path expression happens to resolve to the workspace journal. */
step("verify-engine-boot, against the assembled bundle");
run(process.execPath, [path.join(REPO, "scripts/verify-engine-boot.mjs"),
                       path.join(BUILT_APP, "Contents")], { stdio: "inherit" });

/* Rebuild the ad-hoc DMG around the engine-bearing app, with the ENGINE-BEARING first-run
 * notes. `package-app.sh` sealed the fixtures notes and no engine into its DMG; that one is
 * now stale in both respects. The signed path rebuilds its own DMG in `signAndNotarize`. */
if (!SIGN) rebuildAdHocDmg();

/**
 * Enumerate the engine's third-party code from its metafile, resolve each package's licence,
 * refuse AGPL/unresolved, and write `Contents/Resources/THIRD-PARTY-NOTICES.txt`.
 */
function writeThirdPartyNotices() {
  step("third-party notices + engine licence gate");
  const meta = JSON.parse(fs.readFileSync(ENGINE_META, "utf8"));
  /* Every `node_modules/.pnpm/<spec>/node_modules/…` input names a package in the pnpm store, and
   * the STORE DIRECTORY NAME (`<spec>`) is what carries the package identity — `@zone-eu+mailsplit@5.4.14`,
   * `drizzle-orm@0.36.4_<peers>`. The import path AFTER `node_modules/` is that package's OWN layout
   * (`drizzle-orm/pg-core/…`) and must not be mistaken for a package name, which the first version of
   * this did. So the spec dir is the unit: `+`→`/` restores a scope, the last `@` splits name from
   * version, and a `_<peers>` suffix is dropped. PGlite is `external` in the build (vendored, not
   * bundled), so it is added by hand from the copy that will ship. */
  /* ── ENUMERATE THE BUNDLED THIRD-PARTY PACKAGES — LAYOUT-AGNOSTIC ─────────────────────────────
   *
   * A package's identity is the segment after the LAST `node_modules/` in a metafile input, and its
   * directory is the path up to and including that segment. This resolves BOTH pnpm's
   * `node_modules/.pnpm/<spec>/node_modules/<name>/…` store and npm's flat `node_modules/<name>/…`,
   * including npm's nested `…/parent/node_modules/<name>` for a conflicting version. It has to: this
   * repository's CI installs the engine's dependencies with `npm ci` (a flat tree), while the
   * workspace it is generated from installs the same closure with pnpm (a content-addressed store),
   * and a matcher that understood only one layout would enumerate NOTHING on the other — the AGPL
   * gate would then pass having inspected no licence at all, and THIRD-PARTY-NOTICES.txt would omit
   * every bundled package. Version and licence are read from each resolved `package.json` rather than
   * parsed out of a store-specific directory name, for the same reason. */
  const pkgDirs = new Set();
  for (const input of Object.keys(meta.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const rest = input.slice(at + "node_modules/".length).split("/");
    const nameLen = rest[0]?.startsWith("@") ? 2 : 1;   // a scoped name is `@scope/name`
    if (rest.length < nameLen || !rest[nameLen - 1]) continue;
    pkgDirs.add(input.slice(0, at) + "node_modules/" + rest.slice(0, nameLen).join("/"));
  }
  const pgliteDir = path.join(BUILT_APP, "Contents/node_modules/@electric-sql/pglite");
  const entries = [];
  const forbidden = [];
  const unresolved = [];
  const seen = new Set();
  /* Read name, version and licence from the package's OWN manifest — the directory is the only
   * thing the caller supplies, so this is identical for every store layout. */
  const add = (dir) => {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) { unresolved.push(path.relative(REPO, dir)); return; }
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const name = pkg.name ?? path.basename(dir);
    const version = pkg.version ?? null;
    const key = `${name}@${version ?? "?"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const licence = typeof pkg.license === "string" ? pkg.license
      : (pkg.license?.type || (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(" OR ") : ""));
    if (!licence) { unresolved.push(key); return; }
    if (/\bAGPL/i.test(licence)) forbidden.push(`${key} (${licence})`);
    const licFile = ["LICENSE", "LICENCE", "LICENSE.md", "license", "LICENSE.txt", "LICENSE-MIT"]
      .map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    entries.push({ name, version, licence, text: licFile ? fs.readFileSync(licFile, "utf8").trim() : null });
  };
  for (const dir of [...pkgDirs].sort()) add(path.join(REPO, dir));
  add(pgliteDir);   // external (vendored, not bundled), so it is never in the metafile inputs

  /* ── NON-VACUITY: under-enumeration must fail RED, never pass green ───────────────────────────
   *
   * The failure this guards is the one a layout bug produces, and it is silent both ways: an
   * enumeration that finds nothing runs the AGPL check over an empty set (passes) and writes notices
   * that list nothing (also passes). So the metafile's own third-party file count is an independent
   * floor — a bundle that draws in third-party code MUST resolve a plausible number of packages, or
   * the gate refuses. Measured: this engine bundles ~74 packages via the metafile; the floor sits
   * far above the vacuous case (2) and comfortably below 74, with margin for ordinary churn. Watched
   * failing: force `pkgDirs` short and this dies. */
  const thirdPartyInputs = Object.keys(meta.inputs).filter((i) => i.includes("node_modules/")).length;
  const MIN_BUNDLED_PACKAGES = 40;
  if (thirdPartyInputs > 0 && pkgDirs.size < MIN_BUNDLED_PACKAGES) {
    die(`the licence enumeration resolved only ${pkgDirs.size} bundled package(s) from ` +
        `${thirdPartyInputs} third-party file input(s) in the engine metafile.\n` +
        `  It has under-counted — a store layout it does not understand is the usual cause — so the\n` +
        `  AGPL gate would pass having inspected almost no licences, and the notices would omit most\n` +
        `  of what this binary conveys. Refusing to ship an incomplete licence audit.`);
  }

  /* The vendored Node runtime itself. MIT, and its own LICENSE reproduces the licences of the
   * components Node bundles — OpenSSL, ICU, libuv, V8, zlib and the rest — so shipping that text is
   * what makes the notices cover the runtime completely. */
  const nodeVersion = (capture(path.join(BUILT_APP, "Contents/Resources/node"), ["--version"]) || "").trim() || "22.x";
  const nodeLicense = path.join(REPO, "build/vendor/node.LICENSE");
  if (!fs.existsSync(nodeLicense)) {
    die(`the vendored Node's LICENSE is missing (build/vendor/node.LICENSE) — it must ship in the\n` +
        `  notices because it covers OpenSSL, ICU and the rest of what Node bundles.`);
  }
  entries.push({ name: "node", version: nodeVersion.replace(/^v/, ""), licence: "MIT",
                 text: fs.readFileSync(nodeLicense, "utf8").trim() });

  if (forbidden.length) {
    die(`the engine bundles code under an AGPL licence, which GPL-3.0-or-later cannot carry\n` +
        `  without forcing the hosted service to be published in full:\n\n` +
        forbidden.map((f) => `    ${f}`).join("\n"));
  }
  if (unresolved.length) {
    die(`the engine bundles packages whose licence could not be read — declare them or the\n` +
        `  notices are incomplete:\n\n` + unresolved.slice(0, 20).map((u) => `    ${u}`).join("\n"));
  }
  const dedup = new Map(entries.map((e) => [`${e.name}@${e.version}`, e]));
  const sorted = [...dedup.values()].sort((a, b) => a.name.localeCompare(b.name));
  const header =
    "ohmail for macOS — third-party notices\n" +
    "======================================\n\n" +
    "ohmail's mail engine bundles the components below. Each is distributed under its own\n" +
    "licence, reproduced where the package ships one. ohmail's own code is GPL-3.0-or-later.\n" +
    "\nGenerated from the engine build; do not edit by hand.\n\n" +
    sorted.map((e) => `  - ${e.name} ${e.version} — ${e.licence}`).join("\n") + "\n";
  const bodies = sorted.filter((e) => e.text).map((e) =>
    `\n${"=".repeat(78)}\n${e.name} ${e.version} — ${e.licence}\n${"=".repeat(78)}\n\n${e.text}\n`).join("\n");
  fs.writeFileSync(path.join(BUILT_APP, "Contents/Resources/THIRD-PARTY-NOTICES.txt"), header + bodies);
  say(`  ${sorted.length} packages, all GPL-compatible; notices written to Contents/Resources/`);
}

/** Rebuild the ad-hoc DMG around the (engine-bearing) app, with the engine-bearing notes. */
function rebuildAdHocDmg() {
  step("rebuilding the DMG around the engine-bearing app");
  const short = plist(INFO, "CFBundleShortVersionString");
  const firstRun = path.join(TREE, "Resources/FIRST-RUN-ENGINE.txt");
  if (!fs.existsSync(firstRun)) die(`missing engine-bearing notes: Resources/FIRST-RUN-ENGINE.txt`);
  const dmgStage = fs.mkdtempSync(path.join(os.tmpdir(), "ohmail-dmg-"));
  run("ditto", [BUILT_APP, path.join(dmgStage, "ohmail.app")]);
  fs.copyFileSync(firstRun, path.join(dmgStage, "Read me first.txt"));
  fs.symlinkSync("/Applications", path.join(dmgStage, "Applications"));
  fs.rmSync(BUILT_DMG, { force: true });
  run("hdiutil", ["create", "-volname", `ohmail ${short}`, "-srcfolder", dmgStage,
                  "-fs", "HFS+", "-format", "UDZO", "-ov", "-quiet", BUILT_DMG], { stdio: "inherit" });
  fs.rmSync(dmgStage, { recursive: true, force: true });
}

/* ─────────────────────────────────────────────── Developer ID + notarise ──
 *
 * NEVER EXECUTED. There are no ohmail signing credentials, so every Apple-facing
 * line below is unverified against Apple's services and is written to be read as
 * much as run. It is guarded by preflight checks that ARE exercised (identity
 * absent → a clear death), it re-smokes before the slow notary round-trip so a
 * hardened-runtime breakage surfaces locally, and it never silently degrades to
 * ad-hoc: if signing was asked for and cannot be done, the run already stopped.
 *
 * The DMG is rebuilt rather than re-signed because package-app.sh ad-hoc signs
 * the .app and then seals it into the DMG, so by the time control reaches here
 * the DMG holds an ad-hoc app. The hdiutil call below therefore restates
 * package-app.sh:69-83. That restatement should not survive: when a Developer ID
 * exists, teach package-app.sh to take an identity — it already takes
 * OHMAIL_ARCHS and OHMAIL_BUILD_VERSION from the environment — and delete this.
 * It lives here only because that script is the published mirror's copy.
 */
function signAndNotarize() {
  step("Developer ID signature (hardened runtime)");
  /* --options runtime is what notarisation requires. No entitlements file is
   * passed because this app needs none: it opens no socket, reads no user data,
   * runs no JIT. That is the strictest correct answer today.
   *
   * The Keychain is the one thing that will eventually want one. Asking for the
   * data-protection keychain answers errSecMissingEntitlement without a
   * `keychain-access-groups` entitlement, so the keystore uses the file keychain
   * instead — see `KeychainKeyStore`, which records the measurement. Granting
   * that entitlement is the change that moves it, and it is a signing change
   * rather than a code one.
   *
   * When the engine lands it brings a node binary, and node needs BOTH
   * com.apple.security.cs.allow-jit and
   * com.apple.security.cs.allow-unsigned-executable-memory — V8 will not start
   * without them, and the failure looks like a product bug rather than a signing
   * one. Those belong on the NODE binary's own signature, not the app's: each
   * Mach-O carries its own entitlements, and granting the app JIT it does not
   * need weakens the outer bundle for nothing. Nested code signs inside-out —
   * helpers first, enclosing bundle last. No --deep: it is Apple-deprecated and
   * re-signs nested code with the wrong entitlements. */
  run("codesign", ["--force", "--options", "runtime", "--timestamp",
                   "--sign", IDENTITY, BUILT_APP], { stdio: "inherit" });
  run("codesign", ["--verify", "--strict", "--verbose=2", BUILT_APP], { stdio: "inherit" });

  /* Before the notary round-trip, not after: hardened runtime can break a
   * process that ran perfectly ad-hoc, and that must not be discovered in a
   * ticket from a user. */
  smokeTheBundle("hardened runtime");

  step("notarising the app (waits on Apple; minutes, not seconds)");
  submitAndCheck(zipForNotary(BUILT_APP));
  run("xcrun", ["stapler", "staple", BUILT_APP], { stdio: "inherit" });

  step("rebuilding the DMG around the stapled app");
  const short = plist(INFO, "CFBundleShortVersionString");
  const dmgStage = fs.mkdtempSync(path.join(os.tmpdir(), "ohmail-dmg-"));
  run("ditto", [BUILT_APP, path.join(dmgStage, "ohmail.app")]);
  fs.symlinkSync("/Applications", path.join(dmgStage, "Applications"));
  /* FIRST-RUN.txt is deliberately NOT copied here. It tells the reader "this
   * build is UNSIGNED and UN-NOTARIZED" and walks them through a right-click →
   * Open they no longer need. Shipping it beside a notarised app would be a
   * false statement in the one file written to be trusted on first contact.
   * A signed-build variant of those notes is an edit to public/ohmail/Resources,
   * which is the mirror's copy and not this script's to make. */
  fs.rmSync(BUILT_DMG, { force: true });
  run("hdiutil", ["create", "-volname", `ohmail ${short}`, "-srcfolder", dmgStage,
                  "-fs", "HFS+", "-format", "UDZO", "-ov", "-quiet", BUILT_DMG], { stdio: "inherit" });
  fs.rmSync(dmgStage, { recursive: true, force: true });

  step("signing, notarising and stapling the DMG");
  run("codesign", ["--force", "--timestamp", "--sign", IDENTITY, BUILT_DMG], { stdio: "inherit" });
  submitAndCheck(BUILT_DMG);
  run("xcrun", ["stapler", "staple", BUILT_DMG], { stdio: "inherit" });

  for (const artifact of [BUILT_APP, BUILT_DMG]) {
    run("xcrun", ["stapler", "validate", artifact], { stdio: "inherit" });
  }
  /* The only check that answers the question a downloader actually has: would
   * Gatekeeper let this run on a machine that has never seen it? */
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", BUILT_APP], { stdio: "inherit" });
}

/** notarytool wants a flat file, not a bundle directory. */
function zipForNotary(app) {
  const zip = `${app}.zip`;
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  return zip;
}

/**
 * Submit and READ THE VERDICT, rather than trusting the exit code.
 * `notarytool submit --wait` has shipped versions that exit 0 on
 * `status: Invalid`, which would staple nothing and ship a rejected build.
 */
function submitAndCheck(artifact) {
  const out = run("xcrun", ["notarytool", "submit", artifact,
                            "--keychain-profile", NOTARY_PROFILE, "--wait"]) || "";
  process.stdout.write(out);
  if (!/status:\s*Accepted/i.test(out)) {
    const id = (out.match(/id:\s*([0-9a-f-]{36})/i) || [])[1];
    die(`the notary service did not accept ${path.basename(artifact)}.\n\n` +
        `  Read the reasons with:\n` +
        `      xcrun notarytool log ${id || "<submission-id>"} --keychain-profile ${NOTARY_PROFILE}\n\n` +
        `  Nothing was stapled and nothing was copied into build/.`);
  }
}

if (SIGN) signAndNotarize();

/* ──────────────────────────────────────────────── what the bundle claims ──
 * Claims are contracts. The DMG ships first-run notes telling a stranger this
 * build has "no IMAP client, no network code" and that their own mail "is not
 * involved and cannot be". Those are the strongest statements ohmail makes to
 * someone who has just downloaded a binary, so they are checked against the
 * bytes rather than trusted from the copy.
 */
step("verifying the bundle against what it claims");

const problems = [];
const fail = (what, why) => problems.push({ what, why });

/* 1. Identity and metadata. */
for (const [k, want] of Object.entries({
  CFBundleIdentifier: "io.ohmail.desktop",
  CFBundleName: "ohmail",
  CFBundleDisplayName: "ohmail",
  CFBundleExecutable: "OhMail",
  CFBundlePackageType: "APPL",
  LSApplicationCategoryType: "public.app-category.productivity",
  LSMinimumSystemVersion: "15.0",
  CFBundleVersion: BUILD_VERSION,
})) {
  const got = plist(INFO, k);
  if (got !== want) fail(`Info.plist ${k}`, `is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}
if (plist(INFO, "CFBundleVersion") === "0") {
  fail("Info.plist CFBundleVersion", "is 0 — package-app.sh's fallback fired, so the build number is not one");
}

/* 2. The brand. "MailOh" is the pre-rename name and must not reach anything a
 *    user or a Finder column can see, the display name included. */
for (const [what, text] of [
  ["Info.plist", fs.readFileSync(INFO, "utf8")],
  ["the executable", fs.readFileSync(MACHO, "latin1")],
]) {
  if (/MailOh/.test(text)) fail(`brand in ${what}`, `contains "MailOh" — the brand is ohmail`);
}

/* 3. The icon is present and is a real icon set, not a zero-byte placeholder. */
const icon = path.join(BUILT_APP, "Contents/Resources/ohmail.icns");
if (!fs.existsSync(icon) || fs.statSync(icon).size < 1024) {
  fail("the app icon", "Contents/Resources/ohmail.icns is missing or too small to be an icon set");
} else if (fs.readFileSync(icon).subarray(0, 4).toString("latin1") !== "icns") {
  fail("the app icon", "does not begin with the 'icns' magic");
}

/* 4. Every requested architecture actually made it in. */
const arches = (capture("lipo", ["-archs", MACHO]) || "").split(/\s+/).filter(Boolean);
for (const a of ARCHS.split(/\s+/).filter(Boolean)) {
  if (!arches.includes(a)) fail("architectures", `${a} was requested but the binary has: ${arches.join(" ") || "none"}`);
}

/* 5. "No network code" — asserted, not merely asserted in prose.
 *
 * ── THIS USED TO REFUSE THE DYLIB, AND THE DYLIB IS THE WRONG UNIT ──────────
 *
 * It read `otool -L` and failed on CFNetwork, Network, Security or libnetwork
 * appearing at all. That was a good proxy while the app was one window over
 * fixtures, and it stopped being one twice over:
 *
 *   · the bridge to the local engine shapes its replies as `HTTPURLResponse`,
 *     whose Objective-C class lives in CFNetwork. It is a value type. It has no
 *     socket in it, and constructing one dials nothing;
 *   · the keystore reads one item out of the Keychain, which is `SecItem*` in
 *     Security. Also no socket.
 *
 * So the check moved from WHICH LIBRARIES ARE LINKED to WHICH SYMBOLS ARE
 * IMPORTED, which is the thing the claim is actually about — and is stricter,
 * not looser: `dyld_info -imports` attributes every imported symbol to the
 * library it comes from, so the two libraries a socket could come out of are
 * held to an explicit list of what may be taken from them. A build that started
 * using `NSURLSession`, `SSLHandshake` or `SecureTransport` fails here, and
 * nothing has to remember to add it to a denylist.
 *
 * Network.framework and libnetwork stay refused outright: nothing in either is
 * anything but networking, so there is no allowed symbol to enumerate. */
const NETWORK_CAPABLE = {
  // Response metadata the engine bridge fills in itself. Nothing here opens
  // anything; `EngineTransport` states why no `URLSession` is involved.
  CFNetwork: new Set(["_OBJC_CLASS_$_NSHTTPURLResponse"]),
  // The Keychain, and the system random source. `KeychainKeyStore` is the only
  // caller.
  Security: new Set([
    "_SecItemAdd", "_SecItemCopyMatching", "_SecItemDelete",
    "_SecRandomCopyBytes", "_SecCopyErrorMessageString",
    "_kSecClass", "_kSecClassGenericPassword",
    "_kSecAttrService", "_kSecAttrAccount", "_kSecAttrAccessible",
    "_kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly", "_kSecAttrSynchronizable",
    "_kSecValueData", "_kSecReturnData", "_kSecMatchLimit", "_kSecMatchLimitOne",
    "_kSecRandomDefault",
  ]),
};

const linked = (capture("otool", ["-L", MACHO]) || "").split("\n")
  .filter((l) => /\/Network\.framework|libnetwork/.test(l));
if (linked.length) {
  fail("the no-network claim",
       `the first-run notes tell the downloader this build has "no network code",\n` +
       `      but the binary links:\n${linked.map((l) => `        ${l.trim()}`).join("\n")}\n` +
       `      Either the claim or the link has to go.`);
}

/* `dyld_info` is part of the toolchain this script already requires. A null
 * capture means it could not be run at all, which is a check that did not
 * happen — reported, never passed over. */
const imports = capture("dyld_info", ["-imports", MACHO]);
if (imports === null) {
  fail("the no-network claim", "dyld_info could not read the binary's imports, so the claim was never checked");
} else {
  const unexpected = [];
  for (const line of imports.split("\n")) {
    const m = /^\s*0x[0-9A-Fa-f]+\s+(\S+)\s+\(from (\S+)\)\s*$/.exec(line);
    if (!m) continue;
    const [, symbol, library] = m;
    const allowed = NETWORK_CAPABLE[library];
    if (allowed && !allowed.has(symbol)) unexpected.push(`${symbol}  (from ${library})`);
  }
  if (unexpected.length) {
    fail("the no-network claim",
         `the first-run notes tell the downloader this build has "no network code",\n` +
         `      and it imports from a library that can reach one:\n` +
         `${unexpected.map((s) => `        ${s}`).join("\n")}\n` +
         `      If these open nothing, add them to NETWORK_CAPABLE above with the\n` +
         `      reason. If any of them opens a socket, the claim has to go instead.`);
  }
}

/* 6. The signature verifies, whatever kind it is. */
if (capture("codesign", ["--verify", "--strict", BUILT_APP]) === null) {
  fail("the signature", "codesign --verify --strict rejected the bundle");
}

/* 7. Mount the DMG and look inside — the public CI job's check, plus the one it
 *    does not make: that the notes still disclose what this build is. */
const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "ohmail-mnt-"));
run("hdiutil", ["attach", BUILT_DMG, "-nobrowse", "-readonly", "-mountpoint", mnt], { stdio: "ignore" });
try {
  if (!fs.existsSync(path.join(mnt, "ohmail.app"))) fail("the DMG", "does not contain ohmail.app");
  if (!fs.existsSync(path.join(mnt, "Applications"))) fail("the DMG", "has no /Applications drag target");
  if (!fs.existsSync(path.join(mnt, "ohmail.app/Contents/Resources/ohmail.icns"))) {
    fail("the DMG", "the app inside it has no icon");
  }
  if (capture("codesign", ["--verify", "--strict", path.join(mnt, "ohmail.app")]) === null) {
    fail("the DMG", "the app inside it fails codesign --verify");
  }

  const notes = path.join(mnt, "Read me first.txt");
  if (SIGN) {
    /* The signed DMG must not ship the unsigned build's notes. */
    if (fs.existsSync(notes) && /UNSIGNED and UN-NOTARIZED/.test(fs.readFileSync(notes, "utf8"))) {
      fail("the first-run notes", "a notarised DMG is shipping text that says the build is unsigned");
    }
  } else if (!fs.existsSync(notes)) {
    fail("the first-run notes", "the DMG does not contain 'Read me first.txt'");
  } else {
    const text = fs.readFileSync(notes, "utf8");
    /* The disclosure, phrase by phrase, for the ENGINE-BEARING build. This app connects to a real
     * mailbox and carries its own runtime, so the notes must say what it IS — self-contained — and
     * still name the fixture door (`--args --demo`), which is now one mode of a real client rather
     * than the whole product. Reworded copy that still discloses will fail here, and should. */
    const missing = [
      "self-contained",                       // it carries its own Node; nothing else to install
      "connects to your own IMAP mail server", // it is a mail client, not a preview
      "--args --demo",                         // the fixture door, still named
    ].filter((p) => !text.toLowerCase().includes(p.toLowerCase()));
    if (missing.length) {
      fail("the first-run disclosure",
           `'Read me first.txt' no longer says: ${missing.map((m) => JSON.stringify(m)).join(", ")}.\n` +
           `      This build is a self-contained mail client with a fixture preview. The download has to say so.`);
    }
    if (!/UNSIGNED and UN-NOTARIZED/.test(text)) {
      fail("the signing disclosure", "an unsigned build's notes must tell its downloader it is unsigned");
    }
    /* THE OWNER'S STANDALONE DIRECTIVE, AS A CONTRACT. The app ships its own Node, so the notes must
     * not tell anyone to install one — a claim that would be both false and a broken promise. */
    if (/requires? node|install node|node 20\+? (is )?required/i.test(text)) {
      fail("the standalone claim", "the notes tell the user to install Node, but the app vendors its own runtime");
    }
    /* And the artifact must actually BE standalone: the runtime it claims to carry has to be there. */
    const vendoredNode = path.join(mnt, "ohmail.app/Contents/Resources/node");
    if (!fs.existsSync(vendoredNode) || fs.statSync(vendoredNode).size < 10 * 1024 * 1024) {
      fail("the vendored runtime", "Contents/Resources/node is missing or too small to be a Node binary");
    }
    for (const p of ["Contents/MacOS/ohmail-engine", "Contents/drizzle"]) {
      if (!fs.existsSync(path.join(mnt, "ohmail.app", p))) fail("the engine", `the app inside the DMG has no ${p}`);
    }
  }
} finally {
  run("hdiutil", ["detach", mnt, "-quiet"], { stdio: "ignore", tolerate: true });
  fs.rmSync(mnt, { recursive: true, force: true });
}

if (problems.length) {
  die(`the bundle does not match what it claims — ${problems.length} problem(s):\n\n` +
      problems.map((c) => `    ✗ ${c.what}: ${c.why}`).join("\n"));
}
say(`  metadata, brand, icon, architectures, signature, the no-network claim and the`);
say(`  first-run disclosure all check out.`);

/* ──────────────────────────────────────────────────────────── the output ──
 * Provenance is RECORDED, not printed. package-app.sh prints the commit to
 * stdout, where it is gone the moment the terminal scrolls; a downloadable needs
 * a fact somebody can check a file against months later.
 *
 * It goes in a sidecar rather than into Info.plist deliberately. Stamping extra
 * keys would make a locally-built bundle byte-differ from the one the public CI
 * job builds from the same commit, and two artifacts that disagree are worse
 * than one artifact with a manifest beside it; anything written into the bundle
 * after codesign also breaks the seal. The precedent is already here — the CI
 * run summary publishes a sha256 table beside the artifact, not inside it.
 */
step("writing build/ — and publishing nothing");

const OUT = path.join(REPO, "build");
fs.mkdirSync(OUT, { recursive: true });
/* In mirror mode TREE IS the repo, so build/ohmail.{app,dmg} were assembled directly in OUT — a
 * copy would be from a path onto itself (and the `rmSync` would delete the source first). */
if (!MIRROR_MODE) {
  for (const name of ["ohmail.app", "ohmail.dmg"]) {
    const dst = path.join(OUT, name);
    fs.rmSync(dst, { recursive: true, force: true });
    /* ditto, not cp: it preserves the signature and extended attributes. */
    run("ditto", [path.join(TREE, "build", name), dst]);
  }
} else {
  say(`  build/ohmail.app and build/ohmail.dmg were assembled in place`);
}

const outApp = path.join(OUT, "ohmail.app");
const manifest = {
  artifact: "ohmail for macOS",
  commit: SHA,
  builtFrom: MIRROR_MODE ? "mirror tree (in place)" : "git archive HEAD",
  unrelatedDirtAllowed: ALLOW_DIRT && dirty.length > 0,
  packagerModified: dirty.includes(PACKAGER),
  testsRun: !SKIP_TESTS,
  bundleVersion: BUILD_VERSION,
  shortVersion: plist(path.join(outApp, "Contents/Info.plist"), "CFBundleShortVersionString"),
  bundleIdentifier: plist(path.join(outApp, "Contents/Info.plist"), "CFBundleIdentifier"),
  architectures: arches,
  signing: SIGN
    ? { kind: "developer-id", identity: IDENTITY, notarized: true }
    : { kind: "ad-hoc", notarized: false, note: "first launch needs right-click → Open" },
  contents: "standalone mail client — embeds the mail engine and a vendored Node runtime; " +
    "connects to the user's own IMAP; a fixture preview under --demo. x86_64 slice untested on real Intel.",
  licence: "GPL-3.0-or-later; conveys no third-party code",
  toolchain: (capture("swift", ["--version"]) || "").split("\n")[0],
  builtOn: `macOS ${capture("sw_vers", ["-productVersion"])} ${capture("uname", ["-m"])}`,
  builtAt: new Date().toISOString(),
  /* The DMG and the Mach-O only. A `ditto -c -k` zip of the .app is not
   * reproducible — its bytes move with timestamps — so its digest would be a
   * number nobody can ever reproduce, which is worse than not publishing one. */
  sha256: {
    "ohmail.dmg": sha256(path.join(OUT, "ohmail.dmg")),
    "ohmail.app/Contents/MacOS/OhMail": sha256(path.join(outApp, "Contents/MacOS/OhMail")),
  },
};
const manifestPath = path.join(OUT, `ohmail-${SHORT}.build.json`);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (STAGE && KEEP_STAGING) say(`\n  staging kept at ${TREE}`);
else if (STAGE) fs.rmSync(STAGE, { recursive: true, force: true });

say("");
say(`  app       build/ohmail.app`);
say(`  dmg       build/ohmail.dmg  (${(fs.statSync(path.join(OUT, "ohmail.dmg")).size / 1e6).toFixed(1)} MB)`);
say(`  manifest  build/${path.basename(manifestPath)}`);
say(`  commit    ${SHORT}  ·  arch ${arches.join(" ")}`);
say(`  signing   ${SIGN ? `${IDENTITY}, notarised` : "ad-hoc — first launch needs right-click → Open"}`);
say("");
say(`\x1b[1mThis script does not publish.\x1b[0m Nothing was uploaded, tagged or released. It`);
say(`writes an engine-bearing, self-contained bundle to build/ and stops — publishing the engine`);
say(`SOURCE to the mirror is a separate, deliberate step, and it must come before or with any`);
say(`release of this binary (source-before-binary is the licence boundary this whole plan turns on).`);
