import XCTest
@testable import OhMailEngine

/// **The real engine, not a stand-in.**
///
/// Everything else in this suite talks to a Node script written to agree with this shell's reading
/// of the protocol, which is exactly the failure mode a shared contract has: two documents that
/// agree with each other and not with the thing they describe. This file runs the **real engine**
/// and asserts that this shell reaches `serving` off its actual `ready` frame.
///
/// **The engine is not part of this repository, and this test skips when it is absent.** It is
/// built in the workspace this client is developed in, and a checkout of the client alone has no
/// engine to run — which is the ordinary case for anyone reading this. A skip is honest; a green
/// run against a missing engine would not be.
///
/// `OHMAIL_TEST_ENGINE` names the engine's entry point. Without it the test looks for one in the
/// surrounding workspace and skips if there is none.
///
/// **It runs the engine's SOURCE through `tsx`, not a compiled bundle, and that is the engine's own
/// decision rather than a shortcut here.** The engine's dependencies resolve their exports to
/// TypeScript source, because that is how the engine actually runs today; the compiled entry point
/// cannot resolve its own sync loop and exits — verified, not assumed. Until a packaging step
/// produces a self-contained engine binary there is nothing else to hand this shell, and the honest
/// thing is to run the engine the way it runs and say so.
final class RealSidecarTests: XCTestCase {
    private var directory: URL!

    /// The workspace this client is developed in, five levels above this file. Built by component
    /// rather than written as one path, because a checkout of the client alone does not contain it
    /// and a literal would read as a link nobody can follow.
    private static var workspaceRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // the test directory
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // the client
            .deletingLastPathComponent()   // the apps directory
            .deletingLastPathComponent()   // the workspace
    }

    /// Where the engine's entry point sits in that workspace, assembled from components for the
    /// same reason.
    private static var defaultEngineEntry: URL {
        ["apps", "sidecar", "src", "main.ts"].reduce(workspaceRoot) { $0.appendingPathComponent($1) }
    }

    /// The mailbox variables go in THIS process's environment, not into the launch.
    ///
    /// That is not test scaffolding, it is the contract under test: `plan` composes only the data
    /// directory and the key, and everything else the engine reads "is already in the environment
    /// this process was given and the child inherits it". Putting them in the launch would test a
    /// composition this shell deliberately does not do — and the first version of this test did
    /// exactly that, passed them to `plan(environment:)`, and watched the real engine fail four
    /// starts with `start_failed` because they never reached the child at all.
    ///
    /// The consequence for the shipped app is worth naming here rather than discovering: a
    /// double-clicked bundle has an empty environment, so it will report `OHMAIL_IMAP_HOST` and
    /// `OHMAIL_IMAP_USER` missing until a slice feeds them from `EngineConfigStore`.
    private static let mailboxEnvironment = [
        "OHMAIL_IMAP_HOST": "127.0.0.1",
        "OHMAIL_IMAP_PORT": "1",
        "OHMAIL_IMAP_USER": "someone@example.org",
        "CI": "true",
    ]

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ohmail-real-sidecar-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, value) in Self.mailboxEnvironment { setenv(name, value, 1) }
    }

    override func tearDownWithError() throws {
        for name in Self.mailboxEnvironment.keys { unsetenv(name) }
        try? FileManager.default.removeItem(at: directory)
    }

    /// A wrapper named `ohmail-engine`, so this is also the path shape the shipped app will use:
    /// one executable of that name beside the shell's own.
    private func engineWrapper() throws -> URL {
        let node = try nodePath()
        let root = Self.workspaceRoot
        let entry = ProcessInfo.processInfo.environment["OHMAIL_TEST_ENGINE"]
            .map { URL(fileURLWithPath: $0) } ?? Self.defaultEngineEntry
        guard FileManager.default.fileExists(atPath: entry.path) else {
            throw XCTSkip("no engine at \(entry.path); set OHMAIL_TEST_ENGINE to run this against one")
        }
        guard FileManager.default.fileExists(
            atPath: root.appendingPathComponent("node_modules").appendingPathComponent("tsx").path) else {
            throw XCTSkip("the workspace's node dependencies are not installed, so the engine cannot start")
        }
        let wrapper = directory.appendingPathComponent(ENGINE_FILE_STEM)
        try Data("""
        #!/bin/sh
        cd "\(root.path)"
        exec "\(node)" --import tsx "\(entry.path)"

        """.utf8).write(to: wrapper)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
        return wrapper
    }

    private func launch() throws -> EngineLaunch {
        // The real environment this process now has — the host and user set in `setUpWithError`
        // among it — plus the two the shell decides. A host nothing answers on is fine: the engine
        // announces itself BEFORE it dials the mailbox, deliberately, because a first sync of a real
        // mailbox takes minutes and a UI that could ask nothing until it finished would look broken.
        // So this proves the bridge without needing a live IMAP server, and a test that needed one
        // would be a test nobody runs.
        var environment = ProcessInfo.processInfo.environment
        environment[ENGINE_PATH_VAR] = try engineWrapper().path
        environment[KEK_VAR] = String(repeating: "0", count: 64)
        environment[DATA_DIR_VAR] = directory.path

        let plan = EngineProcess.plan(
            environment: environment,
            executableDirectory: directory,
            dataDirectoryFallback: directory)
        guard case .spawn(let launch) = plan else {
            throw Failure("the plan refused to start the real engine: \(plan)")
        }
        return launch
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    /// The acceptance run, in a test: the real engine, reached over a real pipe, and `serving` off
    /// its own `ready` frame.
    func testTheRealEngineIsReachedAndAnswers() async throws {
        let engine = EngineProcess(launch: try launch())
        let transport = EngineTransport(engine: engine)
        defer { engine.stop() }
        engine.start()

        // Generous: a first launch builds the on-disk mirror and runs every migration.
        waitFor("the real engine to announce itself", within: 120) {
            if case .serving = engine.status { return true }
            if case .failed = engine.status { return true }
            return false
        }
        guard case .serving(let mailboxID) = engine.status else {
            return XCTFail("the real engine did not reach serving: \(engine.status)")
        }
        XCTAssertFalse(mailboxID.isEmpty)

        let ready = try XCTUnwrap(engine.ready)
        XCTAssertEqual(ready.baseURL, "http://sidecar")
        XCTAssertFalse(ready.sessionToken.isEmpty, "the ready frame carried a per-launch session")
        XCTAssertEqual(ready.mailboxID, mailboxID)

        // And the bridge carries a request. `GET /health` is the engine's own liveness route and is
        // `anonymous`, so this asserts the transport rather than the session.
        var request = URLRequest(url: URL(string: "http://sidecar/health")!)
        request.httpMethod = "GET"
        let response = try await transport.response(for: request)
        XCTAssertEqual(response.status, 200, String(decoding: response.body, as: UTF8.self))

        // **"The LOCAL sidecar is bearer-only and mints no cookies; keep that true by evidence."**
        // The `sc` array exists so this is a measurement and not an assumption.
        XCTAssertEqual(response.setCookie, [], "the LOCAL engine minted a cookie")
        XCTAssertFalse(response.headers.contains { $0.name.lowercased() == "set-cookie" },
                       "a set-cookie arrived in the ordinary header list, where two of them would "
                       + "have been silently combined")

        engine.stop()
        XCTAssertEqual(engine.status, .stopped)
        XCTAssertEqual(engine.lastExit?.code, 0, "the real engine left on EOF, cleanly")
    }
}
