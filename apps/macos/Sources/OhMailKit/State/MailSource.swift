import Foundation

// The seam.
//
// Everything above this line is a shell: routes, selection, overlays, a toast, a
// search index. Everything below it is whatever actually holds the mail. The app
// ships against `FixtureSource`; the point of the protocol is that swapping in
// something that talks to a real mailbox is a new conformance and not a rewrite of
// the shell.
//
// TWO RULES SHAPE THE DESIGN, and both are here because the obvious version of
// this protocol fails at first contact with a real account.
//
// 1. THE SOURCE OWNS THE MAIL. The shell does not edit arrays and tell the source
//    afterwards; it names what the reader wants (`MailIntent`) and takes back
//    whatever world the source then reports. A shell that mutates locally and
//    "informs" the source has two truths, and a mailbox — where messages arrive
//    unbidden, where another client files things, where the server is entitled to
//    say no — will disagree with the local one within seconds.
//
// 2. UNDO IS A FORWARD REQUEST, NOT A SAVED WORLD. It would be easy to keep a copy
//    of the world before each action and write it back on Undo. That works
//    perfectly against fixtures and is a lie against a mailbox: by the time Undo is
//    tapped, mail has arrived, a phone has read something, the server has renumbered.
//    So `apply` hands back a `Receipt`, Undo asks for that receipt to be reversed,
//    and the source is entitled to answer `.refused` with a reason the reader sees.
//    An undo that can fail out loud is worth more than one that silently restores
//    a stale copy.
//
// Nothing here is `Codable`, deliberately — see the note in `Models/SourceState.swift`.

// MARK: - The world

/// Everything a mailbox owns, as one value.
///
/// Handed over whole rather than as deltas. At this app's scale — a screener, an
/// inbox, two bounded streams — re-projecting the lot costs nothing measurable,
/// and a delta protocol would be the first design choice that made one kind of
/// engine easier to write than another. Do not "optimise" this into patches
/// without a measurement that says it matters.
///
/// Note there are no chrome strings here. A compose draft, a pre-filled search
/// query, a caption under an illustration: those belong to the preview, not to any
/// mailbox, and a real source must not be handed a slot it would have to invent
/// something to fill. They live in `PreviewChrome`.
public struct MailWorld: Sendable {
    public var ohbox: [Message] = []
    public var reads: [Message] = []
    public var receipts: [Message] = []
    public var receiptGroups: [ReceiptGroup] = []

    /// Bodies by message id, per stream. `BodyState` rather than `String` because a
    /// real source has headers before it has bodies.
    public var readsBodies: [String: BodyState] = [:]
    public var receiptsBodies: [String: BodyState] = [:]

    public var waiting: [WaitingSender] = []
    public var screened: [ScreenedSender] = []
    public var spam: [SpamSender] = []

    public var tagsByID: [String: [TagID]] = [:]
    public var piles: [TriagePile] = []
    public var drafts: [String: String] = [:]

    public var notificationSettings: [NotificationSetting] = []
    public var vips: [String] = []
    public var mailboxes: [MailboxAccount] = []
    /// The address this app is signed in as.
    public var ownerAddress: String = ""

    public init() {}
}

// MARK: - Intents

/// What the reader asked for, in terms a mailbox understands.
///
/// **Identities here are mailbox identities** — a sender's address, a message's
/// own id — never a row index and never an id this app minted for its own list.
/// "Put it back at position 3" is a promise no mailbox can keep.
///
/// PROVISIONAL. These cases are exactly the mutations the app performs today and
/// no more. Nothing speculative has been added in anticipation of an engine,
/// because a case nobody can exercise is a case nobody can get right. Expect this
/// vocabulary to be revised by the slice that first lands a real source.
public enum MailIntent: Sendable {
    // Screener
    /// File a first-time sender, and make it a rule at `scope`.
    case decide(sender: String, scope: Scope, to: Destination, markRead: Bool)
    /// Release a screened-out sender's held mail to a place.
    case allow(sender: String, to: Destination)
    case notSpam(sender: String, to: NotSpamTarget)
    case deleteSpam(sender: String)
    /// Whether the pending rule for this sender covers the address or the domain.
    case setScope(sender: String, Scope)

    // Mail
    case markSeen(message: String)
    case setTag(message: String, tag: TagID, on: Bool)

    // Triage
    case addToPile(PileKind, TriageItem)
    case removeFromPile(PileKind, message: String)
    case saveDraft(message: String, text: String)

    // Account
    case addVIP(String)
    case setNotification(id: String, on: Bool)

    /// Take back something the source already did. The source decides whether it
    /// still can — see the note at the top of this file.
    case reverse(Receipt)
}

/// The source's own name for one applied intent, quoted back to it by
/// `.reverse(_:)`. Opaque to the shell: what it takes to undo an operation is the
/// source's business, and the shell holding that detail is what made the old design
/// unlandable.
public struct Receipt: Sendable, Identifiable, Equatable {
    public let id: String
    public init(id: String) { self.id = id }
}

/// What the source did about an intent.
public enum IntentOutcome: Sendable {
    case applied(IntentAck)
    /// Nothing changed, and this is why. Not an exception: a mailbox refusing is
    /// ordinary, and the reader is owed the reason.
    case refused(SourceFailure)
}

public struct IntentAck: Sendable {
    /// How many mail items actually moved. Zero is a legitimate answer — marking a
    /// message seen that is already seen changes nothing, and the shell must not
    /// announce that it did.
    public var affected: Int
    /// Ids the operation brought into being, in the order they were created.
    public var createdIDs: [String]
    /// `nil` when this operation cannot be taken back at all, which is how the
    /// shell knows not to offer an Undo it would have to withdraw.
    public var receipt: Receipt?

    public init(affected: Int = 0, createdIDs: [String] = [], receipt: Receipt? = nil) {
        self.affected = affected; self.createdIDs = createdIDs; self.receipt = receipt
    }
}

// MARK: - The protocol

/// Whatever holds the mail.
@MainActor
public protocol MailSource: AnyObject {
    /// The world the app opens on, synchronously, because the first frame needs
    /// one. **Must be cheap.** A source that would have to go to a network or a
    /// disk returns whatever it already has — its last persisted world, or an empty
    /// one — reports `.syncing` from `start(sink:)`, and pushes the real thing
    /// through the sink when it arrives. "Still loading" is representable: an empty
    /// world plus `.syncing` says exactly that, and says it without blocking.
    func openingWorld() -> MailWorld

    /// Attach the shell and return where sync stands right now.
    ///
    /// One call rather than a settable property, so there is no window in which the
    /// source is live but has nowhere to push — a first update arriving before
    /// anyone was listening is a bug that only shows up against a fast engine.
    /// **The sink is held weakly**; the shell owns the source, not the other way round.
    @discardableResult
    func start(sink: any MailSourceSink) -> SyncState

    func bodyState(for id: String, in place: Place) -> BodyState
    /// Ask for a body. Returns immediately; the answer arrives through the sink.
    func requestBody(for id: String, in place: Place)

    @discardableResult
    func apply(_ intent: MailIntent) -> IntentOutcome
}

/// How a source pushes back. The shell conforms to this.
@MainActor
public protocol MailSourceSink: AnyObject {
    /// A new world, whole.
    ///
    /// Whatever the source sends **is** the truth, including the effects of intents
    /// it has just applied. The shell re-projects and does not merge: reconciling a
    /// local edit against an incoming world is the source's problem, because only
    /// the source knows which of the two the mailbox actually agreed to.
    func worldDidChange(_ world: MailWorld)
    func bodyDidChange(id: String, in place: Place, to state: BodyState)
    func syncStateDidChange(_ state: SyncState)
}
