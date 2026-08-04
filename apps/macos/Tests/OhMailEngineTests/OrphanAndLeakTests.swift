import XCTest
@testable import OhMailEngine

/// **The two properties no in-process test can see.**
///
/// Both need a whole separate process to be the shell: one has to kill it, the other has to read its
/// stderr from birth to exit. `Sources/OhMailEngineProbe` is that shell — the real `EngineProcess`
/// with no window around it.
///
/// The engine here is reached through a wrapper script literally named `ohmail-engine`, which
/// `exec`s Node on the stand-in. That is not decoration: the acceptance criterion is that no
/// `ohmail-engine` survives, and `ps` can only answer a question about a name that is on the command
/// line. The script carries a per-run identifier as well, so a stray engine from ANOTHER test run
/// cannot make this one pass or fail.
final class OrphanAndLeakTests: XCTestCase {
    private var directory: URL!
    private var runID: String!
    private var wrapper: URL!
    private var logFile: URL!

    override func setUpWithError() throws {
        let node = try nodePath()
        runID = UUID().uuidString.prefix(8).lowercased()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ohmail-orphan-\(runID!)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // Named so `ps` can see it, and unique so it can only see THIS run.
        let script = directory.appendingPathComponent("ohmail-engine-\(runID!).cjs")
        try Data(fakeEngineSource.utf8).write(to: script)

        wrapper = directory.appendingPathComponent(ENGINE_FILE_STEM)
        let mode = ProcessInfo.processInfo.environment["OHMAIL_TEST_ENGINE_MODE"] ?? "serve"
        try Data("#!/bin/sh\nexec \"\(node)\" \"\(script.path)\" \(mode)\n".utf8).write(to: wrapper)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)

        logFile = directory.appendingPathComponent("starts.log")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// The probe, built beside this test bundle.
    private func probeURL() throws -> URL {
        let bundle = Bundle(for: type(of: self)).bundleURL.deletingLastPathComponent()
        let probe = bundle.appendingPathComponent("ohmail-engine-probe")
        guard FileManager.default.isExecutableFile(atPath: probe.path) else {
            throw XCTSkip("ohmail-engine-probe was not built beside the test bundle at \(probe.path)")
        }
        return probe
    }

    private func startProbe(token: String, quitAfterMS: Int?, stderr: FileHandle?) throws -> (Process, Pipe) {
        let probe = Process()
        probe.executableURL = try probeURL()
        probe.arguments = [wrapper.path]
        var environment = ProcessInfo.processInfo.environment
        environment["OHMAIL_IMAP_HOST"] = "imap.example.org"
        environment["OHMAIL_IMAP_USER"] = "someone@example.org"
        environment[KEK_VAR] = String(repeating: "0", count: 64)
        environment[DATA_DIR_VAR] = directory.path
        environment["FAKE_LOG"] = logFile.path
        environment["FAKE_TOKEN"] = token
        if let quitAfterMS { environment["OHMAIL_PROBE_QUIT_AFTER_MS"] = String(quitAfterMS) }
        probe.environment = environment

        let out = Pipe()
        probe.standardOutput = out
        probe.standardError = stderr ?? FileHandle.nullDevice
        try probe.run()
        return (probe, out)
    }

    /// Read the probe's report until `prefix` shows up, or give up.
    ///
    /// `availableData` and not `read(upToCount:)`: the latter does not return until it has the count
    /// asked for or the far end closes, so reading a probe that is still running — which is the only
    /// interesting case here — waits for its exit. That is the same trap `EngineProcess.readSome`
    /// exists to avoid, and it bit this file too.
    private func readUntil(_ prefix: String, from pipe: Pipe, within: TimeInterval = 30) throws -> String {
        var text = ""
        let deadline = Date().addingTimeInterval(within)
        while Date() < deadline {
            for line in text.split(separator: "\n") where line.hasPrefix(prefix) {
                return String(line)
            }
            let chunk = pipe.fileHandleForReading.availableData
            if chunk.isEmpty { break }   // the probe closed its output
            text += String(decoding: chunk, as: UTF8.self)
        }
        for line in text.split(separator: "\n") where line.hasPrefix(prefix) { return String(line) }
        throw Failure("the probe never said “\(prefix)”. It said:\n\(text)")
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    /// Every live process whose command line names this run's engine.
    private func survivors() -> [String] {
        processTable()
            .split(separator: "\n")
            .map(String.init)
            .filter { $0.contains(ENGINE_FILE_STEM) && $0.contains(runID) }
    }

    // MARK: - The orphan defence

    /// **`kill -9` the shell; the engine must still leave.**
    ///
    /// Nothing else holds the write end of that pipe, so the kernel closes it when this process dies
    /// however it dies, the engine reads EOF and shuts itself down. That is the one property a unit
    /// test cannot show and the one that decides whether a stray engine can sit on an authenticated
    /// IMAP connection after the app is gone.
    func testKillNineOfTheShellLeavesNoEngineBehind() throws {
        let (probe, out) = try startProbe(token: "tok_orphan", quitAfterMS: nil, stderr: nil)
        defer { if probe.isRunning { kill(probe.processIdentifier, SIGKILL) } }

        _ = try readUntil("serving ", from: out)
        let pidLine = try readUntil("pid ", from: out)
        let enginePID = try XCTUnwrap(Int32(pidLine.dropFirst("pid ".count)))

        // Not vacuous: the engine is alive, and `ps` can see it by name, BEFORE anything is killed.
        XCTAssertTrue(isAlive(enginePID), "the engine is running before the shell is killed")
        XCTAssertFalse(survivors().isEmpty,
                       "`ps` cannot see this run's engine at all, so its absence later would prove nothing")

        kill(probe.processIdentifier, SIGKILL)
        probe.waitUntilExit()
        XCTAssertEqual(probe.terminationReason, .uncaughtSignal, "the shell died the hard way, unhandled")

        waitFor("the orphaned engine to notice its parent is gone", within: 15) { !isAlive(enginePID) }
        XCTAssertFalse(isAlive(enginePID), "engine process \(enginePID) outlived a kill -9 of its shell")
        XCTAssertEqual(survivors(), [], "`ps` still shows an ohmail-engine from this run")

        // And it left of its own accord — it ran its exit handler, which a killed process does not.
        let log = (try? String(contentsOf: logFile, encoding: .utf8)) ?? ""
        XCTAssertEqual(log.split(separator: "\n").filter { $0.hasPrefix("exit ") }.count, 1,
                       "the engine shut itself down on EOF rather than being killed: \(log)")
    }

    // MARK: - The vacuity trap, closed

    /// **The session token must not appear in the process's stderr after a full launch-and-quit.**
    ///
    /// Asserting `Secret.description == "<redacted>"` proves only that one function returns one
    /// string. This reads every byte a whole shell wrote to stderr across a launch, a `ready` frame
    /// carrying a real token, and a graceful quit — the stream that a crash reporter, a `log
    /// collect` and a support bundle all pick up.
    ///
    /// Two guards against the assertion passing for the wrong reason: the token really existed (the
    /// probe reports its LENGTH, never its value), and the stderr file really captured this shell's
    /// output (it contains the log lines that bracket the run).
    func testTheSessionTokenNeverReachesStderrAcrossAWholeLaunchAndQuit() throws {
        let token = "tok_leak_canary_\(runID!)_\(String(repeating: "z", count: 16))"
        let stderrFile = directory.appendingPathComponent("stderr.log")
        FileManager.default.createFile(atPath: stderrFile.path, contents: nil)
        let handle = try FileHandle(forWritingTo: stderrFile)

        let (probe, out) = try startProbe(token: token, quitAfterMS: 150, stderr: handle)
        defer { if probe.isRunning { kill(probe.processIdentifier, SIGKILL) } }

        let lengthLine = try readUntil("token-length ", from: out)
        XCTAssertEqual(lengthLine, "token-length \(token.count)",
                       "the ready frame carried the token, so there was something to leak")

        probe.waitUntilExit()
        XCTAssertEqual(probe.terminationStatus, 0, "the shell quit cleanly")
        try? handle.close()

        let stderr = try String(contentsOf: stderrFile, encoding: .utf8)
        XCTAssertTrue(stderr.contains("serving mailbox mbx-1"),
                      "this file did not capture the shell's stderr, so finding nothing in it proves "
                      + "nothing:\n\(stderr)")
        XCTAssertTrue(stderr.contains("stopped"), "the quit is in here too:\n\(stderr)")
        XCTAssertFalse(stderr.contains(token), "the session token reached stderr:\n\(stderr)")
        XCTAssertFalse(stderr.contains("tok_leak_canary"), "a prefix of the token reached stderr:\n\(stderr)")
    }

    // MARK: - The loud empty hole

    /// **Launched with no key, the shell names the variable and starts nothing.**
    ///
    /// The same assertion the window makes visually. It is here as well because a screenshot is a
    /// one-off and this is not: the Keychain work exists because the engine side and a shell side each
    /// assumed the key was the other's, and a hole nothing asserts on closes itself by accident.
    func testAShellLaunchedWithNoKeyNamesOhmailKekAndStartsNothing() throws {
        let probe = Process()
        probe.executableURL = try probeURL()
        probe.arguments = [wrapper.path]
        var environment = ProcessInfo.processInfo.environment
        environment["OHMAIL_IMAP_HOST"] = "imap.example.org"
        environment["OHMAIL_IMAP_USER"] = "someone@example.org"
        environment[DATA_DIR_VAR] = directory.path
        environment.removeValue(forKey: KEK_VAR)
        probe.environment = environment

        let out = Pipe()
        probe.standardOutput = out
        probe.standardError = FileHandle.nullDevice
        try probe.run()
        let report = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        probe.waitUntilExit()

        XCTAssertEqual(probe.terminationStatus, 0, "an unconfigured install is not a crash")
        XCTAssertTrue(report.contains("missing OHMAIL_KEK"), "the report names the variable:\n\(report)")
        XCTAssertTrue(report.contains("not started — nothing set OHMAIL_KEK"), report)
        XCTAssertEqual(survivors(), [], "nothing was started")
        XCTAssertFalse(FileManager.default.fileExists(atPath: logFile.path),
                       "the engine was executed despite there being no key to seal a credential under")
    }
}
