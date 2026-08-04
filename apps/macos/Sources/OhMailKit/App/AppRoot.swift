import SwiftUI
import OhMailEngine

/// THE COMPOSITION ROOT — the one object allowed to decide what the app is showing, and the only
/// one that builds a mail source.
///
/// Everything below it takes what it is given. `AppState` is handed a source in its initialiser and
/// has no setter; the views are handed an `AppState` and cannot reach past it; and this class is
/// where the filesystem, the process and the command line are read. That is the arrangement that
/// makes "the app never shows invented mail by accident" a property somebody can check, because
/// there is exactly one place to look.
///
/// ── WHAT WAS HERE BEFORE ──────────────────────────────────────────────────────────────────
///
/// `OhMailApp` built `AppState()`, which defaults to the sample world, and showed it. There was no
/// state in which the window said anything else: a missing engine, a mailbox nobody had configured
/// and a mailbox whose engine had died all produced the same nine invented messages from people who
/// do not exist. The engine's own status existed and was published, and the window drew a one-line
/// strip about it above the invented mail.
///
/// ── THE THREE THINGS THIS OWNS ────────────────────────────────────────────────────────────
///
///  1. **The decision**, delegated to ``SourceSelection/decide(configured:engine:status:flags:)``, which is
///     pure so that every state below is reachable from a test rather than only from a machine in
///     the right condition.
///  2. **The engine's lifetime.** One ``EngineBridge``, started at most once. It used to be owned by
///     `RootView`; a window-scoped engine plus a root-scoped one is two engines, and the second one
///     fails on the data directory's exclusive lock and reports that another copy of ohmail is
///     running — which is true, and is this app.
///  3. **The mailbox's configuration**, read from disk here and mapped onto the engine's own
///     environment contract in ``EngineEnvironment``.
@Observable
@MainActor
public final class AppRootModel {

    /// How an engine-backed mail source is built, if this build has one.
    ///
    /// **A seam and not an import.** The projection that turns the engine's routes into a
    /// `MailWorld` is separate work; naming its type here would make this file uncompilable until it
    /// lands and would make the two slices one. Absent, the mailbox still opens and the window says
    /// so — see ``noProjection``. What it must never do is fall back to the sample world, which is
    /// why this returns an optional rather than a source.
    public typealias EngineSourceFactory = @MainActor (EngineBridge) -> (any MailSource)?

    public let flags: LaunchFlags
    public let engine = EngineBridge()

    private let store: EngineConfigStore
    private let inheritedEnvironment: [String: String]
    /// Whether this build carries an engine — **read off the bundle once, at launch.**
    ///
    /// Read once for the same reason `configured` is: a SwiftUI body runs whenever anything it reads
    /// changes, and this feeds the decision that every frame consults. It is also the honest lifetime
    /// — the answer is a property of the download, and an app that noticed an engine appearing beside
    /// its executable mid-run would be an app that could start one it never planned for.
    private let engineInstall: EngineInstall
    private let makeEngineSource: EngineSourceFactory
    /// Injected for the same reason it is injected on the bridge: reading the shipped one mints a
    /// key into the login keychain, which a test must not do to the machine it runs on.
    private let keys: KeyProvider

    /// Whether this install has been pointed at a mailbox.
    ///
    /// Read once and then maintained, rather than asked of the filesystem on every evaluation: a
    /// SwiftUI body runs whenever anything it reads changes, and a `stat` in that path is a `stat`
    /// per frame.
    private(set) var configured: Bool
    private(set) var config: EngineConfig?

    /// The mail, once there is any — and then **for the life of the window.**
    ///
    /// Sticky on purpose. The engine's supervisor restarts a child that dies, which takes tens of
    /// milliseconds, and a window that tore the mailbox down and rebuilt it around each of those
    /// would flash a panel at somebody who was reading. The mail already fetched is still true: it
    /// came out of the local mirror, which is on disk and is not going anywhere. So a restart after
    /// the mailbox has opened is narrated in a strip over the mail, and only a failure that happens
    /// *before* the mailbox has ever opened takes the whole window.
    public private(set) var mail: AppState?
    private var mailKind: MailSourceKind?

    // MARK: Onboarding, which is a sequence and not a state

    private(set) var inSetup = false
    /// Whether ``saveMailbox(_:)`` has written a configuration during this run of setup. The step
    /// after it waits for the engine, which is why setup outlives the moment `configured` flips.
    private(set) var savedMailbox = false
    private(set) var setupFailure: EngineNoticeText?
    /// A refusal the person can do something about, shown beside the field rather than as a state.
    private(set) var passwordProblem: String?
    private(set) var submittingPassword = false

    /// - Parameter install: whether this build carries an engine. `nil` means *go and look*, which
    ///   is what a launch does; a test passes the state it is about, because the answer for a test
    ///   process is a fact about the test runner's own directory and not about anything shipped.
    ///   It is resolved from the `environment` this object was handed rather than from
    ///   `ProcessInfo`, so that an `OHMAIL_ENGINE` the composition root was given is the same engine
    ///   the check looks for and the spawn later runs.
    public init(flags: LaunchFlags = LaunchFlags.parse(CommandLine.arguments),
                store: EngineConfigStore = EngineConfigStore(),
                environment: [String: String] = ProcessInfo.processInfo.environment,
                keys: KeyProvider = KeyProviderDefault(),
                install: EngineInstall? = nil,
                engineSource: @escaping EngineSourceFactory = { _ in nil }) {
        self.flags = flags
        self.store = store
        self.inheritedEnvironment = environment
        self.engineInstall = install ?? EngineProcess.install(
            environment: environment,
            executableDirectory: EngineProcess.bundledEngineDirectory)
        self.keys = keys
        self.makeEngineSource = engineSource
        let stored = try? store.load()
        self.config = stored
        self.configured = stored != nil
        // Every stored property, explicitly, before the call below: `materialize()` reads `self`,
        // and the observation machinery will not let it until they all exist.
        self.mail = nil
        self.mailKind = nil
        self.inSetup = false
        self.savedMailbox = false
        self.setupFailure = nil
        self.passwordProblem = nil
        self.submittingPassword = false
        // Eagerly, so a launch that already knows what it is showing shows it on the first frame
        // rather than after one pass through a surface that has nothing in it.
        materialize()
    }

    // MARK: - What the window draws

    /// The decision, before this object's own sequencing is applied to it.
    public var selection: SourceSelection {
        SourceSelection.decide(configured: configured, engine: engineInstall,
                               status: engine.status, flags: flags)
    }

    /// What the window draws right now.
    public var surface: SourceSelection.Surface {
        // Onboarding is a sequence somebody is part-way through, so it outranks the decision: the
        // moment a configuration is written, `decide` stops saying `.setup` — and the password step
        // has not happened yet.
        //
        // **AND THE SEQUENCE DOES NOT OUTRANK THE ONE FACT THAT MAKES IT POINTLESS.** This line sits
        // ABOVE the decision, so a guard placed only inside `decide` would not make the credential
        // form unreachable — it would make it unreachable by the one route that happens to set this
        // flag today. That is a property of `saveMailbox` being the only writer, not a property
        // anybody checked, and there is already a loop behind it: `dismissSetupFailure` clears
        // `savedMailbox` and leaves `inSetup` standing, which walks straight back to the form.
        //
        // So the state that must never be drawn is refused here as well as decided there. Two
        // guards for one rule is not duplication when the rule is "a stranger is never asked for a
        // mail password by a build that cannot use it".
        if inSetup, case .installed = engineInstall { return .setup }

        let selection = self.selection
        switch selection.surface {
        case .engineState where mailKind == .engine:
            // Post-serve degradation. See `mail`.
            return .mail
        case .mail where mail == nil:
            // The mailbox is open and this build cannot draw it. Said out loud, because the
            // alternative — showing the sample world here — is the defect this whole file is about.
            return .engineState(Self.noProjection)
        default:
            return selection.surface
        }
    }

    // MARK: - Lifetime

    /// Start whatever the decision calls for. Idempotent; `EngineBridge` refuses a second start.
    public func begin() {
        guard selection.spawnEngine else { return }
        engine.start(environment: inheritedEnvironment, overlay: overlay, keys: keys)
    }

    public func end() { engine.stop() }

    /// The stored configuration, on the engine's own variable names. Empty until there is one.
    var overlay: [(name: String, value: String)] {
        config.map(EngineEnvironment.overlay(for:)) ?? []
    }

    /// Build the source the decision names — **the only construction of either one in the app.**
    ///
    /// Called from the view's `task`, so it runs after the decision has settled and can run again
    /// when the engine changes state without anything being rebuilt twice.
    public func materialize() {
        guard mail == nil, inSetup == false, let kind = selection.source else { return }
        switch kind {
        case .fixtures:
            // Reachable only through the `--demo` branch of `SourceSelection.decide`, which asks the
            // flag and nothing else. `SourceSelectionTests` walks a configured launch across every
            // engine status to prove there is no other way here.
            mail = AppState(source: FixtureSource())
        case .engine:
            guard let source = makeEngineSource(engine) else { return }
            // NOT `.fixtures`. `PreviewChrome` is the sample persona's narrative — a compose draft,
            // a pre-filled search, a name to suggest for VIP — and it is the default because the
            // preview was the only thing there was. Handing it to a real account would put a
            // stranger's half-written message in somebody's compose window.
            mail = AppState(source: source, chrome: Self.noChrome)
        }
        mailKind = kind
    }

    // MARK: - Onboarding

    /// Write the mailbox down and start the engine against it.
    ///
    /// The password is deliberately not a parameter and not a field on ``EngineConfig``: it is typed
    /// on the next step and sealed into the engine's own store, and a file under Application Support
    /// is not where a mailbox password goes.
    public func saveMailbox(_ config: EngineConfig) {
        do {
            try store.save(config)
        } catch {
            setupFailure = Self.couldNotFinish(
                "The mailbox could not be written to disk (\(error.localizedDescription)).")
            return
        }
        self.config = config
        self.configured = true
        // BOTH FLAGS, HERE, AND NOT FROM A VIEW'S `onAppear`.
        //
        // Writing the configuration is the moment the decision stops saying `.setup` — the install
        // has a mailbox now — and the password has not been collected yet. If entering setup were
        // something a lifecycle callback did, an order that skipped it would drop somebody out of
        // onboarding half-way through, onto a panel about an engine they were in the middle of
        // configuring. So the step that makes the decision stale is the step that marks the
        // sequence as running.
        self.inSetup = true
        self.savedMailbox = true
        self.setupFailure = nil
        // KNOWN LIMITATION, RECORDED RATHER THAN PAPERED OVER: `EngineBridge.start` is idempotent by
        // way of "there is already an engine", so coming back to this form after a failed start and
        // saving different details writes the new mailbox to disk and does NOT restart the child
        // against it. The next launch opens the new one. Changing that means tearing down a running
        // engine and standing another one up against the same data directory, which is the one
        // sequence the exclusive lock is there to make impossible to get wrong — so it is its own
        // piece of work, not a line here.
        engine.start(environment: inheritedEnvironment, overlay: overlay, keys: keys)
    }

    /// Where onboarding stands. Derived, so it cannot disagree with the engine.
    public var setupStep: SetupStep {
        if let setupFailure { return .failed(setupFailure) }
        guard savedMailbox else { return .mailbox(config) }
        switch engine.status {
        case .serving:
            return .password
        case nil, .starting, .restarting:
            return .starting
        case .absent, .notConfigured, .stopped, .failed:
            // Terminal for this sequence. The sentence is the one the decision would have put on a
            // full panel, so the words a start failure uses are the same on both surfaces.
            if case .engineState(let notice) = SourceSelection.decide(
                configured: true, engine: engineInstall,
                status: engine.status, flags: flags).surface {
                return .failed(notice)
            }
            return .failed(Self.couldNotFinish("The local engine stopped."))
        }
    }

    /// Send the password to the engine's own credential route.
    ///
    /// It goes down the pipe as a request, never into the child's environment: a launch that carried
    /// it would put it in process state anything running as this user could read, which is the
    /// property sealing it into the engine's store removed. See `EngineBridge.overlayRefuses`.
    public func submitPassword(_ password: String) async {
        passwordProblem = nil
        guard !submittingPassword else { return }
        guard let ready = engine.ready, let transport = engine.transport, let config else {
            setupFailure = Self.couldNotFinish("The local engine stopped before the password could be stored.")
            return
        }
        submittingPassword = true
        defer { submittingPassword = false }

        let request: URLRequest
        do {
            request = try Self.credentialRequest(mailboxID: ready.mailboxID, baseURL: ready.baseURL,
                                                 token: ready.sessionToken, config: config,
                                                 password: password)
        } catch {
            setupFailure = Self.couldNotFinish("The password could not be sent to the local engine.")
            return
        }

        do {
            let response = try await transport.response(for: request)
            switch Self.verdict(status: response.status, body: response.payload) {
            case .stored:
                inSetup = false
                savedMailbox = false
            case .refusedCredentials(let why):
                // The one answer that IS about what was typed. Everything else is a state of the
                // install, and calling any of it a wrong password sends somebody to change a
                // password that was correct.
                passwordProblem = why
            case .couldNotFinish(let why):
                setupFailure = Self.couldNotFinish(why)
            }
        } catch {
            // A transport failure is the engine going away mid-request, not a bad password.
            setupFailure = Self.couldNotFinish("The local engine stopped before the password could be stored.")
        }
    }

    public func dismissSetupFailure() {
        setupFailure = nil
        // Back to the form. Whatever is wrong is either the mailbox details or the install, and both
        // are things the first step can change.
        savedMailbox = false
    }

    // MARK: - The credential round trip

    enum CredentialVerdict: Equatable {
        case stored
        /// The mail server was reached and said no to these details.
        case refusedCredentials(String)
        /// Anything else. Never phrased as a password problem.
        case couldNotFinish(String)
    }

    /// Classify the engine's answer.
    ///
    /// **`503` IS NOT A WRONG PASSWORD, and the whole reason this function exists is that it looks
    /// like one.** An install with no durable key refuses to encrypt rather than sealing a credential
    /// under a key that dies with the process — so the password field's submit fails, on an install
    /// where the password was right. Reported as a refusal it would send somebody to reset a working
    /// mailbox password, repeatedly, and it would never start working.
    ///
    /// The engine tries the credentials before it stores them, and it tries them first, so the two
    /// answers do not overlap: a password the mail server rejects comes back as a probe failure, and
    /// a password the mail server accepted comes back as `503` only when the key is the thing that
    /// is missing.
    static func verdict(status: Int, body: Data) -> CredentialVerdict {
        if (200..<300).contains(status) { return .stored }

        let error = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let payload = error?["error"] as? [String: Any]
        let code = payload?["code"] as? String
        let message = (payload?["message"] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

        // The mail server was reached and refused. The service's own reason is better than anything
        // that could be written here, because it knows which of the answers it got.
        if code == "mailbox_probe_failed" {
            return .refusedCredentials(message ?? "The mail server did not accept that password.")
        }
        if let message, !message.isEmpty { return .couldNotFinish(message) }
        return .couldNotFinish("The local engine answered \(status).")
    }

    static func credentialRequest(mailboxID: String, baseURL: String, token: Secret,
                                  config: EngineConfig, password: String) throws -> URLRequest {
        guard let base = URL(string: baseURL),
              let url = URL(string: "/mailboxes/\(mailboxID)", relativeTo: base) else {
            throw EngineTransportError.unavailable("the engine reported no usable address")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(token.expose())", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "imap": [
                "host": config.host,
                "port": config.port,
                "secure": config.tls,
                "user": config.user,
                "pass": password,
            ],
        ])
        return request
    }

    // MARK: - Sentences

    /// The mailbox is open and there is nothing here that can draw it.
    ///
    /// Temporary, and loud rather than quiet, because the quiet version of this state is the sample
    /// world — which is exactly the thing that must never happen.
    static let noProjection = EngineNoticeText(
        title: "Your mailbox is open.",
        detail: "This build has no view for the local engine's mail yet. Nothing invented is shown "
            + "in its place.")

    /// What the sample world says about itself, permanently, while it is on screen.
    static let demoNotice = EngineNoticeText(
        title: "Demo mail.",
        detail: "Every message here was written for the preview. No mailbox is open and no engine "
            + "is running.")

    static func couldNotFinish(_ why: String) -> EngineNoticeText {
        EngineNoticeText(title: "Set up could not finish.", detail: why)
    }

    /// A source with a mailbox behind it has no compose draft, no pre-filled search and nobody to
    /// suggest for VIP. Empty is the truthful value; the sample persona's is not.
    static let noChrome = PreviewChrome(
        readsWaterlineMeta: "", streamArtCaption: "", initialSearchQuery: "",
        composeTo: "", composeSubject: "", composeDraft: "", composeGrounding: "",
        notificationsPrivacyNote: "", learnedSuggestion: "", learnedSuggestionSubject: "")
}

/// Where onboarding stands.
public enum SetupStep: Equatable, Sendable {
    /// Collect the mailbox. Carries whatever is already stored, so re-running setup does not ask
    /// somebody to retype a server name that is already right.
    case mailbox(EngineConfig?)
    /// Written down; waiting for the engine to say it is serving.
    case starting
    /// The engine is serving and has somewhere to seal a password.
    case password
    case failed(EngineNoticeText)
}

/// The stored mailbox, on the engine's own variable names.
///
/// **The engine's contract, not this app's.** Every name below is one the engine reads, and the
/// mapping is here rather than spread across the composition root so that a rename has one site and
/// a test has one thing to assert.
public enum EngineEnvironment {
    public static let hostVar = "OHMAIL_IMAP_HOST"
    public static let portVar = "OHMAIL_IMAP_PORT"
    public static let userVar = "OHMAIL_IMAP_USER"
    public static let addressVar = "OHMAIL_MAILBOX_ADDRESS"
    /// Implicit TLS. The engine reads this as "anything that is not the string `0`", so the false
    /// case has to be spelled exactly — an empty value would mean secure.
    public static let secureVar = "OHMAIL_IMAP_SECURE"

    public static func overlay(for config: EngineConfig) -> [(name: String, value: String)] {
        [
            (hostVar, config.host),
            (portVar, String(config.port)),
            (userVar, config.user),
            (addressVar, config.address),
            (secureVar, config.tls ? "1" : "0"),
        ]
    }
}
