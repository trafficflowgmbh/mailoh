import SwiftUI
import OhMailKit

// Entry point. We intentionally do NOT use `@main`: the --smoke path must run
// (an offscreen render check) without ever activating NSApp or showing a window.
// Top-level code runs on the main thread, which is what the MainActor work below
// requires.
//
// ── THE FLAGS ─────────────────────────────────────────────────────────────────────────────
//
// `--demo` opens the sample world: the interface, drawn over invented mail, with no mailbox open
// and no engine running. It is the only way to reach that world — see `SourceSelection`, where the
// rule lives and is tested. Without it, an install that has not been pointed at a mailbox shows the
// setup form, and one that has shows the mailbox or says why it cannot.
//
// `--smoke` and `--shot` imply it, because both walk every route in the app and assert something
// about what was drawn, and the only world this app has that is the same on every machine is the
// sample one. Neither renders through the composition root at all: they build the shell directly
// and never read this install's configuration, so what they check does not depend on whether the
// person running them happens to have added a mailbox. `LaunchFlags.parse` is where that one rule
// is written down.
let args = CommandLine.arguments

if args.contains(LaunchFlags.smokeFlag) {
    MainActor.assumeIsolated { Smoke.run() }
} else if let i = args.firstIndex(of: LaunchFlags.shotFlag) {
    let dir = args.count > i + 1 ? args[i + 1] : "./shots"
    MainActor.assumeIsolated { Smoke.shoot(into: dir) }
} else {
    OhMailApp.main()
}
