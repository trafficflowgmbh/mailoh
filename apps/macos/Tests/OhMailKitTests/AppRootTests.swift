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

    private func model(demo: Bool = false,
                       engineSource: @escaping AppRootModel.EngineSourceFactory = { _ in nil })
        -> AppRootModel {
        AppRootModel(flags: LaunchFlags(demo: demo), store: store,
                     // Empty, which is what a bundle opened from the Finder inherits. The stored
                     // mailbox is the only thing that can make a launch startable, which is the
                     // point of the composition.
                     environment: [:], keys: NoKeys(), engineSource: engineSource)
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

    // MARK: - Setup is a sequence

    func testSetupCollectsTheMailboxBeforeTheEngineExistsAndThenWaits() {
        let root = model()
        XCTAssertEqual(root.surface, .setup)
        guard case .mailbox(let prefill) = root.setupStep else {
            return XCTFail("setup did not open on the mailbox form")
        }
        XCTAssertNil(prefill, "nothing is stored yet, so there is nothing to prefill")

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
            ("setup · mailbox", AnyView(setupView(step: .mailbox(nil)))),
            ("setup · waiting", AnyView(setupView(step: .starting))),
            ("setup · password", AnyView(setupView(step: .password))),
            ("setup · password refused", AnyView(setupView(
                step: .password, problem: "The mail server rejected that login."))),
            ("setup · failed", AnyView(setupView(
                step: .failed(AppRootModel.couldNotFinish("This install has no durable key."))))),
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

    private func setupView(step: SetupStep, problem: String? = nil) -> some View {
        SetupView(step: step, problem: problem, submitting: false,
                  onSaveMailbox: { _ in }, onSubmitPassword: { _ in }, onBack: {})
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
