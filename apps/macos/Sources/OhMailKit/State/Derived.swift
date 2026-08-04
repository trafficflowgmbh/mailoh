import SwiftUI

/// The exact arrays the views render, plus the command-palette model and theme
/// resolution. Views own no list logic of their own: whatever a view shows, it
/// shows by iterating one of these. That is what makes the NO-COLLAPSE RULE
/// testable — `renderManifest(_:)` enumerates every mail identity a route puts on
/// screen, and `OhMailKitTests` asserts it covers the fixtures exactly, at every
/// depth (threads, held bags). A "12 more" placeholder would drop identities from
/// the manifest and fail.
public extension AppState {

    // MARK: - Ohbox render lists

    var ohboxNew: [Message] { ohbox.filter { !$0.seen } }
    var ohboxSeen: [Message] { ohbox.filter { $0.seen } }
    var ohboxMeta: String { "\(ohboxUnread) unread of \(ohboxTotal)" }

    // MARK: - Reads render lists (unseen above the waterline, seen below)

    var readsUnseen: [Message] { reads.filter { !$0.seen } }
    var readsSeen: [Message] { reads.filter { $0.seen } }
    var readsMeta: String { "\(readsNew) new" }

    // MARK: - Receipts render lists (day groups, in order)

    var receiptsMeta: String { "\(receiptsNew) new" }
    /// Day groups resolved to real messages. Groups cover every receipt.
    var receiptRows: [(label: String, items: [Message])] {
        receiptGroups.map { g in
            (g.label, g.itemIDs.compactMap { id in receipts.first { $0.id == id } })
        }
    }
    /// Flat receipt order — the stream renders this.
    var receiptStream: [Message] { receiptRows.flatMap(\.items) }

    // MARK: - Stream items for a place

    func streamItems(for place: Place) -> [Message] {
        switch place {
        case .reads: return readsUnseen + readsSeen
        case .receipts: return receiptStream
        case .ohbox: return ohbox
        }
    }

    /// The body as a string, which is what today's cards render.
    ///
    /// A shim over `bodyState(for:in:)`. Against fixtures every body is
    /// `.available`, so the fallback to the preview never fires; against a source
    /// that fetches, this is where "not fetched yet" currently collapses into the
    /// preview line. That collapse is the honest placeholder only until there is a
    /// surface that can draw waiting and failure properly — the views move onto
    /// `bodyState` in the slice that can actually reach those states.
    func body(for m: Message) -> String {
        if case .ohbox = m.place { return m.body ?? "" }
        return bodyState(for: m.id, in: m.place).text ?? m.preview ?? ""
    }

    /// Current stream selection for a place (drives the row highlight both ways).
    func streamCurrent(_ place: Place) -> String? {
        place == .receipts ? streamReceiptsCur : streamReadsCur
    }
    func setStreamCurrent(_ place: Place, _ id: String) {
        if place == .receipts { streamReceiptsCur = id } else { streamReadsCur = id }
    }

    /// `↵` in a stream. Owned here rather than in `StreamView` so the global
    /// keyboard map can actually reach it.
    @discardableResult
    func toggleStreamExpanded(_ id: String) -> Bool {
        if streamExpanded.contains(id) { streamExpanded.remove(id); return false }
        streamExpanded.insert(id)
        return true
    }
    func isStreamExpanded(_ id: String) -> Bool { streamExpanded.contains(id) }

    /// j / k over a stream: move, mark seen going forward, and scroll the stream so
    /// the selection is actually visible.
    func moveStreamSelection(_ place: Place, by delta: Int) {
        let ids = streamItems(for: place).map(\.id)
        guard !ids.isEmpty else { return }
        let cur = streamCurrent(place).flatMap { ids.firstIndex(of: $0) } ?? 0
        let next = min(max(cur + delta, 0), ids.count - 1)
        if delta > 0 { markSeen(ids[next]) }
        setStreamCurrent(place, ids[next])
        requestScroll(place, to: ids[next])
    }

    // MARK: - Screener render lists

    var screenerMeta: String {
        "\(waiting.count) first-time sender\(waiting.count == 1 ? "" : "s") waiting"
    }
    func screenerIDs(_ seg: ScreenerSeg) -> [String] {
        switch seg {
        case .waiting: return waiting.map(\.id)
        case .screened: return screened.map(\.id)
        case .spam: return spam.map(\.id)
        }
    }
    func screenerSelection(_ seg: ScreenerSeg) -> String? {
        let ids = screenerIDs(seg)
        let stored: String?
        switch seg {
        case .waiting: stored = scnSelWaiting
        case .screened: stored = scnSelScreened
        case .spam: stored = scnSelSpam
        }
        if let stored, ids.contains(stored) { return stored }
        return ids.first
    }
    func setScreenerSelection(_ seg: ScreenerSeg, _ id: String?) {
        switch seg {
        case .waiting: scnSelWaiting = id
        case .screened: scnSelScreened = id
        case .spam: scnSelSpam = id
        }
    }
    /// j / k over the active screener segment.
    func moveScreenerSelection(_ seg: ScreenerSeg, by delta: Int) {
        let ids = screenerIDs(seg)
        guard !ids.isEmpty else { return }
        let cur = screenerSelection(seg).flatMap { ids.firstIndex(of: $0) } ?? 0
        setScreenerSelection(seg, ids[min(max(cur + delta, 0), ids.count - 1)])
    }
    var currentWaiting: WaitingSender? {
        screenerSelection(.waiting).flatMap { id in waiting.first { $0.id == id } }
    }

    /// Whether anything in the screener has a suggestion at all.
    ///
    /// The condition on every control that acts on suggestions in bulk — "apply all", and the `y`
    /// hint that advertises accepting one. A tier with no classifier answers false for a full
    /// screener, and the controls are not offered rather than being offered and doing nothing.
    /// Offering them would be the worse half of the same defect: a button that files real mail is
    /// read as a button that knows where the mail goes.
    var hasSuggestions: Bool { waiting.contains { $0.ai != nil } }
    var currentScreened: ScreenedSender? {
        screenerSelection(.screened).flatMap { id in screened.first { $0.id == id } }
    }
    var currentSpam: SpamSender? {
        screenerSelection(.spam).flatMap { id in spam.first { $0.id == id } }
    }

    /// The held mail a screener segment previews — **all** of it, always.
    func heldMail(_ seg: ScreenerSeg) -> [HeldMail] {
        switch seg {
        case .waiting: return currentWaiting?.held.all ?? []
        case .screened: return currentScreened?.held.all ?? []
        case .spam: return currentSpam?.held.all ?? []
        }
    }

    /// Decision scope is per-sender and editable from the bar. It goes to the
    /// source because it is the shape of a rule about a mailbox, not a UI toggle:
    /// filing at domain scope is a different instruction from filing one address.
    func setScope(_ id: String, _ scope: Scope) {
        guard let sender = waiting.first(where: { $0.id == id }) else { return }
        setScope(address: sender.addr, scope)
    }
    /// The rule target the decision bar names: one address, or the whole domain.
    func ruleTarget(_ s: WaitingSender) -> String {
        s.scope == .domain ? "@" + String(s.addr.split(separator: "@").last ?? "") : s.addr
    }

    /// Whether a row's destination chooser is open. Shell state — see the
    /// projection in `AppState`.
    func setChoosingScreened(_ id: String, _ on: Bool) {
        if on { choosingScreened.insert(id) } else { choosingScreened.remove(id) }
    }
    func setChoosingSpam(_ id: String, _ on: Bool) {
        if on { choosingSpam.insert(id) } else { choosingSpam.remove(id) }
    }

    // MARK: - Ohbox j / k

    func moveOhboxSelection(by delta: Int) {
        let ids = (ohboxNew + ohboxSeen).map(\.id)
        guard !ids.isEmpty else { return }
        let cur = ids.firstIndex(of: selectedOhboxID) ?? 0
        selectedOhboxID = ids[min(max(cur + delta, 0), ids.count - 1)]
    }

    // MARK: - Triage (every number derived from `piles`)

    var pileCounts: [PileKind: Int] {
        Dictionary(uniqueKeysWithValues: PileKind.allCases.map { ($0, pile($0)?.items.count ?? 0) })
    }
    func pileCount(_ kind: PileKind) -> Int { pile(kind)?.items.count ?? 0 }
    var replyCount: Int { pileCount(.replyLater) }
    var asideCount: Int { pileCount(.setAside) }
    var resurfaceCount: Int { pileCount(.resurface) }
    var triageMeta: String {
        let n = piles.reduce(0) { $0 + $1.items.count }
        return "\(n) item\(n == 1 ? "" : "s")"
    }

    // MARK: - Theme resolution

    /// The scheme the shell actually paints in, given the preference and the system.
    func effectiveScheme(system: ColorScheme) -> ColorScheme {
        switch themePref {
        case .light: return .light
        case .dark: return .dark
        case .system: return system
        }
    }

    // MARK: - Search facets (derived from the real hits — never fabricated)

    struct Facets: Sendable {
        public var senders: [(name: String, count: Int)]
        public var places: [String]
        public var hasAttachment: Bool
    }
    func facets(for hits: [SearchHit]) -> Facets {
        var bySender: [String: Int] = [:]
        var places: [String] = []
        for h in hits {
            let first = String(h.who.split(separator: " ").first ?? Substring(h.who))
            bySender[first, default: 0] += 1
            let place = String(h.origin.split(separator: " ").first ?? "")
            if !places.contains(place) { places.append(place) }
        }
        let attach = hits.contains { h in allItems.first { $0.id == h.id }?.attach != nil }
        return Facets(senders: bySender.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }
                                      .map { (name: $0.key, count: $0.value) },
                      places: places, hasAttachment: attach)
    }

    // MARK: - The render manifest (what makes no-collapse checkable)

    /// Which presentation the manifest is being asked about. Below the breakpoint the
    /// detail panes are not in the deck — they are separate presentations (reading
    /// mode, the full-screen Screener pane) — so the promise a surface makes depends
    /// on which surface it is.
    enum RenderSurface: Sendable {
        /// The route as laid out in the deck.
        case deck
        /// Reading mode — the open Ohbox message and its whole conversation.
        case reader
        /// The Screener's decision pane (its own screen below the breakpoint).
        case screenerDetail
    }

    /// Every mail identity a surface puts on screen, in render order — including the
    /// messages behind a thread badge and every message in a held bag. Views render
    /// from the same accessors this reads, so a collapsed list shows up here as
    /// missing identities.
    func renderManifest(_ route: Route, surface: RenderSurface = .deck,
                        compact: Bool = false) -> [String] {
        switch surface {
        case .reader:
            return selectedOhbox.map { $0.conversation.map(\.id) } ?? []
        case .screenerDetail:
            guard case .screener(let seg) = route else { return [] }
            return heldMail(seg).map(\.id)
        case .deck:
            break
        }
        switch route {
        case .ohbox:
            // The rows — plus, when there is a reading column, the whole
            // conversation of the open message.
            let rows = (ohboxNew + ohboxSeen).map(\.id)
            guard !compact else { return rows }
            let open = selectedOhbox.map { $0.conversation.map(\.id) } ?? []
            return rows + open.filter { !rows.contains($0) }
        case .reads:
            return (readsUnseen + readsSeen).map(\.id)
        case .receipts:
            return receiptStream.map(\.id)
        case .screener(let seg):
            // Compact shows the list only; the held mail lives on the detail screen.
            return compact ? screenerIDs(seg) : screenerIDs(seg) + heldMail(seg).map(\.id)
        case .triage:
            return piles.flatMap { $0.items.map(\.id) }
        case .tag(let t):
            return tagged(t).map(\.id)
        case .search, .compose, .settings:
            return []
        }
    }

    // MARK: - Command palette

    func runCommand(_ c: PaletteCommand) {
        switch c.action {
        case .route(let r): route = r
        case .toggleTheme: themePref = effectiveScheme(system: .light) == .dark ? .light : .dark
        case .tagSelection(let t): toggleTag(selectedOhboxID, t)
        case .focusReply: route = .triage; startFocusReply()
        case .resurfaceSelection: if let m = selectedOhbox { resurface(m) }
        }
    }

    /// The palette's command set. Fuzzy-filtered by `PaletteCommand.matches`.
    var paletteCommands: [PaletteCommand] {
        [
            PaletteCommand("Go to Ohbox", ["g", "o"], .route(.ohbox)),
            PaletteCommand("Go to Reads", ["g", "r"], .route(.reads)),
            PaletteCommand("Go to Receipts", ["g", "e"], .route(.receipts)),
            PaletteCommand("Open Screener", ["g", "s"], .route(.screener(.waiting))),
            PaletteCommand("Screener: Screened out", [], .route(.screener(.screened))),
            PaletteCommand("Screener: Spam", [], .route(.screener(.spam))),
            PaletteCommand("Start Reply Run", ["f"], .focusReply),
            PaletteCommand("Search everything", ["/"], .route(.search)),
            PaletteCommand("New message", ["c"], .route(.compose)),
            PaletteCommand("Open Settings", [], .route(.settings)),
            PaletteCommand("Tag: Pottery Project…", ["t"], .tagSelection(.pottery), icon: .tag),
            PaletteCommand("Tag: Paperwork…", [], .tagSelection(.buch), icon: .tag),
            PaletteCommand("Tag: Adventures…", [], .tagSelection(.privat), icon: .tag),
            PaletteCommand("Go to tag: Pottery Project", [], .route(.tag(.pottery)), icon: .tag),
            PaletteCommand("Toggle light / dark", [], .toggleTheme),
            PaletteCommand("Resurface selection", ["b"], .resurfaceSelection),
        ]
    }

    func filteredCommands(_ query: String) -> [PaletteCommand] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return paletteCommands }
        return paletteCommands.filter { $0.matches(q) }
    }
}

/// One palette row. `keys` are the shortcut keycaps shown on the right.
public struct PaletteCommand: Identifiable, Sendable {
    public enum Action: Sendable {
        case route(Route)
        case toggleTheme
        case tagSelection(TagID)
        case focusReply
        case resurfaceSelection
    }
    public enum Glyph: Sendable { case spark, tag }

    public let id: String
    public let label: String
    public let keys: [String]
    public let action: Action
    public let icon: Glyph

    init(_ label: String, _ keys: [String], _ action: Action, icon: Glyph = .spark) {
        self.id = label; self.label = label; self.keys = keys; self.action = action; self.icon = icon
    }

    /// Substring match first (the prototype's behavior), then a subsequence pass
    /// so "gtr" still finds "Go to Reads".
    public func matches(_ q: String) -> Bool {
        let l = label.lowercased()
        if l.contains(q) { return true }
        var it = l.makeIterator()
        var needle = q.makeIterator()
        var want = needle.next()
        while let want_ = want, let ch = it.next() {
            if ch == want_ { want = needle.next() }
        }
        return want == nil
    }
}
