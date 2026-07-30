import Foundation

// MARK: - Tags (cross-cutting, never folders)

public enum TagHue: Sendable { case moss, ochre, rosewood }

public enum TagID: String, CaseIterable, Sendable, Identifiable {
    case pottery, buch, privat
    public var id: String { rawValue }
    public var name: String {
        switch self {
        case .pottery: return "Pottery Project"
        case .buch: return "Paperwork"
        case .privat: return "Adventures"
        }
    }
    public var hue: TagHue {
        switch self {
        case .pottery: return .moss
        case .buch: return .ochre
        case .privat: return .rosewood
        }
    }
}

// MARK: - Places (the mail-holding views)

public enum Place: String, Sendable {
    case ohbox, reads, receipts
    public var title: String {
        switch self {
        case .ohbox: return "Ohbox"
        case .reads: return "Reads"
        case .receipts: return "Receipts"
        }
    }
}

// MARK: - Mail content — the sensitive-mail invariant, expressed as a type

/// Everything the app is permitted to know about a message of the protected
/// class (OTP / verification / login link). There is deliberately **no body,
/// preview or excerpt field** here: the metadata is the whole value.
public struct SensitiveMetadata: Sendable, Equatable {
    public enum Klass: String, Sendable, Equatable {
        case verification
        /// Shown in the filing-rationale chip.
        public var rationale: String { "Protected class: \(rawValue) — filed by structure, content untouched" }
    }
    public let klass: Klass
    /// How many characters the redaction stands in for — a length, never the code.
    public let redactedLength: Int
    public init(klass: Klass = .verification, redactedLength: Int = 6) {
        self.klass = klass; self.redactedLength = redactedLength
    }
}

/// **Hard invariant #1, made structural.** Mail content is a sum type, and the
/// protected case carries no payload — so a protected message *cannot* hold
/// plaintext. There is no boolean to forget to check and no field to accidentally
/// populate: the compiler is the enforcement.
///
/// Every consumer that could leak content goes through `searchableText`,
/// `aiPayload` or `forwardableBody`, all of which return `nil` for the protected
/// case. Search, the AI drafting path and forwarding are therefore excluded by
/// construction rather than by a call-site `if`.
public enum MailContent: Sendable {
    /// Ordinary mail. `body` is nil when the full text lives in a body store
    /// (the Reads / Receipts streams) and only the preview line is inline.
    case plain(body: String?, preview: String?)
    /// Protected class: nothing was stored, so there is nothing to render, index,
    /// send to a model, or forward.
    case sensitiveRedacted(SensitiveMetadata)

    /// The inline plaintext, if any. `nil` for protected mail — always.
    public var body: String? {
        switch self {
        case .plain(let b, _): return b
        case .sensitiveRedacted: return nil
        }
    }
    /// The list-row preview line. `nil` for protected mail — the row substitutes
    /// the redaction label, which is copy, not content.
    public var preview: String? {
        switch self {
        case .plain(_, let p): return p
        case .sensitiveRedacted: return nil
        }
    }
    public var isProtected: Bool {
        if case .sensitiveRedacted = self { return true }
        return false
    }
    public var sensitive: SensitiveMetadata? {
        if case .sensitiveRedacted(let m) = self { return m }
        return nil
    }
    /// Text the local index may hold. Protected mail contributes nothing.
    public var searchableText: String? {
        switch self {
        case .plain(let b, let p):
            let t = [b, p].compactMap { $0 }.joined(separator: " ")
            return t.isEmpty ? nil : t
        case .sensitiveRedacted: return nil
        }
    }
    /// Text an AI draft/summary may be grounded in. Protected mail: never.
    public var aiPayload: String? { searchableText }
    /// Text a forward/quote may include. Protected mail: never.
    public var forwardableBody: String? { body }

    /// The inline figure marker inside a newsletter body (splits the body around
    /// the one product illustration). A content concern, not a fixture concern.
    public static let imageMarker = "[[img]]"
}

// MARK: - Message (one unified item, everywhere)

public struct Message: Identifiable, Sendable {
    public let id: String
    public var place: Place
    public var from: String
    public var addr: String
    public var subj: String
    public var time: String
    /// The newest message's content.
    public var content: MailContent
    /// The rest of the conversation, oldest → newest, *excluding* the newest
    /// (which is `content`). Every one of these is rendered — the thread badge is
    /// derived from this array, so it can never claim mail the app does not show.
    public var earlier: [HeldMail]
    public var unread: Bool          // shows the accent dot + counts as "new"
    public var seen: Bool            // placement: below the waterline / "Previously seen"
    public var rationale: String?    // the filing reason chip
    public var tracker: String?      // spy-pixel chip
    public var attach: String?       // "Name.pdf (1.2 MB)"
    public var amount: String?       // receipts

    /// Conversation count badge. **Derived** — `nil` unless there really are
    /// several rendered messages behind this row.
    public var thread: Int? { earlier.isEmpty ? nil : earlier.count + 1 }
    public var body: String? { content.body }
    public var preview: String? { content.preview }
    public var isProtected: Bool { content.isProtected }
    public var sensitive: SensitiveMetadata? { content.sensitive }

    /// Every message behind this row, oldest → newest. The Ohbox reading pane
    /// renders exactly this.
    public var conversation: [HeldMail] {
        earlier + [HeldMail(id: id, subj: subj, time: time, content: content, seen: !unread)]
    }

    /// The full searchable text of the row, including the rest of the thread.
    /// Protected content contributes nothing, at any depth.
    public var searchableText: String {
        ([content.searchableText] + earlier.map(\.content.searchableText))
            .compactMap { $0 }.joined(separator: " ")
    }

    public init(id: String, place: Place, from: String, addr: String, subj: String, time: String,
                content: MailContent, earlier: [HeldMail] = [],
                unread: Bool = false, seen: Bool = false, rationale: String? = nil,
                tracker: String? = nil, attach: String? = nil, amount: String? = nil) {
        self.id = id; self.place = place; self.from = from; self.addr = addr; self.subj = subj
        self.time = time; self.content = content; self.earlier = earlier
        self.unread = unread; self.seen = seen; self.rationale = rationale
        self.tracker = tracker; self.attach = attach; self.amount = amount
    }

    /// Ordinary mail.
    public init(id: String, place: Place, from: String, addr: String, subj: String, time: String,
                unread: Bool = false, seen: Bool = false,
                preview: String? = nil, body: String? = nil, earlier: [HeldMail] = [],
                rationale: String? = nil, tracker: String? = nil, attach: String? = nil,
                amount: String? = nil) {
        self.init(id: id, place: place, from: from, addr: addr, subj: subj, time: time,
                  content: .plain(body: body, preview: preview), earlier: earlier,
                  unread: unread, seen: seen, rationale: rationale,
                  tracker: tracker, attach: attach, amount: amount)
    }

    /// Protected-class mail. The signature has no body or preview parameter, so
    /// there is no way to build one carrying plaintext.
    public static func protected(id: String, place: Place, from: String, addr: String,
                                 subj: String, time: String,
                                 metadata: SensitiveMetadata = SensitiveMetadata(),
                                 unread: Bool = false, seen: Bool = false) -> Message {
        Message(id: id, place: place, from: from, addr: addr, subj: subj, time: time,
                content: .sensitiveRedacted(metadata), unread: unread, seen: seen,
                rationale: metadata.klass.rationale)
    }
}

public struct ReceiptGroup: Sendable {
    public let label: String
    public var itemIDs: [String]
    public init(label: String, itemIDs: [String]) { self.label = label; self.itemIDs = itemIDs }
}

// MARK: - Screener

public enum Destination: String, CaseIterable, Sendable {
    case ohbox, reads, receipts, screened, spam
    /// Label on the decision button.
    public var label: String {
        switch self {
        case .ohbox: return "Ohbox"
        case .reads: return "Reads"
        case .receipts: return "Receipts"
        case .screened: return "Screen out"
        case .spam: return "Spam"
        }
    }
    /// Past-tense name used in toasts and the AI "suggests…" line.
    public var done: String { self == .screened ? "Screened out" : label }
    /// Keyboard key (⇧+key marks read).
    public var key: String {
        switch self {
        case .ohbox: return "o"
        case .reads: return "r"
        case .receipts: return "c"
        case .screened: return "n"
        case .spam: return "x"
        }
    }
    public var isFiling: Bool { self == .ohbox || self == .reads || self == .receipts }
    public var asPlace: Place? {
        switch self {
        case .ohbox: return .ohbox
        case .reads: return .reads
        case .receipts: return .receipts
        default: return nil
        }
    }
}

public enum Scope: String, Sendable { case sender, domain }

/// One held message. Carries its own identity, its own read state and its own
/// content — so moving it between screener segments and mail places never
/// collapses it into a count.
public struct HeldMail: Identifiable, Sendable {
    public let id: String
    public var subj: String
    public var time: String
    public var content: MailContent
    public var trackers: String?
    /// Read state travels *with* the message, so "& read" means the same thing at
    /// every destination — including Screen out and Spam, which hold mail rather
    /// than filing it.
    public var seen: Bool

    public var body: String? { content.body }
    public var isProtected: Bool { content.isProtected }

    public init(id: String, subj: String, time: String, content: MailContent,
                trackers: String? = nil, seen: Bool = false) {
        self.id = id; self.subj = subj; self.time = time; self.content = content
        self.trackers = trackers; self.seen = seen
    }

    /// Ordinary held mail.
    public init(id: String, subj: String, time: String, body: String,
                trackers: String? = nil, seen: Bool = false) {
        self.init(id: id, subj: subj, time: time,
                  content: .plain(body: body, preview: nil), trackers: trackers, seen: seen)
    }

    /// Protected-class held mail — no body parameter exists.
    public static func protected(id: String, subj: String, time: String,
                                 metadata: SensitiveMetadata = SensitiveMetadata(),
                                 seen: Bool = false) -> HeldMail {
        HeldMail(id: id, subj: subj, time: time,
                 content: .sensitiveRedacted(metadata), seen: seen)
    }
}

/// **A non-empty list of held mail.** Every screener record holds one of these
/// instead of an `Int` count plus a single body, which is what makes the
/// no-collapse rule structural: there is no way to say "8 held" without carrying
/// eight renderable messages, and `first` is a stored property rather than an
/// unchecked `[0]` subscript that could trap on an empty engine payload.
public struct HeldMailbag: Sendable {
    public var first: HeldMail
    public var rest: [HeldMail]

    public init(_ first: HeldMail, _ rest: [HeldMail] = []) {
        self.first = first; self.rest = rest
    }
    /// Fails rather than traps when a payload arrives empty.
    public init?(all: [HeldMail]) {
        guard let head = all.first else { return nil }
        self.init(head, Array(all.dropFirst()))
    }

    public var all: [HeldMail] { [first] + rest }
    public var count: Int { rest.count + 1 }
    /// Newest first (the fixtures and the engine both deliver oldest → newest).
    public var newest: HeldMail { rest.last ?? first }

    public mutating func markAllSeen() {
        first.seen = true
        for i in rest.indices { rest[i].seen = true }
    }
    public func markingAllSeen() -> HeldMailbag {
        var copy = self; copy.markAllSeen(); return copy
    }
    /// The joined plaintext of every held message, for the stream body stores.
    /// Protected messages contribute their redaction note, never content.
    public func joinedBody(redactedNote: String) -> String {
        all.map { $0.body ?? redactedNote }.joined(separator: "\n\n— · —\n\n")
    }
}

public struct AISuggestion: Sendable {
    public var dest: Destination
    public var conf: String   // "0.92"
    public var why: String
    public init(dest: Destination, conf: String, why: String) {
        self.dest = dest; self.conf = conf; self.why = why
    }
}

public struct WaitingSender: Identifiable, Sendable {
    public let id: String
    public var from: String
    public var addr: String
    public var initial: String
    public var time: String
    public var scope: Scope
    public var dull: Bool
    public var ai: AISuggestion
    public var held: HeldMailbag
    public init(id: String, from: String, addr: String, initial: String, time: String,
                scope: Scope = .sender, dull: Bool = false, ai: AISuggestion, held: HeldMailbag) {
        self.id = id; self.from = from; self.addr = addr; self.initial = initial; self.time = time
        self.scope = scope; self.dull = dull; self.ai = ai; self.held = held
    }
}

public struct ScreenedSender: Identifiable, Sendable {
    public var sender: String   // address — also the identity
    public var date: String
    /// Every held message, in full. Screening out holds mail; it never discards it.
    public var held: HeldMailbag
    public var choosing: Bool = false
    public var fromWaitingID: String?
    public var id: String { sender }
    public var heldCount: Int { held.count }

    public init(sender: String, date: String, held: HeldMailbag, fromWaitingID: String? = nil) {
        self.sender = sender; self.date = date; self.held = held; self.fromWaitingID = fromWaitingID
    }
}

public struct SpamSender: Identifiable, Sendable {
    public var from: String     // address — also the identity
    public var det: String      // "auto-detected · 0.98 · phishing fingerprint"
    /// Held viewable, never deleted unseen — and never collapsed to a count.
    public var held: HeldMailbag
    public var choosing: Bool = false
    public var fromWaitingID: String?
    public var id: String { from }
    public var heldCount: Int { held.count }
    /// Row conveniences — the newest held message.
    public var subj: String { held.newest.subj }
    public var time: String { held.newest.time }

    public init(from: String, det: String, held: HeldMailbag, fromWaitingID: String? = nil) {
        self.from = from; self.det = det; self.held = held; self.fromWaitingID = fromWaitingID
    }
}

public enum ScreenerSeg: String, Sendable, CaseIterable { case waiting, screened, spam }

// MARK: - Triage

/// One triage item. Its `id` is the mail it stands for, so a pile is a set of
/// message identities — queueing the same mail twice is a no-op, and completing
/// it removes it from exactly one place.
public struct TriageItem: Identifiable, Sendable {
    public let id: String
    public var title: String
    public var subtitle: String
    public var preview: String?
    public var when: String?    // "resurfaces Fri 09:00"
    public init(id: String, title: String, subtitle: String,
                preview: String? = nil, when: String? = nil) {
        self.id = id; self.title = title; self.subtitle = subtitle
        self.preview = preview; self.when = when
    }
}

public enum PileKind: String, Sendable, CaseIterable, Hashable { case replyLater, setAside, resurface }

public struct TriagePile: Identifiable, Sendable {
    public var kind: PileKind
    public var title: String
    public var items: [TriageItem]
    public var hint: String
    public var id: PileKind { kind }
    public init(kind: PileKind, title: String, items: [TriageItem], hint: String) {
        self.kind = kind; self.title = title; self.items = items; self.hint = hint
    }
}

// MARK: - Settings

public struct NotificationSetting: Identifiable, Sendable {
    public let id: String
    public var title: String
    public var subtitle: String
    public var on: Bool
    public init(title: String, subtitle: String, on: Bool) {
        self.id = title; self.title = title; self.subtitle = subtitle; self.on = on
    }
}

public struct MailboxAccount: Identifiable, Sendable {
    public var id: String { address }
    public var address: String
    public var kind: String     // "Work · IMAP"
    public var shortName: String
    public init(address: String, kind: String, shortName: String) {
        self.address = address; self.kind = kind; self.shortName = shortName
    }
}

public enum ThemePreference: String, Sendable, CaseIterable { case light, system, dark }

// MARK: - Search

public struct SearchHit: Identifiable, Sendable {
    public let id: String
    public var who: String
    public var origin: String    // "Ohbox · 09:12"
    public var subject: String
    public var fuzzy: Bool
    public var matchTerm: String?   // substring to highlight, if an exact term matched
    public init(id: String, who: String, origin: String, subject: String, fuzzy: Bool, matchTerm: String? = nil) {
        self.id = id; self.who = who; self.origin = origin; self.subject = subject
        self.fuzzy = fuzzy; self.matchTerm = matchTerm
    }
}

public enum SearchOutcome: Sendable, Equatable {
    case results([SearchHit], fuzzy: Bool)
    case empty
    case easterEgg

    public static func == (a: SearchOutcome, b: SearchOutcome) -> Bool {
        switch (a, b) {
        case (.empty, .empty), (.easterEgg, .easterEgg): return true
        case (.results(let x, let fx), .results(let y, let fy)):
            return fx == fy && x.map(\.id) == y.map(\.id)
        default: return false
        }
    }
}

// MARK: - Routing

public enum Route: Hashable, Sendable, CaseIterable {
    case ohbox, reads, receipts, triage, search, compose, settings
    case screener(ScreenerSeg)
    case tag(TagID)

    /// Every route the shell can be in — the single list the router, the rail, the
    /// smoke walk and the route test all read.
    public static var allCases: [Route] {
        [.ohbox, .reads, .receipts]
            + ScreenerSeg.allCases.map { .screener($0) }
            + [.triage]
            + TagID.allCases.map { .tag($0) }
            + [.search, .compose, .settings]
    }

    public var isScreener: Bool { if case .screener = self { return true }; return false }

    public var title: String {
        switch self {
        case .ohbox: return "Ohbox"
        case .reads: return "Reads"
        case .receipts: return "Receipts"
        case .screener: return "Screener"
        case .triage: return "Triage"
        case .search: return "Search"
        case .compose: return "Compose"
        case .settings: return "Settings"
        case .tag(let t): return t.name
        }
    }

    /// Stable slug — screenshot filenames, smoke reports.
    public var slug: String {
        switch self {
        case .screener(let seg): return "screener-\(seg.rawValue)"
        case .tag(let t): return "tag-\(t.rawValue)"
        default: return title.lowercased()
        }
    }

    /// The mail place a route shows, if it shows one.
    public var place: Place? {
        switch self {
        case .ohbox: return .ohbox
        case .reads: return .reads
        case .receipts: return .receipts
        default: return nil
        }
    }
}

extension ScreenerSeg: Hashable {}
