import SwiftUI
import MailOhKit

// Entry point. We intentionally do NOT use `@main`: the --smoke path must run
// (an offscreen render check) without ever activating NSApp or showing a window.
// Top-level code runs on the main thread, which is what the MainActor work below
// requires.
let args = CommandLine.arguments

if args.contains("--smoke") {
    MainActor.assumeIsolated { Smoke.run() }
} else if let i = args.firstIndex(of: "--shot") {
    let dir = args.count > i + 1 ? args[i + 1] : "./shots"
    MainActor.assumeIsolated { Smoke.shoot(into: dir) }
} else {
    MailOhApp.main()
}
