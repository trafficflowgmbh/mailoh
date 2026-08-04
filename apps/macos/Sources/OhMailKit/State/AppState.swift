import SwiftUI
import Observation

/// Everything the toast's Undo could put back, as one unit — a bulk screener
/// action undoes as one gesture, not eight.
///
/// It holds **receipts**, not mail. What it takes to reverse an operation is the
/// source's business; the shell only remembers what to ask for and what to say
/// once it lands. See the note at the top of `MailSource.swift` for why the
/// alternative — keeping a copy of the world and writing it back — cannot survive
/// a real mailbox.
public struct UndoOp: Sendable {
    public let receipts: [Receipt]
    /// What the toast says after the undo lands. Composed at the time of the
    /// action, because that is when the shell knew what the action was.
    public let doneMessage: String

    /// How many operations the undo takes back — used by the toast's own copy.
    public var count: Int { receipts.count }

    public init(receipts: [Receipt], doneMessage: String) {
        self.receipts = receipts; self.doneMessage = doneMessage
    }
}

/// Where "Not spam" puts the mail.
public enum NotSpamTarget: Sendable { case screener, ohbox }

public struct ToastState: Equatable, Sendable {
    public var message: String
    public var actionLabel: String?
    public let token: Int   // forces re-fire even on identical text
}

/// The shell: routes, selection, overlays, the toast, the search index, and the
/// copy that describes what just happened.
///
/// **It does not own the mail.** Every mail property below is a projection of the
/// world `MailSource` last reported, and every change to it goes out as a
/// `MailIntent` and comes back as a new world. Which source is behind it is the
/// only thing that changes between this preview and an app pointed at a real
/// account — `MailSource.swift` is where that boundary is described.
///
/// **Views see this and nothing else.** Not the fixtures, not the source, not a
/// string belonging to either. That is a checked property rather than an
/// intention: `OhMailKitTests` reads every file under `Views/` and fails on a
/// fixture type, a fixture string, or a reach for a data source. It is worth
/// checking because it decides whether a real engine can land behind these views
/// without rewriting them — and because it was quietly false, a settings card
/// knowing a demo persona by name, for as long as nobody looked.
@Observable
@MainActor
public final class AppState: MailSourceSink {

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
    /// What the toast's Undo will ask for. Cleared the moment it runs, so one toast
    /// can never undo twice.
    public var pendingUndo: UndoOp?

    // MARK: Compact (≤900pt) navigation — the drawer + the single-pane detail
    /// The rail becomes an off-canvas drawer below the breakpoint.
    public var isRailOpen = false
    /// The Screener's preview + decision bar, presented full-screen in compact.
    public var isScreenerDetailOpen = false

    public enum ReadsChip: Sendable { case pending, approved, corrected }

    // MARK: - The source

    private let source: any MailSource
    /// The mail exactly as the source last reported it. Private: anything that
    /// could reach this could reach past the shell.
    private var world: MailWorld
    /// The preview's own narrative — not mail, and not the source's business.
    private let chrome: PreviewChrome

    /// Where the source stands with the mailbox behind it. Always `.idle` on
    /// fixtures; the surfaces that draw a running sync or a failure arrive with the
    /// source that can actually reach those states.
    public private(set) var syncState: SyncState

    // MARK: - Mail (projections — assign to none of these, send an intent)

    public var ohbox: [Message] { world.ohbox }
    public var reads: [Message] { world.reads }
    public var receipts: [Message] { world.receipts }
    public var receiptGroups: [ReceiptGroup] { world.receiptGroups }

    /// The bodies actually in hand. A body still being fetched is *absent* here
    /// rather than present and empty — ask `bodyState(for:in:)` when a surface has
    /// something honest to draw for the other cases.
    public var readsBodies: [String: String] { world.readsBodies.compactMapValues(\.text) }
    public var receiptsBodies: [String: String] { world.receiptsBodies.compactMapValues(\.text) }

    // MARK: Screener
    public var waiting: [WaitingSender] { world.waiting }
    /// The `choosing` flag — whether this row's destination chooser is open — is
    /// shell state stamped onto the projection, not something the source is told
    /// about. An open menu is not a fact about the mailbox, and it must survive a
    /// world arriving from the source underneath it.
    public var screened: [ScreenedSender] {
        world.screened.map { var s = $0; s.choosing = choosingScreened.contains(s.id); return s }
    }
    public var spam: [SpamSender] {
        world.spam.map { var s = $0; s.choosing = choosingSpam.contains(s.id); return s }
    }
    var choosingScreened: Set<String> = []
    var choosingSpam: Set<String> = []

    // MARK: Cross-cutting + triage
    public var tagsByID: [String: [TagID]] { world.tagsByID }
    /// **The single source of truth for triage.** Counts, the rail badges, the
    /// Triage cards and the Reply Run queue are all derived from this.
    public var piles: [TriagePile] { world.piles }
    /// Drafts saved from Reply Run, by the mail's id. Nothing is ever sent here —
    /// this build has no mailbox — so a saved draft is exactly that.
    public var drafts: [String: String] { world.drafts }

    // MARK: - Reads / Receipts stream UI (owned here so the keyboard map can drive it)
    /// Cards the reader has expanded. Lives in the shell, not in `StreamView`,
    /// because `↵` is a global key and has to reach it.
    public var streamExpanded: Set<String> = []
    private var scrollRequestReads: String?
    private var scrollRequestReceipts: String?

    // MARK: Settings
    public var notificationSettings: [NotificationSetting] { world.notificationSettings }
    public var vips: [String] { world.vips }
    public var learnedDismissed = false
    public var mailboxes: [MailboxAccount] { world.mailboxes }
    /// The rail lists the same accounts Settings does, drawn differently.
    public var railMailboxes: [MailboxAccount] { world.mailboxes }
    public var ownerAddress: String { world.ownerAddress }

    // MARK: Preview chrome (see `PreviewChrome` — none of this is mail)
    public var readsWaterlineMeta: String { chrome.readsWaterlineMeta }
    public var streamArtCaption: String { chrome.streamArtCaption }
    public var initialSearchQuery: String { chrome.initialSearchQuery }
    public var composeTo: String { chrome.composeTo }
    public var composeSubject: String { chrome.composeSubject }
    public var composeDraft: String { chrome.composeDraft }
    public var composeGrounding: String { chrome.composeGrounding }
    public var notificationsPrivacyNote: String { chrome.notificationsPrivacyNote }
    public var learnedSuggestion: String { chrome.learnedSuggestion }
    public var learnedSuggestionSubject: String { chrome.learnedSuggestionSubject }

    private var toastSeq = 0
    /// Bumped by every world the source reports; the search index rebuilds when stale.
    private var worldVersion = 0
    private var indexVersion = -1
    private var cachedIndex = SearchIndex(entries: [])

    public init(source: any MailSource = FixtureSource(), chrome: PreviewChrome = .fixtures) {
        self.source = source
        self.chrome = chrome
        self.world = source.openingWorld()
        self.syncState = .idle(lastCompleted: nil)
        // Attached after full initialization, so `self` can be the sink.
        self.syncState = source.start(sink: self)

        streamReadsCur = world.reads.first(where: { !$0.seen })?.id ?? world.reads.first?.id
        streamReceiptsCur = world.receipts.first?.id
        scnSelWaiting = world.waiting.first?.id
        scnSelScreened = world.screened.first?.id
        scnSelSpam = world.spam.first?.id
    }

    // MARK: - MailSourceSink — the source pushing back

    public func worldDidChange(_ world: MailWorld) {
        self.world = world
        worldVersion += 1
    }

    public func bodyDidChange(id: String, in place: Place, to state: BodyState) {
        switch place {
        case .reads: world.readsBodies[id] = state
        case .receipts: world.receiptsBodies[id] = state
        case .ohbox: break   // Ohbox bodies ride on the message itself
        }
        worldVersion += 1
    }

    public func syncStateDidChange(_ state: SyncState) { syncState = state }

    // MARK: - Bodies

    /// Whether a body is in hand, still coming, or could not be had. `body(for:)`
    /// in `Derived.swift` is the string shim over this; surfaces move across as
    /// each gains something honest to draw for the other cases.
    public func bodyState(for id: String, in place: Place) -> BodyState {
        switch place {
        case .reads: return world.readsBodies[id] ?? source.bodyState(for: id, in: place)
        case .receipts: return world.receiptsBodies[id] ?? source.bodyState(for: id, in: place)
        case .ohbox: return source.bodyState(for: id, in: place)
        }
    }

    /// Ask the source for a body it has not fetched. A no-op against fixtures.
    public func requestBody(for id: String, in place: Place) {
        source.requestBody(for: id, in: place)
    }

    // MARK: - Derived counts (single source of truth = the world)

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

    /// Idempotent: a message already read stays put, and nothing is announced.
    @discardableResult
    public func markSeen(_ id: String) -> Bool {
        guard case .applied(let ack) = source.apply(.markSeen(message: id)) else { return false }
        return ack.affected > 0
    }

    // MARK: - Screener decisions

    /// File a waiting sender. Returns the receipt, so a caller can undo the batch
    /// it belongs to; the toast already can.
    @discardableResult
    public func decide(_ sender: WaitingSender, to dest: Destination,
                       read: Bool, quiet: Bool = false) -> Receipt? {
        guard let idx = waiting.firstIndex(where: { $0.id == sender.id }) else { return nil }
        let scopeTxt = sender.scope == .domain ? "the whole domain @" + domain(sender.addr) : sender.addr

        switch source.apply(.decide(sender: sender.addr, scope: sender.scope,
                                    to: dest, markRead: read)) {
        case .refused(let failure):
            showToast(failure.reason)
            return nil

        case .applied(let ack):
            // keep selection on the row that slides up into the decided one's place
            scnSelWaiting = waiting.isEmpty ? nil : waiting[min(idx, waiting.count - 1)].id

            if !quiet, let receipt = ack.receipt {
                let readNote = read ? " Held mail marked read." : ""
                let msg: String
                switch dest {
                case .screened: msg = "Screened out — \(scopeTxt).\(readNote)"
                case .spam: msg = "Marked spam — \(sender.addr).\(readNote)"
                default: msg = "\(dest.done) — filed\(read ? " · marked read" : ""). Future mail from \(scopeTxt) files there automatically."
                }
                offer(UndoOp(receipts: [receipt], doneMessage: "Undone — 1 waiting again."), message: msg)
            }
            return ack.receipt
        }
    }

    /// Apply the AI suggestion to every waiting sender **that has one** (files unread). Returns the
    /// receipts so a caller can undo the whole batch; the toast already can.
    ///
    /// A sender with no suggestion is skipped and stays waiting, rather than being filed somewhere
    /// chosen by this function. That is the whole of the difference: this used to read
    /// `it.ai.dest` off a non-optional field that a projection with no classifier had filled in to
    /// satisfy the type, so "apply all" moved real mail on a decision nothing had made. The UI does
    /// not offer the control when `hasSuggestions` is false, and this is the same rule stated where
    /// the mail actually moves — a keyboard shortcut, a menu item or a test reaches here without
    /// passing the view.
    @discardableResult
    public func applyAllSuggestions() -> [Receipt] {
        let items = waiting
        var receipts: [Receipt] = []
        var applied: [Destination] = []
        for it in items {
            guard let ai = it.ai else { continue }
            if let r = decide(it, to: ai.dest, read: false, quiet: true) {
                receipts.append(r)
                applied.append(ai.dest)
            }
        }
        if !receipts.isEmpty {
            offer(UndoOp(receipts: receipts, doneMessage: "Undone — \(receipts.count) waiting again."),
                  message: summary(applied))
        }
        return receipts
    }

    @discardableResult
    public func markAllSpam() -> [Receipt] {
        let items = waiting
        var receipts: [Receipt] = []
        for it in items { if let r = decide(it, to: .spam, read: false, quiet: true) { receipts.append(r) } }
        if !receipts.isEmpty {
            offer(UndoOp(receipts: receipts, doneMessage: "Undone — \(receipts.count) waiting again."),
                  message: "\(receipts.count) moved to Spam")
        }
        return receipts
    }

    private func summary(_ dests: [Destination]) -> String {
        func n(_ d: Destination) -> Int { dests.filter { $0 == d }.count }
        var parts: [String] = []
        if n(.ohbox) > 0 { parts.append("\(n(.ohbox)) to Ohbox") }
        if n(.reads) > 0 { parts.append("\(n(.reads)) to Reads") }
        if n(.receipts) > 0 { parts.append("\(n(.receipts)) to Receipts") }
        if n(.screened) > 0 { parts.append("\(n(.screened)) screened out") }
        if n(.spam) > 0 { parts.append("\(n(.spam)) to Spam") }
        return "\(dests.count) decided — \(parts.joined(separator: " · "))"
    }

    // MARK: - Screened / Spam actions

    /// Allowing a screened sender **releases the held mail**: every held message
    /// becomes a real item in the chosen view. It is a move, and it is undoable.
    @discardableResult
    public func allowScreened(_ s: ScreenedSender, to dest: Destination) -> [String] {
        switch source.apply(.allow(sender: s.sender, to: dest)) {
        case .refused(let failure):
            showToast(failure.reason)
            return []
        case .applied(let ack):
            scnSelScreened = screened.first?.id
            if let receipt = ack.receipt {
                offer(UndoOp(receipts: [receipt],
                             doneMessage: "Undone — \(s.sender) is screened out again, \(s.heldCount) held."),
                      message: "Allowed — \(s.heldCount) held message\(s.heldCount == 1 ? "" : "s") released to \(dest.label). Future mail from \(s.sender) goes there.")
            }
            return ack.createdIDs
        }
    }

    /// "Not spam" is also a move: the held mail goes where you send it, whole.
    @discardableResult
    public func notSpam(_ s: SpamSender, to target: NotSpamTarget) -> [String] {
        switch source.apply(.notSpam(sender: s.from, to: target)) {
        case .refused(let failure):
            showToast(failure.reason)
            return []
        case .applied(let ack):
            if target == .screener { scnSelWaiting = scnSelWaiting ?? waiting.last?.id }
            scnSelSpam = spam.first?.id
            if let receipt = ack.receipt {
                let msg = target == .ohbox
                    ? "Not spam — \(s.heldCount) message\(s.heldCount == 1 ? "" : "s") filed to Ohbox. \(s.from) is allowed now."
                    : "Not spam — \(s.from) is back in Waiting with \(s.heldCount) held."
                offer(UndoOp(receipts: [receipt], doneMessage: "Undone — \(s.from) is back in Spam."),
                      message: msg)
            }
            return ack.createdIDs
        }
    }

    public func deleteSpam(_ s: SpamSender) {
        switch source.apply(.deleteSpam(sender: s.from)) {
        case .refused(let failure):
            showToast(failure.reason)
        case .applied(let ack):
            scnSelSpam = spam.first?.id
            if let receipt = ack.receipt {
                offer(UndoOp(receipts: [receipt],
                             doneMessage: "Undone — \(s.from) is back in Spam, \(s.heldCount) held."),
                      message: "Deleted — \(s.from).")
            }
        }
    }

    // MARK: - Undo

    /// Ask the source to take back everything the toast offered.
    ///
    /// Newest first: reversing in the order the operations were applied would ask
    /// the source to put back mail a later operation has since moved again. **The
    /// source is allowed to say no** — a mailbox moves underneath you — and when it
    /// does, its reason is what the reader sees instead of a silent no-op.
    @discardableResult
    public func undo(_ op: UndoOp) -> Bool {
        for receipt in op.receipts.reversed() {
            if case .refused(let failure) = source.apply(.reverse(receipt)) {
                showToast(failure.reason)
                return false
            }
        }
        scnSelWaiting = waiting.first?.id
        scnSelScreened = screened.first?.id
        scnSelSpam = spam.first?.id
        showToast(op.doneMessage)
        return true
    }

    /// Back-compat entry point used by the tests and the keyboard map.
    @discardableResult
    public func undo(_ receipts: [Receipt]) -> Bool {
        undo(UndoOp(receipts: receipts, doneMessage: "Undone — \(receipts.count) waiting again."))
    }

    /// Run whatever the visible toast offers, exactly once.
    @discardableResult
    public func undoPending() -> Bool {
        guard let op = pendingUndo else {
            showToast("Nothing left to undo.")
            return false
        }
        pendingUndo = nil
        return undo(op)
    }

    /// Show a toast that offers this operation as its Undo.
    private func offer(_ op: UndoOp, message: String) {
        pendingUndo = op
        showToast(message, action: "Undo")
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
        let nowOn = !tags(id).contains(tag)
        if case .refused(let failure) = source.apply(.setTag(message: id, tag: tag, on: nowOn)) {
            showToast(failure.reason)
            return !nowOn
        }
        showToast(nowOn ? "Tagged “\(tag.name)”." : "Untagged “\(tag.name)”.")
        return nowOn
    }

    public var allItems: [Message] { ohbox + reads + receipts }

    // MARK: - Search (local, typo-tolerant, off the UI actor)

    /// The index is built once per change to the mail, not once per keystroke.
    var searchIndex: SearchIndex {
        if indexVersion != worldVersion {
            cachedIndex = SearchIndex(items: allItems,
                                      bodies: readsBodies.merging(receiptsBodies) { a, _ in a })
            indexVersion = worldVersion
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
        source.apply(.saveDraft(message: item.id, text: text))
        source.apply(.removeFromPile(.replyLater, message: item.id))
        // The pile shrank under the cursor, so the index already points at the next
        // item — advancing here would skip one.
        showToast(trimmed.isEmpty
                  ? "Nothing typed — \(item.title) removed from Answer Later."
                  : "Draft saved for \(item.title) — not sent.")
        return true
    }

    // MARK: - Triage piles (the one source of truth)

    public func pile(_ kind: PileKind) -> TriagePile? { piles.first { $0.kind == kind } }

    /// Adds an item if the pile does not already hold that mail. Returns false when
    /// it was already queued, so the caller can say so instead of double-counting.
    @discardableResult
    public func addToPile(_ kind: PileKind, _ item: TriageItem) -> Bool {
        guard case .applied(let ack) = source.apply(.addToPile(kind, item)) else { return false }
        return ack.affected > 0
    }

    public func removeFromPile(_ kind: PileKind, id: String) {
        source.apply(.removeFromPile(kind, message: id))
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

    // MARK: - Settings

    /// Accept the learned-pattern card. Who it is about comes from the card's own
    /// content, never from the view that draws it.
    public func acceptLearnedSuggestion() {
        learnedDismissed = true
        let who = learnedSuggestionSubject
        if case .refused(let failure) = source.apply(.addVIP(who)) {
            showToast(failure.reason)
            return
        }
        showToast("\(who) added to VIP.")
    }

    public func dismissLearnedSuggestion() {
        learnedDismissed = true
        let first = learnedSuggestionSubject.split(separator: " ").first.map(String.init)
            ?? learnedSuggestionSubject
        showToast("Dismissed — no more suggestions for \(first).")
    }

    public func setNotification(_ id: String, on: Bool) {
        source.apply(.setNotification(id: id, on: on))
    }

    func setScope(address: String, _ scope: Scope) {
        source.apply(.setScope(sender: address, scope))
    }

    // MARK: - Toast

    public func showToast(_ message: String, action: String? = nil) {
        toastSeq += 1
        if action == nil { pendingUndo = nil }
        toast = ToastState(message: message, actionLabel: action, token: toastSeq)
    }

    // MARK: - Helpers

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
