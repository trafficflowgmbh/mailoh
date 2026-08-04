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

    public init() {}

    /// Work out the plan and act on it. Idempotent.
    public func start() {
        guard engine == nil else { return }

        let plan = EngineProcess.plan(
            environment: ProcessInfo.processInfo.environment,
            executableDirectory: Bundle.main.executableURL?.deletingLastPathComponent(),
            // The one value the shell KNOWS rather than reads, derived from the bundle identifier.
            dataDirectoryFallback: EngineProcess.defaultDataDirectory)

        // PLAN ALWAYS; SPAWN ONLY ON A REAL LAUNCH.
        //
        // The line is drawn at starting a process, not at working out what to say, and the two are
        // different for a reason each way. `--smoke` is a pass/fail gate that runs in CI, and a gate
        // that spawned an engine would leave one behind on every run. But `--shot` renders what the
        // window actually looks like, and a shell that hid its own empty hole from the pass that
        // photographs it would be photographing something the app never shows.
        if case .spawn = plan, Self.isRenderCheck { return }

        let engine = EngineProcess.make(plan) { [weak self] status in
            // The supervisor publishes from its own thread. Everything a view reads has to arrive
            // on the main actor, and the hop is here rather than in the engine because the engine
            // has no opinion about actors and should not acquire one.
            Task { @MainActor [weak self] in self?.status = status }
        }
        self.engine = engine
        status = engine.status
        engine.start()
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
