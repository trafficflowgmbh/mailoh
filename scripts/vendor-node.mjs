#!/usr/bin/env node
/**
 * vendor-node.mjs — fetch the official Node build for one platform, verify it, and put the runtime
 * in `build/vendor/` where the packager copies it into the app.
 *
 *     node scripts/vendor-node.mjs                    # this machine's platform
 *     node scripts/vendor-node.mjs --platform linux   # darwin | linux | windows
 *
 * ── WHY THIS IS A SCRIPT AND NOT A PARAGRAPH ──────────────────────────────────────────────
 *
 * The app carries its own Node runtime, and until this existed the packager refused with a block of
 * shell for a person to paste. That is a laptop step: CI cannot follow prose, so the one thing
 * standing between a tagged commit and an installable app was a human running four commands from
 * memory — and an artifact assembled by hand is not the artifact the tag describes. Everything a
 * downloader gets should come out of a run anyone can inspect.
 *
 * ── WHY THE APP CARRIES A RUNTIME AT ALL ──────────────────────────────────────────────────
 *
 * The mail engine is a Node program. Relying on the user's own Node meant relying on `PATH`, and the
 * `PATH` a shipped app is opened with is not the one a developer has: a macOS Finder or launchd
 * launch gets `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no nvm — and a Windows or Linux desktop
 * launch is no better. So "install Node 20+ first" was not a requirement a product could state; it
 * was a build that started and then failed to find its own engine. The shell resolves this vendored
 * runtime first (`engine.rs::resolve_node`) precisely so a normal machine needs nothing installed.
 *
 * ── THE CHECKSUM IS THE POINT, NOT A COURTESY ─────────────────────────────────────────────
 *
 * This downloads an executable and puts it inside an application other people will run, so the bytes
 * are verified against the release's own `SHASUMS256.txt` before anything unpacks them. A mismatch
 * is a hard refusal: shipping a runtime fetched over a connection nobody checked would make the
 * signature on the outer bundle a statement about the wrong thing.
 *
 * The manifest is fetched over HTTPS from the same host as the archives, which is the limit of what
 * this can prove on its own — it establishes that the archive matches the release the project
 * published, not that the release is itself trustworthy. Verifying the detached signature on
 * `SHASUMS256.txt` needs the release keyring and belongs with whoever pins the version.
 *
 * ── ONE PLATFORM PER RUN, AND WHY THERE IS NO CROSS-VENDORING ─────────────────────────────
 *
 * Each platform's runtime is fetched on that platform's own build runner, beside the app it goes
 * into. Fetching all three anywhere would be possible — they are just archives — and it would let a
 * macOS box produce a Linux package whose runtime nothing on that box ever executed. The one thing
 * this script can cheaply prove is that the binary it just wrote RUNS (see the `--version` check at
 * the end), and that proof is only available on the target platform.
 *
 * macOS is the exception that proves it: there the app is universal, so both slices are fetched and
 * `lipo`d into one binary — and the check afterwards asserts every slice is present, because a
 * runtime with one slice inside a two-slice app is an app that works on the machine that built it
 * and fails on half the machines that download it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* Pinned, and read from one place. A runtime bump is a deliberate edit here, not whatever the
 * `latest` redirect happened to serve on the day a release was cut. */
export const VERSION = process.env.OHMAIL_NODE_VERSION ?? "v22.23.2";
const DIST = `https://nodejs.org/dist/${VERSION}`;

const OUT_DIR = path.join(ROOT, "build", "vendor");

const say = (m) => process.stdout.write(`${m}\n`);
function die(m) {
  process.stderr.write(`\nvendor-node: ${m}\n`);
  process.exit(1);
}

/**
 * What each platform downloads, and what comes out.
 *
 * `archives` are nodejs.org's own names — the ONLY strings that address a release — and `binary` is
 * the path to the runtime inside the unpacked archive. Note `x64` in the download names and
 * `x86_64` in `slices`: those are the same architecture under two spellings, and the second is the
 * one `lipo -archs` prints. Checking for the literal `x64` there fails on a bundle that is in fact
 * correct, which is the kind of guard that gets deleted for being wrong rather than fixed.
 */
const PLATFORMS = {
  darwin: {
    archives: [`node-${VERSION}-darwin-arm64.tar.gz`, `node-${VERSION}-darwin-x64.tar.gz`],
    unpack: ["-xzf"],
    binary: (name) => path.join(name.replace(/\.tar\.gz$/, ""), "bin", "node"),
    licence: (name) => path.join(name.replace(/\.tar\.gz$/, ""), "LICENSE"),
    out: "node",
    /* Universal, because the shell is. An app that ships two slices and a one-slice runtime is
     * standalone on one architecture and broken on the other. */
    slices: ["arm64", "x86_64"],
  },
  linux: {
    archives: [`node-${VERSION}-linux-x64.tar.xz`],
    unpack: ["-xJf"],
    binary: (name) => path.join(name.replace(/\.tar\.xz$/, ""), "bin", "node"),
    licence: (name) => path.join(name.replace(/\.tar\.xz$/, ""), "LICENSE"),
    out: "node",
  },
  windows: {
    archives: [`node-${VERSION}-win-x64.zip`],
    /* `tar -xf` and not `unzip`: Windows 10+ ships bsdtar as `tar.exe`, which reads zip archives,
     * and `unzip` is not on a Git-Bash PATH. One tool, three platforms, nothing to install. */
    unpack: ["-xf"],
    binary: (name) => path.join(name.replace(/\.zip$/, ""), "node.exe"),
    licence: (name) => path.join(name.replace(/\.zip$/, ""), "LICENSE"),
    out: "node.exe",
  },
};

/** `process.platform` → the key above. */
function hostPlatform() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return null;
}

/* `curl` rather than `fetch`: this runs in sandboxes where node's DNS is unavailable but curl works.
 * `--fail` so a 404 from a mistyped version is an error instead of an HTML page written to the
 * archive and a checksum mismatch three steps later. */
function curl(url, dest) {
  try {
    execFileSync("curl", ["-sSL", "--fail", "--retry", "3", "-o", dest, url], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    die(`could not download ${url}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const args = process.argv.slice(2);
const flag = args.indexOf("--platform");
const target = flag >= 0 ? args[flag + 1] : hostPlatform();
const spec = PLATFORMS[target];
if (!spec) {
  die(`unknown platform ${JSON.stringify(target)} — one of ${Object.keys(PLATFORMS).join(", ")}`);
}

const OUT = path.join(OUT_DIR, spec.out);
const OUT_LICENSE = path.join(OUT_DIR, "node.LICENSE");

const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ohmail-node-"));

say(`vendor-node: ${VERSION} for ${target}`);

/* The release manifest first, so a bad download is caught before it is unpacked rather than after it
 * has been turned into a binary inside an app. */
const shasums = path.join(work, "SHASUMS256.txt");
curl(`${DIST}/SHASUMS256.txt`, shasums);
const expected = new Map(
  fs.readFileSync(shasums, "utf8").split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2)
    .map(([hash, name]) => [name, hash]),
);
if (expected.size === 0) die(`${DIST}/SHASUMS256.txt listed no files — refusing to guess`);

const binaries = [];
let licenceFrom = null;
for (const name of spec.archives) {
  const want = expected.get(name);
  if (!want) die(`${name} is not listed in the release's SHASUMS256.txt`);

  const archive = path.join(work, name);
  curl(`${DIST}/${name}`, archive);

  const got = sha256(archive);
  if (got !== want) {
    die(`${name} does not match the release checksum.\n` +
        `  expected ${want}\n  got      ${got}\n` +
        `  Refusing to build an app around a runtime whose bytes are not the published ones.`);
  }
  say(`  ${name}  sha256 ok`);

  execFileSync("tar", [...spec.unpack, archive, "-C", work]);
  const binary = path.join(work, spec.binary(name));
  if (!fs.existsSync(binary)) die(`${name} did not contain ${spec.binary(name)}`);
  binaries.push(binary);
  licenceFrom ??= path.join(work, spec.licence(name));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(OUT, { force: true });
if (binaries.length > 1) {
  execFileSync("lipo", ["-create", ...binaries, "-output", OUT]);
} else {
  fs.copyFileSync(binaries[0], OUT);
}
/* Explicitly, and not left to whatever the archive or `lipo` produced. The shell holds the runtime
 * to "runnable, not merely present" — a copy that lost its mode is reported as a build with no Node
 * in it, which reads as a broken install rather than as a broken package. */
fs.chmodSync(OUT, 0o755);

/* The runtime's own licence travels with it. An app that bundles someone else's binary and drops
 * their licence text is not a licensing subtlety, it is a missing file. */
if (!fs.existsSync(licenceFrom)) die("the archive did not contain a LICENSE — refusing to vendor it unlicensed");
fs.copyFileSync(licenceFrom, OUT_LICENSE);

/* Every slice the app has. See `slices` above for why the spelling differs from the download name. */
if (spec.slices) {
  const archs = execFileSync("lipo", ["-archs", OUT], { encoding: "utf8" }).trim().split(/\s+/);
  for (const want of spec.slices) {
    if (!archs.includes(want)) {
      die(`the vendored binary is missing the ${want} slice (has: ${archs.join(" ") || "none"})`);
    }
  }
  say(`  slices: ${archs.join(" ")}`);
}

/* IT RUNS, and this is the only check here that is about the binary rather than about its bytes.
 * A checksum proves the download matched a manifest; it says nothing about whether this machine can
 * execute the result — a wrong architecture, a stripped slice, a missing loader all pass the hash
 * and fail here. Only possible because each platform vendors on its own runner; see the header. */
if (target === hostPlatform()) {
  let reported;
  try {
    reported = execFileSync(OUT, ["--version"], { encoding: "utf8" }).trim();
  } catch (err) {
    die(`the vendored runtime would not run on this machine: ${err.message}`);
  }
  if (reported !== VERSION) die(`the vendored runtime reports ${reported}, not ${VERSION}`);
  say(`  runs: ${reported}`);
} else {
  say(`  (not run: vendored for ${target} on ${hostPlatform() ?? "an unknown platform"})`);
}

fs.rmSync(work, { recursive: true, force: true });

say(`\nvendor-node: ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MiB`);
say(`vendor-node: ${path.relative(ROOT, OUT_LICENSE)}`);
