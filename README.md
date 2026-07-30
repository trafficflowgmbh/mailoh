<div align="center">

<img src="docs/mailoh-icon.png" width="88" height="88" alt="mailoh">

# mailoh for the desktop

**Consent-first email, on the mailboxes you already have.**

A native SwiftUI client for macOS and a Tauri shell for Windows and Linux.
Free, GPL-3.0, no account, no subscription — this repository is the whole thing.

[![build](https://github.com/trafficflowgmbh/mailoh/actions/workflows/build.yml/badge.svg)](https://github.com/trafficflowgmbh/mailoh/actions/workflows/build.yml)
[![licence: GPL-3.0](https://img.shields.io/badge/licence-GPL--3.0-a3461c)](LICENSE)
[![macOS 15+](https://img.shields.io/badge/macOS-15%2B-111111)](#macos)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-111111)](#windows)
[![Linux](https://img.shields.io/badge/Linux-AppImage%20%C2%B7%20deb-111111)](#linux)
[![mailoh.io](https://img.shields.io/badge/mailoh.io-website-666666)](https://mailoh.io)

</div>

---

## What this repository is

**This repository is the free mailoh desktop apps** — macOS, Windows and Linux.
All of them, all of their source, under GPL-3.0. There is no paid edition of the
desktop app, no feature held back for one, and no telemetry reporting back on
you.

**mailoh Cloud — the hosted sync service — is the commercial product and is not
open source.** It is what puts your mail on your phone and on the web and keeps
it organised while your laptop is shut. None of its code is in this repository:
no backend, no billing, no sync server. It is entirely optional, and the desktop
app never asks you for it.

[Desktop or Cloud](#desktop-or-cloud) explains the split properly, including
what Cloud costs.

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

## What mailoh is

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
- **Triage piles** — Answer Later, Parked, and **Resurface** for mail that
  should come back at a chosen time.
- **Tags, never folders** — cross-cutting, and applied on top of the one place a
  message actually lives.
- **Organise in place** — every decision lands as a real folder on your real
  server, readable by every other mail app you own. There is no export step,
  because there is nothing to export.
- **Spy pixels blocked** — the tracking pixels that tell a sender when you opened
  their mail, and where, do not load.
- **AI proposes, you decide.** Suggestions are preselected, never applied.
  Nothing sends itself. One-time codes and login links are structurally excluded
  from anything AI touches — in this codebase a protected message has *no body
  field to leak*.

## Screenshots

Rendered from this source tree by `swift run MailOh --shot`, unretouched.

**Ohbox** — a thread, its rule provenance, the blocked tracking pixel, the tags.

<img src="docs/ohbox-light.png" alt="mailoh Ohbox, light" width="100%">

**Screener** — a first-time sender who is a person rather than a list: two held
messages, both shown in full, one suggested destination, five to choose from, and
the keys that pick them. (In this preview the suggestion is a fixture, not a live
model — see [Status](#status--read-this-first).)

<img src="docs/screener-light.png" alt="mailoh Screener, light" width="100%">

<details>
<summary><strong>Dark mode</strong> (same two surfaces)</summary>

<img src="docs/ohbox-dark.png" alt="mailoh Ohbox, dark" width="100%">
<img src="docs/screener-dark.png" alt="mailoh Screener, dark" width="100%">

</details>

All of it is fictional mail from a fictional persona. No real people, no real
brands, no scraped inboxes.

## Download a build

Every push to `main` builds all three platforms on GitHub-hosted runners and
attaches the installers to the run:
[latest builds →](https://github.com/trafficflowgmbh/mailoh/actions/workflows/build.yml)

The artifact list is at the bottom of a run page, and GitHub requires you to be
signed in to download artifacts. **Each run's summary prints the SHA-256 of every
artifact it produced**, plus the toolchain and the runner, so you can check what
you downloaded against what the run made.

| Platform | Artifacts | Runner |
|---|---|---|
| **macOS** | `mailoh.dmg` (universal, arm64 + x86_64), `mailoh.app.zip`, the full screenshot set | `macos-15` |
| **Windows** | `mailoh_0.1.0_x64_en-US.msi`, `mailoh_0.1.0_x64-setup.exe` (NSIS) | `windows-latest` |
| **Linux** | `mailoh_0.1.0_amd64.AppImage`, `mailoh_0.1.0_amd64.deb` | `ubuntu-latest` |

**Nothing here is signed**, on any platform. Code-signing certificates cost money
mailoh has not spent yet. We would rather say that plainly than have you discover
it from a scary dialog. On all three platforms, building from source is the
option that requires trusting nobody.

### macOS

> [!IMPORTANT]
> **The DMG is unsigned and un-notarized.** It carries an ad-hoc signature only,
> not an Apple Developer ID. On first launch macOS Gatekeeper will refuse a
> double-click and may claim the app "is damaged". It is not.
> **Right-click (or Control-click) mailoh.app → Open → Open.** The same note is
> in the DMG as *Read me first.txt*. Signed and notarized builds land with the
> developer account.

Requires macOS 15 (Sequoia) or newer.

### Windows

> [!IMPORTANT]
> **No Authenticode signature.** SmartScreen will show "Windows protected your
> PC" on first run. **More info → Run anyway.** The NSIS installer installs
> per-user, so it needs no administrator; the `.msi` is there for anyone who
> deploys that way.

> [!IMPORTANT]
> **The installers do not download WebView2 — and that is deliberate.** Tauri's
> default is to compile a downloader into the `.msi` and the `.exe` that fetches
> the runtime from `go.microsoft.com` during installation. We set
> `webviewInstallMode: skip` and took it out, because an installer that opens a
> connection makes "it cannot reach the network" a footnote instead of a fact.
> The trade is that **you must already have WebView2.** Windows 11 has it;
> so does any Windows 10 that has taken updates since 2021, because Edge
> installs it. If yours does not, mailoh will not start and will tell you so —
> install the Evergreen runtime once, from Microsoft:
> <https://developer.microsoft.com/microsoft-edge/webview2/>

Requires Windows 10 or newer, plus the WebView2 runtime as described above.

### Linux

> [!IMPORTANT]
> **The AppImage needs the executable bit**, which GitHub's artifact zip does not
> preserve:
> ```bash
> chmod +x mailoh_0.1.0_amd64.AppImage && ./mailoh_0.1.0_amd64.AppImage
> ```
> If it exits immediately on a distribution that has not enabled unprivileged
> user namespaces, run it with `--appimage-extract-and-run`.

The `.deb` installs with `sudo apt install ./mailoh_0.1.0_amd64.deb` and pulls in
WebKitGTK. It is **not** in any repository, so it will never auto-update — and
there is no update checker in this build at all.

To uninstall it: `sudo apt remove mailoh`. The Debian package name, the binary at
`/usr/bin/mailoh`, the icon and the launcher entry are all the same word.

### Verify it yourself

On Windows and Linux the interface is embedded **uncompressed** on purpose, so
you can check what a downloaded binary does without running it:

```bash
strings -a mailoh.exe | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u
strings -a mailoh.exe | grep -c Ohbox      # the interface really is in there
```

The first command prints **13 strings on Linux, 14 on Windows**, and every one
of them is one of four things: an XML namespace constant React compares against,
a documentation link inside a panic or error message, Microsoft's own WebView2
download page (see the Windows note above), or — three of them — an artifact of
grepping a Rust binary, where `"http://"` is a string literal that sits in
read-only data with no terminator between it and whatever was placed next to it.
`apps/desktop/README.md` lists all fourteen, one by one, with the full
surrounding line for the three that are not URLs at all.

CI runs exactly these greps on every build, prints the complete list in the job
log, **asserts the count** so that "13 and 14" cannot quietly stop being true,
and **fails the run** if any URL in the binary points at mailoh or TrafficFlow
infrastructure. It also fails the Windows job if the `.msi` or the `-setup.exe`
contains a WebView2 downloader.

## Build it yourself

### macOS

**Requirements:** macOS 15 (Sequoia) or newer, and Xcode for the Swift 6
toolchain and the macOS SDK (`xcode-select --install` on its own is not enough).
Built and tested on every push with **Xcode 26.3 / Swift 6.2.4** on macOS 15 —
that is the combination we can vouch for; Swift 6.0 (Xcode 16) is the language
mode the package declares and should work, but is not covered by CI.

No dependencies: `Package.swift` declares zero third-party packages, so there is
nothing to resolve, install or trust.

```bash
git clone https://github.com/trafficflowgmbh/mailoh
cd mailoh

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
./scripts/package-app.sh     # → build/mailoh.app and build/mailoh.dmg
```

### Windows and Linux

**Requirements:** [Rust](https://rustup.rs) (stable) and Node 22. On Linux also
the Tauri prerequisites — on Ubuntu 24.04:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  libssl-dev build-essential curl wget file patchelf desktop-file-utils
```

On Windows, the MSVC build tools and WebView2.

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

### It cannot reach the network

Not "does not" — cannot, in three independent ways. The webview's
Content-Security-Policy is `connect-src 'none'`, so `fetch`, XHR, WebSocket and
EventSource are refused before they are attempted. The page then replaces those
APIs with functions that throw. And the Cloud sync client is aliased out of the
bundle at build time — it is not compiled in, and its source is not in this
repository at all. The Tauri capability list is literally empty
(`"permissions": []`): the interface can call no Tauri command, touch no file and
spawn no process.

**The installers do not either**, which is a separate claim and worth stating
separately, because it was not true of the first build we made. Tauri ships a
`downloadBootstrapper` by default: a WiX custom action in the `.msi` and an
NSISdl step in the `-setup.exe` that fetch the WebView2 runtime from
`go.microsoft.com` if the machine lacks it. Both are gone —
`webviewInstallMode: skip`, asserted by CI against the built installers rather
than trusted from the config — and the cost is that you supply WebView2
yourself. See the Windows note above.

## Desktop or Cloud

mailoh comes in two halves, and **this repository is the whole of the first
one**. Here is the honest comparison, including the parts where Desktop wins.

|  | **Desktop** — this repository | **Cloud** — optional |
|---|---|---|
| **Price** | **Free, forever.** Not a trial, not a freemium tier. | $9 / $15 / $29 per month |
| **Mailboxes** | As many as you like | 2 / 5 / 10 |
| **Where your mail is processed** | **Your machine. Only.** It never touches our servers — there is no server to touch. | EU-hosted, encrypted in transit and at rest — not end-to-end — solely to serve you, deletable |
| **Account** | **None.** Nothing to sign up for, nothing to cancel. | Yes |
| **AI** | Bring your own API key, or run [Ollama](https://ollama.com) locally so nothing leaves your machine at all | A monthly allowance of managed AI actions is included (~2k / 6k / 20k) |
| **Web and mobile apps** | — | Yes |
| **Push notifications** | — | Yes |
| **Works while your laptop is shut** | — | Yes — mail is screened and filed as it arrives |
| **Open source** | **GPL-3.0. All of it, right here.** | No |

### Why a Cloud exists at all

Not to unlock features. Your phone cannot hold a connection to your mailbox open
all day — the battery and the operating system will not allow it. Something has
to stay awake to notice new mail, run it past the Screener and file it. On
Desktop that something is your computer, while it is on. Cloud is that same work,
done on a machine that does not sleep.

That is the entire difference. **The Screener, the Ohbox, the tags, the
organise-in-place model and the privacy promise are identical on both.** Desktop
is not a demo of Cloud.

### If you do want Cloud

- **14 days free, no card.** The trial runs **rules-only** — the whole product
  except the managed AI actions, which begin when a subscription does.
- **Run out of AI actions and mail keeps flowing, rules-only,** until the next
  cycle. There are no overage charges, ever. We would rather degrade than
  surprise you with a bill.
- **Leave whenever.** Your mail was organised in place, in real folders on your
  own server, the entire time. There is no export, because there is nothing to
  export — cancel and your mailbox stays exactly as organised as it was.

Details and sign-up: **[mailoh.io](https://mailoh.io)**. And if the answer is
"the free desktop app is fine, thanks" — genuinely, that is a good outcome. It is
why we built it this way.

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

One of those 99 reports as *skipped* here, and says why when it does: it compares
the triage pile's sheet-edge shadow against the original design prototype, which
is not published. It runs in the monorepo, where it once caught a shadow that had
drifted from `.10` to `.16` alpha.

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

Dates are not promised. The order is. Each of these is an open issue with the
detail in it, and [CHANGELOG.md](CHANGELOG.md) records what has actually shipped.

## Licence

GPL-3.0-or-later. Copyright © 2026 **TrafficFlow GmbH**, Staubstrasse 1, 8038
Zürich, Switzerland.

The desktop client is free and is meant to stay free: GPL-3.0 means anyone can
use, study, change and share it, and any redistributed change comes back under
the same terms — so a closed-source re-skin of mailoh is not possible. Full text
in [LICENSE](LICENSE) — a verbatim copy of the FSF's GPL-3.0 — and the reasoning,
the third-party position and the per-file-header decision in
[COPYRIGHT](COPYRIGHT).

**The code is free; the name and the icon are not.** You may fork, build and
redistribute this source; a fork you publish needs its own name and its own
artwork, so nobody is misled about who supports it.
[TRADEMARK.md](TRADEMARK.md) is the policy, and it is more permissive than you
probably expect — packaging mailoh for a distribution under its own name is
explicitly fine.

Contributions need **no CLA and no copyright assignment**, just a DCO sign-off
(`git commit -s`) — see [CONTRIBUTING.md](CONTRIBUTING.md), which is also honest
about the one part of the tree where GPL-only contributions constrain us.
Security reports: [SECURITY.md](SECURITY.md).

---

<div align="center">

[mailoh.io](https://mailoh.io) · [issues](https://github.com/trafficflowgmbh/mailoh/issues) · support@mailoh.io

Built in Zürich by [TrafficFlow GmbH](https://trafficflow.ch).

</div>
