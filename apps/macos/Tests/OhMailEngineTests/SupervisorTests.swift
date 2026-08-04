import XCTest
@testable import OhMailEngine

/// The engine lifecycle, against a real child process. See `EngineFixture.swift` for why nothing
/// here is a mock.
final class SupervisorTests: XCTestCase {
    // MARK: - Starting, and what "running" means

    func testTheEngineIsRunningWhenItSaysItIsServing() throws {
        let fixture = try EngineFixture("serving")
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings)
        defer { engine.stop() }
        engine.start()

        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        XCTAssertEqual(engine.status, .serving(mailboxID: "mbx-1"))
        XCTAssertEqual(fixture.starts, 1)

        let ready = try XCTUnwrap(engine.ready, "a serving engine has said ready")
        XCTAssertEqual(ready.baseURL, "http://sidecar")
        XCTAssertEqual(ready.mailboxID, "mbx-1")
        XCTAssertEqual(ready.sessionToken.expose(), "tok_" + String(repeating: "a", count: 24))

        let pid = try XCTUnwrap(engine.pid, "a running engine has a pid")
        XCTAssertTrue(isAlive(pid), "the engine process is running")

        // AND IT KEEPS RUNNING, because this process is holding its stdin open.
        //
        // The Rust original added this line after a mutation went the wrong colour: replacing the
        // piped stdin with a null device left every behavioural test green, because a null stdin is
        // EOF and the engine leaving immediately looks like the engine leaving politely. The pipe
        // being OPEN — and privately held — is the invariant, and this is the line that can see it.
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(engine.status, .serving(mailboxID: "mbx-1"), "still serving a moment later")
        XCTAssertNil(engine.lastExit, "nothing has ended: \(String(describing: engine.lastExit))")
        XCTAssertEqual(fixture.exits, 0, "the engine has not left: \(fixture.lines)")
    }

    /// **The mutation the acceptance criteria name.** A supervisor that reported `serving` because
    /// the spawn returned would pass every other test in this file — `serve` announces itself
    /// milliseconds later either way. This is the child that starts, stays up, and never says ready.
    func testAProcessThatSleepsForeverWithoutSayingReadyIsNeverReportedAsServing() throws {
        let fixture = try EngineFixture("mute")
        let engine = EngineProcess(launch: fixture.launch("mute"), timings: quickTimings)
        defer { engine.stop() }
        engine.start()

        waitFor("the child to be up") { engine.pid != nil }
        let pid = try XCTUnwrap(engine.pid)
        Thread.sleep(forTimeInterval: 0.5)

        XCTAssertTrue(isAlive(pid), "the process is alive — which is exactly the point")
        XCTAssertNil(engine.ready, "nothing announced itself")
        XCTAssertEqual(engine.status, .starting(attempt: 1), "a live pid is not a running engine")
        if case .serving = engine.status { XCTFail("spawn success was mistaken for serving") }
    }

    /// The whole reason `ready` is the signal: a locked data directory, a missing credential or a
    /// failed migration all produce a process that exists and will never serve.
    func testAProcessThatDiesBeforeReadyBurnsTheBudgetAndStaysDown() throws {
        let fixture = try EngineFixture("never-ready")
        let engine = EngineProcess(launch: fixture.launch("die"), timings: quickTimings)
        defer { engine.stop() }
        engine.start()

        waitFor("the restart budget to run out", within: 30) {
            if case .failed = engine.status { return true }
            return false
        }
        XCTAssertNil(engine.ready, "nothing ever announced itself")
        guard case .failed(_, let last) = engine.status, let exit = last else {
            return XCTFail("expected a failed status carrying the last exit, got \(engine.status)")
        }
        XCTAssertFalse(exit.served, "the run never served")
        XCTAssertEqual(exit.code, 1)
    }

    /// Nothing at that path, and nothing retries: this is the interface preview, which is what the
    /// shell has shipped since it existed.
    func testABuildWithNoEngineBesideItIsNotAnError() throws {
        let engine = EngineProcess(
            launch: EngineLaunch(program: URL(fileURLWithPath: "/nonexistent/ohmail/ohmail-engine")),
            timings: quickTimings)
        defer { engine.stop() }
        engine.start()
        waitFor("the absent status") {
            if case .absent = engine.status { return true }
            return false
        }
    }

    // MARK: - Quitting: the defect this slice exists to prevent

    func testQuittingLeavesNoEngineBehind() throws {
        let fixture = try EngineFixture("quit")
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        let pid = try XCTUnwrap(engine.pid)

        engine.stop()

        XCTAssertEqual(engine.status, .stopped)
        // Three independent proofs, because "the supervisor says it stopped it" is the claim under
        // test rather than evidence for it: the engine ran its own exit handler, the kernel gave us
        // an exit status for it, and the kernel no longer has the process.
        XCTAssertEqual(fixture.exits, 1, "the engine ran its exit handler: \(fixture.lines)")
        XCTAssertEqual(try XCTUnwrap(engine.lastExit).code, 0)
        XCTAssertFalse(isAlive(pid), "process \(pid) is gone")
    }

    /// The distinction matters: EOF on stdin is what makes the engine finish its in-flight work,
    /// close IMAP and close its database in that order. A kill skips all three.
    func testQuittingClosesTheEnginesInputRatherThanKillingIt() throws {
        let fixture = try EngineFixture("graceful")
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }

        let began = Date()
        engine.stop()

        XCTAssertLessThan(Date().timeIntervalSince(began), quickTimings.stopGrace,
                          "it left of its own accord, well inside the grace period — it was asked, not killed")
        XCTAssertEqual(fixture.exits, 1)
        XCTAssertEqual(try XCTUnwrap(engine.lastExit).code, 0, "a clean exit, not a signal")
    }

    func testAnEngineThatIgnoresTheAskIsKilledRatherThanLeftRunning() throws {
        let fixture = try EngineFixture("deaf")
        let engine = EngineProcess(launch: fixture.launch("serve-deaf"), timings: quickTimings)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        let pid = try XCTUnwrap(engine.pid)

        let began = Date()
        engine.stop()

        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), quickTimings.stopGrace,
                                    "the grace period was waited out before killing")
        XCTAssertEqual(engine.status, .stopped)
        // No exit line: a killed process does not run its own exit handler, which is exactly why
        // this case needs the operating system's account of it rather than the engine's.
        XCTAssertEqual(fixture.exits, 0)
        XCTAssertNil(try XCTUnwrap(engine.lastExit).code, "a signal ended it, and the kernel reaped it")
        XCTAssertFalse(isAlive(pid), "process \(pid) is gone")
    }

    /// The shell stops the engine when the window closes and again when the app exits.
    func testStoppingTwiceIsTheSameAsStoppingOnce() throws {
        let fixture = try EngineFixture("twice")
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        engine.stop()
        engine.stop()
        XCTAssertEqual(engine.status, .stopped)
        XCTAssertEqual(fixture.starts, 1, "nothing was restarted by the second stop")
    }

    func testAStoppedEngineIsNotRestarted() throws {
        let fixture = try EngineFixture("no-resurrect")
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        engine.stop()
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(fixture.starts, 1)
        XCTAssertEqual(engine.status, .stopped)
    }

    // MARK: - Supervision: noticing, restarting, and knowing when to stop

    func testAnEngineThatDiesIsNoticedAndRestartedABoundedNumberOfTimes() throws {
        let fixture = try EngineFixture("crashloop")
        let engine = EngineProcess(launch: fixture.launch("serve-then-die"), timings: quickTimings)
        defer { engine.stop() }
        engine.start()

        waitFor("the restart budget to run out", within: 40) {
            if case .failed = engine.status { return true }
            return false
        }
        XCTAssertEqual(fixture.starts, EngineTimings.maxStarts,
                       "one start and three restarts: \(fixture.lines)")
        guard case .failed(let reason, let last) = engine.status, let exit = last else {
            return XCTFail("expected a failed status, got \(engine.status)")
        }
        XCTAssertTrue(exit.served, "each run did serve before dying")
        XCTAssertEqual(exit.code, 9)
        XCTAssertTrue(reason.contains("stopped restarting"), reason)
        XCTAssertTrue(reason.contains("another copy"), "the reason names the likely cause: \(reason)")

        // And it stays down. A supervisor that gave up and then quietly tried again would be the
        // restart loop with extra steps.
        Thread.sleep(forTimeInterval: 0.4)
        XCTAssertEqual(fixture.starts, EngineTimings.maxStarts)
    }

    /// **The crash-loop bug the Rust original recorded at `engine.rs:583-598`.** A run torn down for
    /// a protocol fault leaves a kill deadline in the past; carried into the next run it kills the
    /// next child on the supervisor's first pass, before it has executed far enough to do anything.
    ///
    /// The visible symptom is that every restarted child dies by signal without ever serving —
    /// which points at the engine and not at the supervisor. So the assertion is on `served`: with
    /// the deadline cleared, each of the four runs reaches ready first.
    func testAStaleKillDeadlineDoesNotKillTheNextHealthyChild() throws {
        let fixture = try EngineFixture("stale-deadline")
        let engine = EngineProcess(launch: fixture.launch("noise"), timings: quickTimings)
        defer { engine.stop() }
        engine.start()

        waitFor("the restart budget to run out", within: 40) {
            if case .failed = engine.status { return true }
            return false
        }
        XCTAssertEqual(fixture.starts, EngineTimings.maxStarts, "\(fixture.lines)")
        guard case .failed(_, let last) = engine.status, let exit = last else {
            return XCTFail("expected a failed status, got \(engine.status)")
        }
        XCTAssertTrue(exit.served,
                      "the last run reached ready before it was torn down — a deadline carried over "
                      + "from the previous run would have killed it first")
        XCTAssertEqual(fixture.exits, EngineTimings.maxStarts,
                       "every run left of its own accord after being asked: \(fixture.lines)")
    }

    func testStoppingDuringARestartDelayDoesNotWaitTheDelayOut() throws {
        var timings = quickTimings
        timings.backoffBase = 30
        timings.backoffCap = 30
        let fixture = try EngineFixture("interrupt-backoff")
        let engine = EngineProcess(launch: fixture.launch("die"), timings: timings)
        engine.start()

        waitFor("the supervisor to enter its restart delay") {
            if case .restarting = engine.status { return true }
            return false
        }
        let began = Date()
        engine.stop()
        XCTAssertLessThan(Date().timeIntervalSince(began), 5, "stop returned in \(Date().timeIntervalSince(began))s")
        XCTAssertEqual(engine.status, .stopped)
    }

    // MARK: - A malformed frame is terminal, not something to resync from

    /// One fault, one torn-down child, and no attempt to find the next frame boundary — there is no
    /// next frame boundary to find.
    func testProseOnTheFrameStreamTearsTheRunDownRatherThanResyncing() throws {
        try assertFatalStream(mode: "noise", fixture: "noise")
    }

    func testAnOversizedBodyLengthTearsTheRunDown() throws {
        try assertFatalStream(mode: "oversize", fixture: "oversize")
    }

    func testAHeaderThatIsNotJSONTearsTheRunDown() throws {
        try assertFatalStream(mode: "badheader", fixture: "badheader")
    }

    private func assertFatalStream(mode: String, fixture name: String) throws {
        let fixture = try EngineFixture(name)
        let engine = EngineProcess(launch: fixture.launch(mode), timings: quickTimings)
        defer { engine.stop() }
        engine.start()

        waitFor("the restart budget to run out", within: 40) {
            if case .failed = engine.status { return true }
            return false
        }
        XCTAssertEqual(fixture.starts, EngineTimings.maxStarts, "\(fixture.lines)")
        XCTAssertEqual(fixture.exits, EngineTimings.maxStarts,
                       "every faulted run ended, rather than being left running while the shell "
                      + "restarted around it: \(fixture.lines)")
    }

    // MARK: - The stdin pipe is private to this process

    /// **"Never hand that stdin to a second child."** A second child that inherited the write end
    /// would keep the first engine's stdin open after this process closed it, and the engine would
    /// never see EOF — the orphan defence, defeated silently.
    ///
    /// So: start the engine, start an unrelated long-lived child, then quit. The engine must still
    /// leave, and it must leave by being asked rather than by being killed.
    func testASecondChildDoesNotInheritTheEnginesInput() throws {
        let fixture = try EngineFixture("private-pipe")
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }

        let bystander = Process()
        bystander.executableURL = URL(fileURLWithPath: "/bin/sleep")
        bystander.arguments = ["30"]
        try bystander.run()
        defer { if bystander.isRunning { bystander.terminate() } }

        let began = Date()
        engine.stop()
        XCTAssertLessThan(Date().timeIntervalSince(began), quickTimings.stopGrace,
                          "the engine saw EOF — a second child holding the write end would have made "
                          + "the shell wait out the grace period and kill it")
        XCTAssertEqual(fixture.exits, 1, "it ran its own exit handler")
        XCTAssertEqual(try XCTUnwrap(engine.lastExit).code, 0)
    }

    // MARK: - The status is published

    func testEveryStatusChangeIsPublished() throws {
        let fixture = try EngineFixture("published")
        let seen = Collected<String>()
        let engine = EngineProcess(launch: fixture.launch("serve"), timings: quickTimings,
                                   onStatusChange: { status in seen.add(status.description) })
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        engine.stop()

        let descriptions = seen.all
        XCTAssertEqual(descriptions.first, "starting (attempt 1 of 4)")
        XCTAssertTrue(descriptions.contains("serving mailbox mbx-1"), "\(descriptions)")
        XCTAssertEqual(descriptions.last, "stopped", "\(descriptions)")
    }
}
