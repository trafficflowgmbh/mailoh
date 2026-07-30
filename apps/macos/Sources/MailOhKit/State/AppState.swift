import SwiftUI
import Observation

/// A single screener decision, captured so it can be undone as a unit (bulk
/// actions undo as one). Carries the sender *whole* — every held message, with its
/// identity, content and read state — so an undo restores the exact prior world.
public struct DecisionSnapshot: Sendable {
    public let sender: WaitingSender
    public let index: Int
    public let dest: Destination
    public let read: Bool
    public var newID: String?
}

/// Every reversible operation in the app, typed. The toast's Undo runs exactly
/// one of these and then forgets it — there is no "wired per action" placeholder
/// and no snapshot that gets dropped on the floor.
public enum UndoOp: Sendable {
    case decisions([DecisionSnapshot])
    case allow(sender: ScreenedSender, index: Int, newIDs: [String], dest: Destination)
    case notSpam(sender: SpamSender, index: Int, newIDs: [String], backWaitingID: String?)
    case deleteSpam(sender: SpamSender, index: Int)

    /// How many mail items the undo puts back — used by the toast's own copy.
    public var count: Int {
        switch self {
        case .decisions(let s): return s.count
        default: return 1
        }
    }
}

/// Where "Not spam" puts the mail.
public enum NotSpamTarget: Sendable { case screener, ohbox }

public struct ToastState: Equatable, Sendable {
    public var message: String
    public var actionLabel: String?
    public let token: Int   // forces re-fire even on identical text
}

/// The whole app's live state and logic. Fixtures-only for the Tier-1 preview;
/// the real IMAP/sync engine wires in behind this same surface later. Deliberately
/// framework-light so `MailOhKitTests` can drive every rule without SwiftUI.
///
/// **Views never see `Fixtures`.** Everything a view renders — mail, counts, the
/// rail's mailbox list, the owner address, the waterline meta, the pre-filled
/// search query, the compose draft — is a property here. Swapping fixtures for the
/// engine is a change to `init` and nothing else.
@Observable
@MainActor
public final class AppState {

    // MARK: Navigation & selection
    public var route: Route = .ohbox
    public var selectedOhboxID: String = "giulia"
    public var streamReadsCur: String?
    public var streamReceiptsCur: String?
    public var scnSelWaiting: String?
    public var scnSelScreened: String?
    public var scnSelSpam: String?

    // MARK: Overlays / transient UI
    public var isReading = false
    public var isPaletteOpen = false
    public var isFocusReplyOpen = false
    public var isAboutOpen = false
    public var tagPickerFor: String?
    public var focusReplyIndex = 0
    public var themePref: ThemePreference = .system
    public var readsChipState: ReadsChip = .pending
    public var toast: ToastState?
    /// What the toast's Undo will do. Cleared the moment it runs, so one toast can
    /// never undo twice.
    public var pendingUndo: UndoOp?

    // MARK: Compact (≤900pt) navigation — the drawer + the single-pane detail
    /// The rail becomes an off-canvas drawer below the breakpoint.
    public var isRailOpen = false
    /// The Screener's preview + decision bar, presented full-screen in compact.
    public var isScreenerDetailOpen = false

    public enum ReadsChip: Sendable { case pending, approved, corrected }

    // MARK: Mail
    public var ohbox: [Message] { didSet { mailVersion += 1 } }
    public var reads: [Message] { didSet { mailVersion += 1 } }
    public var receipts: [Message] { didSet { mailVersion += 1 } }
    public var receiptGroups: [ReceiptGroup]
    public var readsBodies: [String: String] { didSet { mailVersion += 1 } }
    public var receiptsBodies: [String: String] { didSet { mailVersion += 1 } }

    // MARK: Screener
    public var waiting: [WaitingSender]
    public var screened: [ScreenedSender]
    public var spam: [SpamSender]

    // MARK: Cross-cutting + triage
    public var tagsByID: [String: [TagID]]
    /// **The single source of truth for triage.** Counts, the rail badges, the
    /// Triage cards and the Reply Run queue are all derived from this.
    public var piles: [TriagePile]
    /// Drafts saved from Reply Run, by the mail's id. Nothing is ever sent
    /// here — this build has no network — so a saved draft is exactly that.
    public var drafts: [String: String] = [:]

    // MARK: Reads / Receipts stream UI (owned here so the keyboard map can drive it)
    /// Cards the reader has expanded. Lives in state, not in `StreamView`, because
    /// `↵` is a global key and has to reach it.
    public var streamExpanded: Set<String> = []
    private var scrollRequestReads: String?
    private var scrollRequestReceipts: String?

    // MARK: Settings
    public var notificationSettings: [NotificationSetting]
    public var vips: [String]
    public var learnedDismissed = false
    public let mailboxes: [MailboxAccount]

    // MARK: Preview content the chrome renders (engine replaces these wholesale)
    public let railMailboxes: [MailboxAccount]
    public let ownerAddress: String
    public let readsWaterlineMeta: String
    public let streamArtCaption: String
    public let initialSearchQuery: String
    public let composeTo: String
    public let composeSubject: String
    public let composeDraft: String
    public let composeGrounding: String
    public let notificationsPrivacyNote: String
    public let learnedSuggestion: String

    private var seq = 0
    private var toastSeq = 0
    /// Bumped by every change to mail text; the search index rebuilds when stale.
    private var mailVersion = 0
    private var indexVersion = -1
    private var cachedIndex = SearchIndex(entries: [])

    public init() {
        ohbox = Fixtures.ohbox()
        reads = Fixtures.reads()
        receipts = Fixtures.receipts()
        receiptGroups = Fixtures.receiptGroups()
        readsBodies = Fixtures.readsBodies()
        receiptsBodies = Fixtures.receiptsBodies()
        waiting = Fixtures.waiting()
        screened = Fixtures.screened()
        spam = Fixtures.spam()
        tagsByID = Fixtures.tags()
        piles = Fixtures.piles()
        notificationSettings = Fixtures.notificationSettings()
        vips = Fixtures.vips()
        mailboxes = Fixtures.mailboxes()
        railMailboxes = Fixtures.mailboxesRail()
        ownerAddress = Fixtures.ownerAddress
        readsWaterlineMeta = Fixtures.readsWaterline
        streamArtCaption = Fixtures.readsArtCaption
        initialSearchQuery = Fixtures.searchInitialQuery
        composeTo = Fixtures.composeTo
        composeSubject = Fixtures.composeSubject
        composeDraft = Fixtures.composeDraft
        composeGrounding = Fixtures.composeGrounding
        notificationsPrivacyNote = Fixtures.notificationsPrivacyNote
        learnedSuggestion = Fixtures.learnedSuggestion
        streamReadsCur = reads.first(where: { !$0.seen })?.id ?? reads.first?.id
        streamReceiptsCur = receipts.first?.id
        scnSelWaiting = waiting.first?.id
        scnSelScreened = screened.first?.id
        scnSelSpam = spam.first?.id
    }

    // MARK: - Derived counts (single source of truth = the arrays)

    /// Ohbox rail badge = unread. Reading in the Ohbox is non-destructive (the
    /// prototype never marks Ohbox mail seen on open), so this only moves on
    /// screener decisions.
    public var ohboxUnread: Int { ohbox.filter { $0.unread }.count }
    public var ohboxTotal: Int { ohbox.count }
    /// Reads / Receipts badges = "new" (unread) — decremented as the stream is scrolled past.
    public var readsNew: Int { reads.filter { $0.unread }.count }
    public var receiptsNew: Int { receipts.filter { $0.unread }.count }
    public var screenerWaiting: Int { waiting.count }

    public func count(for seg: ScreenerSeg) -> Int {
        switch seg {
        case .waiting: return waiting.count
        case .screened: return screened.count
        case .spam: return spam.count
        }
    }

    // MARK: - Lookups

    public func message(_ id: String) -> Message? {
        ohbox.first { $0.id == id } ?? reads.first { $0.id == id } ?? receipts.first { $0.id == id }
    }
    public var selectedOhbox: Message? { ohbox.first { $0.id == selectedOhboxID } ?? ohbox.first }

    // MARK: - Seen semantics (Reads · Receipts stream + rows)

    /// Marking seen fades the dot in place (no reshuffle) and ticks the "new"
    /// count down by one. Idempotent — a message already read stays put and the
    /// count does not double-decrement. Never touches Ohbox (its unread count is
    /// an invariant across reading).
    @discardableResult
    public func markSeen(_ id: String) -> Bool {
        if let i = reads.firstIndex(where: { $0.id == id }), reads[i].unread {
            reads[i].unread = false
            return true
        }
        if let i = receipts.firstIndex(where: { $0.id == id }), receipts[i].unread {
            receipts[i].unread = false
            return true
        }
        return false
    }

    // MARK: - Screener decisions

    private func nextSeq() -> Int { seq += 1; return seq }

    /// File a waiting sender to a destination.
    ///
    /// Lossless by construction: **every** held message travels, keeping its id,
    /// subject, time, trackers and read state. Filing to a mail place produces one
    /// row whose `earlier` array carries the rest of the thread (so the thread
    /// badge is derived from mail that is actually rendered); Screen out and Spam
    /// keep the whole `HeldMailbag`.
    ///
    /// `read == true` (the ✓ "& read" half) marks every held message seen *before*
    /// the move, which is what makes "& read" mean the same thing at all five
    /// destinations — including Screen out and Spam, where there is no unread
    /// count but there is still read state.
    @discardableResult
    public func decide(_ sender: WaitingSender, to dest: Destination, read: Bool, quiet: Bool = false) -> DecisionSnapshot? {
        guard let idx = waiting.firstIndex(where: { $0.id == sender.id }) else { return nil }
        waiting.remove(at: idx)
        var snap = DecisionSnapshot(sender: sender, index: idx, dest: dest, read: read, newID: nil)
        let bag = read ? sender.held.markingAllSeen() : sender.held
        let scopeTxt = sender.scope == .domain ? "the whole domain @" + domain(sender.addr) : sender.addr

        if let place = dest.asPlace {
            let nid = "scn\(nextSeq())-\(sender.id)"
            snap.newID = nid
            let rationale = "\(dest.done) — you said Yes to \(sender.addr) in the Screener"
            let it = message(id: nid, place: place, from: sender.from, addr: sender.addr,
                             time: sender.time, bag: bag, rationale: rationale, read: read)
            switch place {
            case .ohbox:
                if read { insertSeen(&ohbox, it) } else { ohbox.insert(it, at: 0) }
            case .reads:
                readsBodies[nid] = bag.joinedBody(redactedNote: Copy.protectedRedactedBody)
                if read { insertSeen(&reads, it) } else { reads.insert(it, at: 0) }
            case .receipts:
                receiptsBodies[nid] = bag.joinedBody(redactedNote: Copy.protectedRedactedBody)
                receipts.insert(it, at: 0)
                if !receiptGroups.isEmpty { receiptGroups[0].itemIDs.insert(nid, at: 0) }
            }
        } else if dest == .screened {
            screened.insert(ScreenedSender(sender: sender.addr, date: "today", held: bag,
                                           fromWaitingID: sender.id), at: 0)
        } else {
            spam.insert(SpamSender(from: sender.addr, det: "marked spam by you", held: bag,
                                   fromWaitingID: sender.id), at: 0)
        }

        // keep selection on the row that slides up into the decided one's place
        scnSelWaiting = waiting.isEmpty ? nil : waiting[min(idx, waiting.count - 1)].id

        if !quiet {
            let readNote = read ? " Held mail marked read." : ""
            let msg: String
            switch dest {
            case .screened: msg = "Screened out — \(scopeTxt).\(readNote)"
            case .spam: msg = "Marked spam — \(sender.addr).\(readNote)"
            default: msg = "\(dest.done) — filed\(read ? " · marked read" : ""). Future mail from \(scopeTxt) files there automatically."
            }
            offer(.decisions([snap]), message: msg)
        }
        return snap
    }

    /// One mail row standing for a whole held bag: the newest message is the row's
    /// own content, the rest ride along in `earlier` and are all rendered.
    private func message(id: String, place: Place, from: String, addr: String, time: String,
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

    /// Apply an undo operation. Every branch is a *move back*, never a delete.
    public func undo(_ op: UndoOp) {
        switch op {
        case .decisions(let snaps):
            for s in snaps.reversed() {
                switch s.dest {
                case .ohbox: removeByID(&ohbox, s.newID)
                case .reads: removeByID(&reads, s.newID); if let n = s.newID { readsBodies[n] = nil }
                case .receipts:
                    removeByID(&receipts, s.newID)
                    if let n = s.newID {
                        receiptsBodies[n] = nil
                        if !receiptGroups.isEmpty { receiptGroups[0].itemIDs.removeAll { $0 == n } }
                    }
                case .screened: screened.removeAll { $0.fromWaitingID == s.sender.id }
                case .spam: spam.removeAll { $0.fromWaitingID == s.sender.id }
                }
                waiting.insert(s.sender, at: min(s.index, waiting.count))
            }
            scnSelWaiting = waiting.first?.id
            showToast("Undone — \(snaps.count) waiting again.")

        case .allow(let sender, let index, let newIDs, let dest):
            for id in newIDs {
                switch dest {
                case .ohbox: removeByID(&ohbox, id)
                case .reads: removeByID(&reads, id); readsBodies[id] = nil
                default: break
                }
            }
            screened.insert(sender, at: min(index, screened.count))
            scnSelScreened = sender.id
            showToast("Undone — \(sender.sender) is screened out again, \(sender.heldCount) held.")

        case .notSpam(let sender, let index, let newIDs, let backWaitingID):
            for id in newIDs { removeByID(&ohbox, id) }
            if let w = backWaitingID { waiting.removeAll { $0.id == w } }
            spam.insert(sender, at: min(index, spam.count))
            scnSelSpam = sender.id
            showToast("Undone — \(sender.from) is back in Spam.")

        case .deleteSpam(let sender, let index):
            spam.insert(sender, at: min(index, spam.count))
            scnSelSpam = sender.id
            showToast("Undone — \(sender.from) is back in Spam, \(sender.heldCount) held.")
        }
    }

    /// Back-compat entry point used by the tests and the keyboard map.
    public func undo(_ snaps: [DecisionSnapshot]) { undo(.decisions(snaps)) }

    /// Run whatever the visible toast offers, exactly once.
    @discardableResult
    public func undoPending() -> Bool {
        guard let op = pendingUndo else {
            showToast("Nothing left to undo.")
            return false
        }
        pendingUndo = nil
        undo(op)
        return true
    }

    /// Show a toast that offers this operation as its Undo.
    private func offer(_ op: UndoOp, message: String) {
        pendingUndo = op
        showToast(message, action: "Undo")
    }

    /// Apply the AI suggestion to every waiting sender (files unread). Returns the
    /// snapshots so a caller can undo the whole batch; the toast already can.
    @discardableResult
    public func applyAllSuggestions() -> [DecisionSnapshot] {
        let items = waiting
        var snaps: [DecisionSnapshot] = []
        for it in items { if let s = decide(it, to: it.ai.dest, read: false, quiet: true) { snaps.append(s) } }
        if !snaps.isEmpty { offer(.decisions(snaps), message: summary(snaps)) }
        return snaps
    }

    @discardableResult
    public func markAllSpam() -> [DecisionSnapshot] {
        let items = waiting
        var snaps: [DecisionSnapshot] = []
        for it in items { if let s = decide(it, to: .spam, read: false, quiet: true) { snaps.append(s) } }
        if !snaps.isEmpty { offer(.decisions(snaps), message: "\(snaps.count) moved to Spam") }
        return snaps
    }

    private func summary(_ snaps: [DecisionSnapshot]) -> String {
        func n(_ d: Destination) -> Int { snaps.filter { $0.dest == d }.count }
        var parts: [String] = []
        if n(.ohbox) > 0 { parts.append("\(n(.ohbox)) to Ohbox") }
        if n(.reads) > 0 { parts.append("\(n(.reads)) to Reads") }
        if n(.receipts) > 0 { parts.append("\(n(.receipts)) to Receipts") }
        if n(.screened) > 0 { parts.append("\(n(.screened)) screened out") }
        if n(.spam) > 0 { parts.append("\(n(.spam)) to Spam") }
        return "\(snaps.count) decided — \(parts.joined(separator: " · "))"
    }

    // MARK: - Screened / Spam actions

    /// Allowing a screened sender **releases the held mail**: every held message
    /// becomes a real item in the chosen view. It is a move, and it is undoable.
    @discardableResult
    public func allowScreened(_ s: ScreenedSender, to dest: Destination) -> [String] {
        guard let index = screened.firstIndex(where: { $0.id == s.id }) else { return [] }
        screened.remove(at: index)
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
                readsBodies[nid] = h.body ?? Copy.protectedRedactedBody
                if h.seen { insertSeen(&reads, it) } else { reads.insert(it, at: 0) }
            default:
                if h.seen { insertSeen(&ohbox, it) } else { ohbox.insert(it, at: 0) }
            }
        }
        scnSelScreened = screened.first?.id
        offer(.allow(sender: s, index: index, newIDs: newIDs, dest: dest),
              message: "Allowed — \(s.heldCount) held message\(s.heldCount == 1 ? "" : "s") released to \(dest.label). Future mail from \(s.sender) goes there.")
        return newIDs
    }

    /// "Not spam" is also a move: the held mail goes where you send it, whole.
    @discardableResult
    public func notSpam(_ s: SpamSender, to target: NotSpamTarget) -> [String] {
        guard let index = spam.firstIndex(where: { $0.id == s.id }) else { return [] }
        spam.remove(at: index)
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
                if h.seen { insertSeen(&ohbox, it) } else { ohbox.insert(it, at: 0) }
            }
            offer(.notSpam(sender: s, index: index, newIDs: newIDs, backWaitingID: nil),
                  message: "Not spam — \(s.heldCount) message\(s.heldCount == 1 ? "" : "s") filed to Ohbox. \(s.from) is allowed now.")
        case .screener:
            let wid = "w\(nextSeq())"
            backWaitingID = wid
            waiting.append(WaitingSender(id: wid, from: s.from, addr: s.from,
                                         initial: String(s.from.prefix(1)).uppercased(),
                                         time: s.time, scope: .sender, dull: true,
                                         ai: AISuggestion(dest: .screened, conf: "0.97", why: s.det),
                                         held: s.held))
            scnSelWaiting = scnSelWaiting ?? wid
            offer(.notSpam(sender: s, index: index, newIDs: [], backWaitingID: backWaitingID),
                  message: "Not spam — \(s.from) is back in Waiting with \(s.heldCount) held.")
        }
        scnSelSpam = spam.first?.id
        return newIDs
    }

    public func deleteSpam(_ s: SpamSender) {
        guard let index = spam.firstIndex(where: { $0.id == s.id }) else { return }
        spam.remove(at: index)
        scnSelSpam = spam.first?.id
        offer(.deleteSpam(sender: s, index: index), message: "Deleted — \(s.from).")
    }

    // MARK: - Tags (cross-cutting)

    public func tags(_ id: String) -> [TagID] { tagsByID[id] ?? [] }

    public func tagged(_ tag: TagID) -> [Message] {
        allItems.filter { (tagsByID[$0.id] ?? []).contains(tag) }
    }
    public func tagCount(_ tag: TagID) -> Int { tagged(tag).count }

    /// Toggle a tag on a message. Returns true if the message now carries it.
    @discardableResult
    public func toggleTag(_ id: String, _ tag: TagID) -> Bool {
        var arr = tagsByID[id] ?? []
        let nowOn: Bool
        if let i = arr.firstIndex(of: tag) { arr.remove(at: i); nowOn = false }
        else { arr.append(tag); nowOn = true }
        tagsByID[id] = arr
        showToast(nowOn ? "Tagged “\(tag.name)”." : "Untagged “\(tag.name)”.")
        return nowOn
    }

    public var allItems: [Message] { ohbox + reads + receipts }

    // MARK: - Search (local, typo-tolerant, off the UI actor)

    /// The index is built once per change to the mail, not once per keystroke.
    var searchIndex: SearchIndex {
        if indexVersion != mailVersion {
            cachedIndex = SearchIndex(items: allItems, bodies: readsBodies.merging(receiptsBodies) { a, _ in a })
            indexVersion = mailVersion
        }
        return cachedIndex
    }

    /// Synchronous search — used by tests and by anything already on the actor.
    public func search(_ raw: String) -> SearchOutcome { searchIndex.search(raw) }

    /// What `SearchView` calls. The scan itself runs off the main actor, so a long
    /// query can never stall a keystroke; the caller debounces.
    public func searchOffActor(_ raw: String) async -> SearchOutcome {
        let index = searchIndex
        return await Task.detached(priority: .userInitiated) { index.search(raw) }.value
    }

    // MARK: - Reply Run (derived from the Answer Later pile)

    /// The queue *is* the pile — completing an item removes it, so reopening a
    /// Reply Run can never re-present something already answered.
    public var focusReplyQueue: [TriageItem] { pile(.replyLater)?.items ?? [] }

    public func startFocusReply() { focusReplyIndex = 0; isFocusReplyOpen = true }
    public func focusReplySkip() { focusReplyIndex += 1 }

    /// Save the typed reply and drop the item from the pile. Nothing is sent: this
    /// build has no mailbox, and the copy says so.
    @discardableResult
    public func saveFocusReplyDraft(_ text: String) -> Bool {
        guard focusReplyIndex < focusReplyQueue.count else { return false }
        let item = focusReplyQueue[focusReplyIndex]
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { drafts[item.id] = trimmed }
        removeFromPile(.replyLater, id: item.id)
        // The pile shrank under the cursor, so the index already points at the next
        // item — advancing here would skip one.
        showToast(trimmed.isEmpty
                  ? "Nothing typed — \(item.title) removed from Answer Later."
                  : "Draft saved for \(item.title) — not sent.")
        return true
    }

    // MARK: - Triage piles (the one source of truth)

    public func pile(_ kind: PileKind) -> TriagePile? { piles.first { $0.kind == kind } }

    private func mutate(_ kind: PileKind, _ body: (inout TriagePile) -> Void) {
        guard let i = piles.firstIndex(where: { $0.kind == kind }) else { return }
        body(&piles[i])
    }

    /// Adds an item if the pile does not already hold that mail. Returns false when
    /// it was already queued, so the caller can say so instead of double-counting.
    @discardableResult
    public func addToPile(_ kind: PileKind, _ item: TriageItem) -> Bool {
        guard pile(kind)?.items.contains(where: { $0.id == item.id }) != true else { return false }
        mutate(kind) { $0.items.append(item) }
        return true
    }

    public func removeFromPile(_ kind: PileKind, id: String) {
        mutate(kind) { $0.items.removeAll { $0.id == id } }
    }

    // MARK: - Message actions (Ohbox reading pane)

    public func replyLater(_ m: Message) {
        let item = TriageItem(id: m.id, title: m.from, subtitle: m.subj, preview: m.preview)
        if addToPile(.replyLater, item) {
            showToast("Queued in Answer Later (\(pileCounts[.replyLater] ?? 0))")
        } else {
            let first = m.from.split(separator: " ").first.map(String.init) ?? m.from
            showToast("\(first) is already queued — Answer Later (\(pileCounts[.replyLater] ?? 0))")
        }
    }

    public func setAside(_ m: Message) {
        let item = TriageItem(id: m.id, title: m.from, subtitle: m.subj)
        showToast(addToPile(.setAside, item) ? "Parked." : "Already parked.")
    }

    public func resurface(_ m: Message) {
        let item = TriageItem(id: m.id, title: m.from, subtitle: m.subj, when: "resurfaces Fri 09:00")
        showToast(addToPile(.resurface, item) ? "Resurfaces Fri 09:00" : "Already scheduled — Fri 09:00")
    }

    // MARK: - Toast

    public func showToast(_ message: String, action: String? = nil) {
        toastSeq += 1
        if action == nil { pendingUndo = nil }
        toast = ToastState(message: message, actionLabel: action, token: toastSeq)
    }

    // MARK: - Helpers

    private func insertSeen(_ arr: inout [Message], _ it: Message) {
        if let i = arr.firstIndex(where: { $0.seen }) { arr.insert(it, at: i) } else { arr.append(it) }
    }
    private func removeByID(_ arr: inout [Message], _ id: String?) {
        guard let id else { return }
        arr.removeAll { $0.id == id }
    }
    private func domain(_ addr: String) -> String { String(addr.split(separator: "@").last ?? "") }

    // MARK: - Stream scroll requests (list column → stream)

    public func scrollRequest(_ place: Place) -> String? {
        place == .receipts ? scrollRequestReceipts : scrollRequestReads
    }
    public func requestScroll(_ place: Place, to id: String) {
        if place == .receipts { scrollRequestReceipts = id } else { scrollRequestReads = id }
    }
    public func clearScrollRequest(_ place: Place) {
        if place == .receipts { scrollRequestReceipts = nil } else { scrollRequestReads = nil }
    }
}

/// Damerau-free Levenshtein edit distance (insert / delete / substitute).
public func editDistance(_ a: String, _ b: String) -> Int {
    let s = Array(a), t = Array(b)
    if s.isEmpty { return t.count }
    if t.isEmpty { return s.count }
    var prev = Array(0...t.count)
    var cur = [Int](repeating: 0, count: t.count + 1)
    for i in 1...s.count {
        cur[0] = i
        for j in 1...t.count {
            let cost = s[i - 1] == t[j - 1] ? 0 : 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        }
        swap(&prev, &cur)
    }
    return prev[t.count]
}

// MARK: - The local index

/// A `Sendable` snapshot of everything searchable, tokenised once. Handing this to
/// a background task is what keeps typing smooth.
///
/// **Protected mail contributes nothing.** The entries are built from
/// `Message.searchableText`, which is derived from `MailContent` — and the
/// protected case has no text to give. A verification code cannot be in this index
/// because it was never stored anywhere.
struct SearchIndex: Sendable {
    struct Entry: Sendable {
        let id: String
        let who: String
        let origin: String
        let subject: String
        let haystack: String
        let words: [String]
    }
    let entries: [Entry]

    init(entries: [Entry]) { self.entries = entries }

    init(items: [Message], bodies: [String: String]) {
        entries = items.map { m in
            let text = [m.from, m.subj, m.searchableText, bodies[m.id] ?? ""]
                .filter { !$0.isEmpty }.joined(separator: " ").lowercased()
            return Entry(id: m.id, who: m.from,
                         origin: "\(m.place.title) · \(m.time)",
                         subject: m.subj, haystack: text,
                         words: text.split { !$0.isLetter && !$0.isNumber }.map(String.init))
        }
    }

    func search(_ raw: String) -> SearchOutcome {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q == "blanc" { return .easterEgg }
        if q.isEmpty { return .empty }

        // 1) exact substring over sender + subject + body + preview
        var hits: [SearchHit] = []
        for e in entries where e.haystack.contains(q) {
            hits.append(SearchHit(id: e.id, who: e.who, origin: e.origin, subject: e.subject,
                                  fuzzy: false, matchTerm: q))
        }
        if !hits.isEmpty { return .results(hits, fuzzy: false) }

        // 2) typo-tolerant: any word within edit distance 1 of the query
        //    ("invoce" → "invoice" is a single insertion → the Erdton invoice).
        //    Length-gated first, so the O(n·m) pass only runs on plausible words.
        for e in entries where e.words.contains(where: {
            abs($0.count - q.count) <= 1 && editDistance($0, q) <= 1
        }) {
            hits.append(SearchHit(id: e.id, who: e.who, origin: e.origin, subject: e.subject,
                                  fuzzy: true, matchTerm: nil))
        }
        return hits.isEmpty ? .empty : .results(hits, fuzzy: true)
    }
}
