# Changelog

All notable changes to the ohmail desktop apps are recorded here.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are the dates the work actually landed; every entry corresponds to commits
you can read in `git log`.

A note on what a version means here: **0.x is a preview of the interface.** It
does not connect to a mailbox. See [Status](README.md#status--read-this-first).

## [Unreleased]

Next is the engine slice — IMAP behind today's `AppState` seam, and the thing
that makes these apps a mail client rather than a preview of one. See
[Roadmap](README.md#roadmap) and issue #1.

## [0.3.0-preview] — 2026-08-05

**Still a preview**: no engine ships in these artifacts, so they do not connect
to a mailbox. The macOS app now contains the code to launch and supervise a local
engine, and it stays inert because it finds nothing to launch.

### Added

- **Compose is a rich text editor.** Bold, italic, lists, headings and links, in
  the inline reply as well as the compose view, where before it was plain text.
  A send may now carry markup alongside its plain-text alternative.

### Changed

- **A Screener decision names the folder it chose.** It used to answer with only
  two destinations, so three of the five decision buttons wrote a rule pointing
  at a place the user had not picked.
- **A partial first import stops presenting itself as a finished one**, so a
  mailbox that is still filling no longer reads as complete.

### Fixed

- The formatting editor kept only the first of two changes that landed in the
  same tick.
- Two different sets of key bindings could produce one cache key.
- A render check that could pass against a stale bundle.
- The macOS orphan test could time out on a loaded CI runner: its reader kept its
  buffer in a local, so a line arriving in the same read as the one it matched
  was discarded. The property under test — that killing the shell leaves no
  engine process behind — is unchanged.
- Two installer inspection checks piped a producer into `grep -q`, which exits at
  its first match and kills the producer; under `set -o pipefail` that reported
  the wrong thing.
- The URL-string audit over the shipped binaries counts 14 on Linux and 15 on
  Windows. The editor brought one new documentation link into the bundle, which
  is the pinned count doing its job.

## [0.2.0-preview] — 2026-07-31

The same interface under its real name. **Still a preview**: this build does not
connect to a mailbox either, and is not meant to until the engine slice lands.
0.1.0-preview's artifacts were left where they are rather than relabelled, so
this is the first release whose files are called `ohmail_*`.

### Changed

- **The version is 0.2.0, not 0.1.1.** Nothing here is a patch: the product is
  called something else than it was, and the installers a stranger downloads have
  different names. It is not 1.0 or a beta either, because the sentence above is
  still true — 0.x means a preview of the interface, and it will keep meaning
  that until the engine ships. `tauri.conf.json` and `Cargo.toml` carry the bare
  `0.2.0` the MSI bundler requires; the `-preview` suffix lives in
  `package.json`, `Info.plist`, the tag and this file.
- **The published message catalogue is a single file, and it grew.**
  `apps/webapp/messages/en.json` is shared with the Cloud client and is published
  whole, so it now also carries the strings for surfaces the desktop app has
  never rendered — a sign-up wizard, plan cards, a marketing page. Those screens
  are Cloud-only and are not part of this repository; their text is compiled into
  the Windows/Linux bundle only because the catalogue is not split. Cosmetic, and
  worth knowing before you run `strings` over a binary and find a price in it.
- **The demo decision left the React module** so it can be tested on its own,
  and the plan card became one template rather than three hard-coded plans.
  Neither changes what the desktop app renders.
- **Renamed: `mailoh` → `ohmail`, on `ohmail.app`.** The mark is unchanged — the
  same outlined "oh." with its terracotta period, the same icon files. Only the
  name set as type moved. This reaches everything a user can see or type: the app
  and window titles, the macOS bundle identifier (`io.mailoh.desktop` →
  `io.ohmail.desktop`) and its Tauri variant, the installer filenames, the Swift
  module and product names, and the repository itself
  (`trafficflowhq/ohmail`). The Debian `Package:` field follows `productName` and
  is now `ohmail`, so the uninstall command is `apt remove ohmail`.

  The `0.1.0-preview` section below was written under the old name and is left
  as it was: it describes a release that really did ship as `mailoh`, and its
  assets really are called `mailoh_*`. A fresh release is cut from the renamed
  build rather than relabelling those files.

  Precisely, for anyone comparing the two release pages: 0.1.0-preview's six
  files are `MailOh.dmg`, `MailOh.app.zip`, `MailOh_0.1.0_x64_en-US.msi`,
  `MailOh_0.1.0_x64-setup.exe`, `MailOh_0.1.0_amd64.AppImage` and
  `MailOh_0.1.0_amd64.deb` — the casing `productName` carried at the time.
  Renaming them now would invalidate the six checksums published against them,
  which is the whole reason a new release exists instead.

### Fixed

- **The rail wordmark still read the old name.** It is painted as two `Text` runs
  so the accent falls on "oh", which means the brand never appears in the source
  as one string and a grep over the tree cannot see it — the rename sweep missed
  it, and its `.accessibilityLabel` had begun contradicting its own visible text,
  telling a sighted user and a VoiceOver user two different names.
  `testWordmarkReadsOhmailHoweverItIsSplit` reconstructs the concatenation of the
  runs and asserts all three agree; verified by mutation.
- **Two claims the rename sweep turned false.** `apps/desktop/README.md` said
  `productName` "used to be `OhMail`, which kebab-cased to `mail-oh`" — it cannot:
  `OhMail` kebab-cases to `oh-mail`, and the value that produces `mail-oh` is
  `MailOh`, which is what it really was. `TRADEMARK.md` named the macOS bundle
  `app.ohmail.app`; the bundle is `ohmail.app`, and `app.ohmail.app` is a website.
- **The CI binary audit was renamed along with everything else**, to
  `ohmail|trafficflow` — but during a rename the old name is exactly what you
  still want asserted against. Both jobs now match `ohmail|mailoh|trafficflow`.
- The "Desktop or Cloud" table in the README described the product the engine
  will make possible as though it already existed. The rows waiting on it are
  marked, and the paragraph above the table says so.

## [0.1.0-preview] — 2026-07-30

The first tagged build. Three platforms, one interface, a fictional mailbox, and
no network in any of them.

### Added

- **ohmail for macOS** — a native SwiftUI client. Every surface: Ohbox, Screener
  (two-pane, decision bar, bulk undo), Reads with its waterline, Receipts,
  triage piles with the Reply Run, tags, search, compose, settings. Light and
  dark, down to a 390 pt window, keyboard-first with a ⌘K palette. Ships with 99
  tests and a `--smoke` render check that hosts every route offscreen and fails
  if anything draws nothing. (2026-07-30)
- **ohmail for Windows and Linux** — a Tauri v2 shell rendering the same
  interface, built by Vite from the shared React shell rather than forked. The
  webview is locked down: `"permissions": []`, `withGlobalTauri` off,
  `assetProtocol` disabled, no `invoke_handler`, no plugins, and a CSP of
  `connect-src 'none'`. `offline-guard.ts` replaces fetch, XHR, WebSocket,
  EventSource and sendBeacon with functions that throw, so "no network" is
  testable rather than merely claimed. (2026-07-30)
- **The design system** — `@ohmail/tokens` (colour, type, spacing, radii,
  shadows, motion, z, in light and dark), `@ohmail/ui` (34 components, 2 hooks)
  and `@ohmail/fixtures` (the demo mailbox everything renders). The tokens carry
  an anti-drift gate: a test parses the canonical design prototype and fails on
  any divergence. Every colour, radius and layout value in the SwiftUI theme is
  then compared numerically against `packages/tokens/src/tokens.ts`, so the two
  clients cannot drift apart either. (2026-07-29)
- **`@ohmail/client-engine`** — the delta-sync core the shell runs on: an
  idempotent apply core, an IndexedDB mirror that writes page and cursor in one
  transaction, selectors, local search, and an optimistic overlay in which the
  user always wins. In this repository it runs against `FixturesAdapter`, a
  complete in-memory server. (2026-07-30)
- **The "oh." icon system** — one master mark in three optical tiers, so it stays
  legible from 16 px to 1024 px. `Resources/ohmail.icns` is the macOS bundle
  icon; the Tauri shell carries the same mark. (2026-07-30)
- **CI that builds what you download** — GitHub Actions produces a `.dmg` and a
  zipped `.app` on macOS 15, `.msi` and NSIS `-setup.exe` on Windows, and
  `.AppImage` and `.deb` on Linux, on every push. Each run prints the toolchain
  it used and the artifact's sha256, so an unsigned download can be checked
  against the run that made it. (2026-07-30)
- **The repository's own paperwork** — GPL-3.0 with a COPYRIGHT statement that
  says what it covers, TRADEMARK.md for the one thing the licence does not carry
  (the "oh." mark and the icon family), CONTRIBUTING, SECURITY, and screenshots
  taken by the app's own `--shot` mode. (2026-07-30)

### Changed

- The repository is `trafficflowhq/ohmail`. It was `mailoh-desktop` while the
  macOS app was the only thing in it; the Windows and Linux shells made that name
  narrower than the contents. The Rust crate was renamed with it. Nothing shipped
  changed: the binaries are still `ohmail` / `ohmail.exe`, and the `.deb` still
  installs `usr/bin/ohmail`. (2026-07-30)
- The demo mailbox is entirely fictional — no real people, no real brands, no
  real domains — and every name in it was cleared before use and recorded in a
  registry that CI greps. (2026-07-29 – 2026-07-30)
- Mail is never collapsed. "N more" placeholders were removed everywhere and held
  Screener mail became a structural array, so every held message renders in full
  and a Screener decision carries all of it. This is a product rule, and the
  guards on it are mutation-tested. (2026-07-30)

### Fixed

- **The Windows installers no longer download WebView2.** Tauri's default
  `webviewInstallMode` had put a WiX custom action in the `.msi` that ran a hidden
  `powershell.exe` against `go.microsoft.com`, and shipped `NSISdl.dll` in the
  `-setup.exe` for the same purpose — an outbound connection made by a product
  that says it cannot make one. Now `"type": "skip"`, and CI greps the built
  installers for all five signatures so it cannot come back. The honest cost is
  documented: the installers do not provide WebView2, which Windows 11 and any
  updated Windows 10 already have. (2026-07-30)
- The `.deb`'s package name is `mail-oh`, not `mailoh` — Tauri kebab-cases it out
  of `productName` and gives no way to override it. `apt remove mail-oh` is the
  command. Pinned in CI so the documentation goes red rather than stale.
  (2026-07-30) — *historical: this entry describes the `mailoh` release. The
  product has since been renamed and `productName` is now `ohmail`, which
  kebab-cases to itself; see the rename entry under Unreleased.*
- The Linux `.deb` inspection in CI anchored its assertions on a leading `/`,
  which `dpkg-deb -c` never prints, so three checks could never have matched.
  (2026-07-30)
- TRADEMARK.md claimed the icon files were the only binary artwork here, which
  contradicted COPYRIGHT two files away, and pointed forkers at a path that does
  not exist in this tree. (2026-07-30)
- Both READMEs overstated the `strings` audit of the release binaries. They now
  enumerate all 13 strings on Linux and 14 on Windows, including the four that
  are not URLs at all, and CI pins the counts. (2026-07-30)
- `ThemeProvider` no longer mismatches on hydration: a deterministic first
  render, then post-mount adoption that never clobbers the pre-paint stamp.
  (2026-07-30)

### Security

- No IMAP client, no HTTP client, no telemetry and no update check exists in
  either build. On macOS the entire app imports AppKit, Foundation, SwiftUI and
  Observation, and nothing else. On Windows and Linux the network APIs are
  removed from the page and the webview forbids connections outright.
- Nothing is signed on any platform. See the install notes in the README —
  Gatekeeper, SmartScreen and the AppImage's executable bit all need a manual
  step, and that is a real cost of a preview rather than something to gloss over.

[Unreleased]: https://github.com/trafficflowhq/ohmail/compare/v0.3.0-preview...HEAD
[0.3.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.3.0-preview
[0.2.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.2.0-preview
[0.1.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.1.0-preview
