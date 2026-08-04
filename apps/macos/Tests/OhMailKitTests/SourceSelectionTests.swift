import XCTest
@testable import OhMailKit
import OhMailEngine

/// WHAT THE APP SHOWS WHEN IT IS NOT SHOWING MAIL — and the one thing it must never show.
///
/// The audits here are written against the *fallback*, not against the happy path. A test that
/// confirms the error panel renders is worth almost nothing: the panel was never the risk. The risk
/// is the branch nobody writes on purpose — a `catch` that lands on the sample world so the window
/// is not empty — and every assertion below is shaped so that adding one turns something red.
@MainActor
final class SourceSelectionTests: XCTestCase {

    // MARK: - Every engine status, on an install that HAS a mailbox

    /// The complete set of statuses the supervisor can publish, plus `nil` for "not asked yet".
    ///
    /// Written out rather than derived, and the switch in `SourceSelection.decide` has no `default:`
    /// — so a case added to `EngineStatus` fails to compile there, and this list is what makes it
    /// fail here too rather than silently going untested.
    static let everyStatus: [EngineStatus?] = [
        nil,
        .absent(lookedFor: "/nowhere/ohmail-engine"),
        .notConfigured(missing: ["OHMAIL_IMAP_HOST", "OHMAIL_KEK"]),
        .starting(attempt: 1),
        .starting(attempt: 3),
        .serving(mailboxID: "mbx-1"),
        .restarting(attempt: 2, delay: 1,
                    last: EngineExit(code: 1, served: false, ran: 0.2)),
        .restarting(attempt: 2, delay: 1,
                    last: EngineExit(code: nil, served: true, ran: 900)),
        .stopped,
        .failed(reason: "the engine failed 4 starts in a row, so the shell stopped restarting it.",
                last: EngineExit(code: 1, served: false, ran: 0.1)),
    ]

    private static let live = LaunchFlags(demo: false)

    /// A build that carries an engine, which is what every audit below is about unless it says
    /// otherwise. Written out at each call rather than defaulted in `decide` itself: a default is a
    /// parameter a future call site can forget, and what forgetting it restores is the password form
    /// on a build with nothing to run.
    private static let hasEngine = EngineInstall.installed

    /// **THE AUDIT.** No status, on a configured install, may name the invented world.
    ///
    /// This is the assertion the whole slice exists for. Mutating `decide` so that any branch below
    /// `configured` returns `.fixtures` — the natural shape of "show something rather than nothing"
    /// — turns it red for that status.
    func testAConfiguredLaunchNeverReachesTheInventedWorld() {
        for status in Self.everyStatus {
            let selection = SourceSelection.decide(configured: true, engine: Self.hasEngine, status: status, flags: Self.live)
            XCTAssertNotEqual(selection.source, .fixtures,
                              "a configured install reached the sample world from \(describe(status))")
            XCTAssertNotEqual(selection.surface, .demo,
                              "a configured install rendered the sample surface from \(describe(status))")
        }
    }

    /// And neither may an install with no mailbox, unless it was asked for by name.
    func testAnUnconfiguredLaunchShowsSetupRatherThanSamples() {
        let selection = SourceSelection.decide(configured: false, engine: Self.hasEngine, status: nil, flags: Self.live)
        XCTAssertEqual(selection.surface, .setup)
        XCTAssertNil(selection.source, "there is nothing to hold mail before a mailbox exists")
        XCTAssertFalse(selection.spawnEngine, "the engine refuses to run without a mailbox")
    }

    // MARK: - The form is not offered by a build that cannot use what it collects

    /// **THE SECOND AUDIT, and the defect it is written against actually shipped.**
    ///
    /// A download with no engine in it opened the setup form, collected an IMAP host, a user and a
    /// mail password, and discovered at the spawn — after the password — that there was nothing to
    /// hand any of it to. A stranger's credential, typed into a window that could not open the
    /// mailbox it named.
    ///
    /// The mutation: pin `engine` to `.installed` in the guard below — or restore the branch to a
    /// bare `return SourceSelection(surface: .setup, …)` — and this goes red on the first assertion,
    /// naming the form.
    func testABuildWithNoEngineSaysSoInsteadOfCollectingAMailbox() {
        let selection = SourceSelection.decide(
            configured: false,
            engine: .missing(lookedFor: "/Applications/ohmail.app/Contents/MacOS/ohmail-engine"),
            status: nil, flags: Self.live)

        XCTAssertNotEqual(selection.surface, .setup,
                          "a build with nothing to run asked somebody for their mail password")
        guard case .engineState(let notice) = selection.surface else {
            return XCTFail("a build with no engine produced \(selection.surface)")
        }
        XCTAssertTrue(notice.detail.contains("/Applications/ohmail.app/Contents/MacOS/ohmail-engine"),
                      "the path is the only actionable thing there is: “\(notice.detail)”")
        XCTAssertTrue(notice.detail.contains(ENGINE_PATH_VAR),
                      "…and the variable that overrides where it is looked for")
        XCTAssertNil(selection.source, "a build with no engine offered a source to hold mail")
        XCTAssertFalse(selection.spawnEngine, "there is nothing to spawn")
    }

    /// One fact, one sentence, whichever branch reached it. The unconfigured check and the
    /// supervisor's own `absent` are two journeys to "there is nothing to run at this path", and a
    /// second wording of it is a second thing to keep right.
    func testTheMissingEngineSentenceIsTheSameFromBothBranches() {
        let path = "/Applications/ohmail.app/Contents/MacOS/ohmail-engine"
        guard case .engineState(let beforeSetup) = SourceSelection.decide(
                configured: false, engine: .missing(lookedFor: path),
                status: nil, flags: Self.live).surface,
              case .engineState(let fromTheSpawn) = SourceSelection.decide(
                configured: true, engine: Self.hasEngine,
                status: .absent(lookedFor: path), flags: Self.live).surface else {
            return XCTFail("one of the two missing-engine branches is not a named state")
        }
        XCTAssertEqual(beforeSetup, fromTheSpawn)
    }

    /// **The preview build keeps working.** `--demo` is asked before anything about the install, and
    /// a build that carries no engine is exactly the build the flag exists for: nothing to run is
    /// not a reason to refuse to draw the sample world, and the sample world starts no engine.
    func testTheSampleWorldStillOpensInABuildWithNoEngine() {
        let selection = SourceSelection.decide(
            configured: false, engine: .missing(lookedFor: "/nowhere/ohmail-engine"),
            status: nil, flags: LaunchFlags(demo: true))
        XCTAssertEqual(selection.surface, .demo)
        XCTAssertEqual(selection.source, .fixtures)
        XCTAssertFalse(selection.spawnEngine)
    }

    /// A CONFIGURED install is not second-guessed here: the spawn is the authority on whether the
    /// engine exists, because its answer comes from the syscall that would have started it and
    /// cannot go stale between a check and a launch. So a stale `.missing` may not take a window
    /// away from a mailbox that is open.
    func testAServingEngineIsNotOverriddenByAStaleInstallCheck() {
        let selection = SourceSelection.decide(
            configured: true, engine: .missing(lookedFor: "/nowhere/ohmail-engine"),
            status: .serving(mailboxID: "mbx-1"), flags: Self.live)
        XCTAssertEqual(selection.surface, .mail)
        XCTAssertEqual(selection.source, .engine)
    }

    /// The one door, and the flag is the whole of its lock.
    func testTheSampleWorldIsReachableOnlyFromTheFlag() {
        let demo = LaunchFlags(demo: true)
        for configured in [true, false] {
            let selection = SourceSelection.decide(configured: configured, engine: Self.hasEngine, status: nil, flags: demo)
            XCTAssertEqual(selection.surface, .demo)
            XCTAssertEqual(selection.source, .fixtures)
            // The invariant that makes the flag safe on a machine that HAS a mailbox: nothing is
            // running underneath it. One organizer per mailbox, and a window full of invented mail
            // is not allowed to be the one filing the real thing.
            XCTAssertFalse(selection.spawnEngine,
                           "the sample world started an engine — it would be organizing a real mailbox "
                           + "behind a window showing mail that is not in it")
        }
    }

    /// Serving is the only status that produces mail, and it produces the engine's.
    func testOnlyAServingEngineProducesMail() {
        for status in Self.everyStatus {
            let selection = SourceSelection.decide(configured: true, engine: Self.hasEngine, status: status, flags: Self.live)
            if case .serving = status {
                XCTAssertEqual(selection.surface, .mail)
                XCTAssertEqual(selection.source, .engine)
            } else {
                XCTAssertNil(selection.source,
                             "\(describe(status)) offered a mail source without a serving engine")
            }
        }
    }

    // MARK: - The sentences

    /// Each state that a person may have to ACT on gets its own line. A shared "something went
    /// wrong" would pass every assertion above and tell nobody anything.
    ///
    /// `starting` is not on this list and `nil` is not either: both mean the engine is coming up,
    /// which is not something to act on and not something worth two sentences.
    func testEveryActionableStatusSaysSomethingDifferent() {
        let actionable: [EngineStatus] = [
            .absent(lookedFor: "/nowhere/ohmail-engine"),
            .notConfigured(missing: ["OHMAIL_IMAP_HOST"]),
            .restarting(attempt: 2, delay: 1, last: EngineExit(code: 1, served: false, ran: 0.2)),
            .stopped,
            .failed(reason: "the engine failed 4 starts in a row.", last: nil),
        ]
        var seen: [String: String] = [:]
        for status in actionable {
            guard case .engineState(let notice) = SourceSelection
                .decide(configured: true, engine: Self.hasEngine, status: status, flags: Self.live).surface else {
                return XCTFail("\(describe(status)) is not a named state at all")
            }
            let line = notice.title + " " + notice.detail
            XCTAssertFalse(notice.title.isEmpty, "\(describe(status)) has no title")
            XCTAssertFalse(notice.detail.isEmpty, "\(describe(status)) has no sentence")
            if let other = seen[line] {
                XCTFail("\(describe(status)) and \(other) say exactly the same thing: “\(line)”")
            }
            seen[line] = describe(status)
        }
        XCTAssertEqual(seen.count, actionable.count)
    }

    /// A restart that follows a run which SERVED says so, because it is a different event: the mail
    /// already fetched is still true, and the engine is coming back rather than failing to arrive.
    func testARestartAfterServingReadsDifferentlyFromOneBeforeIt() {
        func line(served: Bool) -> String {
            guard case .engineState(let notice) = SourceSelection.decide(
                configured: true, engine: Self.hasEngine,
                status: .restarting(attempt: 2, delay: 1,
                                    last: EngineExit(code: 1, served: served, ran: 1)),
                flags: Self.live).surface else { return "" }
            return notice.detail
        }
        XCTAssertNotEqual(line(served: true), line(served: false))
        XCTAssertFalse(line(served: true).isEmpty)
    }

    /// And the two transient ones agree on purpose, so that a launch does not narrate itself twice.
    func testTheFirstAttemptSaysWhatNotYetStartedSays() {
        let before = SourceSelection.decide(configured: true, engine: Self.hasEngine, status: nil, flags: Self.live)
        let first = SourceSelection.decide(configured: true, engine: Self.hasEngine, status: .starting(attempt: 1),
                                           flags: Self.live)
        XCTAssertEqual(before.surface, first.surface)
    }

    /// The two states that name a specific thing must actually name it. A sentence that said
    /// "configuration is incomplete" would send the reader looking for what.
    func testTheNamedStatesNameTheThing() {
        guard case .engineState(let absent) = SourceSelection.decide(
            configured: true, engine: Self.hasEngine, status: .absent(lookedFor: "/Applications/ohmail.app/ohmail-engine"),
            flags: Self.live).surface else { return XCTFail("absent is not a named state") }
        XCTAssertTrue(absent.detail.contains("/Applications/ohmail.app/ohmail-engine"),
                      "the missing engine's own path is the only actionable thing there is")
        XCTAssertTrue(absent.detail.contains(ENGINE_PATH_VAR),
                      "…and the variable that overrides where it is looked for")

        guard case .engineState(let missing) = SourceSelection.decide(
            configured: true, engine: Self.hasEngine, status: .notConfigured(missing: ["OHMAIL_IMAP_HOST", KEK_VAR]),
            flags: Self.live).surface else { return XCTFail("notConfigured is not a named state") }
        for name in ["OHMAIL_IMAP_HOST", KEK_VAR] {
            XCTAssertTrue(missing.detail.contains(name), "“\(name)” is named, not described")
        }
    }

    /// The supervisor's own reason travels verbatim. It knows which start failed and how many came
    /// before it; nothing here does.
    func testAFailedEngineShowsTheSupervisorsSentence() {
        let reason = "the engine failed 4 starts in a row, so the shell stopped restarting it. Quit "
            + "ohmail and open it again once the cause is fixed — if another copy of ohmail is "
            + "already running, that is the cause."
        guard case .engineState(let notice) = SourceSelection.decide(
            configured: true, engine: Self.hasEngine, status: .failed(reason: reason, last: nil), flags: Self.live).surface
        else { return XCTFail("failed is not a named state") }
        XCTAssertEqual(notice.detail, reason)
    }

    // MARK: - The flags

    func testRenderChecksImplyTheSampleWorld() {
        XCTAssertTrue(LaunchFlags.parse(["OhMail", "--demo"]).demo)
        XCTAssertTrue(LaunchFlags.parse(["OhMail", "--smoke"]).demo,
                      "the render check needs a world that is the same on every machine")
        XCTAssertTrue(LaunchFlags.parse(["OhMail", "--shot", "./shots"]).demo)
        XCTAssertFalse(LaunchFlags.parse(["OhMail"]).demo,
                       "a plain launch must never be the sample world")
        XCTAssertTrue(LaunchFlags.isRenderCheck(["OhMail", "--smoke"]))
        XCTAssertFalse(LaunchFlags.isRenderCheck(["OhMail", "--demo"]),
                       "`--demo` is a launch somebody watches; the render checks are not")
    }

    // MARK: - The mailbox on the engine's own variable names

    /// The five names, against the contract the engine actually reads. Copied from the engine's own
    /// configuration reader rather than from this app's idea of it: the failure this guards is a
    /// rename on one side, and a test written from the same source as the code catches none of them.
    func testTheStoredMailboxMapsOntoTheEnginesVariables() {
        let config = EngineConfig(host: "imap.example.org", port: 1143, user: "login",
                                  address: "someone@example.org", tls: false)
        let overlay = Dictionary(uniqueKeysWithValues:
            EngineEnvironment.overlay(for: config).map { ($0.name, $0.value) })

        XCTAssertEqual(overlay["OHMAIL_IMAP_HOST"], "imap.example.org")
        XCTAssertEqual(overlay["OHMAIL_IMAP_PORT"], "1143")
        XCTAssertEqual(overlay["OHMAIL_IMAP_USER"], "login")
        XCTAssertEqual(overlay["OHMAIL_MAILBOX_ADDRESS"], "someone@example.org")
        // The engine reads this as "anything that is not the string 0", so the false case is the
        // one that has to be spelled exactly — an empty value would mean secure.
        XCTAssertEqual(overlay["OHMAIL_IMAP_SECURE"], "0")
        XCTAssertEqual(overlay.count, 5, "the overlay grew a variable this test does not know about")

        let secure = Dictionary(uniqueKeysWithValues: EngineEnvironment
            .overlay(for: EngineConfig(host: "h", user: "u", address: "a"))
            .map { ($0.name, $0.value) })
        XCTAssertEqual(secure["OHMAIL_IMAP_SECURE"], "1")
        XCTAssertEqual(secure["OHMAIL_IMAP_PORT"], "993", "993 is the default the engine assumes")
    }

    /// **The stored mailbox may not set the three things it must never set.**
    ///
    /// `config.json` is a plaintext file. One that could set the data directory could point the
    /// mirror somewhere else; one that could set the key would replace the key every stored
    /// credential is sealed under; and one that could set a password would put it in the child's
    /// environment, which is the exact property sealing it into the engine's store removed.
    func testTheOverlayCannotCarryTheKeyTheDataDirectoryOrAPassword() {
        let hostile: [(name: String, value: String)] = [
            (KEK_VAR, "00"), (DATA_DIR_VAR, "/tmp/elsewhere"), ("OHMAIL_IMAP_PASS", "hunter2"),
            ("OHMAIL_IMAP_HOST", "imap.example.org"),
        ]
        let allowed = EngineBridge.admissible(hostile).map(\.name)
        XCTAssertEqual(allowed, ["OHMAIL_IMAP_HOST"])

        let plan = EnginePlan.spawn(EngineLaunch(
            program: URL(fileURLWithPath: "/bin/echo"),
            environment: [(DATA_DIR_VAR, "/real/dir"), (KEK_VAR, "abc")]))
        guard case .spawn(let launch) = EngineBridge.carrying(hostile, in: plan) else {
            return XCTFail("the plan stopped being a spawn")
        }
        let composed = Dictionary(launch.environment.map { ($0.name, $0.value) }) { _, b in b }
        XCTAssertEqual(composed[DATA_DIR_VAR], "/real/dir", "the shell's data directory stood")
        XCTAssertEqual(composed[KEK_VAR], "abc", "the keystore's key stood")
        XCTAssertNil(composed["OHMAIL_IMAP_PASS"], "a password reached the child's environment")
        XCTAssertEqual(composed["OHMAIL_IMAP_HOST"], "imap.example.org")
    }

    private func describe(_ status: EngineStatus?) -> String {
        status.map { "\($0)" } ?? "nil (not started)"
    }
}
