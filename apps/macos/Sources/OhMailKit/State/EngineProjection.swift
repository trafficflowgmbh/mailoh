import Foundation

/// THE MAILBOX, TURNED INTO THE ONE VALUE THE SHELL RENDERS.
///
/// Pure: a mirror of wire messages in, a `MailWorld` out, with `now` passed as an argument rather
/// than read from the clock. Everything about what the app shows for a given mailbox is therefore
/// decidable from a file of recorded engine responses, which is what `EngineProjectionTests` reads.
///
/// ── THE WORLD IS READ WHOLE, NOT PATCHED ─────────────────────────────────────────────────────
///
/// `MailSource.swift` already ruled this: the world is "handed over whole rather than as deltas …
/// Do not 'optimise' this into patches without a measurement that says it matters." So a cycle
/// drains `/sync` from the beginning, rebuilds the mirror, and re-projects the lot. A delta
/// protocol here would be a second implementation of the client protocol, in a second language,
/// with no second set of tests.
///
/// ── WHAT IS DERIVED AND WHAT IS SIMPLY ABSENT ────────────────────────────────────────────────
///
/// The Screener is derived from the message mirror, the same way the web client derives it and for
/// the same reason: the server's own queue is a derivation too — one entry per distinct sender,
/// the latest message representing it — so grouping the mirror reproduces that queue with no
/// second wire entity to keep in lockstep with every folder move. The representative id is the
/// message id the decide endpoint resolves.
///
/// Several slots on `MailWorld` have NO fact behind them on this tier and are left empty rather
/// than filled with something plausible: tags (a closed enum of three sample tags that no real tag
/// id can map onto), VIPs, notification settings and drafts. Empty is the truthful value; a
/// fabricated one would be indistinguishable from a real one on screen.
public struct EngineProjection {

    /// Every message the engine has told us about, by id.
    private(set) var messages: [String: WireMessage] = [:]

    public init() {}

    // MARK: - Building the mirror

    /// Apply one page of `/sync` deltas.
    ///
    /// **In `seq` order, never in bucket order.** The four buckets are four views of one feed and
    /// the same id appears in several of them on a first drain — created, moved into
    /// `ohmail/Screener`, then updated. Applying them bucket by bucket lets whichever bucket comes
    /// last win, which is a message that silently reverts to unread. `seq` is the account's order
    /// of record and this follows it.
    mutating func apply(_ page: WireSyncResponse) {
        for change in page.ordered {
            guard change.type == "message" else { continue }
            if change.op == "delete" {
                messages.removeValue(forKey: change.id)
                continue
            }
            guard let message = change.message else { continue }
            messages[message.id] = message
        }
    }

    /// Set a message's read state in the mirror. Returns whether anything actually changed, so a
    /// caller cannot announce a change it did not make.
    ///
    /// The optimistic half of a write: the row loses its dot at once, and the drain that follows
    /// replaces this with whatever the mailbox says. It edits the MIRROR rather than the projected
    /// world, so there is still exactly one place a `MailWorld` is built from.
    mutating func setUnread(_ id: String, _ unread: Bool) -> Bool {
        guard var message = messages[id], message.unread != unread else { return false }
        message.unread = unread
        messages[id] = message
        return true
    }

    // MARK: - The world

    /// Project the mirror.
    ///
    /// - Parameters:
    ///   - bodies: what is actually in hand, per message id. A message with no entry has a body
    ///     that was never asked for — which is not an empty message, and the difference is the
    ///     whole reason `BodyState` exists.
    ///   - identity: who this app is signed in as, from `GET /mailboxes`.
    ///   - now: the instant display times are relative to.
    public func world(bodies: [String: BodyState],
                      identity: EngineIdentity,
                      now: Date) -> (world: MailWorld, index: EngineIndex) {
        var world = MailWorld()
        var index = EngineIndex()

        world.ownerAddress = identity.address
        world.mailboxes = identity.mailboxes

        let all = messages.values.sorted(by: Self.newestFirst)

        for wire in all {
            index.unreadByID[wire.id] = wire.unread
            guard let view = Self.view(of: wire.folder) else {
                // A folder outside the six this build knows. Left out of every list rather than
                // guessed at: `MailWorld` has no slot for it, and putting somebody's `Archive/2026`
                // mail into the Ohbox would be worse than not showing it. Recorded in the index so
                // a caller can say how much was skipped rather than discovering it as a gap.
                index.unplacedIDs.append(wire.id)
                continue
            }
            switch view {
            case .place(let place):
                index.placeByID[wire.id] = place
                let message = Self.message(wire, in: place, bodies: bodies, now: now)
                switch place {
                case .ohbox: world.ohbox.append(message)
                case .reads:
                    world.reads.append(message)
                    world.readsBodies[wire.id] = bodies[wire.id] ?? .notFetched
                case .receipts:
                    world.receipts.append(message)
                    world.receiptsBodies[wire.id] = bodies[wire.id] ?? .notFetched
                }
            case .screener(let segment):
                index.append(wire, to: segment)
            }
        }

        world.receiptGroups = Self.receiptGroups(world.receipts, all: messages, now: now)

        for sender in index.waiting {
            world.waiting.append(Self.waiting(sender, mirror: messages, bodies: bodies, now: now))
        }
        for sender in index.screened {
            world.screened.append(Self.screened(sender, mirror: messages, bodies: bodies, now: now))
        }
        for sender in index.spam {
            world.spam.append(Self.spam(sender, mirror: messages, bodies: bodies, now: now))
        }

        world.piles = Self.piles(all, now: now)
        return (world, index)
    }

    // MARK: - Folders → views

    enum View {
        case place(Place)
        case screener(EngineIndex.Segment)
    }

    /// The six folders this client knows, and nothing else.
    ///
    /// A table rather than an enum on the wire type, so a name this build has never heard of is a
    /// lookup that misses — not a decode that throws and takes a page of somebody's mail with it.
    static func view(of folder: String) -> View? {
        switch folder {
        case "INBOX": return .place(.ohbox)
        case "ohmail/Reads": return .place(.reads)
        case "ohmail/Receipts": return .place(.receipts)
        case "ohmail/Screener": return .screener(.waiting)
        case "ohmail/Screened": return .screener(.screened)
        case "ohmail/Quarantine": return .screener(.spam)
        default: return nil
        }
    }

    // MARK: - One message

    static func message(_ wire: WireMessage, in place: Place,
                        bodies: [String: BodyState], now: Date) -> Message {
        let time = displayTime(wire.date, now: now)

        // THE PROTECTED CLASS IS A DIFFERENT CONSTRUCTOR, NOT A FLAG.
        //
        // `Message.protected` has no body or preview parameter, so a protected message built here
        // structurally cannot carry plaintext — the snippet is not passed, and there is no field to
        // pass it to. That is the sensitive-mail invariant enforced by the compiler rather than by
        // this function remembering.
        if wire.sensitivity.sensitive {
            return Message.protected(id: wire.id, place: place, from: wire.from.display,
                                     addr: wire.from.address, subj: wire.subject, time: time,
                                     unread: wire.unread, seen: !wire.unread)
        }

        // `body` is the hydrated text when there is one and nil otherwise, and `preview` is the
        // server's snippet. Nil is not "empty": every surface that would render a body reads
        // `BodyState` first, and a snippet is never passed off as the message.
        var message = Message(id: wire.id, place: place, from: wire.from.display,
                              addr: wire.from.address, subj: wire.subject, time: time,
                              content: .plain(body: bodies[wire.id]?.text,
                                              preview: wire.snippet.isEmpty ? nil : wire.snippet),
                              earlier: [],
                              unread: wire.unread, seen: !wire.unread)
        // `attach`, `amount`, `tracker`, `rationale` and `classification` are all left nil. Each is
        // a sentence or a number about one message, and this tier has no fact behind any of them:
        // the engine emits no routing decision on a local install, and a filing rationale invented
        // here would be a statement about somebody's real mail that nothing made.
        message.classification = nil
        return message
    }

    /// Held mail keeps its own identity, subject, time and read state — a held message is never a
    /// slot in a count.
    static func held(_ wire: WireMessage, bodies: [String: BodyState], now: Date) -> HeldMail {
        if wire.sensitivity.sensitive {
            return HeldMail.protected(id: wire.id, subj: wire.subject,
                                      time: displayTime(wire.date, now: now), seen: !wire.unread)
        }
        return HeldMail(id: wire.id, subj: wire.subject, time: displayTime(wire.date, now: now),
                        content: .plain(body: bodies[wire.id]?.text,
                                        preview: wire.snippet.isEmpty ? nil : wire.snippet),
                        seen: !wire.unread)
    }

    // MARK: - Screener rows

    static func waiting(_ sender: EngineIndex.Sender, mirror: [String: WireMessage],
                        bodies: [String: BodyState], now: Date) -> WaitingSender {
        let representative = mirror[sender.representativeID]
        let name = representative?.from.display ?? sender.key
        return WaitingSender(
            id: sender.representativeID,
            from: name,
            addr: representative?.from.address ?? sender.key,
            initial: initial(of: name),
            time: displayTime(representative?.date, now: now),
            scope: .sender,
            dull: false,
            // No classifier runs in this tier, so there is no suggestion — said with `nil` rather
            // than with a manufactured destination. See `WaitingSender.ai`.
            ai: nil,
            held: bag(sender, mirror: mirror, bodies: bodies, now: now))
    }

    static func screened(_ sender: EngineIndex.Sender, mirror: [String: WireMessage],
                         bodies: [String: BodyState], now: Date) -> ScreenedSender {
        ScreenedSender(sender: mirror[sender.representativeID]?.from.address ?? sender.key,
                       date: dayStamp(mirror[sender.representativeID]?.date),
                       held: bag(sender, mirror: mirror, bodies: bodies, now: now))
    }

    static func spam(_ sender: EngineIndex.Sender, mirror: [String: WireMessage],
                     bodies: [String: BodyState], now: Date) -> SpamSender {
        SpamSender(from: mirror[sender.representativeID]?.from.address ?? sender.key,
                   det: quarantineNote,
                   held: bag(sender, mirror: mirror, bodies: bodies, now: now))
    }

    /// Held mail, oldest first — the order every preview renders, and all of it.
    static func bag(_ sender: EngineIndex.Sender, mirror: [String: WireMessage],
                    bodies: [String: BodyState], now: Date) -> HeldMailbag {
        let all = sender.heldIDs.compactMap { mirror[$0] }.map { held($0, bodies: bodies, now: now) }
        // `heldIDs` is non-empty by construction — a sender exists in the index because a message
        // put it there — but the fallible initialiser is used anyway rather than a `[0]` subscript,
        // because a trap on an empty engine payload is a crash in somebody's mail client.
        return HeldMailbag(all: all) ?? HeldMailbag(HeldMail(id: sender.representativeID, subj: "",
                                                             time: "", content: .plain(body: nil, preview: nil)))
    }

    /// **THERE IS NO FABRICATED VALUE IN THIS FILE, AND THIS NOTE IS WHY THAT IS CHECKABLE.**
    ///
    /// A local install has no classifier: `GET /screener` answers `aiSuggestion: null` and the delta
    /// feed carries no routing decision, so there is no destination, no confidence and no rationale
    /// to state about a waiting sender.
    ///
    /// This used to be a named constant — `.ohbox` with an empty confidence and an empty reason —
    /// because `WaitingSender.ai` was non-optional and the projection had to put *something* there.
    /// It was contained rather than correct: the row still drew a confidence chip for it, the
    /// decision bar still ringed that destination as the suggested one, and "apply all suggestions"
    /// still filed real mail to it. `WaitingSender.ai` is optional now and this projection passes
    /// `nil`, so the absence is representable and every reader has to handle it.
    ///
    /// Nothing replaces the constant. It is named here only so that a future reader who finds this
    /// projection filling a suggestion in again knows the shape was tried and what it cost.

    /// What a quarantined sender's row says. A statement of where the mail is, with no detection
    /// source and no confidence, because this tier computes neither.
    static let quarantineNote = "Held in Quarantine on your server."

    // MARK: - Receipts, grouped by the day they arrived

    static func receiptGroups(_ receipts: [Message], all: [String: WireMessage], now: Date) -> [ReceiptGroup] {
        var order: [String] = []
        var byLabel: [String: [String]] = [:]
        for receipt in receipts {
            let label = dayStamp(all[receipt.id]?.date)
            if byLabel[label] == nil { order.append(label) }
            byLabel[label, default: []].append(receipt.id)
        }
        return order.map { ReceiptGroup(label: $0, itemIDs: byLabel[$0] ?? []) }
    }

    // MARK: - Triage piles

    /// The three piles, from the reader's own triage state on each message.
    ///
    /// The pile NAMES are the app's own vocabulary for `PileKind` and match what the shell has
    /// always called them; the CONTENTS are entirely the engine's. The hint line is empty because
    /// there is no fact behind one.
    static func piles(_ all: [WireMessage], now: Date) -> [TriagePile] {
        var items: [PileKind: [TriageItem]] = [:]
        for wire in all {
            guard let kind = pile(of: wire.triage?.state) else { continue }
            items[kind, default: []].append(TriageItem(
                id: wire.id,
                title: wire.from.display,
                subtitle: wire.subject,
                preview: wire.snippet.isEmpty ? nil : wire.snippet,
                when: wire.triage?.bubbleUpAt.map { "resurfaces \(dayStamp($0))" }))
        }
        return [
            TriagePile(kind: .replyLater, title: "Answer Later", items: items[.replyLater] ?? [], hint: ""),
            TriagePile(kind: .setAside, title: "Parked", items: items[.setAside] ?? [], hint: ""),
            TriagePile(kind: .resurface, title: "Resurface", items: items[.resurface] ?? [], hint: ""),
        ]
    }

    static func pile(of state: String?) -> PileKind? {
        switch state {
        case "reply_later": return .replyLater
        case "set_aside": return .setAside
        case "bubbled_up": return .resurface
        default: return nil
        }
    }

    // MARK: - Order and time

    /// Newest first, ties broken by id descending — the server's own list order.
    static func newestFirst(_ a: WireMessage, _ b: WireMessage) -> Bool {
        let ta = instant(a.date) ?? .distantPast
        let tb = instant(b.date) ?? .distantPast
        if ta != tb { return ta > tb }
        return a.id > b.id
    }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoWhole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func instant(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return iso.date(from: text) ?? isoWhole.date(from: text)
    }

    static let weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    static var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0)!
        return c
    }

    /// The same rule the web client uses: today is a clock time, the last six days are a weekday,
    /// anything older is a date — and a message with no date says nothing rather than guessing.
    static func displayTime(_ raw: String?, now: Date) -> String {
        guard let date = instant(raw) else { return "" }
        let calendar = utc
        let days = calendar.dateComponents([.day],
                                           from: calendar.startOfDay(for: date),
                                           to: calendar.startOfDay(for: now)).day ?? 0
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: date)
        if days == 0 {
            return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        }
        if days >= 1 && days <= 6 {
            return weekdayShort[((parts.weekday ?? 1) - 1) % 7]
        }
        let stamp = "\(parts.day ?? 1) \(monthShort[((parts.month ?? 1) - 1) % 12])"
        let thisYear = calendar.dateComponents([.year], from: now).year
        return parts.year == thisYear ? stamp : "\(stamp) \(parts.year ?? 0)"
    }

    /// A calendar day, for the receipt groups and the screened-on line. Empty for no date.
    static func dayStamp(_ raw: String?) -> String {
        guard let date = instant(raw) else { return "" }
        let parts = utc.dateComponents([.month, .day], from: date)
        return "\(parts.day ?? 1) \(monthShort[((parts.month ?? 1) - 1) % 12])"
    }

    static func initial(of name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }
}

// MARK: - Identity

/// Who this app is signed in as. Read once at start from `GET /mailboxes` — identity, not mail
/// truth, so it is not part of the per-cycle read.
public struct EngineIdentity: Sendable {
    public var address: String
    public var mailboxes: [MailboxAccount]

    public init(address: String = "", mailboxes: [MailboxAccount] = []) {
        self.address = address
        self.mailboxes = mailboxes
    }

    static func from(_ list: WireMailboxList) -> EngineIdentity {
        let accounts = list.items.map { mailbox -> MailboxAccount in
            let domain = mailbox.address.split(separator: "@").last.map(String.init) ?? mailbox.address
            let name = mailbox.displayName?.isEmpty == false ? mailbox.displayName! : domain
            // Both halves are the mailbox's own: what the person called it, and the protocol it
            // speaks. The sample world's "Work · IMAP" is the same shape with invented words in it.
            return MailboxAccount(address: mailbox.address,
                                  kind: "\(name) · \(mailbox.provider.uppercased())",
                                  shortName: domain)
        }
        return EngineIdentity(address: list.items.first?.address ?? "", mailboxes: accounts)
    }
}

// MARK: - The index

/// What the projection learned that is not renderable but IS needed to act.
///
/// It exists so that `EngineSource` never has to re-derive the sender grouping in order to map an
/// intent onto the wire. Two implementations of that bucketing would agree until the day they did
/// not, and the symptom would be a decision applied to the wrong sender's mail.
public struct EngineIndex: Sendable {
    public enum Segment: Sendable { case waiting, screened, spam }

    public struct Sender: Sendable {
        /// The address, case-folded — the same key the server groups by.
        public let key: String
        /// The newest held message. This is the id `POST /screener/:id` resolves.
        public let representativeID: String
        /// Every held message, oldest first. Never a count.
        public var heldIDs: [String]
    }

    public var waiting: [Sender] = []
    public var screened: [Sender] = []
    public var spam: [Sender] = []

    /// The engine's own read state per message, as of the drain this index came from. It is the
    /// "before" a write is measured against.
    public var unreadByID: [String: Bool] = [:]
    public var placeByID: [String: Place] = [:]
    /// Messages in a folder this build has no view for. Named rather than silently dropped.
    public var unplacedIDs: [String] = []

    /// The address, case-folded and trimmed — the same normalisation the server does, so a
    /// decision names the sender the server will resolve.
    public static func senderKey(_ address: String) -> String {
        address.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// Add a message to its sender's bucket. Called in newest-first order, so the first message a
    /// sender contributes is its representative and the held list ends up oldest-first once
    /// reversed on the way out.
    mutating func append(_ wire: WireMessage, to segment: Segment) {
        let key = Self.senderKey(wire.from.address)
        let insert: (inout [Sender]) -> Void = { rows in
            if let i = rows.firstIndex(where: { $0.key == key }) {
                rows[i].heldIDs.insert(wire.id, at: 0)
            } else {
                rows.append(Sender(key: key, representativeID: wire.id, heldIDs: [wire.id]))
            }
        }
        switch segment {
        case .waiting: insert(&waiting)
        case .screened: insert(&screened)
        case .spam: insert(&spam)
        }
    }
}
