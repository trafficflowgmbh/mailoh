import XCTest
import SwiftUI
@testable import OhMailKit
import OhMailEngine

/// THE COMPOSITION ROOT, DRIVEN THE WAY A LAUNCH DRIVES IT.
///
/// `SourceSelectionTests` proves the decision. This proves the object that acts on it: that a
/// configured launch builds no sample world, that setup is a sequence rather than a state, and that
/// the one answer from the engine that looks like a wrong password is not reported as one.
@MainActor
final class AppRootTests: XCTestCase {

    private struct NoKeys: KeyProvider {
        func kek() throws -> String? { nil }
    }

    private var dir: URL!
    private var store: EngineConfigStore!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ohmail-root-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = EngineConfigStore(directory: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// - Parameter install: stated rather than looked up, and there is no default for it here for
    ///   the same reason there is none on `decide`. Left to look, this would answer a question about
    ///   the **test runner's** own directory — which has no `ohmail-engine` beside it — so every
    ///   setup-sequence test below would silently become a test of the no-engine panel and would
    ///   still be green.
    private func model(demo: Bool = false,
                       install: EngineInstall = .installed,
                       engineSource: @escaping AppRootModel.EngineSourceFactory = { _ in nil },
                       // A stub that never touches the network. The shipped default is the REAL
                       // `CloudSignIn()`, which would dial `api.ohmail.app`; every test drives door two
                       // through an injected outcome instead.
                       cloudSignIn: CloudSignInService = StubCloudSignIn(outcome: .unavailable("no network in tests")),
                       // Unknown by default, so no test raises the FileVault nudge unless it asks to —
                       // and never shells out to `fdesetup` on the machine running the suite.
                       fileVault: FileVaultProbe = StubFileVault(result: .unknown))
        -> AppRootModel {
        AppRootModel(flags: LaunchFlags(demo: demo), store: store,
                     // Empty, which is what a bundle opened from the Finder inherits. The stored
                     // mailbox is the only thing that can make a launch startable, which is the
                     // point of the composition.
                     environment: [:], keys: NoKeys(), install: install, engineSource: engineSource,
                     cloudSignIn: cloudSignIn, fileVault: fileVault)
    }

    /// A cloud sign-in that answers a preset outcome without a socket.
    private struct StubCloudSignIn: CloudSignInService {
        let outcome: CloudSignInOutcome
        func signIn(email: String, password: String, code: String) async -> CloudSignInOutcome { outcome }
    }

    /// A FileVault probe that answers a preset status without running `fdesetup`.
    private struct StubFileVault: FileVaultProbe {
        let result: FileVaultStatus
        func status() async -> FileVaultStatus { result }
    }

    /// A throwaway hosted transport for a `.connected` outcome. Constructing it dials nothing; the
    /// session's jar carries the tokens the shell lifts into the cloud sidecar's environment.
    private func stubCloudRequester(session: String = "sess-abc", refresh: String = "ref-xyz") -> CloudRequester {
        let urlSession = makeCloudURLSession()
        let jar = urlSession.configuration.httpCookieStorage
        jar?.setCookie(HTTPCookie(properties: [
            .domain: "api.ohmail.app", .path: "/", .name: "tf_session", .value: session])!)
        jar?.setCookie(HTTPCookie(properties: [
            .domain: "api.ohmail.app", .path: "/auth/refresh", .name: "tf_refresh", .value: refresh])!)
        return CloudRequester(urlSession: urlSession)
    }

    private static let mailbox = EngineConfig(host: "imap.example.org", port: 993,
                                              user: "someone@example.org",
                                              address: "someone@example.org", tls: true)

    // MARK: - The audit

    /// **A CONFIGURED LAUNCH NEVER CONSTRUCTS `FixtureSource`.**
    ///
    /// The mutation this is written against is the one nobody writes on purpose. In
    /// `AppRootModel.materialize()`, change the `.engine` branch so that a missing projection falls
    /// back —
    ///
    ///     case .engine:
    ///         guard let source = makeEngineSource(engine) else {
    ///             mail = AppState(source: FixtureSource())   // ← the fallback
    ///             break
    ///         }
    ///
    /// — which is exactly the shape somebody reaches for when the window is blank and the sample
    /// world is right there. This test goes red on it. The green run below is not the evidence; the
    /// red one under that edit is.
    func testAConfiguredLaunchConstructsNoSampleWorld() throws {
        try store.save(Self.mailbox)
        let root = model()

        XCTAssertTrue(root.configured)
        XCTAssertNotEqual(root.selection.source, .fixtures)
        XCTAssertNil(root.mail, "a configured launch built a mail source with no projection behind it")

        // And it stays that way once the engine has been asked for and has said nothing good.
        root.begin()
        root.materialize()
        XCTAssertNil(root.mail)
        XCTAssertNoFixtureMail(root)

        // The window says so rather than showing nothing.
        guard case .engineState(let notice) = root.surface else {
            return XCTFail("a configured launch with no projection produced \(root.surface)")
        }
        XCTAssertFalse(notice.detail.isEmpty)
        root.end()
    }

    /// The same audit one level down, at the surface the projection lands behind: a serving engine whose
    /// source exists produces THAT source's mail, and the sample world is still not built.
    func testAServingEngineProducesItsOwnMailAndNotTheSampleWorld() throws {
        try store.save(Self.mailbox)
        let empty = EmptySource()
        let root = model(engineSource: { _ in empty })

        // The projection is present, so `materialize` has something to build with — but the engine
        // is not serving, so it must not build it yet.
        XCTAssertNil(root.mail, "mail was built before the engine served")
        XCTAssertNoFixtureMail(root)
        root.end()
    }

    // MARK: - The audit, against an engine that is ACTUALLY SERVING

    /// **THE MUTATION TEST, and the reason the one above is not enough.**
    ///
    /// `materialize()` returns early unless the decision names a source, and the decision names one
    /// only for a serving engine. So a fallback planted in its `.engine` branch is *unreachable*
    /// from a model whose engine never started — which means the audit above passes on the mutated
    /// code, and passing there proves nothing about the branch that matters.
    ///
    /// This drives a real engine all the way to `ready` with no projection behind it, which is the
    /// exact condition somebody would reach for the sample world to fill. Plant the fallback —
    ///
    ///     guard let source = makeEngineSource(engine) else {
    ///         mail = AppState(source: FixtureSource()); mailKind = .engine; return
    ///     }
    ///
    /// — and this goes red. It is the only test in the suite that does.
    func testAServingEngineWithNoProjectionShowsNothingRatherThanSamples() async throws {
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: Self.node),
                          "node is not installed; the stand-in engine is written in it, as the real one is")
        try store.save(Self.mailbox)
        let engine = try writeServingEngine()

        let root = AppRootModel(flags: LaunchFlags(demo: false), store: store,
                                environment: [ENGINE_PATH_VAR: engine.path],
                                keys: HasKey(), engineSource: { _ in nil })
        defer { root.end() }
        root.begin()
        try await waitForServing(root)

        // The decision has named a source, so `materialize` reaches the branch under test.
        XCTAssertEqual(root.selection.source, .engine)
        root.materialize()

        XCTAssertNil(root.mail,
                     "a serving engine with no projection behind it built a world anyway — the only "
                     + "source this app can build without one is the sample world")
        XCTAssertNoFixtureMail(root)
        guard case .engineState(let notice) = root.surface else {
            return XCTFail("the window shows \(root.surface) with no mail behind it")
        }
        XCTAssertEqual(notice, AppRootModel.noProjection)
    }

    /// The other half, so the test above cannot be satisfied by a model that never builds anything:
    /// hand the same serving engine a projection and the mail is ITS mail.
    func testAServingEngineWithAProjectionBuildsThatProjection() async throws {
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: Self.node),
                          "node is not installed; the stand-in engine is written in it, as the real one is")
        try store.save(Self.mailbox)
        let engine = try writeServingEngine()

        let root = AppRootModel(flags: LaunchFlags(demo: false), store: store,
                                environment: [ENGINE_PATH_VAR: engine.path],
                                keys: HasKey(), engineSource: { _ in EmptySource() })
        defer { root.end() }
        root.begin()
        try await waitForServing(root)
        root.materialize()

        XCTAssertNotNil(root.mail, "a serving engine with a projection behind it built nothing")
        XCTAssertEqual(root.surface, .mail)
        XCTAssertNoFixtureMail(root)
        XCTAssertEqual(root.mail?.ohbox.count, 0, "the world is the projection's, and it is empty")
    }

    // MARK: - A stand-in that actually serves

    private static let node = "/opt/homebrew/bin/node"

    private struct HasKey: KeyProvider {
        func kek() throws -> String? { String(repeating: "ab", count: 32) }
    }

    /// An engine that announces itself and then leaves when its stdin ends — the two halves of the
    /// contract this shell depends on. `serving` is reached by reading that frame and never by
    /// observing that the spawn worked, so a stand-in that merely stayed alive would not get there.
    private func writeServingEngine() throws -> URL {
        let script = dir.appendingPathComponent("ohmail-engine")
        try """
        #!\(Self.node)
        const h = Buffer.from(JSON.stringify({
          v: 1, t: "ready", baseUrl: "http://sidecar", sessionToken: "tok_" + "a".repeat(24),
          accountId: "acc-1", userId: "usr-1", mailboxId: "mbx-1",
        }), "utf8");
        const pre = Buffer.alloc(8);
        pre.writeUInt32BE(h.length, 0);
        pre.writeUInt32BE(0, 4);
        process.stdout.write(Buffer.concat([pre, h]));
        process.stdin.on("end", () => process.exit(0));
        process.stdin.resume();

        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return script
    }

    private func waitForServing(_ root: AppRootModel) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if case .serving = root.engine.status { return }
            // Yields the actor, which is what lets the supervisor's status hops land.
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("the stand-in engine never announced itself; status is \(String(describing: root.engine.status))")
    }

    /// `--demo` builds the sample world, says what it is, and starts nothing.
    func testTheSampleWorldIsBuiltOnlyForTheFlagAndRunsNoEngine() throws {
        let root = model(demo: true)
        XCTAssertEqual(root.surface, .demo)
        let mail = try XCTUnwrap(root.mail, "`--demo` built no world at all")
        XCTAssertGreaterThan(mail.ohbox.count, 0, "the sample world is empty")

        XCTAssertFalse(root.selection.spawnEngine)
        root.begin()
        XCTAssertNil(root.engine.status,
                     "`--demo` started an engine — it would be organizing a real mailbox behind a "
                     + "window showing mail that is not in it")

        // It is not silent about itself. The strip above the deck is the only thing on screen that
        // distinguishes the preview from an app that is working.
        XCTAssertFalse(AppRootModel.demoNotice.title.isEmpty)
        XCTAssertFalse(AppRootModel.demoNotice.detail.isEmpty)
    }

    /// A real account gets none of the demo persona's narrative. `AppState`'s default chrome is the
    /// sample one, so an engine-backed state built without saying otherwise would put a stranger's
    /// half-written message into somebody's compose window.
    func testARealAccountInheritsNoneOfThePreviewsNarrative() {
        let sample = AppState()
        let real = AppState(source: EmptySource(), chrome: AppRootModel.noChrome)
        XCTAssertFalse(sample.composeDraft.isEmpty, "the sample chrome is the thing being avoided")
        for (name, value) in [("composeDraft", real.composeDraft),
                              ("composeTo", real.composeTo),
                              ("composeSubject", real.composeSubject),
                              ("initialSearchQuery", real.initialSearchQuery),
                              ("learnedSuggestionSubject", real.learnedSuggestionSubject)] {
            XCTAssertTrue(value.isEmpty, "a real account inherited the preview's \(name): “\(value)”")
        }
    }

    // MARK: - The two doors

    /// A fresh install opens on the chooser, not the form. The mailbox comes AFTER a door and a
    /// provider, so the first thing on screen is the one decision that outranks all of them.
    func testAFreshInstallOpensOnTheChooser() {
        let root = model()
        XCTAssertEqual(root.surface, .setup)
        XCTAssertEqual(root.setupStep, .chooseDoor)
        XCTAssertNil(root.door, "nothing has been chosen yet")
        root.end()
    }

    /// Door one is the local engine: pick it, pick a provider, and the form opens PREFILLED — server,
    /// port, TLS and the send server all from the preset — with only the login left to type.
    func testDoorOneLeadsThroughTheProviderPickerToThePrefilledForm() {
        let root = model()
        root.chooseDoor(.local)
        XCTAssertEqual(root.door, .local)
        XCTAssertEqual(root.setupStep, .pickProvider)

        root.chooseProvider(.gmail)
        XCTAssertEqual(root.chosenProvider, .gmail)
        guard case .mailbox(let prefill) = root.setupStep, let prefill else {
            return XCTFail("choosing Gmail did not prefill the form")
        }
        XCTAssertEqual(prefill.host, "imap.gmail.com")
        XCTAssertEqual(prefill.port, 993)
        XCTAssertTrue(prefill.tls)
        XCTAssertEqual(prefill.smtpHost, "smtp.gmail.com")
        XCTAssertEqual(prefill.smtpPort, 465)
        XCTAssertEqual(prefill.smtpSecure, true)
        XCTAssertEqual(prefill.user, "", "the login is the one thing the person still supplies")
        root.end()
    }

    /// A completed door-one mailbox carries the preset's send server all the way into the sealed
    /// config AND the engine's environment — one credential, IMAP and SMTP on the same login.
    func testAPresetSendServerReachesTheStoredConfigAndTheEngineEnvironment() throws {
        let root = model()
        root.chooseDoor(.local)
        root.chooseProvider(.fastmail)
        // The form fills in the login and emits the config; the preset's SMTP rides through unchanged.
        var completed = MailProvider.fastmail.preset!.draft()
        completed.user = "someone@fastmail.com"
        completed.address = "someone@fastmail.com"
        root.saveMailbox(completed)
        root.end()

        let stored = try XCTUnwrap(try store.load())
        XCTAssertEqual(stored.smtpHost, "smtp.fastmail.com")
        XCTAssertEqual(stored.smtpSecure, true)

        let env = Dictionary(uniqueKeysWithValues:
            EngineEnvironment.overlay(for: stored).map { ($0.name, $0.value) })
        XCTAssertEqual(env["OHMAIL_SMTP_HOST"], "smtp.fastmail.com")
        XCTAssertEqual(env["OHMAIL_SMTP_PORT"], "465")
        XCTAssertEqual(env["OHMAIL_SMTP_SECURE"], "1")
        // The send login is never a second secret: nothing in the environment carries an SMTP password.
        XCTAssertNil(env["OHMAIL_SMTP_PASS"])
        XCTAssertNil(env["OHMAIL_SMTP_USER"])
    }

    /// Outlook is present and refused: choosing it advances nothing, because the build cannot open it.
    func testOutlookIsRefusedAndNeverAdvances() {
        let root = model()
        root.chooseDoor(.local)
        root.chooseProvider(.outlook)
        XCTAssertNil(root.chosenProvider, "a refused provider was accepted")
        XCTAssertEqual(root.setupStep, .pickProvider, "Outlook opened a form the build cannot use")
        XCTAssertNotNil(MailProvider.outlook.refusal, "the refused tile has no line to show")
        root.end()
    }

    /// Door two leads to a sign-in, not a stated limit, and it is not a dead end: the person can step
    /// back out to the chooser.
    func testDoorTwoLeadsToCloudSignInAndIsNotADeadEnd() {
        let root = model()
        root.chooseDoor(.cloud)
        XCTAssertEqual(root.door, .cloud)
        XCTAssertEqual(root.setupStep, .cloudSignIn(problem: nil))
        // A cloud door never spawns the engine — not even to draw its sign-in form.
        XCTAssertFalse(root.selection.spawnEngine, "the cloud door spawned the engine")
        XCTAssertNotEqual(root.selection.source, .fixtures)

        root.reconsiderDoor()
        XCTAssertNil(root.door, "the door was not released")
        XCTAssertEqual(root.setupStep, .chooseDoor)
        root.end()
    }

    /// **A CLOUD SIGN-IN SPAWNS THE CLOUD SIDECAR.**
    ///
    /// The rewire (this slice): the cloud door now runs the sidecar in cloud mode behind the same pipe
    /// as door one, so a signed-in cloud install spawns the engine and reads `.engine`. Enforcement of
    /// the one-organizer invariant moved into the sidecar, so this is safe. `begin()` is called first to
    /// prove it does NOT start anything for the cloud door — the start belongs to sign-in. With no
    /// durable key the spawn lands on `.notConfigured`, which is enough to see that a start happened and
    /// that the door routes to `.engine`; the serving path is the integration test below.
    func testACloudSignInSpawnsTheCloudEngine() async {
        let root = model(cloudSignIn: StubCloudSignIn(outcome: .connected(stubCloudRequester())))
        root.chooseDoor(.cloud)
        root.begin()
        XCTAssertNil(root.engine.status, "the cloud door started the engine before sign-in")

        await root.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "123456")

        XCTAssertTrue(root.cloudSignedIn, "the session was not established")
        XCTAssertNotNil(root.engine.status, "the cloud sign-in did not start the sidecar")
        XCTAssertTrue(root.selection.spawnEngine, "the signed-in cloud door does not spawn")
        XCTAssertNotEqual(root.selection.source, .fixtures)
        XCTAssertNoFixtureMail(root)
        root.end()
    }

    /// **THE CLOUD DOOR, ALL THE WAY TO SERVING, READS THE ENGINE LIKE DOOR ONE.** A stand-in engine
    /// announces itself; the signed-in cloud install then names `.engine`, draws `.mail`, and builds no
    /// sample world — the same harness `testAServingEngineWithAProjectionBuildsThatProjection` uses, on
    /// the cloud door.
    func testACloudSignInSpawnsAServingSidecarAndReadsItLikeDoorOne() async throws {
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: Self.node),
                          "node is not installed; the stand-in engine is written in it, as the real one is")
        let engine = try writeServingEngine()
        let root = AppRootModel(
            flags: LaunchFlags(demo: false), store: store,
            environment: [ENGINE_PATH_VAR: engine.path], keys: HasKey(),
            engineSource: { _ in EmptySource() },
            cloudSignIn: StubCloudSignIn(outcome: .connected(stubCloudRequester())))
        defer { root.end() }
        root.chooseDoor(.cloud)
        await root.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "123456")
        try await waitForServing(root)

        XCTAssertEqual(root.selection.source, .engine, "the signed-in cloud door did not read the engine")
        XCTAssertTrue(root.selection.spawnEngine)
        root.materialize()
        XCTAssertNotNil(root.mail, "a serving cloud sidecar built no world")
        XCTAssertEqual(root.surface, .mail)
        XCTAssertNoFixtureMail(root)
    }

    /// A rejection — a wrong password or code — is shown beside the fields, the window builds nothing,
    /// never falls back to the sample world, and starts NO engine (the sidecar is spawned on success
    /// only).
    func testACloudRejectionShowsAProblemNotTheSampleWorld() async {
        let root = model(cloudSignIn: StubCloudSignIn(outcome: .rejected("That code wasn't accepted.")))
        root.chooseDoor(.cloud)
        await root.submitCloudSignIn(email: "a@b.c", password: "pw", code: "000000")

        XCTAssertFalse(root.cloudSignedIn, "a rejected sign-in established a session")
        XCTAssertNil(root.engine.status, "a rejected sign-in started the sidecar")
        XCTAssertNil(root.mail, "a rejected sign-in built a world")
        XCTAssertNoFixtureMail(root)
        XCTAssertEqual(root.setupStep, .cloudSignIn(problem: "That code wasn't accepted."))
        XCTAssertEqual(root.surface, .setup, "a rejection took the person off the sign-in form")
        root.end()
    }

    /// An unreachable host is a NAMED degraded panel, not the sample world and not a wrong-password
    /// message: nothing the person typed was wrong, and no engine was started.
    func testACloudUnavailableHostIsNamedNotTheSampleWorld() async {
        let root = model(cloudSignIn: StubCloudSignIn(outcome: .unavailable("Couldn't reach ohmail Cloud.")))
        root.chooseDoor(.cloud)
        await root.submitCloudSignIn(email: "a@b.c", password: "pw", code: "123456")

        XCTAssertFalse(root.cloudSignedIn)
        XCTAssertNil(root.engine.status, "an unreachable host started the sidecar")
        XCTAssertNil(root.mail)
        XCTAssertNoFixtureMail(root)
        guard case .failed(let notice) = root.setupStep else {
            return XCTFail("an unreachable host produced \(root.setupStep), not a named failure")
        }
        XCTAssertTrue(notice.detail.contains("Couldn't reach"))
        root.end()
    }

    /// **THE CLOUD OVERLAY CARRIES THE MODE, THE API, THE ADDRESS, AND THE JAR'S TOKENS — AND NO IMAP.**
    ///
    /// This is the environment the sidecar is spawned with. `tf_session` and `tf_refresh` are lifted
    /// from the sign-in jar (the path-scoped refresh cookie included), and the presence of any
    /// `OHMAIL_IMAP_*` here would make the sidecar refuse to start — so there is none.
    func testTheCloudOverlayCarriesTheModeUrlAddressAndTokensFromTheJar() {
        let overlay = Dictionary(uniqueKeysWithValues: AppRootModel
            .cloudOverlay(address: "me@ohmail.app", requester: stubCloudRequester(session: "sess-1", refresh: "ref-1"))
            .map { ($0.name, $0.value) })
        XCTAssertEqual(overlay["OHMAIL_MODE"], "cloud")
        XCTAssertEqual(overlay["OHMAIL_CLOUD_URL"], "https://api.ohmail.app")
        XCTAssertEqual(overlay["OHMAIL_MAILBOX_ADDRESS"], "me@ohmail.app")
        XCTAssertEqual(overlay["OHMAIL_CLOUD_ACCESS_TOKEN"], "sess-1", "the access token was not lifted from tf_session")
        XCTAssertEqual(overlay["OHMAIL_CLOUD_REFRESH_TOKEN"], "ref-1",
                       "the path-scoped tf_refresh cookie was not found")
        for name in overlay.keys {
            XCTAssertFalse(name.hasPrefix("OHMAIL_IMAP_"), "the cloud overlay carried an IMAP variable: \(name)")
        }
    }

    /// **LOCAL NEVER CONSTRUCTS THE CLOUD REQUESTER.** The other half of the per-mode privacy
    /// invariant (GOALS #5): a full door-one launch holds no hosted transport.
    func testALocalInstallNeverConstructsTheCloudRequester() throws {
        try store.save(Self.mailbox)
        let root = model()
        root.chooseDoor(.local)
        XCTAssertFalse(root.cloudSignedIn, "a local install has a cloud session")
        XCTAssertNil(root.cloudRequester, "a local install constructed a cloud requester")
        root.end()
    }

    // MARK: - Offline read-only chrome (the cloud mirror's reachability)

    /// **THE OFFLINE READ-ONLY LINE APPEARS ONLY ONCE `/health` SAYS THE MIRROR IS OFFLINE**, and it is
    /// a cloud-only affordance. Online — or before the first poll — the mail surface shows the engine's
    /// own notice, not the offline one.
    func testTheCloudOfflineNoticeTracksHealth() async {
        let root = model()
        root.chooseDoor(.cloud)
        XCTAssertNil(root.cloudOnline, "reachability is unknown before the first poll")
        XCTAssertNil(root.mailNotice, "the offline line showed before anything said the mirror was offline")

        await root.refreshCloudOnline(using: HealthRequester(online: true))
        XCTAssertEqual(root.cloudOnline, true)
        XCTAssertNil(root.mailNotice, "an online cloud mirror showed the read-only chrome")

        await root.refreshCloudOnline(using: HealthRequester(online: false))
        XCTAssertEqual(root.cloudOnline, false)
        XCTAssertEqual(root.mailNotice, AppRootModel.offlineNotice, "an offline mirror did not show the read-only line")
        root.end()
    }

    /// The health parse only flips the chrome on a readable 2xx `online` flag; a non-2xx or junk body
    /// leaves the last value standing rather than blinking the state on a transient miss.
    func testParseOnlineReadsTheHealthFlagAndIgnoresJunk() {
        XCTAssertEqual(AppRootModel.parseOnline(status: 200, body: Data(#"{"online":true}"#.utf8)), true)
        XCTAssertEqual(AppRootModel.parseOnline(status: 200, body: Data(#"{"online":false}"#.utf8)), false)
        XCTAssertNil(AppRootModel.parseOnline(status: 503, body: Data(#"{"online":true}"#.utf8)),
                     "a non-2xx must not flip the chrome")
        XCTAssertNil(AppRootModel.parseOnline(status: 200, body: Data("not json".utf8)))
        XCTAssertNil(AppRootModel.parseOnline(status: 200, body: Data("{}".utf8)))
    }

    /// **THE CLIENT-SIDE GATE: WRITES ARE REFUSED WHILE OFFLINE AND FORWARDED WHEN ONLINE.** Reads pass
    /// through in both states. The gate reads its offline flag live, so it opens again the moment the
    /// mirror is back — the sidecar's 503 stays the backstop this only sits in front of.
    func testTheOfflineGateRefusesWritesWhenOfflineAndForwardsWhenOnline() {
        let inner = RecordingSource()
        var offline = false
        let gate = OfflineGate(inner, isOffline: { offline })

        _ = gate.apply(.markSeen(message: "m1"))
        XCTAssertEqual(inner.applied, ["m1"], "an online write was not forwarded")

        offline = true
        guard case .refused(let failure) = gate.apply(.markSeen(message: "m2")) else {
            return XCTFail("an offline write was not refused")
        }
        XCTAssertEqual(failure.kind, .network)
        XCTAssertEqual(inner.applied, ["m1"], "an offline write reached the source")

        offline = false
        _ = gate.apply(.markSeen(message: "m3"))
        XCTAssertEqual(inner.applied, ["m1", "m3"], "the gate did not reopen when the mirror came back")
    }

    // MARK: - The FileVault nudge (first Cloud sign-in, plaintext mirror)

    /// **A CLOUD SIGN-IN ON A MAC WITH FILEVAULT OFF RAISES THE NUDGE.** The mirror lands in plaintext,
    /// so a disk that is not encrypted at rest is the one case worth a word.
    func testACloudSignInNudgesWhenFileVaultIsOff() async {
        let root = model(cloudSignIn: StubCloudSignIn(outcome: .connected(stubCloudRequester())),
                         fileVault: StubFileVault(result: .off))
        root.chooseDoor(.cloud)
        await root.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "123456")
        XCTAssertTrue(root.showFileVaultNudge, "FileVault was off and the nudge did not appear")
        root.end()
    }

    /// FileVault on — nothing to say, no nudge. And an `unknown` answer is treated the same: a prompt
    /// on a status that could not be read is worse than none.
    func testACloudSignInDoesNotNudgeWhenFileVaultIsOnOrUnknown() async {
        for status in [FileVaultStatus.on, .unknown] {
            let root = model(cloudSignIn: StubCloudSignIn(outcome: .connected(stubCloudRequester())),
                             fileVault: StubFileVault(result: status))
            root.chooseDoor(.cloud)
            await root.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "123456")
            XCTAssertFalse(root.showFileVaultNudge, "FileVault \(status) raised the nudge")
            root.end()
        }
    }

    /// A FAILED sign-in never nudges — the prompt belongs to a session that was actually established.
    func testAFailedCloudSignInDoesNotNudge() async {
        let root = model(cloudSignIn: StubCloudSignIn(outcome: .rejected("nope")),
                         fileVault: StubFileVault(result: .off))
        root.chooseDoor(.cloud)
        await root.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "000000")
        XCTAssertFalse(root.showFileVaultNudge, "a rejected sign-in raised the FileVault nudge")
        root.end()
    }

    /// **THE DISMISSAL IS REMEMBERED ACROSS LAUNCHES.** Dismissed once, a later launch's sign-in — same
    /// disk, still FileVault-off — does not raise it again. The two models read the same store.
    func testADismissedFileVaultNudgeStaysDismissed() async {
        let first = model(cloudSignIn: StubCloudSignIn(outcome: .connected(stubCloudRequester())),
                          fileVault: StubFileVault(result: .off))
        first.chooseDoor(.cloud)
        await first.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "123456")
        XCTAssertTrue(first.showFileVaultNudge)
        first.dismissFileVaultNudge()
        XCTAssertFalse(first.showFileVaultNudge, "dismissing did not close the nudge")
        first.end()

        let relaunch = model(cloudSignIn: StubCloudSignIn(outcome: .connected(stubCloudRequester())),
                             fileVault: StubFileVault(result: .off))
        relaunch.chooseDoor(.cloud)
        await relaunch.submitCloudSignIn(email: "me@ohmail.app", password: "pw", code: "123456")
        XCTAssertFalse(relaunch.showFileVaultNudge, "a dismissed nudge came back on the next launch")
        relaunch.end()
    }

    /// The chosen door is sticky per install: a later launch resumes at it rather than re-asking.
    /// Reconsidering clears it, so neither an unfinished door one nor door two is a trap.
    func testTheChosenDoorIsStickyAcrossLaunches() {
        model().chooseDoor(.local)
        // A second launch reading the SAME store.
        let relaunch = model()
        XCTAssertEqual(relaunch.door, .local, "the door was not remembered")
        XCTAssertEqual(relaunch.setupStep, .pickProvider,
                       "a remembered local door should resume at the provider picker, not the chooser")

        relaunch.reconsiderDoor()
        let afterReconsider = model()
        XCTAssertNil(afterReconsider.door, "reconsidering did not clear the stored door")
        XCTAssertEqual(afterReconsider.setupStep, .chooseDoor)
    }

    /// **The frame renders nothing for the sample world.** `--demo` is answered before the install is
    /// looked at, so a door is never chosen and never shown — structural, like the rest of the demo
    /// gate, not a check inside the frame.
    func testTheDemoWorldNeverReachesTheDoorFrame() {
        let root = model(demo: true)
        XCTAssertEqual(root.surface, .demo)
        XCTAssertNotEqual(root.surface, .setup, "the sample world reached the onboarding frame")
        // And even asked to, it does not switch surfaces — the demo answer outranks the sequence.
        root.chooseDoor(.local)
        XCTAssertEqual(root.surface, .demo)
        root.end()
    }

    // MARK: - Setup is a sequence

    /// **A BUILD WITH NO ENGINE NEVER OPENS THE FORM.**
    ///
    /// The composition root's own half of the audit in `SourceSelectionTests`: not merely that the
    /// decision says so, but that the object which acts on it draws the panel, builds nothing, and
    /// starts nothing. `begin()` is called because the shape that would undo this is a launch that
    /// spawns anyway and lands on the same panel one status later — which is the original trap with
    /// a shorter fuse.
    func testAnInstallWithNoEngineSaysSoAndNeverOpensTheForm() {
        let root = model(install: .missing(lookedFor: "/Applications/ohmail.app/Contents/MacOS/ohmail-engine"))
        defer { root.end() }

        guard case .engineState(let notice) = root.surface else {
            return XCTFail("a build with no engine opened \(root.surface)")
        }
        XCTAssertTrue(notice.detail.contains("/Applications/ohmail.app/Contents/MacOS/ohmail-engine"))
        XCTAssertNil(root.mail, "a build with no engine built a world")

        root.begin()
        XCTAssertNil(root.engine.status, "a build with nothing to run started something")
        // And the form is not one keystroke away either: the sequence that leads to the password
        // field begins at `.mailbox`, and nothing on screen can reach it.
        XCTAssertNotEqual(root.surface, .setup)
    }

    /// The other half, so the test above cannot be satisfied by a model that never shows the form at
    /// all: the same install, with an engine, opens setup exactly as it did before.
    func testAnInstallWithAnEngineStillOpensTheForm() {
        let root = model(install: .installed)
        XCTAssertEqual(root.surface, .setup)
        root.end()
    }

    /// **AND THE SEQUENCE DOES NOT GET PAST IT EITHER.**
    ///
    /// `surface` answers `.setup` for `inSetup` *before* it consults the decision, so a guard that
    /// lived only in `decide` would leave the credential form reachable by anything that sets that
    /// flag. Today one method does, and `dismissSetupFailure` walks back into the form with the flag
    /// still standing — one edit from being a way in. This drives the sequence into the state and
    /// asserts the window still refuses.
    ///
    /// The mutation: restore `if inSetup { return .setup }` and this goes red naming the form.
    func testTheOnboardingSequenceCannotShowTheFormOnAnEnginelessBuild() {
        let root = model(install: .installed)
        root.saveMailbox(Self.mailbox)
        XCTAssertTrue(root.inSetup, "the sequence is not running, so this test proves nothing")
        XCTAssertEqual(root.surface, .setup)
        root.end()

        // The same object's state, on a build with nothing to run.
        let engineless = AppRootModel(
            flags: LaunchFlags(demo: false), store: store, environment: [:], keys: NoKeys(),
            install: .missing(lookedFor: "/Applications/ohmail.app/Contents/MacOS/ohmail-engine"))
        engineless.saveMailbox(Self.mailbox)
        XCTAssertTrue(engineless.inSetup)
        XCTAssertNotEqual(engineless.surface, .setup,
                          "the onboarding sequence put the password form in front of somebody on a "
                          + "build that cannot open a mailbox")
        engineless.end()
    }

    // MARK: - The branch a launch takes, which is the one nothing else exercises

    /// **THE DEFAULT IS TO GO AND LOOK, AND THIS IS THE ONLY TEST THAT LETS IT.**
    ///
    /// Every case above injects `install:`, which is correct for them and leaves the resolution that
    /// decides a stranger's first screen as the one branch nothing runs. So this passes no `install:`
    /// at all and steers the production path with `OHMAIL_ENGINE` — the same variable the spawn
    /// obeys — at a file this test writes and then removes.
    func testWithNoInstallGivenTheModelLooksAtTheEngineItWouldActuallyRun() throws {
        let engine = dir.appendingPathComponent("ohmail-engine")

        let nothingThere = AppRootModel(flags: LaunchFlags(demo: false), store: store,
                                        environment: [ENGINE_PATH_VAR: engine.path], keys: NoKeys())
        guard case .engineState(let notice) = nothingThere.surface else {
            return XCTFail("a launch that looked at an empty directory opened \(nothingThere.surface)")
        }
        XCTAssertTrue(notice.detail.contains(engine.path), notice.detail)
        nothingThere.end()

        try Data("#!/bin/sh\n".utf8).write(to: engine)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)

        let installed = AppRootModel(flags: LaunchFlags(demo: false), store: store,
                                     environment: [ENGINE_PATH_VAR: engine.path], keys: NoKeys())
        XCTAssertEqual(installed.surface, .setup,
                       "the same launch, with something runnable at the same path, must open setup")
        installed.end()
    }

    func testSetupCollectsTheMailboxBeforeTheEngineExistsAndThenWaits() {
        let root = model()
        XCTAssertEqual(root.surface, .setup)
        // The chooser is the first thing now, then — behind door one — the provider picker, then the
        // form. Walk to the form the generic way, which is today's blank one.
        XCTAssertEqual(root.setupStep, .chooseDoor)
        root.chooseDoor(.local)
        XCTAssertEqual(root.setupStep, .pickProvider)
        root.chooseProvider(.generic)
        guard case .mailbox(let prefill) = root.setupStep else {
            return XCTFail("door one did not lead to the mailbox form")
        }
        XCTAssertNil(prefill, "the generic path has no preset, so there is nothing to prefill")

        root.saveMailbox(Self.mailbox)
        XCTAssertTrue(root.configured, "the mailbox was not written down")
        XCTAssertEqual(try? store.load(), Self.mailbox)

        // **Still setup.** This is the whole claim of the test: `decide` alone has already stopped
        // saying `.setup` — the install is configured now — and the password has not been collected.
        // A composition root that deferred to the decision here would drop somebody out of setup
        // half-way through it, onto a panel about an engine they were in the middle of configuring.
        XCTAssertEqual(root.surface, .setup)
        XCTAssertNotEqual(root.selection.surface, .setup,
                          "the decision still says setup, so this test proves nothing")
        if case .mailbox = root.setupStep {
            XCTFail("setup went back to the form it had just accepted")
        }
        root.end()
    }

    /// With no key there is nowhere to seal a password, and setup says so instead of asking for one.
    /// Naming the variable is the deliverable: an install that collected a password it could not
    /// store would look like the product working right up until it did not.
    func testSetupRefusesToAskForAPasswordItCannotStore() {
        let root = model()                     // `NoKeys` — this install has no durable key
        root.saveMailbox(Self.mailbox)
        guard case .failed(let notice) = root.setupStep else {
            return XCTFail("setup reached \(root.setupStep) on an install with no key")
        }
        XCTAssertTrue(notice.detail.contains(KEK_VAR),
                      "the missing key is named, not described: “\(notice.detail)”")
        root.end()
    }

    /// **Nowhere in this flow does a password touch the disk.** The file has no field for one, and
    /// the audit is on the bytes rather than on the type.
    func testTheStoredMailboxCannotCarryAPassword() throws {
        let root = model()
        root.saveMailbox(Self.mailbox)
        root.end()

        let written = try String(contentsOf: dir.appendingPathComponent("config.json"), encoding: .utf8)
        XCTAssertTrue(written.contains("imap.example.org"), "the audit did not read the file")
        for word in ["pass", "password", "secret", "token"] {
            XCTAssertFalse(written.lowercased().contains(word),
                           "the stored mailbox spells “\(word)”: \(written)")
        }
    }

    // MARK: - The one answer that looks like a wrong password

    /// **`503` IS NOT A WRONG PASSWORD.**
    ///
    /// An install with no durable key refuses to encrypt rather than sealing a credential under a key
    /// that dies with the process. The password field's submit therefore fails on an install where
    /// the password was right, and reporting that as a refusal would send somebody to reset a working
    /// mailbox password — repeatedly, and it would never begin to work.
    func testAKeylessInstallIsNotReportedAsAWrongPassword() {
        let body = Data("""
        {"error":{"code":"install_key_absent","message":"this install has no durable key, so a \
        password cannot be stored on this machine."}}
        """.utf8)
        let verdict = AppRootModel.verdict(status: 503, body: body)
        guard case .couldNotFinish(let why) = verdict else {
            return XCTFail("a keyless install came back as \(verdict)")
        }
        XCTAssertTrue(why.contains("durable key"), "the engine's own reason was thrown away")
        XCTAssertFalse(AppRootModel.couldNotFinish(why).title.lowercased().contains("password"),
                       "the title blames the password: “\(AppRootModel.couldNotFinish(why).title)”")
    }

    /// And a password the mail server actually refused IS reported as one — otherwise the test above
    /// would pass on a shell that called everything a setup failure and never told anybody their
    /// password was wrong.
    func testAMailServerRefusalIsReportedAsOne() {
        let body = Data("""
        {"error":{"code":"mailbox_probe_failed","message":"the mail server rejected that login."}}
        """.utf8)
        guard case .refusedCredentials(let why) =
                AppRootModel.verdict(status: 401, body: body) else {
            return XCTFail("a refused login did not come back as one")
        }
        XCTAssertEqual(why, "the mail server rejected that login.")
    }

    func testAStoredCredentialIsAStoredCredential() {
        XCTAssertEqual(AppRootModel.verdict(status: 200, body: Data("{}".utf8)), .stored)
        XCTAssertEqual(AppRootModel.verdict(status: 204, body: Data()), .stored)
    }

    /// The request carries the password in its body and the session in its header — and the password
    /// appears nowhere else, including in the URL, where it would reach every log that records one.
    func testTheCredentialRequestPutsThePasswordInTheBodyAndNowhereElse() throws {
        let request = try AppRootModel.credentialRequest(
            mailboxID: "mbx-1", baseURL: "http://sidecar", token: Secret("tok_abc"),
            config: Self.mailbox, password: "correct horse")

        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/mailboxes/mbx-1")
        XCTAssertFalse(request.url?.absoluteString.contains("correct horse") ?? true)
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer tok_abc")
        for (_, value) in request.allHTTPHeaderFields ?? [:] {
            XCTAssertFalse(value.contains("correct horse"), "the password is in a header")
        }

        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let imap = try XCTUnwrap(json["imap"] as? [String: Any])
        XCTAssertEqual(imap["pass"] as? String, "correct horse")
        XCTAssertEqual(imap["host"] as? String, Self.mailbox.host)
        XCTAssertEqual(imap["user"] as? String, Self.mailbox.user)
        XCTAssertEqual(imap["secure"] as? Bool, true)
    }

    // MARK: - They actually draw

    /// The two new surfaces are rasterised and checked for ink, at both widths and in both schemes.
    ///
    /// **Asserting that a state is *reached* says nothing about whether it is *readable*.** The
    /// render checks walk `RootView`, which neither of these is under, so without this they would be
    /// the only two full-window surfaces in the app that nothing has ever drawn — and the failure
    /// mode there is a panel that lays out to nothing and shows a person an empty window at the exact
    /// moment they need a sentence.
    ///
    /// **The blank detector, and NOT the smoke walk's ink threshold.** `Smoke.minInkFraction` is
    /// calibrated against a full deck of mail, and these panels are four lines centred on an empty
    /// canvas — a correct render of one measures 0.0035 at 1440pt, under a floor that means
    /// "something drew nothing" for a view that fills the window. Applying it here would be using the
    /// wrong instrument and then adjusting the instrument, so the distinct-colour count does the work
    /// instead. `emptyDrawsNothing` below is what makes that a check rather than an assumption.
    func testTheStatesWithNoMailBehindThemActuallyDraw() {
        let width: [CGFloat] = [1440, 390]
        let schemes: [ColorScheme] = [.light, .dark]
        let panels: [(String, AnyView)] = [
            ("engine state", AnyView(EngineStateView(
                notice: AppRootModel.noProjection))),
            ("engine state with an action", AnyView(EngineStateView(
                notice: AppRootModel.couldNotFinish("The local engine stopped."),
                action: (label: "Back", run: {})))),
            ("setup · choose door", AnyView(setupView(step: .chooseDoor))),
            ("setup · cloud sign-in", AnyView(setupView(step: .cloudSignIn(problem: nil)))),
            ("setup · cloud sign-in rejected", AnyView(setupView(
                step: .cloudSignIn(problem: "That code wasn't accepted.")))),
            ("setup · pick provider", AnyView(setupView(step: .pickProvider))),
            ("setup · mailbox", AnyView(setupView(step: .mailbox(nil)))),
            ("setup · mailbox prefilled", AnyView(setupView(
                step: .mailbox(MailProvider.gmail.preset?.draft()), provider: .gmail))),
            ("setup · waiting", AnyView(setupView(step: .starting))),
            ("setup · password", AnyView(setupView(step: .password))),
            ("setup · password refused", AnyView(setupView(
                step: .password, problem: "The mail server rejected that login."))),
            ("setup · failed", AnyView(setupView(
                step: .failed(AppRootModel.couldNotFinish("This install has no durable key."))))),
            ("filevault nudge", AnyView(FileVaultNudge(onOpenSettings: {}, onDismiss: {}))),
        ]

        // The detector bites: a panel-sized canvas with nothing on it is rejected by the very
        // assertion the loop below relies on. Without this the loop could be passing on a bug in the
        // detector rather than on a view that drew.
        for w in width {
            let empty = draw(AnyView(Color.clear), width: w, scheme: .light)
            XCTAssertLessThan(empty?.distinctColors ?? .max, Smoke.minDistinctColors,
                              "the blank detector accepts an empty canvas at \(Int(w))pt — "
                              + "every assertion below is worthless")
        }

        for (name, panel) in panels {
            for w in width {
                for scheme in schemes {
                    let what = "\(name) · \(Int(w)) · \(scheme == .dark ? "dark" : "light")"
                    guard let stats = draw(panel, width: w, scheme: scheme) else {
                        return XCTFail("\(what) produced no bitmap")
                    }
                    XCTAssertGreaterThanOrEqual(stats.distinctColors, Smoke.minDistinctColors,
                                                "\(what) looks blank — only \(stats.distinctColors) "
                                                + "distinct sampled colours")
                    XCTAssertGreaterThan(stats.inkFraction, 0,
                                         "\(what) is a uniform field — nothing was written on it")
                }
            }
        }
    }

    /// - Note: `.blancTheme()` resolves the palette from the AMBIENT colour scheme inside its own
    ///   modifier body, so it has to sit **inside** the `.environment(\.colorScheme:)` that sets it.
    ///   With the two the other way round every render comes back in the light palette and a "both
    ///   schemes" walk quietly checks one of them twice.
    private func draw(_ view: AnyView, width: CGFloat, scheme: ColorScheme) -> Smoke.PixelStats? {
        let renderer = ImageRenderer(content: view
            .environment(\.compactLayout, width <= Space.mobileMax)
            .blancTheme()
            .frame(width: width, height: 900)
            .environment(\.colorScheme, scheme))
        renderer.scale = 1
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return Smoke.PixelStats(rep)
    }

    private func setupView(step: SetupStep, provider: MailProvider? = nil,
                           problem: String? = nil) -> some View {
        SetupView(step: step, provider: provider, problem: problem)
    }

    // MARK: -

    private func XCTAssertNoFixtureMail(_ root: AppRootModel,
                                        file: StaticString = #filePath, line: UInt = #line) {
        guard let mail = root.mail else { return }
        let sample = Set(AppState().allItems.map(\.id))
        let onScreen = Set(mail.allItems.map(\.id))
        XCTAssertTrue(onScreen.isDisjoint(with: sample),
                      "a configured launch is showing invented mail: "
                      + "\(onScreen.intersection(sample).sorted().prefix(3))",
                      file: file, line: line)
    }
}

/// A source with nothing in it. Stands in for the engine-backed projection, which is a separate
/// slice: what these tests need is a conformance that is not `FixtureSource`, not a mailbox.
@MainActor
private final class EmptySource: MailSource {
    private var world = MailWorld()
    func openingWorld() -> MailWorld { world }
    @discardableResult func start(sink: any MailSourceSink) -> SyncState { .idle(lastCompleted: nil) }
    func bodyState(for id: String, in place: Place) -> BodyState { .notFetched }
    func requestBody(for id: String, in place: Place) {}
    @discardableResult func apply(_ intent: MailIntent) -> IntentOutcome { .applied(IntentAck()) }
}

/// Records the mark-seen ids it is handed, so the offline gate's forwarding can be watched rather than
/// inferred.
@MainActor
private final class RecordingSource: MailSource {
    private(set) var applied: [String] = []
    func openingWorld() -> MailWorld { MailWorld() }
    @discardableResult func start(sink: any MailSourceSink) -> SyncState { .idle(lastCompleted: nil) }
    func bodyState(for id: String, in place: Place) -> BodyState { .notFetched }
    func requestBody(for id: String, in place: Place) {}
    @discardableResult func apply(_ intent: MailIntent) -> IntentOutcome {
        if case .markSeen(let id) = intent { applied.append(id) }
        return .applied(IntentAck())
    }
}

/// Answers `/health` with a canned reachability flag, for driving `refreshCloudOnline` without a
/// running engine.
private struct HealthRequester: EngineRequesting {
    let online: Bool
    func send(_ request: URLRequest) async throws -> (HTTPURLResponse, Data) {
        let body = Data("{\"online\":\(online)}".utf8)
        let http = HTTPURLResponse(url: request.url ?? URL(string: "http://sidecar")!,
                                   statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (http, body)
    }
}
