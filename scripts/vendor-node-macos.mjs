#!/usr/bin/env node
/**
 * vendor-node-macos.mjs — fetch the official macOS Node builds, verify them, and `lipo` one
 * universal binary into `build/vendor/node`.
 *
 *     node scripts/vendor-node-macos.mjs
 *
 * ── WHY THIS IS A SCRIPT AND NOT A PARAGRAPH ──────────────────────────────────────────────
 *
 * The packager needs a universal `node` beside the engine, and until now it refused with a block
 * of shell for a person to paste. That is a laptop step: CI cannot follow prose, so the one thing
 * standing between a tagged commit and an installable app was a human running four commands from
 * memory — and an artifact assembled by hand is not the artifact the tag describes. Everything a
 * downloader gets should come out of a run anyone can inspect.
 *
 * ── THE CHECKSUM IS THE POINT, NOT A COURTESY ─────────────────────────────────────────────
 *
 * This downloads an executable and puts it inside an application other people will run, so the
 * bytes are verified against the release's own `SHASUMS256.txt` before `lipo` ever sees them. A
 * mismatch is a hard refusal: shipping a runtime fetched over a connection nobody checked would
 * make the signature on the outer bundle a statement about the wrong thing.
 *
 * The manifest is fetched over HTTPS from the same host as the tarballs, which is the limit of what
 * this can prove on its own — it establishes that the archive matches the release the project
 * published, not that the release is itself trustworthy. Verifying the detached signature on
 * `SHASUMS256.txt` needs the release keyring and belongs with whoever pins the version.
 *
 * ── UNIVERSAL, BECAUSE THE SHELL IS ───────────────────────────────────────────────────────
 *
 * The app ships two slices, so its runtime must too, or the app is standalone on one architecture
 * and broken on the other. Both slices are taken from the official builds rather than compiled
 * here; the packager asserts afterwards that the result carries every slice the shell does.
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
const VERSION = process.env.OHMAIL_NODE_VERSION ?? "v22.23.2";
const ARCHES = ["arm64", "x64"];
const DIST = `https://nodejs.org/dist/${VERSION}`;

const OUT_DIR = path.join(ROOT, "build", "vendor");
const OUT = path.join(OUT_DIR, "node");
const OUT_LICENSE = `${OUT}.LICENSE`;

const say = (m) => process.stdout.write(`${m}\n`);
function die(m) {
  process.stderr.write(`\nvendor-node: ${m}\n`);
  process.exit(1);
}

/* `curl` rather than `fetch`: this runs in sandboxes where node's DNS is unavailable but curl
 * works, and it is the same tool the instructions this replaces told people to use. `--fail` so a
 * 404 from a mistyped version is an error instead of an HTML page written to the tarball. */
function curl(url, dest) {
  try {
    execFileSync("curl", ["-sSL", "--fail", "--retry", "3", "-o", dest, url], { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    die(`could not download ${url}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ohmail-node-"));

say(`vendor-node: ${VERSION}, ${ARCHES.join(" + ")}`);

/* The release manifest first, so a bad download is caught before it is unpacked rather than after
 * it has been turned into a binary. */
const shasums = path.join(work, "SHASUMS256.txt");
curl(`${DIST}/SHASUMS256.txt`, shasums);
const expected = new Map(
  fs.readFileSync(shasums, "utf8").split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2)
    .map(([hash, name]) => [name, hash]),
);
if (expected.size === 0) die(`${DIST}/SHASUMS256.txt listed no files — refusing to guess`);

const slices = [];
let licenseFrom = null;
for (const arch of ARCHES) {
  const name = `node-${VERSION}-darwin-${arch}.tar.gz`;
  const want = expected.get(name);
  if (!want) die(`${name} is not listed in the release's SHASUMS256.txt`);

  const tarball = path.join(work, name);
  curl(`${DIST}/${name}`, tarball);

  const got = sha256(tarball);
  if (got !== want) {
    die(`${name} does not match the release checksum.\n` +
        `  expected ${want}\n  got      ${got}\n` +
        `  Refusing to build an app around a runtime whose bytes are not the published ones.`);
  }
  say(`  ${name}  sha256 ok`);

  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  const slice = path.join(work, `node-${VERSION}-darwin-${arch}`, "bin", "node");
  if (!fs.existsSync(slice)) die(`the ${arch} archive did not contain bin/node`);
  slices.push(slice);
  licenseFrom ??= path.join(work, `node-${VERSION}-darwin-${arch}`, "LICENSE");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
execFileSync("lipo", ["-create", ...slices, "-output", OUT]);
fs.chmodSync(OUT, 0o755);

/* The runtime's own licence travels with it. An app that bundles someone else's binary and drops
 * their licence text is not a licensing subtlety, it is a missing file. */
if (!fs.existsSync(licenseFrom)) die("the archive did not contain a LICENSE — refusing to vendor it unlicensed");
fs.copyFileSync(licenseFrom, OUT_LICENSE);

const archs = execFileSync("lipo", ["-archs", OUT], { encoding: "utf8" }).trim();
for (const arch of ARCHES) {
  if (!archs.split(/\s+/).includes(arch)) die(`the vendored binary is missing the ${arch} slice (has: ${archs})`);
}

fs.rmSync(work, { recursive: true, force: true });

say(`\nvendor-node: ${path.relative(ROOT, OUT)}  [${archs}]  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MiB`);
say(`vendor-node: ${path.relative(ROOT, OUT_LICENSE)}`);
