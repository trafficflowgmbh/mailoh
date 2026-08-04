import Foundation

/// The demo persona's narrative — the strings that exist because this is a
/// preview, not because a mailbox has them.
///
/// Kept off `MailSource` on purpose. A real source has no compose draft, no
/// pre-filled search query and no caption for an illustration, and giving it slots
/// for them would force it to invent content. Each of these becomes real through
/// its own seam later, or not at all.
public struct PreviewChrome: Sendable {
    public var readsWaterlineMeta: String
    public var streamArtCaption: String
    public var initialSearchQuery: String
    public var composeTo: String
    public var composeSubject: String
    public var composeDraft: String
    public var composeGrounding: String
    public var notificationsPrivacyNote: String
    public var learnedSuggestion: String
    /// Who the learned-pattern card is about. The card offers to add this person
    /// to VIP; before this existed the name was typed into `SettingsView` three
    /// times, which meant a view knew a demo persona by name.
    public var learnedSuggestionSubject: String

    public static let fixtures = PreviewChrome(
        readsWaterlineMeta: Fixtures.readsWaterline,
        streamArtCaption: Fixtures.readsArtCaption,
        initialSearchQuery: Fixtures.searchInitialQuery,
        composeTo: Fixtures.composeTo,
        composeSubject: Fixtures.composeSubject,
        composeDraft: Fixtures.composeDraft,
        composeGrounding: Fixtures.composeGrounding,
        notificationsPrivacyNote: Fixtures.notificationsPrivacyNote,
        learnedSuggestion: Fixtures.learnedSuggestion,
        learnedSuggestionSubject: Fixtures.learnedSuggestionSubject
    )
}

/// The mail source the app ships against: the fixture world, and every rule that
/// moves mail around inside it.
///
/// This is where the app's actual behaviour lives — lossless screener moves, the
/// "& read" semantics, what an undo puts back. It used to live in `AppState`,
/// which made the shell and the mail inseparable; moving it here is what makes the
/// protocol above a real boundary rather than a label on the same object.
///
/// Everything is synchronous and cannot fail, because a fixture set cannot fail.
/// That is a property of *this* source, not of the seam: `sync` is always
/// `.idle`, every body is `.available`, and the only intent ever refused is a
/// `.reverse` of something not on record.
@MainActor
public final class FixtureSource: MailSource {

    private var world: MailWorld
    private weak var sink: (any MailSourceSink)?
    private var seq = 0

    /// What it takes to undo each applied intent, by receipt.
    ///
    /// A fixture world can be put back exactly, so this keeps whole values — the
    /// sender as it was, the row it sat at. That is legitimate *here* and is
    /// precisely what a real source could not do, which is why it is behind the
    /// protocol instead of in front of it. The shell holds only the receipt.
    private var journal: [String: Reversal] = [:]

    private enum Reversal {
        case decision(sender: WaitingSender, index: Int, dest: Destination, newID: String?)
        case allow(sender: ScreenedSender, index: Int, newIDs: [String], dest: Destination)
        case notSpam(sender: SpamSender, index: Int, newIDs: [String], backWaitingID: String?)
        case deleteSpam(sender: SpamSender, index: Int)
        case markSeen(message: String)
        case tag(message: String, tag: TagID, wasOn: Bool)
        case pileAdd(PileKind, id: String)
        case pileRemove(PileKind, item: TriageItem, index: Int)
        case draft(message: String, previous: String?)
        case vip(String)
        case notification(id: String, wasOn: Bool)
    }

    /// - Parameter shaping: a last edit to the fixture world before anyone sees it.
    ///   `--shot` uses it to render a shorter Reads stream; nothing in the app does.
    public nonisolated init(shaping: (inout MailWorld) -> Void = { _ in }) {
        var w = MailWorld()
        w.ohbox = Fixtures.ohbox()
        w.reads = Fixtures.reads()
        w.receipts = Fixtures.receipts()
        w.receiptGroups = Fixtures.receiptGroups()
        w.readsBodies = Fixtures.readsBodies().mapValues { .available($0) }
        w.receiptsBodies = Fixtures.receiptsBodies().mapValues { .available($0) }
        w.waiting = Fixtures.waiting()
        w.screened = Fixtures.screened()
        w.spam = Fixtures.spam()
        w.tagsByID = Fixtures.tags()
        w.piles = Fixtures.piles()
        w.notificationSettings = Fixtures.notificationSettings()
        w.vips = Fixtures.vips()
        w.mailboxes = Fixtures.mailboxes()
        w.ownerAddress = Fixtures.ownerAddress
        shaping(&w)
        world = w
    }

    // MARK: - MailSource

    public func openingWorld() -> MailWorld { world }

    @discardableResult
    public func start(sink: any MailSourceSink) -> SyncState {
        self.sink = sink
        // Nothing to sync and nothing to wait for. A source with a mailbox behind
        // it would report `.syncing` here and push when the first pass lands.
        return .idle(lastCompleted: nil)
    }

    public func bodyState(for id: String, in place: Place) -> BodyState {
        switch place {
        case .reads: return world.readsBodies[id] ?? .notFetched
        case .receipts: return world.receiptsBodies[id] ?? .notFetched
        case .ohbox: return world.ohbox.first { $0.id == id }?.body.map { .available($0) } ?? .notFetched
        }
    }

    /// Fixtures are already whole, so there is never anything to fetch. A source
    /// with a server behind it would start a fetch here and push `.fetching`, then
    /// `.available` or `.failed`.
    public func requestBody(for id: String, in place: Place) {}

    @discardableResult
    public func apply(_ intent: MailIntent) -> IntentOutcome {
        let outcome = perform(intent)
        if case .applied = outcome { sink?.worldDidChange(world) }
        return outcome
    }

    // MARK: - Applying an intent

    private func perform(_ intent: MailIntent) -> IntentOutcome {
        switch intent {
        case .decide(let addr, let scope, let dest, let markRead):
            return decide(addr, scope: scope, to: dest, markRead: markRead)
        case .allow(let addr, let dest):
            return allow(addr, to: dest)
        case .notSpam(let addr, let target):
            return notSpam(addr, to: target)
        case .deleteSpam(let addr):
            return deleteSpam(addr)
        case .setScope(let addr, let scope):
            guard let i = world.waiting.firstIndex(where: { $0.addr == addr }) else { return gone("sender") }
            world.waiting[i].scope = scope
            return .applied(IntentAck())            // a pending rule's shape; nothing to undo
        case .markSeen(let id):
            return markSeen(id)
        case .setTag(let id, let tag, let on):
            return setTag(id, tag, on)
        case .addToPile(let kind, let item):
            return addToPile(kind, item)
        case .removeFromPile(let kind, let id):
            return removeFromPile(kind, id)
        case .saveDraft(let id, let text):
            return saveDraft(id, text)
        case .addVIP(let name):
            guard !world.vips.contains(name) else { return .applied(IntentAck()) }
            world.vips.insert(name, at: 0)
            return .applied(IntentAck(affected: 1, receipt: record(.vip(name))))
        case .setNotification(let id, let on):
            guard let i = world.notificationSettings.firstIndex(where: { $0.id == id }) else {
                return gone("notification setting")
            }
            let was = world.notificationSettings[i].on
            world.notificationSettings[i].on = on
            return .applied(IntentAck(affected: was == on ? 0 : 1,
                                      receipt: record(.notification(id: id, wasOn: was))))
        case .reverse(let receipt):
            return reverse(receipt)
        }
    }

    /// File a waiting sender to a destination.
    ///
    /// Lossless by construction: **every** held message travels, keeping its id,
    /// subject, time, trackers and read state. Filing to a mail place produces one
    /// row whose `earlier` array carries the rest of the thread (so the thread
    /// badge is derived from mail that is actually rendered); Screen out and Spam
    /// keep the whole `HeldMailbag`.
    ///
    /// `markRead` (the ✓ "& read" half) marks every held message seen *before* the
    /// move, which is what makes "& read" mean the same thing at all five
    /// destinations — including Screen out and Spam, where there is no unread count
    /// but there is still read state.
    private func decide(_ addr: String, scope: Scope, to dest: Destination, markRead: Bool) -> IntentOutcome {
        guard let idx = world.waiting.firstIndex(where: { $0.addr == addr }) else { return gone("sender") }
        var sender = world.waiting.remove(at: idx)
        // The rule's shape travels with the intent, so a decision bar that changed
        // the scope and filed in one gesture cannot file under the stale one.
        sender.scope = scope
        let bag = markRead ? sender.held.markingAllSeen() : sender.held
        var newID: String?

        if let place = dest.asPlace {
            let nid = "scn\(nextSeq())-\(sender.id)"
            newID = nid
            let rationale = "\(dest.done) — you said Yes to \(sender.addr) in the Screener"
            let it = row(id: nid, place: place, from: sender.from, addr: sender.addr,
                         time: sender.time, bag: bag, rationale: rationale, read: markRead)
            switch place {
            case .ohbox:
                if markRead { insertSeen(&world.ohbox, it) } else { world.ohbox.insert(it, at: 0) }
            case .reads:
                world.readsBodies[nid] = .available(bag.joinedBody(redactedNote: Copy.protectedRedactedBody))
                if markRead { insertSeen(&world.reads, it) } else { world.reads.insert(it, at: 0) }
            case .receipts:
                world.receiptsBodies[nid] = .available(bag.joinedBody(redactedNote: Copy.protectedRedactedBody))
                world.receipts.insert(it, at: 0)
                if !world.receiptGroups.isEmpty { world.receiptGroups[0].itemIDs.insert(nid, at: 0) }
            }
        } else if dest == .screened {
            world.screened.insert(ScreenedSender(sender: sender.addr, date: "today", held: bag,
                                                 fromWaitingID: sender.id), at: 0)
        } else {
            world.spam.insert(SpamSender(from: sender.addr, det: "marked spam by you", held: bag,
                                         fromWaitingID: sender.id), at: 0)
        }

        let receipt = record(.decision(sender: sender, index: idx, dest: dest, newID: newID))
        return .applied(IntentAck(affected: 1, createdIDs: [newID].compactMap { $0}, receipt: receipt))
    }

    /// One mail row standing for a whole held bag: the newest message is the row's
    /// own content, the rest ride along in `earlier` and are all rendered.
    private func row(id: String, place: Place, from: String, addr: String, time: String,
                     bag: HeldMailbag, rationale: String, read: Bool) -> Message {
        let all = bag.all
        let newest = all[all.count - 1]
        var it = Message(id: id, place: place, from: from, addr: addr, subj: newest.subj, time: time,
                         content: newest.content, earlier: Array(all.dropLast()),
                         rationale: rationale)
        it.tracker = newest.trackers
        if read { it.seen = true } else { it.unread = true }
        return it
    }

    /// Allowing a screened sender **releases the held mail**: every held message
    /// becomes a real item in the chosen view. It is a move, and it is undoable.
    private func allow(_ addr: String, to dest: Destination) -> IntentOutcome {
        guard let index = world.screened.firstIndex(where: { $0.sender == addr }) else { return gone("sender") }
        let s = world.screened.remove(at: index)
        var newIDs: [String] = []
        let rationale = "\(dest.done) — you allowed \(s.sender) in the Screener"
        // Oldest first, so the newest ends up on top of the list.
        for h in s.held.all {
            let nid = "allow\(nextSeq())-\(h.id)"
            newIDs.append(nid)
            var it = Message(id: nid, place: dest == .reads ? .reads : .ohbox,
                             from: s.sender, addr: s.sender, subj: h.subj, time: h.time,
                             content: h.content, rationale: rationale)
            it.tracker = h.trackers
            it.unread = !h.seen
            it.seen = h.seen
            switch dest {
            case .reads:
                world.readsBodies[nid] = .available(h.body ?? Copy.protectedRedactedBody)
                if h.seen { insertSeen(&world.reads, it) } else { world.reads.insert(it, at: 0) }
            default:
                if h.seen { insertSeen(&world.ohbox, it) } else { world.ohbox.insert(it, at: 0) }
            }
        }
        let receipt = record(.allow(sender: s, index: index, newIDs: newIDs, dest: dest))
        return .applied(IntentAck(affected: newIDs.count, createdIDs: newIDs, receipt: receipt))
    }

    /// "Not spam" is also a move: the held mail goes where you send it, whole.
    private func notSpam(_ addr: String, to target: NotSpamTarget) -> IntentOutcome {
        guard let index = world.spam.firstIndex(where: { $0.from == addr }) else { return gone("sender") }
        let s = world.spam.remove(at: index)
        var newIDs: [String] = []
        var backWaitingID: String?

        switch target {
        case .ohbox:
            let rationale = "Ohbox — you marked this not spam"
            for h in s.held.all {
                let nid = "ns\(nextSeq())-\(h.id)"
                newIDs.append(nid)
                var it = Message(id: nid, place: .ohbox, from: s.from, addr: s.from,
                                 subj: h.subj, time: h.time, content: h.content, rationale: rationale)
                it.tracker = h.trackers
                it.unread = !h.seen
                it.seen = h.seen
                if h.seen { insertSeen(&world.ohbox, it) } else { world.ohbox.insert(it, at: 0) }
            }
        case .screener:
            let wid = "w\(nextSeq())"
            backWaitingID = wid
            world.waiting.append(WaitingSender(id: wid, from: s.from, addr: s.from,
                                               initial: String(s.from.prefix(1)).uppercased(),
                                               time: s.time, scope: .sender, dull: true,
                                               ai: AISuggestion(dest: .screened, conf: "0.97", why: s.det),
                                               held: s.held))
        }
        let receipt = record(.notSpam(sender: s, index: index, newIDs: newIDs,
                                      backWaitingID: backWaitingID))
        return .applied(IntentAck(affected: max(newIDs.count, 1), createdIDs: newIDs, receipt: receipt))
    }

    private func deleteSpam(_ addr: String) -> IntentOutcome {
        guard let index = world.spam.firstIndex(where: { $0.from == addr }) else { return gone("sender") }
        let s = world.spam.remove(at: index)
        return .applied(IntentAck(affected: 1, receipt: record(.deleteSpam(sender: s, index: index))))
    }

    /// Marking seen fades the dot in place (no reshuffle) and ticks the "new" count
    /// down by one. Idempotent — a message already read stays put and the count does
    /// not double-decrement. Never touches Ohbox (its unread count is an invariant
    /// across reading).
    private func markSeen(_ id: String) -> IntentOutcome {
        if let i = world.reads.firstIndex(where: { $0.id == id }), world.reads[i].unread {
            world.reads[i].unread = false
            return .applied(IntentAck(affected: 1, receipt: record(.markSeen(message: id))))
        }
        if let i = world.receipts.firstIndex(where: { $0.id == id }), world.receipts[i].unread {
            world.receipts[i].unread = false
            return .applied(IntentAck(affected: 1, receipt: record(.markSeen(message: id))))
        }
        return .applied(IntentAck())
    }

    private func setTag(_ id: String, _ tag: TagID, _ on: Bool) -> IntentOutcome {
        var arr = world.tagsByID[id] ?? []
        let wasOn = arr.contains(tag)
        if on, !wasOn { arr.append(tag) }
        if !on, let i = arr.firstIndex(of: tag) { arr.remove(at: i) }
        world.tagsByID[id] = arr
        return .applied(IntentAck(affected: wasOn == on ? 0 : 1,
                                  receipt: record(.tag(message: id, tag: tag, wasOn: wasOn))))
    }

    private func addToPile(_ kind: PileKind, _ item: TriageItem) -> IntentOutcome {
        guard let i = world.piles.firstIndex(where: { $0.kind == kind }) else { return gone("pile") }
        guard !world.piles[i].items.contains(where: { $0.id == item.id }) else {
            return .applied(IntentAck())            // already queued; not a change
        }
        world.piles[i].items.append(item)
        return .applied(IntentAck(affected: 1, receipt: record(.pileAdd(kind, id: item.id))))
    }

    private func removeFromPile(_ kind: PileKind, _ id: String) -> IntentOutcome {
        guard let i = world.piles.firstIndex(where: { $0.kind == kind }),
              let j = world.piles[i].items.firstIndex(where: { $0.id == id }) else {
            return .applied(IntentAck())
        }
        let item = world.piles[i].items.remove(at: j)
        return .applied(IntentAck(affected: 1, receipt: record(.pileRemove(kind, item: item, index: j))))
    }

    private func saveDraft(_ id: String, _ text: String) -> IntentOutcome {
        let previous = world.drafts[id]
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Whitespace is not a draft. Nothing is fabricated from an empty box.
        world.drafts[id] = trimmed.isEmpty ? nil : trimmed
        return .applied(IntentAck(affected: trimmed.isEmpty ? 0 : 1,
                                  receipt: record(.draft(message: id, previous: previous))))
    }

    // MARK: - Reversal

    /// Every branch is a *move back*, never a delete.
    private func reverse(_ receipt: Receipt) -> IntentOutcome {
        guard let entry = journal.removeValue(forKey: receipt.id) else {
            // The honest answer when the record is gone. A source with a mailbox
            // behind it reaches this far more often than fixtures ever will.
            return .refused(SourceFailure(kind: .unsupported,
                                          reason: "That change is no longer on record — it cannot be taken back.",
                                          isRetryable: false))
        }
        switch entry {
        case .decision(let sender, let index, let dest, let newID):
            switch dest {
            case .ohbox: removeByID(&world.ohbox, newID)
            case .reads: removeByID(&world.reads, newID); if let n = newID { world.readsBodies[n] = nil }
            case .receipts:
                removeByID(&world.receipts, newID)
                if let n = newID {
                    world.receiptsBodies[n] = nil
                    if !world.receiptGroups.isEmpty { world.receiptGroups[0].itemIDs.removeAll { $0 == n } }
                }
            case .screened: world.screened.removeAll { $0.fromWaitingID == sender.id }
            case .spam: world.spam.removeAll { $0.fromWaitingID == sender.id }
            }
            world.waiting.insert(sender, at: min(index, world.waiting.count))

        case .allow(let sender, let index, let newIDs, let dest):
            for id in newIDs {
                switch dest {
                case .ohbox: removeByID(&world.ohbox, id)
                case .reads: removeByID(&world.reads, id); world.readsBodies[id] = nil
                default: break
                }
            }
            world.screened.insert(sender, at: min(index, world.screened.count))

        case .notSpam(let sender, let index, let newIDs, let backWaitingID):
            for id in newIDs { removeByID(&world.ohbox, id) }
            if let w = backWaitingID { world.waiting.removeAll { $0.id == w } }
            world.spam.insert(sender, at: min(index, world.spam.count))

        case .deleteSpam(let sender, let index):
            world.spam.insert(sender, at: min(index, world.spam.count))

        case .markSeen(let id):
            if let i = world.reads.firstIndex(where: { $0.id == id }) { world.reads[i].unread = true }
            if let i = world.receipts.firstIndex(where: { $0.id == id }) { world.receipts[i].unread = true }

        case .tag(let id, let tag, let wasOn):
            var arr = world.tagsByID[id] ?? []
            if wasOn, !arr.contains(tag) { arr.append(tag) }
            if !wasOn, let i = arr.firstIndex(of: tag) { arr.remove(at: i) }
            world.tagsByID[id] = arr

        case .pileAdd(let kind, let id):
            if let i = world.piles.firstIndex(where: { $0.kind == kind }) {
                world.piles[i].items.removeAll { $0.id == id }
            }
        case .pileRemove(let kind, let item, let index):
            if let i = world.piles.firstIndex(where: { $0.kind == kind }) {
                world.piles[i].items.insert(item, at: min(index, world.piles[i].items.count))
            }
        case .draft(let id, let previous):
            world.drafts[id] = previous
        case .vip(let name):
            world.vips.removeAll { $0 == name }
        case .notification(let id, let wasOn):
            if let i = world.notificationSettings.firstIndex(where: { $0.id == id }) {
                world.notificationSettings[i].on = wasOn
            }
        }
        return .applied(IntentAck(affected: 1))
    }

    // MARK: - Helpers

    private func nextSeq() -> Int { seq += 1; return seq }

    private func record(_ reversal: Reversal) -> Receipt {
        let receipt = Receipt(id: "r\(nextSeq())")
        journal[receipt.id] = reversal
        return receipt
    }

    /// The refusal a source gives when the thing named is not there any more. On
    /// fixtures this is unreachable in normal use; against a mailbox it is Tuesday.
    private func gone(_ what: String) -> IntentOutcome {
        .refused(SourceFailure(kind: .server,
                               reason: "That \(what) is no longer there — it may have moved elsewhere.",
                               isRetryable: false))
    }

    private func insertSeen(_ arr: inout [Message], _ it: Message) {
        if let i = arr.firstIndex(where: { $0.seen }) { arr.insert(it, at: i) } else { arr.append(it) }
    }

    private func removeByID(_ arr: inout [Message], _ id: String?) {
        guard let id else { return }
        arr.removeAll { $0.id == id }
    }
}
