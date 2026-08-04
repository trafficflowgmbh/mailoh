import Foundation

/// A string that must never reach a log, a crash report or an interpolation.
///
/// The engine's `ready` frame carries the per-launch session token — the credential the UI
/// authenticates with. It travels in-band on a pipe nobody else holds, and it stays that way only
/// if nothing prints it. A newtype makes that a property of the type rather than of every author
/// who ever interpolates an `EngineReady`.
///
/// **Three conformances, and the third was found by a test rather than reasoned about.**
///
/// `"\(value)"` goes through `CustomStringConvertible`; `String(reflecting:)`, `dump` and the
/// debugger go through `CustomDebugStringConvertible`. Those two were written first, and they are
/// not enough: a struct that merely *contains* a `Secret` is printed by walking a `Mirror` of its
/// stored properties, and that walk reads the stored `String` directly — it does not ask the
/// enclosing value's type for permission. Measured: with only the first two conformances,
/// `String(describing: EngineReady(…))` printed the session token in full while
/// `String(describing: secret)` printed `<redacted>`.
///
/// `CustomReflectable` is what closes it. Redaction becomes a property of THIS type rather than an
/// obligation on every type that ever holds one — which matters because the types that will hold
/// one have not been written yet.
///
/// `Codable` is deliberately absent. A `Secret` that could be encoded is a `Secret` that can be
/// written to `config.json` by an author who never thought about it — see `EngineConfigStore`,
/// which has no field for one either.
public struct Secret: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
                      CustomReflectable {
    private let value: String

    public init(_ value: String) { self.value = value }

    /// The only way to read it. Deliberately noisy at the call site.
    public func expose() -> String { value }

    public var description: String { "<redacted>" }
    public var debugDescription: String { "<redacted>" }

    /// No children, so nothing walking a containing value's `Mirror` can reach the string. The
    /// `displayStyle` is left nil, which is what makes the printer fall back to ``description``.
    public var customMirror: Mirror { Mirror(self, children: []) }

    /// Whether there is anything here at all. Answers the one question a caller can otherwise only
    /// answer by exposing the value.
    public var isEmpty: Bool { value.isEmpty }
}
