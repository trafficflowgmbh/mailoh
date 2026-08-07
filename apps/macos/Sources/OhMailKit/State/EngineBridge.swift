import Foundation
import OhMailEngine

/// THE SHELL'S SIDE OF THE ENGINE, and — for now — the only thing that renders it.
///
/// `OhMailEngine` is Foundation-only and knows nothing about SwiftUI; this is the one object that
/// owns an `EngineProcess`, hops its status onto the main actor, and turns it into two strings a
/// view can draw. `AppState` is untouched: the engine does not hold mail yet, so putting it there
/// would put a lifecycle in the object whose whole claim is that it holds no mail.
///
/// ── WHY THIS EXISTS BEFORE ANYTHING READS THE ENGINE ──────────────────────────────────────
///
/// The per-install key was lost once already, and in a way worth naming: the engine side and the
/// shell side each assumed the key was the other's, so nothing minted it and a local install could
/// not store a password at all. A seam that is a side effect of two pieces of work instead of the
/// deliverable of one is how that happens again.
///
/// So the hole is the deliverable. Launched with no key, the window says `OHMAIL_KEK` by name and
/// starts nothing — visibly, on screen, where the next person cannot miss it. Everything else this
/// class can report (`starting`, `serving`, `restarting`) is deliberately silent: a strip that
/// narrated a healthy engine would be chrome, and the design has no room for chrome that says
/// nothing happened.
///
/// ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────────────────────
///
/// Nothing here reads mail. `EngineTransport` exists, is tested against the real engine, and has no
/// caller: putting a `MailSource` behind the bridge is separate work, and a transport wired up by
/// the one piece of work that cannot use it is a wiring nobody has exercised.
@Observable
@MainActor
public final class EngineBridge {
    /// Where the engine stands, or `nil` before ``start()``.
    public private(set) var status: EngineStatus?

    private var engine: EngineProcess?
    private var wire: EngineTransport?

    public init() {}

    /// The engine's hello, once it has sent one: the mailbox this launch opened and the bearer
    /// token for its routes. `nil` until ``EngineStatus/serving(mailboxID:)``.
    public var ready: EngineReady? { engine?.ready }

    /// The request/response side of the pipe, created with the engine and held for its lifetime.
    ///
    /// **One per engine, and it lives here rather than at each call site.** `EngineProcess` holds
    /// its frame sink weakly and keeps only the latest, so a second transport built by a second
    /// caller silently displaces the first — and the first's in-flight requests then wait for
    /// answers that are being delivered to somebody else. Everything that needs the engine's routes
    /// takes this one.
    public var transport: EngineTransport? { wire }

    /// Work out the plan and act on it. Idempotent.
    ///
    /// - Parameter environment: what the plan is read from. A parameter and not `ProcessInfo`
    ///   directly, because the mailbox this install opens is stored configuration rather than
    ///   something the process was launched with: a bundle opened from the Finder inherits an empty
    ///   environment, so a shell that read only `ProcessInfo` reported the mailbox variables missing
    ///   on every double-click. The composition root overlays the stored configuration and passes
    ///   the result. The default is what a developer running this from a shell expects.
    /// - Parameter overlay: the stored configuration, already mapped onto the engine's own variable
    ///   names. It is merged into `environment` for the plan **and** appended to the launch, which
    ///   are two different things — see ``carrying(_:in:)``.
    /// - Parameter keys: where the per-install key comes from. A parameter with the shipped default
    ///   already in it, because the default **mints** a key into the login keychain the first time
    ///   it is read — which is correct for a launch and is not something a test may do to the
    ///   machine it runs on.
    /// - Parameter mode: whether this starts the local organizer or the hosted-mirror sidecar. The
    ///   `overlay` for cloud carries ``ENGINE_MODE_VAR`` so the child takes the matching branch; the
    ///   two are set together at the composition root and the plan checks the mode's own required set.
    public func start(mode: EngineMode = .local,
                      environment: [String: String] = ProcessInfo.processInfo.environment,
                      overlay: [(name: String, value: String)] = [],
                      keys: KeyProvider = KeyProviderDefault()) {
        guard engine == nil else { return }

        var composed = environment
        for (name, value) in Self.admissible(overlay) { composed[name] = value }

        let plan = EngineProcess.plan(
            mode: mode,
            environment: composed,
            // The same directory the install check looked in, spelled once — see
            // `EngineProcess.bundledEngineDirectory`. Two spellings would be a shell that decides
            // what to draw from one path and spawns from another.
            executableDirectory: EngineProcess.bundledEngineDirectory,
            // The one value the shell KNOWS rather than reads, derived from the bundle identifier.
            dataDirectoryFallback: EngineProcess.defaultDataDirectory,
            keys: keys)

        // PLAN ALWAYS; SPAWN ONLY ON A REAL LAUNCH.
        //
        // The line is drawn at starting a process, not at working out what to say, and the two are
        // different for a reason each way. `--smoke` is a pass/fail gate that runs in CI, and a gate
        // that spawned an engine would leave one behind on every run. But `--shot` renders what the
        // window actually looks like, and a shell that hid its own empty hole from the pass that
        // photographs it would be photographing something the app never shows.
        if case .spawn = plan, Self.isRenderCheck { return }

        let engine = EngineProcess.make(Self.carrying(overlay, in: plan)) { [weak self] status in
            // The supervisor publishes from its own thread. Everything a view reads has to arrive
            // on the main actor, and the hop is here rather than in the engine because the engine
            // has no opinion about actors and should not acquire one.
            Task { @MainActor [weak self] in self?.status = status }
        }
        self.engine = engine
        // Attached BEFORE the reader thread exists. A transport built after `start()` can miss
        // frames the reader has already delivered to nobody.
        self.wire = EngineTransport(engine: engine)
        status = engine.status
        engine.start()
    }

    /// Put the overlay where the CHILD will actually read it.
    ///
    /// **A plan built from a composed environment does not pass that environment on, and this is the
    /// whole reason this method exists.** `EngineProcess.plan` reads the dictionary it is given only
    /// to decide *whether* it can start — the `EngineLaunch` it returns deliberately carries just two
    /// pairs, the data directory and the key, because everything else the engine reads is expected to
    /// be inherited. The spawn then overlays those two pairs onto this process's **real**
    /// environment. So a configured install whose mailbox lives in `config.json` would satisfy the
    /// plan's check and then start a child that inherits nothing, and the engine would exit demanding
    /// the very variable the shell had just proved it had. Four times, and then a failure panel
    /// naming a cause that is not the cause.
    ///
    /// Appended after the plan's own pairs, never before: the data directory and the key are the two
    /// values this shell KNOWS rather than reads, and stored configuration may not displace either.
    static func carrying(_ overlay: [(name: String, value: String)], in plan: EnginePlan) -> EnginePlan {
        guard case .spawn(let launch) = plan else { return plan }
        let additions = admissible(overlay).filter { pair in
            !launch.environment.contains { $0.name == pair.name }
        }
        guard !additions.isEmpty else { return plan }
        return .spawn(EngineLaunch(program: launch.program,
                                   arguments: launch.arguments,
                                   environment: launch.environment + additions))
    }

    /// Names the stored configuration is not allowed to set, whatever it holds.
    ///
    /// The first two belong to the shell and to the keystore, and a `config.json` that could set
    /// either would be a plaintext file able to redirect the mirror or replace the key every stored
    /// credential is sealed under. The third is the one that matters most: the password is typed once
    /// and sealed into the engine's own store, and a launch that carried it in the child's
    /// environment would put it in process state that anything running as this user could read — the
    /// exact property sealing it removed.
    static let overlayRefuses: Set<String> = [KEK_VAR, DATA_DIR_VAR, "OHMAIL_IMAP_PASS"]

    static func admissible(_ overlay: [(name: String, value: String)]) -> [(name: String, value: String)] {
        overlay.filter { !overlayRefuses.contains($0.name) }
    }

    /// Ask the engine to leave and wait for it. Safe to call more than once.
    public func stop() {
        engine?.stop()
        status = engine?.status
    }

    /// What to put on screen, or `nil` when there is nothing worth saying.
    public var notice: EngineNoticeText? {
        switch status {
        case nil, .starting, .serving, .stopped:
            return nil
        case .absent:
            return EngineNoticeText(
                title: "No local engine in this build.",
                detail: "This window is the interface preview. It runs on invented mail and opens no mailbox.")
        case .notConfigured(let missing):
            // The whole point of this class. The variable is named, not described.
            return EngineNoticeText(
                title: "The local engine did not start.",
                detail: "Not set: " + missing.joined(separator: ", "))
        case .restarting(let attempt, _, _):
            return EngineNoticeText(
                title: "The local engine is restarting.",
                detail: "Attempt \(attempt) of \(EngineTimings.maxStarts).")
        case .failed(let reason, _):
            return EngineNoticeText(title: "The local engine stopped.", detail: reason)
        }
    }

    /// `--smoke` and `--shot` render the shell offscreen to check that it draws. Neither is an app
    /// launch, and neither should be able to start a process: a render check that spawned an engine
    /// would leave one behind every time CI ran it.
    private static var isRenderCheck: Bool {
        let arguments = CommandLine.arguments
        return arguments.contains("--smoke") || arguments.contains("--shot")
    }
}

/// One line a person reads, and the specific thing behind it.
public struct EngineNoticeText: Equatable, Sendable {
    public let title: String
    public let detail: String

    public init(title: String, detail: String) {
        self.title = title
        self.detail = detail
    }
}
