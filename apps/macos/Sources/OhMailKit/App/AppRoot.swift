import SwiftUI
import AppKit
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
    /// Door two's sign-in — password + TOTP against the hosted API. A dependency, so a test drives the
    /// success and failure paths without a socket.
    private let cloudSignIn: CloudSignInService
    /// Whether the disk is encrypted at rest, asked on the first Cloud sign-in. Injected so a test can
    /// drive the nudge without shelling out to `fdesetup` on the machine it runs on.
    private let fileVault: FileVaultProbe
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

    /// Which door this install chose — organize on this Mac, or on Cloud. Loaded once at launch and
    /// remembered per install: a fresh launch resumes at the chosen door rather than re-asking.
    /// `nil` until the chooser has been answered.
    private(set) var door: OnboardingDoor?
    /// The provider tile chosen behind door one, which drives the form's prefill. In memory only —
    /// what gets written down is the mailbox the form produces, not the tile that seeded it — so a
    /// relaunch mid-flow returns to the provider picker under the remembered door.
    private(set) var chosenProvider: MailProvider?

    // MARK: Door two — the cloud viewer

    /// The hosted transport, once door two has signed in. Held for the life of the window; it carries
    /// the in-memory session and is the one thing the cloud viewer drives.
    ///
    /// **`nil` on every install except a signed-in cloud one, and constructed on exactly one path** —
    /// ``submitCloudSignIn(email:password:code:)``. A local or demo install never reaches that path,
    /// which is the "local never constructs the requester" half of the per-mode privacy invariant
    /// (GOALS #5). The tokens inside live only in memory, re-minted per launch, so nothing is persisted
    /// to the device.
    private(set) var cloudRequester: CloudRequester?
    /// Whether a sign-in is in flight, for the button's own state.
    private(set) var submittingCloud = false
    /// A cloud sign-in refusal the person can act on — a wrong password or code — shown beside the
    /// fields. Distinct from ``setupFailure``, which is a degraded state that takes the whole panel
    /// (the host was unreachable). Neither is ever the invented world.
    private(set) var cloudProblem: String?

    /// Whether door two has an established session this launch. Door two's mailbox is reachable only
    /// once it has, the same way door one's password step sits ahead of the mailbox.
    public var cloudSignedIn: Bool { cloudRequester != nil }

    /// The cloud mirror's live reachability, as `/health` last reported it. `nil` before the first
    /// poll — treated as online, so the read-only chrome only appears once the mirror has actually said
    /// it is offline, never on the first frame before anything is known. Cloud-only: door one's local
    /// mirror is always reachable in this sense.
    private(set) var cloudOnline: Bool?

    /// Whether the "turn on FileVault" nudge is up. Raised once on a Cloud sign-in when the disk is not
    /// encrypted and the nudge has not already been dismissed; the dismissal is remembered on disk.
    private(set) var showFileVaultNudge = false

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
                engineSource: @escaping EngineSourceFactory = { _ in nil },
                cloudSignIn: CloudSignInService = CloudSignIn(),
                fileVault: FileVaultProbe = SystemFileVaultProbe()) {
        self.flags = flags
        self.store = store
        self.inheritedEnvironment = environment
        self.engineInstall = install ?? EngineProcess.install(
            environment: environment,
            executableDirectory: EngineProcess.bundledEngineDirectory)
        self.keys = keys
        self.makeEngineSource = engineSource
        self.cloudSignIn = cloudSignIn
        self.fileVault = fileVault
        let stored = try? store.load()
        self.config = stored
        self.configured = stored != nil
        // Every stored property, explicitly, before the call below: `materialize()` reads `self`,
        // and the observation machinery will not let it until they all exist.
        self.mail = nil
        self.mailKind = nil
        self.door = store.loadDoor()
        self.chosenProvider = nil
        self.cloudRequester = nil
        self.submittingCloud = false
        self.cloudProblem = nil
        self.cloudOnline = nil
        self.showFileVaultNudge = false
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
    ///
    /// ``SourceSelection/resolve(door:cloudSignedIn:configured:engine:status:flags:)`` layers the
    /// chosen door over the local engine's truth table: `--demo` still outranks everything, a signed-in
    /// cloud door is a viewer with no engine, and door one is the old `decide` unchanged.
    public var selection: SourceSelection {
        SourceSelection.resolve(door: door, cloudSignedIn: cloudSignedIn,
                                configured: configured, engine: engineInstall,
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
    ///
    /// **Door one's start only.** The cloud door starts its engine from ``submitCloudSignIn(email:password:code:)``,
    /// with the hosted session's own environment — begin runs at `onAppear`, before any sign-in, so a
    /// cloud install has nothing to start here yet, and starting the local engine for it would spawn a
    /// mode-`local` child with no mailbox. Skipped explicitly rather than left to idempotence, so the
    /// intent is on the page.
    public func begin() {
        guard door != .cloud else { return }
        guard selection.spawnEngine else { return }
        engine.start(environment: inheritedEnvironment, overlay: overlay, keys: keys)
    }

    public func end() { engine.stop() }

    /// The stored configuration, on the engine's own variable names. Empty until there is one.
    var overlay: [(name: String, value: String)] {
        config.map(EngineEnvironment.overlay(for:)) ?? []
    }

    /// Start the sidecar in cloud mode against a freshly signed-in session.
    ///
    /// The tokens the hosted sign-in set as cookies are lifted from the jar here and handed to the
    /// engine's environment on this first launch; the sidecar seals them under the per-install key and
    /// later launches carry only the key. The address is the email the person signed in as — what the
    /// sidecar seeds its local world with (`OHMAIL_MAILBOX_ADDRESS`). Same start path as door one, with
    /// `mode: .cloud` so the plan checks the cloud variables and the child takes the cloud branch.
    func startCloudEngine(address: String, requester: CloudRequester) {
        engine.start(mode: .cloud, environment: inheritedEnvironment,
                     overlay: Self.cloudOverlay(address: address, requester: requester), keys: keys)
    }

    /// The cloud engine's environment: the mode selector, the hosted API, the address, and the
    /// first-launch tokens read out of the sign-in jar. Static and pure, so a test can assert the exact
    /// pairs without a running engine.
    ///
    /// The tokens are secrets that DO travel in the child's environment — the sidecar's own contract on
    /// first launch, and the opposite of the IMAP password, which is never composed into a launch. A
    /// token missing from the jar is simply omitted; the plan then reports it as `.notConfigured` by
    /// name rather than starting a sidecar that cannot pull.
    static func cloudOverlay(address: String, requester: CloudRequester) -> [(name: String, value: String)] {
        var pairs: [(name: String, value: String)] = [
            (ENGINE_MODE_VAR, "cloud"),
            (CLOUD_URL_VAR, cloudAPIBaseURL.absoluteString),
            (EngineEnvironment.addressVar, address),
        ]
        if let access = cloudCookieValue("tf_session", session: requester.session, baseURL: cloudAPIBaseURL) {
            pairs.append((CLOUD_ACCESS_TOKEN_VAR, access))
        }
        if let refresh = cloudCookieValue("tf_refresh", session: requester.session, baseURL: cloudAPIBaseURL) {
            pairs.append((CLOUD_REFRESH_TOKEN_VAR, refresh))
        }
        return pairs
    }

    // MARK: - The cloud mirror's reachability

    /// What the mail surface shows above the deck: the offline read-only line when the cloud mirror has
    /// gone unreachable, otherwise the engine's own notice. Door one never shows the offline line —
    /// its mirror is local.
    public var mailNotice: EngineNoticeText? {
        if door == .cloud, cloudOnline == false { return Self.offlineNotice }
        return engine.notice
    }

    /// Poll `/health` over the pipe and record whether the cloud mirror is reachable. A no-op off the
    /// cloud door or before the engine has a transport. The sidecar's `503 offline_read_only` is the
    /// real backstop for writes; this only drives the chrome and the client-side gate.
    public func refreshCloudOnline() async {
        guard let transport = engine.transport else { return }
        await refreshCloudOnline(using: transport)
    }

    /// The pollable core, taking the requester so a test drives it without a running engine.
    func refreshCloudOnline(using requester: any EngineRequesting) async {
        guard door == .cloud else { return }
        let base = (engine.ready?.baseURL).flatMap { URL(string: $0) } ?? URL(string: "http://sidecar")!
        guard let url = URL(string: "/health", relativeTo: base) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        guard let (http, data) = try? await requester.send(request) else { return }
        if let online = Self.parseOnline(status: http.statusCode, body: data) { cloudOnline = online }
    }

    /// `{ "online": Bool }` off a 2xx `/health`. `nil` for anything else — a non-2xx or an unreadable
    /// body leaves the last known value standing rather than flipping the chrome on a transient miss.
    static func parseOnline(status: Int, body: Data) -> Bool? {
        guard (200..<300).contains(status),
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return object["online"] as? Bool
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
            //
            // The cloud door reads the SAME source over the SAME pipe as door one; the only difference
            // is the read-only gate, which refuses writes while the mirror is offline so the reader
            // gets an immediate answer rather than a round trip to the sidecar's 503. Door one's local
            // mirror is never offline in that sense, so it takes the source unwrapped.
            let gated: any MailSource = door == .cloud
                ? OfflineGate(source, isOffline: { [weak self] in
                    guard let self else { return false }
                    return self.cloudOnline == false
                })
                : source
            mail = AppState(source: gated, chrome: Self.noChrome)
        }
        mailKind = kind
    }

    // MARK: - Onboarding: the two doors

    /// Choose a door, and remember it per install.
    ///
    /// Persisted before it is acted on, so the choice survives a quit taken half-way through the flow
    /// behind it — the property this makes true is "chosen once". Door one leads on to the provider
    /// picker; door two leads to a hosted sign-in (``SetupStep/cloudSignIn(problem:)``).
    public func chooseDoor(_ door: OnboardingDoor) {
        try? store.saveDoor(door)
        self.door = door
        self.chosenProvider = nil
        self.setupFailure = nil
        self.cloudProblem = nil
    }

    /// Choose the provider whose preset fills in the form. Outlook is refused and never advances here
    /// — the picker states its limit in place rather than opening fields the build cannot use.
    public func chooseProvider(_ provider: MailProvider) {
        guard provider.authKind != .refused else { return }
        self.chosenProvider = provider
    }

    /// Return to the chooser and forget the door, so neither an unfinished door one nor an in-progress
    /// cloud sign-in is a place a person can be stuck. Clearing the stored choice is deliberate: the
    /// only thing that changes which way this install organizes is an explicit human action, and this
    /// is that action for "actually, the other way".
    public func reconsiderDoor() {
        try? store.removeDoor()
        self.door = nil
        self.chosenProvider = nil
        self.setupFailure = nil
        // A cloud sign-in in progress is abandoned with the door. The session is in-memory only, so
        // dropping the requester is the whole of forgetting it — nothing on disk to clear.
        self.cloudRequester = nil
        self.cloudProblem = nil
    }

    /// Sign in to ohmail Cloud — password, then the TOTP code — and, on success, start the cloud
    /// sidecar against the hosted session.
    ///
    /// The three outcomes are the ruling's requirement that a failed door two is a NAMED state and
    /// never `.fixtures`: a rejection (wrong password or code) shows beside the fields and the form
    /// stands; an unreachable host is a degraded panel with a sentence; a success starts the engine.
    /// The requester is stored here and nowhere else, which is what keeps a local install from ever
    /// holding one — and it survives only so the shell can lift the session tokens for the sidecar's
    /// environment.
    public func submitCloudSignIn(email: String, password: String, code: String) async {
        cloudProblem = nil
        guard !submittingCloud else { return }
        submittingCloud = true
        defer { submittingCloud = false }

        switch await cloudSignIn.signIn(email: email, password: password, code: code) {
        case .connected(let requester):
            cloudRequester = requester
            cloudProblem = nil
            setupFailure = nil
            // Start the sidecar in cloud mode the moment the session exists, exactly as `saveMailbox`
            // starts the local engine the moment the mailbox is configured. The surface then follows
            // the engine's status — opening, then serving — and `materialize` builds the source once it
            // is; the decision now names `.engine`, not a separate cloud source.
            startCloudEngine(address: email, requester: requester)
            // The mirror lands in plaintext on this disk; if FileVault is off, say so, once.
            await maybeNudgeFileVault()
        case .rejected(let why):
            cloudProblem = why
        case .unavailable(let why):
            // A degraded state, taken by the panel. `couldNotFinish` is the same wrapper a failed
            // local start uses, so the two doors fail in one voice.
            setupFailure = Self.couldNotFinish(why)
        }
    }

    // MARK: - The FileVault nudge

    /// Raise the "turn on FileVault" nudge on a first Cloud sign-in, when the disk is not encrypted.
    ///
    /// Asked only after a successful sign-in, and only when the nudge has not already been dismissed —
    /// so it is a one-time prompt, not something that greets every launch. An `unknown` answer (the
    /// tool would not run, or said something unreadable) does NOT nudge: a prompt on a state we could
    /// not read is worse than none.
    private func maybeNudgeFileVault() async {
        guard !store.loadFileVaultNudgeDismissed() else { return }
        if await fileVault.status() == .off { showFileVaultNudge = true }
    }

    /// Dismiss the nudge and remember it, so a later launch's sign-in does not raise it again.
    public func dismissFileVaultNudge() {
        showFileVaultNudge = false
        try? store.saveFileVaultNudgeDismissed()
    }

    /// Open the system's FileVault settings and dismiss the nudge. The deep link is best-effort — if
    /// the scheme is unavailable the open does nothing, which is why this dismisses regardless. It
    /// lives on the model rather than in the sheet because a view reaches no system service directly.
    public func openFileVaultSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?FileVault") {
            NSWorkspace.shared.open(url)
        }
        dismissFileVaultNudge()
    }

    /// What the form opens on for a chosen provider.
    ///
    /// A mailbox already entered wins over the preset, so returning to the form after a failure shows
    /// what was typed rather than wiping it back to the preset's blank login. Otherwise the provider's
    /// preset seeds server, port, TLS and the send server together — and generic has no preset, which
    /// is today's empty form, entered by hand.
    private func prefill(for provider: MailProvider) -> EngineConfig? {
        if let config { return config }
        return provider.preset?.draft()
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
        // Front matter: the two-door frame, then — behind door one — the provider picker, then the
        // form. All of it lives before the mailbox is written down, so `savedMailbox` gates it.
        if !savedMailbox {
            switch door {
            case .none:
                return .chooseDoor
            case .cloud:
                // Door two: sign in to the hosted mailbox. `cloudProblem` is a rejection to show
                // beside the fields, or `nil` for the first draw. Once signed in the decision names
                // `.mail`, so this step is left behind.
                return .cloudSignIn(problem: cloudProblem)
            case .local:
                guard let provider = chosenProvider else { return .pickProvider }
                return .mailbox(prefill(for: provider))
            }
        }
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

    /// The cloud mirror is unreachable. The mail already pulled is on disk and stays readable; what
    /// stops is writing, until the connection is back. Said plainly rather than hidden, because a
    /// control that silently does nothing is worse than one that says why.
    static let offlineNotice = EngineNoticeText(
        title: "Offline · read only",
        detail: "ohmail can't reach your mailbox right now. You can read what's here; changes are "
            + "paused until the connection is back.")

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
    /// The two-door frame: organize this mailbox on this Mac, or on Cloud. The first thing a fresh
    /// install shows, before it has anything to collect.
    case chooseDoor
    /// Door two: sign in to ohmail Cloud — email, password, and a TOTP code. `problem` is a rejection
    /// to show beside the fields (a wrong password or code), or `nil` for the first draw. Adding a
    /// mailbox to Cloud stays on ohmail.app; this is sign-in and read/triage of mailboxes Cloud holds.
    case cloudSignIn(problem: String?)
    /// Door one's first step: who hosts the mailbox. The answer fills in the server details.
    case pickProvider
    /// Collect the mailbox. Carries whatever is already stored — or a provider preset — so nobody
    /// retypes a server name that is already right.
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
    /// The one name shared with cloud mode — the mailbox address is not IMAP-specific. Spelled once, in
    /// the engine module, so the local overlay and the cloud overlay cannot drift on it.
    public static let addressVar = MAILBOX_ADDRESS_VAR
    /// Implicit TLS. The engine reads this as "anything that is not the string `0`", so the false
    /// case has to be spelled exactly — an empty value would mean secure.
    public static let secureVar = "OHMAIL_IMAP_SECURE"
    /// The SMTP server this mailbox sends through. The engine reads these three and authenticates with
    /// the SAME login it opened IMAP with — one credential per mailbox, so there is no SMTP password
    /// variable to carry and never is.
    public static let smtpHostVar = "OHMAIL_SMTP_HOST"
    public static let smtpPortVar = "OHMAIL_SMTP_PORT"
    public static let smtpSecureVar = "OHMAIL_SMTP_SECURE"

    public static func overlay(for config: EngineConfig) -> [(name: String, value: String)] {
        var pairs: [(name: String, value: String)] = [
            (hostVar, config.host),
            (portVar, String(config.port)),
            (userVar, config.user),
            (addressVar, config.address),
            (secureVar, config.tls ? "1" : "0"),
        ]
        // Only when a send server was configured. Absent, the engine sends nothing rather than
        // guessing a server — and an empty host would read as "no SMTP" downstream anyway, so a blank
        // is never emitted.
        if let smtpHost = config.smtpHost, !smtpHost.isEmpty {
            pairs.append((smtpHostVar, smtpHost))
            pairs.append((smtpPortVar, String(config.smtpPort ?? 587)))
            pairs.append((smtpSecureVar, (config.smtpSecure ?? true) ? "1" : "0"))
        }
        return pairs
    }
}

/// A read-only shell over the cloud mirror while it is offline — the client-side half of "read only".
///
/// Every ``MailIntent`` is a write (a mark-as-read, a Screener decision, a triage move, an undo of one
/// of those), so when the mirror is offline this refuses `apply` outright, with a sentence the reader
/// sees, and forwards everything else — the world, bodies, sync state — untouched. Reads keep working
/// against what the mirror already holds.
///
/// **The sidecar's `503 offline_read_only` is still the backstop.** This is the UX: it turns a write
/// that would round-trip to a 503 into an immediate, plain answer, and it is applied only for the
/// cloud door — door one's local mirror is never offline in this sense. `isOffline` is read live, so
/// the gate opens again the moment `/health` reports the mirror is back.
@MainActor
final class OfflineGate: MailSource {
    private let wrapped: any MailSource
    private let isOffline: @MainActor () -> Bool

    init(_ wrapped: any MailSource, isOffline: @escaping @MainActor () -> Bool) {
        self.wrapped = wrapped
        self.isOffline = isOffline
    }

    func openingWorld() -> MailWorld { wrapped.openingWorld() }

    @discardableResult
    func start(sink: any MailSourceSink) -> SyncState { wrapped.start(sink: sink) }

    func bodyState(for id: String, in place: Place) -> BodyState { wrapped.bodyState(for: id, in: place) }
    func requestBody(for id: String, in place: Place) { wrapped.requestBody(for: id, in: place) }

    @discardableResult
    func apply(_ intent: MailIntent) -> IntentOutcome {
        guard !isOffline() else {
            return .refused(SourceFailure(
                kind: .network,
                reason: "You're offline. ohmail is read-only until your connection is back.",
                isRetryable: true))
        }
        return wrapped.apply(intent)
    }
}
