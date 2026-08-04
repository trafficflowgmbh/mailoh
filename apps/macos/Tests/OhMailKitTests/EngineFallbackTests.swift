import XCTest
@testable import OhMailKit
import OhMailEngine

/// THE THREE WAYS AN ENGINE FAILS, AGAINST REAL PROCESSES.
///
/// Nothing here is a mock. Each test puts an actual file on disk, points the shell at it, lets the
/// real supervisor start it, and asserts what the window would then be showing. A stubbed
/// `EngineStatus` would prove that `SourceSelection` handles a value; these prove that the value
/// arrives — which is the half that was missing, because the shell had no representation for a spawn
/// failure at all.
///
/// The three failures are deliberately different at the operating-system level, because the shell
/// distinguishes them and a test that only broke the engine one way would not notice if it stopped:
///
///  · **not there** — `ENOENT` at `posix_spawn`. Not an error and nothing retries.
///  · **there and not runnable** — `EACCES`. Retrying is pointless in a different way.
///  · **there, runnable, and exits before it serves** — the crash loop, which is the only one of the
///    three worth restarting and the only one with a budget to exhaust.
@MainActor
final class EngineFallbackTests: XCTestCase {

    /// A key, so the plan gets as far as spawning. The shipped provider MINTS into the login
    /// keychain the first time it is read, which a test may not do to the machine it runs on.
    private struct StubKeys: KeyProvider {
        let value: String?
        func kek() throws -> String? { value }
    }

    private static let key = String(repeating: "ab", count: 32)

    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ohmail-fallback-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - The three breaks

    func testAMissingEngineIsItsOwnState() throws {
        let missing = dir.appendingPathComponent("ohmail-engine")   // never written
        let surface = try run(engineAt: missing.path)

        guard case .engineState(let notice) = surface else {
            return XCTFail("a missing engine produced \(surface), not a named state")
        }
        XCTAssertTrue(notice.detail.contains(missing.path),
                      "the panel does not say where it looked: “\(notice.detail)”")
        XCTAssertNoMail(surface)
    }

    func testAnEngineThatCannotBeExecutedIsItsOwnState() throws {
        let unrunnable = dir.appendingPathComponent("ohmail-engine")
        try "this is not a program\n".write(to: unrunnable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o644],
                                              ofItemAtPath: unrunnable.path)

        let surface = try run(engineAt: unrunnable.path)
        guard case .engineState(let notice) = surface else {
            return XCTFail("an unrunnable engine produced \(surface), not a named state")
        }
        XCTAssertTrue(notice.detail.contains(unrunnable.path),
                      "the panel does not name the file it could not run: “\(notice.detail)”")
        XCTAssertNoMail(surface)
    }

    /// The crash loop, all the way to the end of the budget.
    ///
    /// This is the one that has to arrive at a sentence somebody can act on rather than at a spinner:
    /// the other two fail once and stop, and this one fails four times over a backoff and then has to
    /// decide to stay down. The assertion on `spinning` is what makes "the app does not spin"
    /// checkable — the supervisor must have finished, not merely have published something.
    func testARestartBudgetRunsOutAtASentenceSomebodyCanActOn() throws {
        let flapping = dir.appendingPathComponent("ohmail-engine")
        try "#!/bin/sh\nexit 1\n".write(to: flapping, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755],
                                              ofItemAtPath: flapping.path)

        let (surface, engine) = try runKeepingEngine(engineAt: flapping.path)
        guard case .engineState(let notice) = surface else {
            return XCTFail("an engine that never serves produced \(surface), not a named state")
        }
        XCTAssertTrue(engine.isFinished, "the supervisor is still trying — the app would spin")
        XCTAssertNil(engine.pid, "a child outlived the budget")
        XCTAssertTrue(notice.detail.contains("\(EngineTimings.maxStarts)"),
                      "the sentence does not say how many starts were tried: “\(notice.detail)”")
        // What to do next, not merely what happened. The supervisor's own words carry it, and this
        // asserts that they survive to the screen rather than being replaced by a shorter line.
        XCTAssertTrue(notice.detail.lowercased().contains("quit ohmail"),
                      "the sentence names nothing to do: “\(notice.detail)”")
        XCTAssertNoMail(surface)
    }

    /// All three are different on screen. A shell that turned every failure into one panel would pass
    /// each test above on its own.
    func testTheThreeFailuresAreThreeDifferentPanels() throws {
        let absent = dir.appendingPathComponent("gone")
        let unrunnable = dir.appendingPathComponent("plain")
        try "x".write(to: unrunnable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o644],
                                              ofItemAtPath: unrunnable.path)
        let flapping = dir.appendingPathComponent("flap")
        try "#!/bin/sh\nexit 1\n".write(to: flapping, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755],
                                              ofItemAtPath: flapping.path)

        var lines: Set<String> = []
        for path in [absent.path, unrunnable.path, flapping.path] {
            guard case .engineState(let notice) = try run(engineAt: path) else {
                return XCTFail("\(path) did not produce a named state")
            }
            lines.insert(notice.title + "\u{1}" + notice.detail)
        }
        XCTAssertEqual(lines.count, 3, "two of the three failures say the same thing")
    }

    // MARK: - The launch actually carries the mailbox

    /// **THE GUARD ON THE GAP THAT PROMPTED THIS SLICE.**
    ///
    /// `EngineProcess.plan` reads the environment it is handed only to decide whether it CAN start;
    /// the launch it returns carries two pairs, and the spawn overlays those onto this process's real
    /// environment. So a shell that merely fed the stored mailbox into `plan` would satisfy the check
    /// and then start a child that inherits nothing — and the engine would exit demanding the very
    /// variable the shell had just proved it had.
    ///
    /// This starts a real child that writes its own environment to a file, and reads it back. Delete
    /// the `Self.carrying(overlay, in: plan)` call in `EngineBridge.start` — feed the composed
    /// dictionary to `plan` and hand the plan straight to `make`, which is the version that looks
    /// right — and this goes red while every other test here stays green.
    func testTheStoredMailboxReachesTheChildsEnvironment() throws {
        let dump = dir.appendingPathComponent("env.txt")
        let engine = dir.appendingPathComponent("ohmail-engine")
        try "#!/bin/sh\n/usr/bin/env > \(dump.path)\nexit 0\n"
            .write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)

        let config = EngineConfig(host: "imap.example.org", port: 1143, user: "login",
                                  address: "someone@example.org", tls: false)
        let bridge = EngineBridge()
        bridge.start(environment: [ENGINE_PATH_VAR: engine.path],
                     overlay: EngineEnvironment.overlay(for: config),
                     keys: StubKeys(value: Self.key))
        // Wait for the child to have run before asking it to leave. `stop()` sets the stop flag
        // under the supervisor's own lock, and the supervisor checks that flag at the TOP of its
        // loop — so a stop that lands between `start()` and the first spawn is honoured by never
        // spawning at all, and this test would be asserting about a process that never existed.
        let deadline = Date().addingTimeInterval(20)
        while !FileManager.default.fileExists(atPath: dump.path) && Date() < deadline { usleep(2000) }
        bridge.stop()

        let written = try XCTUnwrap(try? String(contentsOf: dump, encoding: .utf8),
                                    "the engine never ran — nothing wrote its environment")
        var seen: [String: String] = [:]
        for line in written.split(separator: "\n") {
            guard let split = line.firstIndex(of: "=") else { continue }
            seen[String(line[..<split])] = String(line[line.index(after: split)...])
        }

        XCTAssertEqual(seen["OHMAIL_IMAP_HOST"], "imap.example.org",
                       "the mailbox never reached the engine — it would exit demanding this")
        XCTAssertEqual(seen["OHMAIL_IMAP_PORT"], "1143")
        XCTAssertEqual(seen["OHMAIL_IMAP_USER"], "login")
        XCTAssertEqual(seen["OHMAIL_MAILBOX_ADDRESS"], "someone@example.org")
        XCTAssertEqual(seen["OHMAIL_IMAP_SECURE"], "0")
        // The two the shell knows rather than reads still arrive, and the password never does.
        XCTAssertEqual(seen[KEK_VAR], Self.key)
        XCTAssertNotNil(seen[DATA_DIR_VAR])
        XCTAssertNil(seen["OHMAIL_IMAP_PASS"],
                     "a password reached the child's environment, where anything running as this "
                     + "user could read it")
    }

    // MARK: - Running one

    /// Start a real engine at `path` against a configured install and return what the window shows
    /// once the supervisor has stopped trying.
    private func run(engineAt path: String) throws -> SourceSelection.Surface {
        try runKeepingEngine(engineAt: path).surface
    }

    private func runKeepingEngine(engineAt path: String) throws
        -> (surface: SourceSelection.Surface, engine: EngineProcess) {
        // The real plan, the real supervisor, and timings small enough that four starts and their
        // backoff take milliseconds rather than seconds. `maxStarts` itself is NOT reduced — the
        // budget is the thing under test.
        let plan = EngineProcess.plan(
            environment: [ENGINE_PATH_VAR: path,
                          "OHMAIL_IMAP_HOST": "imap.example.org",
                          "OHMAIL_IMAP_USER": "someone@example.org"],
            executableDirectory: nil,
            dataDirectoryFallback: dir,
            keys: StubKeys(value: Self.key))

        let engine = EngineProcess.make(plan, timings: EngineTimings(
            stopGrace: 0.2, healthyFor: 60, backoffBase: 0.002, backoffCap: 0.01, poll: 0.002))
        engine.start()

        // Wait for the supervisor to settle rather than for a duration: a sleep long enough on this
        // machine is a flake on a slower one.
        let deadline = Date().addingTimeInterval(20)
        while !engine.isFinished && Date() < deadline { usleep(2000) }
        XCTAssertTrue(engine.isFinished, "the supervisor never settled")

        let surface = SourceSelection.decide(configured: true, status: engine.status,
                                             flags: LaunchFlags(demo: false)).surface
        return (surface, engine)
    }

    /// **No fixture message.** The check the whole slice is about, stated as a property of the
    /// surface: a surface with no mail source cannot render one, and the sample surface is the only
    /// other thing that could have appeared here.
    private func XCTAssertNoMail(_ surface: SourceSelection.Surface,
                                 file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNotEqual(surface, .demo, "a failing engine landed on the sample world", file: file, line: line)
        XCTAssertNotEqual(surface, .mail, "a failing engine claimed to have mail", file: file, line: line)
    }
}
