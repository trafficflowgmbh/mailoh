import XCTest
@testable import OhMailEngine

/// What the shell decides before it does anything — and, as much, what it decides NOT to hand over.
final class PlanTests: XCTestCase {
    private let exeDir = URL(fileURLWithPath: "/apps/ohmail")
    private let dataDir = URL(fileURLWithPath: "/data")

    private func fullEnvironment() -> [String: String] {
        [
            "OHMAIL_IMAP_HOST": "imap.example.org",
            "OHMAIL_IMAP_USER": "someone@example.org",
            // A key, not a password. The engine seals the password into its own store under this and
            // reads it back on later launches, so the environment never has to carry one.
            KEK_VAR: String(repeating: "0", count: 64),
        ]
    }

    /// `Optional<URL>.some(nil)` is what a test that means "there is no directory" has to be able to
    /// say. The first version of this helper took `URL?` and defaulted with `??`, which turned every
    /// "pass nothing" case into "pass the default" — three tests asserted the opposite of what they
    /// ran and failed for the right reason.
    ///
    /// **`keys` defaults to a shell with NO keystore, and not to ``KeyProviderDefault``.** Two
    /// reasons, and the second is the sharper one. The subject of this file is what the plan decides
    /// from what it is given, so the empty keystore is the case that leaves the environment in
    /// charge and keeps every assertion below about the plan. And ``KeyProviderDefault`` now reaches
    /// the real Keychain: with it here, running this file would mint the installed app's key and
    /// then, because the keychain ties an item to the binary that created it and a test bundle is
    /// recompiled between runs, the NEXT run would stop on an authorization dialog and never
    /// finish.
    private func plan(_ env: [String: String], exeDir: URL?? = nil, dataDir: URL?? = nil,
                      keys: KeyProvider = StubKeys(value: nil, failure: nil)) -> EnginePlan {
        EngineProcess.plan(environment: env,
                           executableDirectory: exeDir ?? self.exeDir,
                           dataDirectoryFallback: dataDir ?? self.dataDir,
                           keys: keys)
    }

    private func spawn(_ plan: EnginePlan, file: StaticString = #filePath, line: UInt = #line) throws -> EngineLaunch {
        guard case .spawn(let launch) = plan else {
            XCTFail("expected a spawn plan, got \(plan)", file: file, line: line)
            throw XCTSkip("not a spawn plan")
        }
        return launch
    }

    // MARK: - Which binary

    func testAnExplicitEnginePathWinsOverTheOneBesideTheExecutable() throws {
        var env = fullEnvironment()
        env[ENGINE_PATH_VAR] = "/opt/ohmail/engine"
        let launch = try spawn(plan(env))
        XCTAssertEqual(launch.program.path, "/opt/ohmail/engine")
        XCTAssertTrue(launch.arguments.isEmpty)
    }

    func testWithoutAnExplicitPathTheEngineIsLookedForBesideTheExecutable() throws {
        let launch = try spawn(plan(fullEnvironment()))
        XCTAssertEqual(launch.program.path, "/apps/ohmail/\(ENGINE_FILE_STEM)")
    }

    func testWithNoExecutableDirectoryThereIsNothingToLookBeside() {
        guard case .inert(.absent(let lookedFor)) = plan(fullEnvironment(), exeDir: .some(nil)) else {
            return XCTFail("expected absent")
        }
        XCTAssertTrue(lookedFor.contains(ENGINE_PATH_VAR))
    }

    // MARK: - Whether this build carries an engine at all

    /// Every case below runs against a REAL directory rather than a stubbed `FileManager`. The thing
    /// under test is a question about the filesystem, and a fake that answers it is a fake of the
    /// answer.
    private func temporaryDirectory() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ohmail-install-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    @discardableResult
    private func writeEngine(in dir: URL, named name: String = ENGINE_FILE_STEM,
                             executable: Bool = true) throws -> URL {
        let path = dir.appendingPathComponent(name)
        try Data("#!/bin/sh\n".utf8).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: executable ? 0o755 : 0o644],
                                              ofItemAtPath: path.path)
        return path
    }

    func testABuildWithNothingBesideItsExecutableCarriesNoEngine() throws {
        let dir = try temporaryDirectory()
        XCTAssertEqual(EngineProcess.install(environment: [:], executableDirectory: dir),
                       .missing(lookedFor: dir.appendingPathComponent(ENGINE_FILE_STEM).path),
                       "the panel this feeds has one actionable thing in it, and it is that path")
    }

    func testAnEngineBesideTheExecutableIsAnInstalledOne() throws {
        let dir = try temporaryDirectory()
        try writeEngine(in: dir)
        XCTAssertEqual(EngineProcess.install(environment: [:], executableDirectory: dir), .installed)
    }

    /// **Present is not runnable, and the difference is a trap rather than a nicety.** A file without
    /// the execute bit makes the spawn fail with a permission error instead of `NotFound` — a
    /// different sentence for the same absence — and an install check that accepted it would put the
    /// password form back on screen in front of a build that still cannot open a mailbox.
    func testAFileThatCannotBeRunIsNotAnEngine() throws {
        let dir = try temporaryDirectory()
        try writeEngine(in: dir, executable: false)
        XCTAssertEqual(EngineProcess.install(environment: [:], executableDirectory: dir),
                       .missing(lookedFor: dir.appendingPathComponent(ENGINE_FILE_STEM).path))
    }

    /// `fileExists` says yes to a directory, and `isExecutableFile` says yes to a searchable one. A
    /// folder named `ohmail-engine` is neither an engine nor a thing to tell somebody is installed.
    func testADirectoryWithTheEnginesNameIsNotAnEngine() throws {
        let dir = try temporaryDirectory()
        try FileManager.default.createDirectory(at: dir.appendingPathComponent(ENGINE_FILE_STEM),
                                                withIntermediateDirectories: true)
        XCTAssertEqual(EngineProcess.install(environment: [:], executableDirectory: dir),
                       .missing(lookedFor: dir.appendingPathComponent(ENGINE_FILE_STEM).path))
    }

    func testAnExplicitEnginePathIsWhatTheInstallCheckLooksAt() throws {
        let dir = try temporaryDirectory()
        let elsewhere = try writeEngine(in: dir, named: "engine-somewhere-else")
        // The bundle has nothing in it; the variable names something runnable.
        XCTAssertEqual(EngineProcess.install(environment: [ENGINE_PATH_VAR: elsewhere.path],
                                             executableDirectory: dir),
                       .installed)
        XCTAssertEqual(EngineProcess.install(environment: [ENGINE_PATH_VAR: dir.path + "/nope"],
                                             executableDirectory: dir),
                       .missing(lookedFor: dir.path + "/nope"),
                       "the variable wins for the check exactly as it wins for the spawn")
    }

    func testWithNoExecutableDirectoryAndNoVariableThereIsNoEngineAndTheSentenceSaysWhy() {
        guard case .missing(let lookedFor) = EngineProcess.install(environment: [:],
                                                                   executableDirectory: nil) else {
            return XCTFail("a build with nowhere to look reported an engine")
        }
        XCTAssertTrue(lookedFor.contains(ENGINE_PATH_VAR))
    }

    /// **THE ANTI-DRIFT ASSERTION.** The check and the spawn must resolve the same file. Two
    /// resolutions is a build that stats one path and launches another, and it fails in the
    /// direction that matters: the check reports an engine, the spawn reports `NotFound`, and the
    /// trap the check exists to close is back with a layer on top of it.
    func testTheInstallCheckLooksExactlyWhereTheSpawnWouldRun() throws {
        let dir = try temporaryDirectory()
        let environments: [[String: String]] = [[:], [ENGINE_PATH_VAR: dir.path + "/named-by-the-variable"]]
        for environment in environments {
            let launch = try spawn(EngineProcess.plan(
                environment: fullEnvironment().merging(environment) { _, b in b },
                executableDirectory: dir,
                dataDirectoryFallback: dataDir,
                keys: StubKeys(value: String(repeating: "0", count: 64), failure: nil)))
            guard case .missing(let lookedFor) = EngineProcess.install(environment: environment,
                                                                       executableDirectory: dir) else {
                return XCTFail("nothing was written, so there is nothing to run")
            }
            XCTAssertEqual(lookedFor, launch.program.path)
        }
    }

    // MARK: - What must be set

    func testAMissingMailboxIsNamedAndNothingIsStarted() {
        var env = fullEnvironment()
        env.removeValue(forKey: "OHMAIL_IMAP_HOST")
        XCTAssertEqual(plan(env), .inert(.notConfigured(missing: ["OHMAIL_IMAP_HOST"])))
    }

    /// The engine WOULD start without one. It would also refuse to store the password the user is
    /// about to type, which is a mailbox that works until the app is closed — so the shell treats a
    /// missing key as a reason not to start rather than as a reason to start and hope.
    func testWithoutAKeyNothingIsStarted() {
        var env = fullEnvironment()
        env.removeValue(forKey: KEK_VAR)
        XCTAssertEqual(plan(env), .inert(.notConfigured(missing: [KEK_VAR])))
    }

    /// The launch the acceptance screenshot is taken of.
    func testANameableHoleIsWhatAnUnkeyedInstallRenders() {
        var env = fullEnvironment()
        env.removeValue(forKey: KEK_VAR)
        guard case .inert(let status) = plan(env) else { return XCTFail("expected inert") }
        XCTAssertEqual(status.description, "not started — nothing set OHMAIL_KEK",
                       "the status names the variable, because that string is what a person reads")
    }

    func testAnEmptyCredentialCountsAsMissing() {
        var env = fullEnvironment()
        env["OHMAIL_IMAP_USER"] = "   "
        XCTAssertEqual(plan(env), .inert(.notConfigured(missing: ["OHMAIL_IMAP_USER"])))
    }

    func testWithNoDataDirectoryFromEitherSourceNothingIsStarted() {
        XCTAssertEqual(plan(fullEnvironment(), dataDir: .some(nil)), .inert(.notConfigured(missing: [DATA_DIR_VAR])))
    }

    func testAnEnvironmentDataDirectoryBeatsTheShellsOwn() throws {
        var env = fullEnvironment()
        env[DATA_DIR_VAR] = "/elsewhere"
        let launch = try spawn(plan(env))
        XCTAssertEqual(launch.environment.first { $0.name == DATA_DIR_VAR }?.value, "/elsewhere")
    }

    func testEverythingMissingIsNamedAtOnceRatherThanOneAtATime() {
        guard case .inert(.notConfigured(let missing)) = plan([:], dataDir: .some(nil)) else {
            return XCTFail("expected notConfigured")
        }
        XCTAssertEqual(missing, ["OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER", KEK_VAR, DATA_DIR_VAR],
                       "a person fixing this should have to launch once, not four times")
    }

    // MARK: - What is composed, and what is never composed

    /// It was required in an earlier design, and requiring it is what put a password in process
    /// state on every launch. The engine still accepts one; this shell does not hand one over, and a
    /// launch without one is the ordinary case rather than a first-run exception.
    func testTheMailboxPasswordIsNeverRequiredAndNeverComposed() throws {
        XCTAssertFalse(requiredEngineVars.contains("OHMAIL_IMAP_PASS"))
        var env = fullEnvironment()
        env["OHMAIL_IMAP_PASS"] = "hunter2"
        let launch = try spawn(plan(env))
        XCTAssertEqual(launch.environment.map(\.name), [DATA_DIR_VAR, KEK_VAR],
                       "only the data directory and the key — the two values the shell KNOWS")
        XCTAssertFalse(launch.environment.contains { $0.value == "hunter2" })
    }

    /// A synthesised description would put the per-install key in the first crash report that
    /// formats a plan.
    func testALaunchPrintsTheNamesOfItsEnvironmentAndNoneOfTheValues() {
        let launch = EngineLaunch(
            program: URL(fileURLWithPath: "/apps/ohmail/ohmail-engine"),
            environment: [(KEK_VAR, "deadbeef-do-not-print")])
        for printed in ["\(launch)", String(reflecting: launch), String(describing: launch)] {
            XCTAssertTrue(printed.contains(KEK_VAR))
            XCTAssertFalse(printed.contains("deadbeef-do-not-print"), "an environment value was printed: \(printed)")
        }
    }

    // MARK: - The keystore seam

    private struct StubKeys: KeyProvider {
        let value: String?
        let failure: Error?
        func kek() throws -> String? {
            if let failure { throw failure }
            return value
        }
    }

    func testAKeyFromTheKeystoreIsWhatIsComposed() throws {
        var env = fullEnvironment()
        env[KEK_VAR] = "from-the-environment"
        let launch = try spawn(plan(env, keys: StubKeys(value: "from-the-keychain", failure: nil)))
        XCTAssertEqual(launch.environment.first { $0.name == KEK_VAR }?.value, "from-the-keychain",
                       "once a keystore exists it is the store, and an environment variable may not "
                       + "silently displace it")
    }

    /// `nil` and a throw are different answers, and conflating them is how a locked keychain becomes
    /// a fresh key sealed over credentials that still need the old one.
    func testAKeystoreThatCannotBeReadIsAFailureAndNotAnEmptyOne() {
        let env = fullEnvironment()
        let broken = StubKeys(value: nil, failure: NSError(domain: "Keychain", code: -25308,
                                                          userInfo: [NSLocalizedDescriptionKey: "interaction not allowed"]))
        guard case .inert(.failed(let reason, _)) = plan(env, keys: broken) else {
            return XCTFail("a keystore error must not read as notConfigured")
        }
        XCTAssertTrue(reason.contains("interaction not allowed"), reason)
    }

    /// **The default keystore is the Keychain, and this asserts it without opening one.**
    ///
    /// It used to assert that ``KeyProviderDefault`` answered `nil` — that the hole was still a
    /// hole. The hole is filled, so the claim worth keeping is the wiring: an app that constructs
    /// nothing gets the real keystore, at the one item the shipped build owns. Calling `kek()` here
    /// would mint that item on the developer's own machine and make every later run of this file
    /// stop on a keychain authorization dialog, so the name is what is checked; `KeychainKeyStoreTests`
    /// is where the item is actually opened, always under a service name unique to its run.
    func testTheDefaultKeyProviderIsTheKeychain() {
        XCTAssertEqual(KeyProviderDefault(environment: [:]).service, "io.ohmail.desktop")
    }

    // MARK: - The shipped numbers

    func testDefaultTimingsAreTheShippedOnes() {
        let t = EngineTimings.default
        XCTAssertEqual(t.stopGrace, 5)
        XCTAssertEqual(t.healthyFor, 60)
        XCTAssertEqual(t.backoffBase, 1)
        XCTAssertEqual(t.backoffCap, 8)
        XCTAssertEqual(EngineTimings.maxStarts, 4)
    }

    func testTheRestartDelayBacksOffAndIsCapped() {
        let t = EngineTimings.default
        XCTAssertEqual(t.backoff(attempt: 2), 1)
        XCTAssertEqual(t.backoff(attempt: 3), 2)
        XCTAssertEqual(t.backoff(attempt: 4), 4)
        XCTAssertEqual(t.backoff(attempt: 9), 8)
        XCTAssertEqual(t.backoff(attempt: 40), 8, "the shift must not overflow into a negative delay")
    }
}
