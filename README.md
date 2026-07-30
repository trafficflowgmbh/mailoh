<div align="center">

<img src="docs/mailoh-icon.png" width="88" height="88" alt="MailOh">

# MailOh for the desktop

**Consent-first email, on the mailboxes you already have.**

A native SwiftUI client for macOS and a Tauri shell for Windows and Linux. Free,
GPL-3.0, no account, no subscription — this repository is the whole thing.

[![build](https://github.com/trafficflowgmbh/mailoh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/trafficflowgmbh/mailoh-desktop/actions/workflows/build.yml)
[![licence: GPL-3.0](https://img.shields.io/badge/licence-GPL--3.0-a3461c)](LICENSE)
[![macOS 15+](https://img.shields.io/badge/macOS-15%2B-111111)](#build-it-yourself)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-111111)](#windows-and-linux)
[![Linux](https://img.shields.io/badge/Linux-AppImage%20%C2%B7%20deb-111111)](#windows-and-linux)
[![mailoh.io](https://img.shields.io/badge/mailoh.io-website-666666)](https://mailoh.io)

</div>

---

## Status — read this first

**This is a preview of the interface, not a working mail client yet.** It runs on
a small fictional mailbox that ships inside the app.

| | |
|---|---|
| ✅ Runs, and is worth looking at | Every surface is real: Ohbox, Screener, Reads, Receipts, triage piles, tags, search, compose, settings — light and dark, down to a 390 pt window, keyboard-first. Native SwiftUI on macOS; the same interface in a locked-down webview on Windows and Linux. |
| ✅ Tested | 99 tests over the model, the rules and the design tokens, plus a render check (`--smoke`) that hosts every route offscreen, rasterises it, and fails if anything draws nothing or quietly collapses a list. The Tauri shell has its own 31-check render + offline audit over the built bundle, and 14 assertions on its security configuration. |
| ❌ Does not talk to your mailbox | There is **no IMAP client, no HTTP client, no telemetry and no update check** in either build. `import` lines across the whole macOS app: AppKit, Foundation, SwiftUI, Observation. Nothing else. The Windows/Linux shell forbids connections at the webview level (`connect-src 'none'`) and replaces the page's network APIs with functions that throw. |
| ❌ No accounts, no credentials | Nothing to sign into, nothing stored in the keychain. |
| 🔜 Next | The local engine slice — IMAP with IDLE and delta fetch, an on-device store, the rules pipeline, then AI with your own key or a local Ollama. See [Roadmap](#roadmap). |

Nothing in `Views/` reaches past `AppState` — not even for a string. That is the
seam the engine lands behind, and the test suite enforces it today so the swap
stays boring.

If you came here from [mailoh.io](https://mailoh.io) expecting to read your mail:
not yet. Watch the repository, or ask us at support@mailoh.io.

## What MailOh is

Email that asks your permission before it takes your attention, built **on your
existing mailboxes** — any IMAP provider — and organising them **in place**, in
real folders on the real server. Leave whenever you like; your mailbox stays
organised.

- **Screener** — nobody reaches you twice by default. First contact waits, with
  every held message shown in full, and you send the sender somewhere: Ohbox,
  Reads, Receipts, screened out, spam. The choice becomes a rule.
- **Ohbox** — the inbox, after the Screener has done its work. Only mail from
  people you said yes to.
- **Reads** — newsletters in a skim stream with a seen-waterline, so a week away
  costs you nothing.
- **Receipts** — orders, confirmations, tickets. Filed, not read.
- **Triage piles** — Reply Later, Set Aside, and **Resurface** for mail that
  should come back at a chosen time.
- **Tags, never folders** — cross-cutting, and applied on top of the one place a
  message actually lives.
- **AI proposes, you decide.** Suggestions are preselected, never applied.
  Nothing sends itself. One-time codes and login links are structurally excluded
  from anything AI touches — in this codebase a protected message has *no body
  field to leak*.

**Desktop is free and standalone** — local engine, local processing, bring your
own AI key or run Ollama. No account, no limits, and your mail never touches our
servers. MailOh Cloud (web, mobile, push, always-on processing, managed AI) is
the paid tier and a separate product; none of its code is in this repository.

## Screenshots

Rendered from this source tree by `swift run MailOh --shot`, unretouched.

**Ohbox** — a thread, its rule provenance, the blocked tracking pixel, the tags.

<img src="docs/ohbox-light.png" alt="MailOh Ohbox, light" width="100%">

**Screener** — a first-time sender who is a person rather than a list: two held
messages, both shown in full, one suggested destination, five to choose from, and
the keys that pick them. (In this preview the suggestion is a fixture, not a live
model — see [Status](#status--read-this-first).)

<img src="docs/screener-light.png" alt="MailOh Screener, light" width="100%">

<details>
<summary><strong>Dark mode</strong> (same two surfaces)</summary>

<img src="docs/ohbox-dark.png" alt="MailOh Ohbox, dark" width="100%">
<img src="docs/screener-dark.png" alt="MailOh Screener, dark" width="100%">

</details>

All of it is fictional mail from a fictional persona. No real people, no real
brands, no scraped inboxes.

## Build it yourself — macOS

**Requirements:** macOS 15 (Sequoia) or newer, and Xcode for the Swift 6
toolchain and the macOS SDK (`xcode-select --install` on its own is not enough).
Built and tested on every push with **Xcode 26.3 / Swift 6.2.4** on macOS 15 —
that is the combination we can vouch for; Swift 6.0 (Xcode 16) is the language
mode the package declares and should work, but is not covered by CI.

No dependencies: `Package.swift` declares zero third-party packages, so there is
nothing to resolve, install or trust.

```bash
git clone https://github.com/trafficflowgmbh/mailoh-desktop
cd mailoh-desktop

swift build --package-path apps/macos -c release   # ~15 s cold on an M-series Mac
swift test  --package-path apps/macos              # 99 tests, ~1 s
swift run   --package-path apps/macos MailOh       # opens the app
```

Two extra entry points, both used by CI:

```bash
# Render check: every route × light/dark × 1440 pt and 390 pt, hosted offscreen,
# rasterised, and audited — including that no message was replaced by a "N more"
# placeholder. Prints "SMOKE OK (110 checks)" and exits 0.
swift run --package-path apps/macos MailOh --smoke

# Screenshots of every route, both schemes, both widths, as PNGs.
swift run --package-path apps/macos MailOh --shot shots
```

And an installable bundle, which SwiftPM cannot make on its own:

```bash
./scripts/package-app.sh     # → build/MailOh.app and build/MailOh.dmg
```

## Windows and Linux

The same interface, in a Tauri v2 shell: a native Rust window around a
**locked-down webview** rendering a static bundle that ships inside the binary.
It is the same preview as the macOS app and the same fixture mailbox — see
[Status](#status--read-this-first) before you download anything.

**It cannot reach the network.** Not "does not" — cannot, in three independent
ways. The webview's Content-Security-Policy is `connect-src 'none'`, so `fetch`,
XHR, WebSocket and EventSource are refused before they are attempted. The page
then replaces those five APIs with functions that throw. And the Cloud sync
client is aliased out of the bundle at build time — it is not compiled in, and
its source is not even in this repository. The Tauri capability list is
literally empty (`"permissions": []`): the interface can call no Tauri command,
touch no file and spawn no process.

Because the interface is embedded **uncompressed**, you can check all of that on
a binary you downloaded, without running it:

```bash
strings -a mailoh.exe | grep -oE 'https?://[^ ]+' | sort -u   # W3C + React + Tauri docs, nothing else
strings -a mailoh.exe | grep -c Ohbox                         # the interface really is in there
```

### Build it yourself

**Requirements:** [Rust](https://rustup.rs) (stable) and Node 22. On Linux also
the Tauri prerequisites — on Ubuntu 24.04:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  libssl-dev build-essential curl wget file patchelf desktop-file-utils
```

On Windows, the MSVC build tools and WebView2 (already on Windows 11 and
up-to-date Windows 10).

```bash
cd apps/desktop
npm install
npm run ui:build      # → dist/, the bundle the app embeds
npm run smoke         # → SMOKE OK (31 checks) — renders, and proves it is offline
npx tauri build       # → src-tauri/target/release/bundle/…
```

`apps/desktop/README.md` is the long version: why the UI is bundled with Vite
rather than exported from Next, what each of the three aliases does, and the
complete capability and CSP set.

### Download a build

Every push to `main` also builds on GitHub-hosted `windows-latest` and
`ubuntu-latest` runners and attaches **MailOh_0.1.0_x64_en-US.msi**,
**MailOh_0.1.0_x64-setup.exe** (NSIS), **MailOh_0.1.0_amd64.AppImage** and
**MailOh_0.1.0_amd64.deb**. Each run's summary prints every artifact's SHA-256.

> [!IMPORTANT]
> **Windows: these builds have no Authenticode signature.** SmartScreen will
> show "Windows protected your PC" on first run. **More info → Run anyway.** The
> NSIS installer installs per-user, so it needs no administrator. Code-signing
> certificates cost money MailOh has not spent yet; building from source is the
> option that requires trusting nobody.

> [!IMPORTANT]
> **Linux: the AppImage needs the executable bit**, which GitHub's artifact zip
> does not preserve:
> ```bash
> chmod +x MailOh_0.1.0_amd64.AppImage && ./MailOh_0.1.0_amd64.AppImage
> ```
> If it exits immediately on a distribution that has not enabled unprivileged
> user namespaces, run it with `--appimage-extract-and-run`. The `.deb` installs
> with `sudo apt install ./MailOh_0.1.0_amd64.deb` and pulls in WebKitGTK; it is
> **not** in any repository, so it will never auto-update. There is no update
> checker in this build at all.

## Download a macOS build

Every push to `main` builds on a GitHub-hosted macOS runner and attaches
**MailOh.dmg** (universal, arm64 + x86_64) to the run:
[latest builds →](https://github.com/trafficflowgmbh/mailoh-desktop/actions/workflows/build.yml)
(the artifact list is at the bottom of a run; GitHub requires you to be signed
in to download artifacts). Each run's summary page prints the DMG's SHA-256, the
architectures in the binary and the exact toolchain, so you can check what you
downloaded against what the run produced.

> [!IMPORTANT]
> **These builds are unsigned and un-notarized.** They carry an ad-hoc signature
> only, not an Apple Developer ID, because MailOh does not have a paid Apple
> Developer account yet. On first launch macOS Gatekeeper will refuse a
> double-click and may claim the app "is damaged". It is not.
> **Right-click (or Control-click) MailOh.app → Open → Open.** The same note is
> in the DMG as *Read me first.txt*. Signed and notarized builds land with the
> developer account; until then, building from source is the option that requires
> trusting nobody.

## How it is put together

Two clients, one interface. The macOS app is native SwiftUI; the Windows/Linux
app is a Rust window around the React implementation of the same design system.
Neither is a port of the other — they are two renderings of one specification,
and the parts that could drift (colours, radii, spacing, shadows) are compared
numerically against the same token file by the Swift test suite.

### macOS — `apps/macos`

7,600 lines of Swift across 30 files plus 1,400 lines of tests, one SwiftPM
package, no dependencies.

| Target | Kind | What is in it |
|---|---|---|
| `MailOhKit` | library | `Theme/` (the design tokens), `Models/`, `Fixtures/`, `State/`, `Views/`, `App/` |
| `MailOh` | executable | `main.swift` — dispatches `--smoke`, `--shot`, or the app |
| `MailOhKitTests` | tests | 99 tests: counts and seen-semantics, lossless Screener moves, undo, triage, tags, search, numeric design-token fidelity, source audits, and the no-collapse audit |

### Windows and Linux — `apps/desktop`

Eleven lines of Rust, and a 330 KB bundle.

| Piece | What is in it |
|---|---|
| `src-tauri/src/main.rs` | the whole Rust side: create the window, run. No commands, no plugins, no `std::fs`, no `std::net`. |
| `src-tauri/tauri.conf.json` | window geometry (clean to 390 px), the CSP, the bundle targets, the `oh.` icon family |
| `src-tauri/capabilities/main.json` | one file, `"permissions": []` |
| `src/` | the desktop-specific layer: providers, the pre-paint theme stamp, the offline guard, and the stub that stands in for the Cloud sync client |
| `packages/{tokens,ui,fixtures,client-engine}` + `apps/webapp/app/{shell,views}` | the interface itself — the same sources the web client renders, compiled by Vite into the bundle Tauri embeds |

`apps/webapp/app/` here is **only** the client shell and its views. The Cloud web
app's sign-in, its API topology and its server-side plumbing are not in this
repository, and neither is the `/sync` protocol client.

One of those 99 reports as *skipped* here, and says why when it does: it compares
the triage pile's sheet-edge shadow against the original design prototype, which
is not published. It runs in the monorepo, where it once caught a shadow that had
drifted from `.10` to `.16` alpha.

Worth knowing if you plan to read the code:

- **`AppState` is the only thing views may touch.** No view imports fixtures; a
  test fails the build if one does.
- **Every colour and shadow comes from `Theme/`.** `Palette` converts the
  authored OKLCH values to sRGB with Ottosson's matrix so the native app and the
  web design system resolve to the same pixels; `Lift` holds the whole shadow
  vocabulary. A hand-written `OKLCH(` or `.shadow(` inside `Views/` fails the
  suite — that is how a drifted shadow was caught.
- **`--smoke` is the interesting test.** It proves three separate things per
  route: that it lays out, that it actually *draws* (bitmap sampled for ink and
  distinct colours), and that every message the state says exists was built by a
  real row view. The harness is itself mutation-tested: a flat bitmap must fail
  the blank check, and a deliberately collapsing list must fail the row audit.
- **Compact layout is not an afterthought.** `RootView` measures itself and
  publishes `compactLayout` at ≤ 900 pt; the rail becomes a drawer, panes
  collapse per view, and `--smoke` walks every route at 390 × 844 in both
  schemes.

`apps/macos/README.md` is the long version: the architecture, every invariant and
where it is enforced, the two instrumentation approaches that were tried and
abandoned, and the one deliberate divergence from `NavigationSplitView`.

This tree is a generated mirror of a private monorepo (the Cloud backend lives
there and stays there). Commits arrive as syncs that name the monorepo revision
they came from; pull requests land in the monorepo and come back out here.

## Roadmap

1. **The engine slice** — IMAP (IDLE, delta fetch, per-mailbox sequence), an
   on-device store, and the rules pipeline behind today's `AppState`. Real
   folders, moved in place, with the desired-state model that makes a half-moved
   mailbox impossible.
2. **Signed installers** — a notarized DMG with a real Apple Developer ID, an
   Authenticode-signed .msi and .exe, and automatic updates.
3. **AI, locally or with your key** — Screener suggestions and draft replies via
   your own API key or a local Ollama. Proposed, never applied; sensitive mail
   structurally excluded.

Dates are not promised. The order is.

## Licence

GPL-3.0-or-later. Copyright © 2026 **TrafficFlow GmbH**, Staubstrasse 1, 8038
Zürich, Switzerland.

The desktop client is free and is meant to stay free: GPL-3.0 means anyone can
use, study, change and share it, and any redistributed change comes back under
the same terms — so a closed-source re-skin of MailOh is not possible. Full text
in [LICENSE](LICENSE); the reasoning and the trademark note in
[COPYRIGHT](COPYRIGHT). Contributions need no CLA and no copyright assignment
([CONTRIBUTING.md](CONTRIBUTING.md)). Security reports:
[SECURITY.md](SECURITY.md).

---

<div align="center">

[mailoh.io](https://mailoh.io) · [issues](https://github.com/trafficflowgmbh/mailoh-desktop/issues) · support@mailoh.io

Built in Zürich by [TrafficFlow GmbH](https://trafficflow.ch).

</div>
