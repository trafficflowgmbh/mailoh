import SwiftUI

/// The Screener — the consent gate, built as the fourth two-pane view so it reads
/// as part of the mail app rather than a settings screen. Waiting senders on the
/// left, **their actual held mail** on the right, and the decision bar sticky above
/// it. You never decide about a sender you cannot see.
///
/// No-collapse: every segment renders **every** held message. `Screened out` and
/// `Spam` carry a `HeldMailbag`, not a count plus one body, so "8 held" is eight
/// cards on screen and the pane can never claim mail it is not showing.
///
/// Below the breakpoint the list is the view and selecting a sender presents the
/// decision pane full-screen (`body.scn-full`), driven by
/// `AppState.isScreenerDetailOpen` and rendered by `RootView`.
public struct ScreenerView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let s: AppState
    let seg: ScreenerSeg

    public init(_ s: AppState, seg: ScreenerSeg) { self.s = s; self.seg = seg }

    public var body: some View {
        SplitPane(compactPane: .list) {
            VStack(spacing: 0) {
                ViewHead("Screener", meta: s.screenerMeta)
                head
                Scroller { Rows { rows } }
                HintBar { hints }
            }
            .panel(p)
        } detail: {
            ScreenerPreview(s, seg: seg).panel(p)
        }
    }

    // MARK: List column

    private var head: some View {
        VStack(alignment: .leading, spacing: 9) {
            Segmented([(ScreenerSeg.waiting, "Waiting", s.waiting.count),
                       (.screened, "Screened out", s.screened.count),
                       (.spam, "Spam", s.spam.count)],
                      selection: seg) { s.route = .screener($0) }
                .accessibilityLabel("Screener sections")

            if seg == .waiting && !s.waiting.isEmpty {
                HStack(spacing: 7) {
                    PillButton(Copy.applyAll, key: "a", compact: true) { s.applyAllSuggestions() }
                    PillButton(Copy.markAllSpam, key: "s", kind: .ghost, compact: true) { s.markAllSpam() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, compact ? Space.paneXCompact : Space.paneX)
        .padding(.bottom, 12)
    }

    /// Selecting a row previews the held mail. In compact that preview is a
    /// full-screen presentation, because there is no second pane to put it in.
    private func select(_ seg: ScreenerSeg, _ id: String) {
        s.setScreenerSelection(seg, id)
        if compact { s.isScreenerDetailOpen = true }
    }

    @ViewBuilder private var rows: some View {
        let sel = s.screenerSelection(seg)
        switch seg {
        case .waiting:
            if s.waiting.isEmpty { emptyState } else {
                ForEach(s.waiting) { w in
                    SenderRow(rowID: w.id, initial: w.initial, who: w.from, addr: w.addr, time: w.time,
                              subject: w.held.newest.subj, dull: w.dull, selected: w.id == sel,
                              chips: {
                                  Badge("→ \(w.ai.dest.done) \(w.ai.conf)", kind: .ai, numeric: true)
                                  if w.held.count > 1 { Badge("\(w.held.count) held", numeric: true) }
                              }) { select(.waiting, w.id) }
                }
            }
        case .screened:
            if s.screened.isEmpty { emptyState } else {
                ForEach(s.screened) { x in
                    SenderRow(rowID: x.id, initial: initial(x.sender), who: x.sender, addr: nil, time: x.date,
                              subject: x.held.newest.subj, dull: false, selected: x.id == sel,
                              chips: { Badge("\(x.heldCount) held", numeric: true) }) {
                        select(.screened, x.id)
                    }
                }
            }
        case .spam:
            if s.spam.isEmpty { emptyState } else {
                ForEach(s.spam) { x in
                    SenderRow(rowID: x.id, initial: initial(x.from), who: x.from, addr: nil, time: x.time,
                              subject: x.subj, dull: true, selected: x.id == sel,
                              chips: {
                                  Badge(x.det, numeric: true)
                                  if x.heldCount > 1 { Badge("\(x.heldCount) held", numeric: true) }
                              }) {
                        select(.spam, x.id)
                    }
                }
            }
        }
    }

    private func initial(_ addr: String) -> String { String(addr.prefix(1)).uppercased() }

    private var emptyState: some View {
        let c = Copy.screenerEmpty(seg)
        return EmptyStateView(glyph: c.glyph, title: c.title, sub: c.sub)
    }

    @ViewBuilder private var hints: some View {
        if seg == .waiting {
            Hint(["j", "k"], "move")
            Hint(["y"], "accept suggestion")
            Hint(["o", "r", "c", "n", "x"], "file")
            Hint(["⇧"], "+key marks read")
        } else {
            Hint(["j", "k"], "move")
            Hint("selecting a row previews the held mail")
        }
    }
}

// MARK: - The preview pane (also the compact full-screen presentation)

/// Decision bar plus **all** of the selected sender's held mail. Extracted so the
/// compact layout can present the identical pane full-screen instead of
/// re-implementing it.
struct ScreenerPreview: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let s: AppState
    let seg: ScreenerSeg

    init(_ s: AppState, seg: ScreenerSeg) { self.s = s; self.seg = seg }

    var body: some View {
        switch seg {
        case .waiting:
            if let w = s.currentWaiting {
                VStack(spacing: 0) {
                    DecisionBar(s, sender: w)
                    heldScroll(caption: w.held.count > 1
                               ? Copy.heldCaption(w.held.count, firstContact: w.held.first.time)
                               : nil) {
                        whyLine(w)
                        ForEach(w.held.all) { h in
                            HeldMailCard(from: w.from, addr: w.addr, mail: h, dull: w.dull)
                                .padding(.bottom, 16)
                        }
                    }
                }
            } else { previewEmpty }
        case .screened:
            if let x = s.currentScreened {
                VStack(spacing: 0) {
                    ScreenedBar(s, item: x)
                    heldScroll(caption: Copy.heldCaption(x.heldCount)) {
                        ForEach(x.held.all) { h in
                            HeldMailCard(from: x.sender, addr: nil, mail: h, dull: true)
                                .padding(.bottom, 16)
                        }
                    }
                }
            } else { previewEmpty }
        case .spam:
            if let x = s.currentSpam {
                VStack(spacing: 0) {
                    SpamBar(s, item: x)
                    heldScroll(caption: x.det) {
                        ForEach(x.held.all) { h in
                            HeldMailCard(from: x.from, addr: nil, mail: h, dull: true)
                                .padding(.bottom, 16)
                        }
                    }
                }
            } else { previewEmpty }
        }
    }

    private func whyLine(_ w: WaitingSender) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Icon(.spark, 15).foregroundStyle(p.accentInk.color).padding(.top, 2)
            (Text("AI suggests ")
             + Text(w.ai.dest.done).font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
             + Text(" \(w.ai.conf)").font(Typography.font(Typography.Size.bodyS, Typography.Weight.heavy))
             + Text(" — ").foregroundStyle(p.ink3.color)
             + Text("“\(w.ai.why)”").foregroundStyle(p.ink3.color))
                .blanc(BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.regular, leading: 1.5))
                .foregroundStyle(p.ink2.color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 14)
    }

    @ViewBuilder
    private func heldScroll<C: View>(caption: String?, @ViewBuilder content: () -> C) -> some View {
        VScroll {
            LazyStack {
                VStack(alignment: .leading, spacing: 0) {
                    if let caption {
                        Text(caption).blanc(.caption).monospacedDigit()
                            .foregroundStyle(p.ink3.color).padding(.bottom, 10)
                    }
                    content()
                }
                .frame(maxWidth: Space.messageMax, alignment: .leading)
                .padding(.horizontal, compact ? 18 : Space.paneX)
                .padding(.top, 20).padding(.bottom, 60)
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }

    private var previewEmpty: some View {
        let c = Copy.screenerEmpty(seg)
        return EmptyStateView(glyph: c.glyph, title: c.title, sub: c.sub, topPad: 96)
            .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - Waiting row

private struct SenderRow<Chips: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    let rowID: String
    let initial: String
    let who: String
    let addr: String?
    let time: String
    let subject: String
    let dull: Bool
    let selected: Bool
    @ViewBuilder let chips: Chips
    let action: () -> Void

    init(rowID: String, initial: String, who: String, addr: String?, time: String, subject: String,
         dull: Bool, selected: Bool, @ViewBuilder chips: () -> Chips, action: @escaping () -> Void) {
        self.rowID = rowID
        self.initial = initial; self.who = who; self.addr = addr; self.time = time
        self.subject = subject; self.dull = dull; self.selected = selected
        self.chips = chips(); self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 11) {
                Avatar(initial).padding(.top, 1)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(who)
                            .blanc(dull ? .rowSenderSeen : .rowSender)
                            .foregroundStyle(dull ? p.ink2.color : p.ink.color)
                            .lineLimit(1).truncationMode(.tail).layoutPriority(2)
                        if let addr {
                            Text(addr).blanc(.caption).foregroundStyle(p.ink3.color)
                                .lineLimit(1).truncationMode(.tail).layoutPriority(0)
                        }
                        Spacer(minLength: 6)
                        Text(time).blanc(.caption).monospacedDigit()
                            .foregroundStyle(p.ink3.color).fixedSize()
                    }
                    Text(subject)
                        .blanc(dull ? .rowSubjectSeen : .rowSubject)
                        .foregroundStyle(dull ? p.ink2.color : p.ink.color)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(.top, 2)
                    FlowRow(spacing: 6, lineSpacing: 5) { chips }.padding(.top, 5)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .modifier(SenderRowBackground(selected: selected, hovering: hovering))
            .offset(y: selected ? -1 : 0)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancFlip), value: selected)
        .accessibilityLabel("\(who): \(subject)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .recordRender(rowID)
    }
}

private struct SenderRowBackground: ViewModifier {
    @Environment(\.palette) private var p
    let selected: Bool
    let hovering: Bool
    func body(content: Content) -> some View {
        if selected { content.surface(Radius.row, p.float.color, .l2) }
        else { content.wash(Radius.row, hovering ? p.tint.color : .clear) }
    }
}

// MARK: - The decision bar

/// **The decision bar.** Five destinations, one click each; every destination
/// carries an attached ✓ half that files the mail *already read*. The
/// AI-suggested destination wears the accent ring and answers to `y` — so the
/// common case is one keystroke, and the AI never files anything by itself.
struct DecisionBar: View {
    @Environment(\.palette) private var p
    let s: AppState
    let sender: WaitingSender
    init(_ s: AppState, sender: WaitingSender) { self.s = s; self.sender = sender }

    var body: some View {
        DecisionBarShell {
            FlowRow(spacing: 8, lineSpacing: 8) {
                ForEach(Destination.allCases, id: \.self) { d in
                    SplitDecisionButton(
                        dest: d,
                        isAI: sender.ai.dest == d,
                        quiet: !d.isFiling,
                        onFile: { s.decide(sender, to: d, read: false) },
                        onFileRead: { s.decide(sender, to: d, read: true) }
                    )
                }
            }
        } note: {
            HStack(alignment: .center, spacing: 10) {
                Segmented([(Scope.sender, Copy.scopeSender, nil),
                           (Scope.domain, Copy.scopeDomain, nil)],
                          selection: sender.scope, dense: true) { s.setScope(sender.id, $0) }
                    .accessibilityLabel("Decision scope")
                Text(Copy.decideRule(s.ruleTarget(sender)))
                    .blanc(BlancText(size: Typography.Size.caption, weight: Typography.Weight.regular, leading: 1.45))
                    .foregroundStyle(p.ink3.color)
                    .fixedSize(horizontal: false, vertical: true)
                    // The note takes all the slack (the keys group stays fixed), so
                    // the rule sentence lands on one or two lines instead of
                    // hyphenating the sender's own domain across three.
                    .frame(maxWidth: .infinity, alignment: .leading)
                DecisionKeysHint()
            }
        }
    }
}

/// `.d-keys{display:none}` below the breakpoint — there is no keyboard to teach.
private struct DecisionKeysHint: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    var body: some View {
        if !compact {
            HStack(spacing: 4) {
                Kbd("y"); Text("accept ·").blanc(.badge).foregroundStyle(p.ink3.color)
                Kbd("⇧"); Text("+key marks read").blanc(.badge).foregroundStyle(p.ink3.color)
            }
            .fixedSize()
        }
    }
}

/// One destination: `[ Ohbox | ✓ ]`. The divider is functional — it separates two
/// different outcomes, so it stays a hairline.
private struct SplitDecisionButton: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hoverMain = false
    @State private var hoverRead = false

    let dest: Destination
    let isAI: Bool
    let quiet: Bool
    let onFile: () -> Void
    let onFileRead: () -> Void

    private var hovering: Bool { hoverMain || hoverRead }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onFile) {
                HStack(spacing: 6) {
                    Text(dest.label)
                        .font(Typography.font(Typography.Size.bodyS,
                                              isAI ? Typography.Weight.heavy
                                                   : (quiet ? Typography.Weight.medium : Typography.Weight.semibold)))
                    if isAI { Kbd("y", style: .naked) }
                }
                .foregroundStyle(isAI ? p.accentInk.color : (quiet ? p.ink2.color : p.ink.color))
                .padding(.horizontal, 13).padding(.vertical, 6.5)
                .background(isAI ? p.accentSoft.color : (hoverMain ? p.tint.color : .clear))
            }
            .buttonStyle(.plain)
            .onHover { hoverMain = $0 }
            .help("\(dest.done) (\(dest.key))")
            .accessibilityLabel("\(dest.done)\(isAI ? ", suggested" : "")")

            Rectangle().fill(p.hairSoft.color).frame(width: 1)

            Button(action: onFileRead) {
                Icon(.check, 12)
                    .foregroundStyle(hoverRead ? p.accentInk.color : p.ink3.color)
                    .padding(.horizontal, 11).padding(.vertical, 6.5)
                    .background(hoverRead ? p.accentSoft.color : .clear)
            }
            .buttonStyle(.plain)
            .onHover { hoverRead = $0 }
            .help("\(dest.done), mark read (\(dest.key.uppercased()))")
            .accessibilityLabel("\(dest.done), mark read")
        }
        .fixedSize()
        .clip(Radius.pill)
        .surface(Radius.pill, p.float.color, hovering ? .l2 : .l0)
        .accentRing(p, radius: Radius.pill, on: isAI)
        .offset(y: hovering ? -1 : 0)
        .animation(motion(reduceMotion, .blancFast), value: hovering)
    }
}

/// Screened-out senders stay listed and reversible — screening out is not a
/// deletion, and the bar says exactly what allowing again would do.
private struct ScreenedBar: View {
    @Environment(\.palette) private var p
    let s: AppState
    let item: ScreenedSender
    init(_ s: AppState, item: ScreenedSender) { self.s = s; self.item = item }

    var body: some View {
        DecisionBarShell {
            FlowRow(spacing: 8) {
                if item.choosing {
                    Text(Copy.allowChoose).blanc(.chip).foregroundStyle(p.ink3.color)
                    PillButton("→ Ohbox", compact: true) { s.allowScreened(item, to: .ohbox) }
                    PillButton("→ Reads", compact: true) { s.allowScreened(item, to: .reads) }
                    PillButton("Cancel", kind: .ghost, compact: true) {
                        s.setChoosingScreened(item.id, false)
                    }
                } else {
                    PillButton(Copy.allowLabel, compact: true) { s.setChoosingScreened(item.id, true) }
                }
            }
        } note: {
            Text(Copy.screenedNote(item.date, item.heldCount)).monospacedDigit()
                .blanc(BlancText(size: Typography.Size.caption, weight: Typography.Weight.regular, leading: 1.45))
                .foregroundStyle(p.ink3.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Auto-detected spam is held and viewable, never deleted unseen — and the note
/// states what detection actually reads.
private struct SpamBar: View {
    @Environment(\.palette) private var p
    let s: AppState
    let item: SpamSender
    init(_ s: AppState, item: SpamSender) { self.s = s; self.item = item }

    var body: some View {
        DecisionBarShell {
            FlowRow(spacing: 8) {
                if item.choosing {
                    Text(Copy.notSpamChoose).blanc(.chip).foregroundStyle(p.ink3.color)
                    PillButton("→ Screener", compact: true) { s.notSpam(item, to: .screener) }
                    PillButton("→ Ohbox", compact: true) { s.notSpam(item, to: .ohbox) }
                    PillButton("Cancel", kind: .ghost, compact: true) { s.setChoosingSpam(item.id, false) }
                } else {
                    PillButton(Copy.notSpamLabel, compact: true) { s.setChoosingSpam(item.id, true) }
                    PillButton("Delete", kind: .ghost, compact: true) { s.deleteSpam(item) }
                }
            }
        } note: {
            Text(Copy.spamNote)
                .blanc(BlancText(size: Typography.Size.caption, weight: Typography.Weight.regular, leading: 1.45))
                .foregroundStyle(p.ink3.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct DecisionBarShell<Actions: View, Note: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    @ViewBuilder let actions: Actions
    @ViewBuilder let note: Note

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            actions
            note.padding(.top, 10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, compact ? 18 : 26)
        .padding(.top, compact ? 14 : 16).padding(.bottom, compact ? 12 : 13)
        .background {
            UnevenRoundedRectangle(topLeadingRadius: Radius.panel, bottomLeadingRadius: 0,
                                   bottomTrailingRadius: 0, topTrailingRadius: Radius.panel,
                                   style: .continuous)
                .fill(p.panel.color)
                .lift(.barEdge)
        }
    }
}

/// The held mail itself. Spam-grade mail renders quieter — less light, less ink —
/// so the eye is not asked to treat a phishing blast like a letter. Protected mail
/// renders the policy block, because there is no body to render.
struct HeldMailCard: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let from: String
    let addr: String?
    let mail: HeldMail
    let dull: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                UnreadDot(on: !mail.seen)
                Text(from)
                    .font(Typography.font(Typography.Size.control, Typography.Weight.bold))
                    .foregroundStyle(p.ink.color)
                if let addr {
                    Text(addr).blanc(.chip).foregroundStyle(p.ink3.color)
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 8)
                Text(mail.time).blanc(.caption).monospacedDigit()
                    .foregroundStyle(p.ink3.color).fixedSize()
            }
            Text(mail.subj)
                .blanc(.heldTitle)
                .foregroundStyle(dull ? p.ink2.color : p.ink.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6).padding(.bottom, 10)
            if let t = mail.trackers {
                Badge(t, glyph: .shield, kind: .shield).padding(.bottom, 10)
            }
            if let meta = mail.content.sensitive {
                ProtectedBlock(meta)
            } else {
                Text(mail.body ?? "")
                    .blanc(.streamBody)
                    .foregroundStyle(dull ? p.ink2.color : p.ink.color)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, compact ? 18 : 26)
        .padding(.top, 20).padding(.bottom, 22)
        .floatSurface(p, radius: Radius.panel, lift: dull ? .l0 : .l1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(from): \(mail.subj)")
        .accessibilityValue(mail.seen ? "read" : "unread")
        .recordRender(mail.id)
    }
}
