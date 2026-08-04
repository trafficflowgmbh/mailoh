import Foundation

/// How a run of the engine ended.
public struct EngineExit: Equatable, Sendable {
    /// `nil` when a signal ended it — which includes this shell's own kill.
    public let code: Int32?
    /// Whether it ever reached `ready`. A process that exits without serving is a start failure,
    /// not a crash, and the two want different words in the log.
    public let served: Bool
    public let ran: TimeInterval

    public init(code: Int32?, served: Bool, ran: TimeInterval) {
        self.code = code
        self.served = served
        self.ran = ran
    }
}

/// Where the engine stands, and why it is not running when it is not.
///
/// The port of `EngineState` in `apps/desktop/src-tauri/src/engine.rs:221-238`. Published; a surface
/// that renders it is a different slice's, and every case here is written to be readable by one.
public enum EngineStatus: Equatable, Sendable {
    /// There is no engine to run. The window is the interface preview, which is what the shell has
    /// always been; this is not an error and nothing retries.
    case absent(lookedFor: String)

    /// There is an engine, and nothing to point it at — or no key to seal a credential under.
    /// Naming the variables beats starting a process that fails, or one that runs and then refuses
    /// to remember the password somebody just typed.
    case notConfigured(missing: [String])

    case starting(attempt: Int)

    /// Serving: the `ready` frame arrived. **Never reached by observing that the spawn succeeded** —
    /// a live pid is not a running engine.
    case serving(mailboxID: String)

    case restarting(attempt: Int, delay: TimeInterval, last: EngineExit)

    /// Asked to leave, and gone.
    case stopped

    /// Down and staying down. `reason` is a sentence, because it is the only thing anyone will have
    /// to work from.
    case failed(reason: String, last: EngineExit?)
}

extension EngineStatus: CustomStringConvertible {
    /// One line, for a log or a strip. Carries no token and no data directory: a path under the
    /// user's home carries their account name, and the shell that set it already knows.
    public var description: String {
        switch self {
        case .absent(let lookedFor):
            return "no engine in this build (\(lookedFor)); the window is the interface preview"
        case .notConfigured(let missing):
            return "not started — nothing set \(missing.joined(separator: ", "))"
        case .starting(let attempt):
            return "starting (attempt \(attempt) of \(EngineTimings.maxStarts))"
        case .serving(let mailboxID):
            return "serving mailbox \(mailboxID)"
        case .restarting(let attempt, let delay, _):
            return "restarting in \(Int(delay * 1000))ms (attempt \(attempt) of \(EngineTimings.maxStarts))"
        case .stopped:
            return "stopped"
        case .failed(let reason, _):
            return reason
        }
    }
}
