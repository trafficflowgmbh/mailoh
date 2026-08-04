import Foundation

// The states a real mailbox has and a fixture set does not.
//
// These live with the models rather than with the seam because they are things a
// *view* may one day have to draw: a sync running, a body that has not arrived, a
// failure with a reason worth reading. The seam types in `State/MailSource.swift`
// are not — a view has no business naming those.
//
// Nothing here is `Codable`. Making it so would quietly promote these Swift types
// to a wire format and pin whatever engine lands behind the seam to serialising
// exactly this shape. Whatever the engine speaks, it maps into these; the mapping
// is its own business.

// MARK: - Where sync stands

/// What the source is doing about the mailbox behind it, right now.
///
/// A fixture set is only ever `.idle`. Every other case exists because a real
/// mailbox reaches it, and the shell has to be able to say so rather than showing
/// an empty list that looks like an empty mailbox.
public enum SyncState: Sendable, Equatable {
    /// Nothing running. `lastCompleted` is `nil` before the first successful sync,
    /// which is a different thing from "synced and found nothing".
    case idle(lastCompleted: Date?)
    /// A sync is running. The mail on screen is real but may be incomplete.
    case syncing(SyncActivity)
    /// The last attempt failed. The mail on screen is whatever survived from
    /// before, which may be nothing.
    case failed(SourceFailure)
}

/// What a running sync is doing, in terms a person can read.
///
/// `done`/`total` are optional on purpose: a mailbox that has not finished listing
/// does not yet know how many messages there are, and a progress bar that invents
/// a denominator is a progress bar that lies.
public struct SyncActivity: Sendable, Equatable {
    /// A short phrase naming the work — "Fetching Ohbox", "Reading headers".
    public var what: String
    public var done: Int?
    public var total: Int?

    public init(what: String, done: Int? = nil, total: Int? = nil) {
        self.what = what; self.done = done; self.total = total
    }
}

// MARK: - Failing with a reason

/// Why something did not work, in enough detail to say it out loud.
///
/// `reason` is a sentence, not a code: it is what the toast or the empty state
/// prints. A seam that can only report "failed" forces every caller to invent
/// copy, and invented copy is how an app ends up telling a reader that their
/// mailbox is empty when the truth is that the password expired.
public struct SourceFailure: Sendable, Equatable, Error {
    public enum Kind: Sendable, Equatable {
        /// The mailbox could not be reached.
        case network
        /// The mailbox was reached and refused the credentials.
        case authentication
        /// The mailbox was reached, understood, and said no.
        case server
        /// This source cannot do the thing that was asked of it at all.
        case unsupported
    }

    public var kind: Kind
    /// Shown to the reader. Say what happened and, if there is one, what to do.
    public var reason: String
    /// Whether trying the same thing again could plausibly work.
    public var isRetryable: Bool

    public init(kind: Kind, reason: String, isRetryable: Bool) {
        self.kind = kind; self.reason = reason; self.isRetryable = isRetryable
    }
}

// MARK: - Bodies arrive later than headers

/// Whether a message's body is actually in hand.
///
/// Fixtures always have one, so this enum looks like ceremony until the day the
/// app is pointed at a real account — at which point a list of headers exists long
/// before the bodies do, and every surface that assumed `String` has to be found
/// and rewritten. Keeping the empty case representable now is what stops that.
public enum BodyState: Sendable, Equatable {
    /// Never asked for. Not an error, and not an empty message.
    case notFetched
    case fetching
    case available(String)
    /// Asked for and could not be had — deleted on the server, too large, refused.
    case failed(SourceFailure)

    /// The text, if there is any. `nil` for every state that is not `.available`,
    /// so a caller cannot accidentally render "not fetched yet" as an empty body.
    public var text: String? {
        if case .available(let text) = self { return text }
        return nil
    }
}
