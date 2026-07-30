<div align="center">

<img src="docs/mailoh-icon.png" width="88" height="88" alt="MailOh">

# MailOh for macOS

**Consent-first email, on the mailboxes you already have.**

A native SwiftUI client for MailOh. Free, GPL-3.0, no account, no subscription —
this repository is the whole thing.

[![build](https://github.com/trafficflowgmbh/mailoh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/trafficflowgmbh/mailoh-desktop/actions/workflows/build.yml)
[![licence: GPL-3.0](https://img.shields.io/badge/licence-GPL--3.0-a3461c)](LICENSE)
[![platform: macOS 15+](https://img.shields.io/badge/macOS-15%2B-111111)](#build-it-yourself)
[![Swift 6](https://img.shields.io/badge/Swift-6-f05138)](apps/macos/Package.swift)
[![mailoh.io](https://img.shields.io/badge/mailoh.io-website-666666)](https://mailoh.io)

</div>

---

## Status — read this first

**This is a preview of the interface, not a working mail client yet.** It runs on
a small fictional mailbox that ships inside the app.

| | |
|---|---|
| ✅ Runs, and is worth looking at | Every surface is real SwiftUI on the real design system: Ohbox, Screener, Reads, Receipts, triage piles, tags, search, compose, settings — light and dark, down to a 390 pt window, keyboard-first. |
| ✅ Tested | 99 tests over the model, the rules and the design tokens, plus a render check (`--smoke`) that hosts every route offscreen, rasterises it, and fails if anything draws nothing or quietly collapses a list. |
| ❌ Does not talk to your mailbox | There is **no IMAP client, no HTTP client, no telemetry and no update check** in this build. `import` lines across the whole app: AppKit, Foundation, SwiftUI, Observation. Nothing else. |
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

**Screener** — first contact from a real person: two held messages, both shown in
full, one AI suggestion, five destinations, and the keys that pick them.

<img src="docs/screener-light.png" alt="MailOh Screener, light" width="100%">

<details>
<summary><strong>Dark mode</strong> (same two surfaces)</summary>

<img src="docs/ohbox-dark.png" alt="MailOh Ohbox, dark" width="100%">
<img src="docs/screener-dark.png" alt="MailOh Screener, dark" width="100%">

</details>

All of it is fictional mail from a fictional persona. No real people, no real
brands, no scraped inboxes.

## Build it yourself

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

swift build --package-path apps/macos -c release   # ~15 s cold
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

## Download a build

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

There are no Windows or Linux builds yet — those are a Tauri shell that does not
exist in this repository yet. The CI workflow deliberately has no green job
pretending otherwise.

## How it is put together

7,600 lines of Swift in 30 files, one SwiftPM package, no dependencies.

| Target | Kind | What is in it |
|---|---|---|
| `MailOhKit` | library | `Theme/` (the design tokens), `Models/`, `Fixtures/`, `State/`, `Views/`, `App/` |
| `MailOh` | executable | `main.swift` — dispatches `--smoke`, `--shot`, or the app |
| `MailOhKitTests` | tests | 99 tests: counts and seen-semantics, lossless Screener moves, undo, triage, tags, search, numeric design-token fidelity, source audits, and the no-collapse audit |

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
2. **Signed, notarized DMG** with a real Developer ID, and automatic updates.
3. **AI, locally or with your key** — Screener suggestions and draft replies via
   your own API key or a local Ollama. Proposed, never applied; sensitive mail
   structurally excluded.
4. **Windows and Linux** — a Tauri shell over the same engine, built in CI here.

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
