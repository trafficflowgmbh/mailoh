# Contributing

MailOh is built by a small team at [TrafficFlow GmbH](https://trafficflow.ch) in
Zürich. This repository is the free desktop client — native SwiftUI on macOS,
a Tauri shell on Windows and Linux. Contributions are welcome, and
so is a plain "this is wrong" — the client is early enough that direction still
moves.

## What is most useful right now

The app currently runs on a fixture world, not on a real mailbox
([status](README.md#status--read-this-first)), so the most valuable input is
about the parts that already exist:

- **Design and interaction** — the Blanc surfaces, keyboard flow, compact
  (≤ 900 pt) layout, reduced-motion behaviour, VoiceOver gaps.
- **Swift and SwiftUI craft** — state that should be derived, views that do too
  much, layout that will break at a width we have not tried.
- **The Tauri shell's security posture** — the CSP, the empty capability list,
  the offline guard, the aliases in `apps/desktop/vite.config.ts`. A way for the
  app to reach the network that we have missed is the most valuable bug in the
  repository.
- **The seam** — `AppState` is the only thing `Views/` may talk to. If you see a
  view reaching past it, that is a bug worth reporting even if nothing breaks
  yet: the IMAP engine lands behind exactly that seam.
- **Correctness of the honest claims** — if the README, `apps/macos/README.md`
  or `apps/desktop/README.md` overstates something, that is a bug too, and a
  serious one.

Please do not send IMAP or sync implementations unprompted. That layer has a
design (rules-first pipeline, desired-state folder moves, redacted handling of
sensitive mail) that is not published yet, and a large PR against it would be
wasted work. Open an issue first and we will tell you what is planned.

## Issues

Issues are welcome and read. Useful bug reports carry: your OS version, the
toolchain version (`swift --version`, or `rustc --version` and `node --version`
for the Tauri shell), what you ran, what happened, what you expected. If it is visual, a screenshot beats a description —
`swift run --package-path apps/macos MailOh --shot /tmp/shots` renders every
route in both colour schemes at both verified widths.

## Pull requests

- Fork, branch, open a PR against `main`. PRs are reviewed by a human.
- CI runs three jobs. macOS: `swift build -c release`, `swift test`, and
  `MailOh --smoke`. Windows and Linux: `tsc`, the UI bundle build,
  `npm run smoke` over the built bundle, then `tauri build`. All must pass;
  the two smokes are what catch a view that lays out but draws nothing, a list
  that quietly collapses rows, or a build that grew a network call.
- Keep the existing invariants: colours and shadows come from `Theme/`
  (`Palette`, `Lift`) — never hand-written in a view; fixtures never appear in
  `Views/`; no message is ever replaced by a "N more" placeholder. The test
  suite enforces all three, and it is meant to.
- Add or extend a test for behaviour you change. `swift test` is fast (~1 s);
  there is no excuse.
- Match the surrounding style. There is no formatter config to fight with.

## No CLA

There is no contributor licence agreement and no copyright assignment. You keep
your copyright; your contribution is licensed under GPL-3.0, the same licence as
the rest of the repository. By opening a PR you confirm you have the right to
contribute the code under that licence.

## Conduct

Be direct, be technical, be decent. Harassment or discrimination gets you
removed from the repository, and there is no appeal process.

## Contact

Anything that does not belong in a public issue: **support@mailoh.io**.
Security reports go the way [SECURITY.md](SECURITY.md) describes — not into an
issue.
