import Foundation
import OhMailEngine

/// A shell that is only an engine — no window, no SwiftUI, nothing to look at.
///
/// It exists because **two properties of this slice cannot be observed from inside a test process.**
/// A test that wants to prove an engine dies when its parent is `kill -9`d has to be able to kill
/// the parent, and an XCTest bundle's parent is the test runner. A test that wants to prove the
/// session token never reaches stderr has to read a whole process's stderr from birth to exit, and
/// a test bundle's stderr is shared with every other test in the run.
///
/// So this is the parent those two tests kill and read. It is not shipped: the packaging step
/// bundles `Contents/MacOS/OhMail` by name, and nothing here is reachable from that binary.
///
///     ohmail-engine-probe [<engine path>]
///
/// Everything else comes from the environment, through the real `EngineProcess.plan` rather than a
/// test-only path — a probe that took a shortcut around the code under test would prove nothing
/// about it. `OHMAIL_PROBE_QUIT_AFTER_MS` makes it quit by itself after that long in
/// `serving`, which is the "full launch-and-quit cycle" the stderr assertion needs.
///
/// stdout carries the probe's own report, one `key value` line at a time, flushed. stderr carries
/// the shell's log and the engine's diagnostics, verbatim — which is the stream under test.

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

var environment = ProcessInfo.processInfo.environment
let arguments = CommandLine.arguments
if arguments.count > 1 { environment[ENGINE_PATH_VAR] = arguments[1] }

let executableDirectory = URL(fileURLWithPath: arguments[0]).deletingLastPathComponent()
let dataDirectory = environment[DATA_DIR_VAR].map { URL(fileURLWithPath: $0) }

let plan = EngineProcess.plan(
    environment: environment,
    executableDirectory: executableDirectory,
    dataDirectoryFallback: dataDirectory ?? EngineProcess.defaultDataDirectory)

let engine = EngineProcess.make(plan, onStatusChange: { status in
    say("status \(status)")
})

switch plan {
case .inert(let status):
    say("inert \(status)")
    // The names, so a test can assert on them without parsing a sentence.
    if case .notConfigured(let missing) = status { say("missing \(missing.joined(separator: ","))") }
    exit(0)
case .spawn:
    break
}

engine.start()

let quitAfter = environment["OHMAIL_PROBE_QUIT_AFTER_MS"].flatMap(Double.init).map { $0 / 1000 }
let deadline = Date().addingTimeInterval(60)
var announced = false

while Date() < deadline {
    if case .serving(let mailboxID) = engine.status, !announced {
        announced = true
        say("serving \(mailboxID)")
        if let pid = engine.pid { say("pid \(pid)") }
        // THE TOKEN IS NEVER PRINTED, not even here. Its LENGTH is, so a test can tell "the ready
        // frame carried a token" from "the ready frame carried an empty string" without the value
        // ever leaving the process.
        if let ready = engine.ready { say("token-length \(ready.sessionToken.expose().count)") }
        if let quitAfter {
            Thread.sleep(forTimeInterval: quitAfter)
            engine.stop()
            say("stopped \(engine.status)")
            exit(0)
        }
    }
    if case .failed(let reason, _) = engine.status {
        say("failed \(reason)")
        exit(1)
    }
    if engine.isFinished, !announced {
        say("finished \(engine.status)")
        exit(1)
    }
    Thread.sleep(forTimeInterval: 0.02)
}

say("timeout \(engine.status)")
engine.stop()
exit(2)
