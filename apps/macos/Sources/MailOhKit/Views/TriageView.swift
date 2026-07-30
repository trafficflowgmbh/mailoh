import SwiftUI

/// Triage — three piles, drawn as literal stacks of paper: the sheet edges behind
/// each card are the only decorative geometry in Blanc, and they earn it by saying
/// "there is more than one thing under here".
///
/// Every number here is `pile.items.count`. There is no parallel integer, so a card
/// cannot show 0 while rendering two items — and completing something in Focus &
/// Reply removes it from the pile, which is the same array the card reads.
public struct TriageView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let s: AppState
    public init(_ s: AppState) { self.s = s }

    public var body: some View {
        VStack(spacing: 0) {
            ViewHead("Triage", meta: s.triageMeta)
            Scroller {
                if compact {
                    // `.piles{flex-direction:column}` — one full-width card per row.
                    VStack(alignment: .leading, spacing: 26) {
                        ForEach(s.piles) { pile in PileCard(pile: pile, fullWidth: true) }
                    }
                    .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 22)
                } else {
                    FlowRow(spacing: 26, lineSpacing: 26) {
                        ForEach(s.piles) { pile in PileCard(pile: pile, fullWidth: false) }
                    }
                    .padding(.horizontal, 34).padding(.top, 16).padding(.bottom, 26)
                }

                HStack(spacing: 12) {
                    PillButton(Copy.focusReply, glyph: .spark, key: "f", kind: .primary) {
                        s.startFocusReply()
                    }
                    Text(Copy.focusReplyNote).blanc(.chip).foregroundStyle(p.ink3.color)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, compact ? 14 : Space.paneX).padding(.bottom, 30)
            }
        }
    }
}

private struct PileCard: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false
    let pile: TriagePile
    let fullWidth: Bool

    /// Derived, never passed in from a second counter.
    private var count: Int { pile.items.count }

    private var glyph: Glyph {
        switch pile.kind {
        case .replyLater: return .clock
        case .setAside: return .pause
        case .resurface: return .up
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Icon(glyph, 14).foregroundStyle(p.accentInk.color)
                Text(pile.title).blanc(.pileTitle).foregroundStyle(p.ink.color)
                Spacer(minLength: 6)
                Text("\(count)").blanc(.meta).monospacedDigit()
                    .foregroundStyle(p.ink3.color).contentTransition(.numericText())
            }
            ForEach(Array(pile.items.enumerated()), id: \.element.id) { i, item in
                VStack(alignment: .leading, spacing: 0) {
                    Text(item.title)
                        .font(Typography.font(Typography.Size.control, Typography.Weight.bold))
                        .foregroundStyle(p.ink.color)
                        .fixedSize(horizontal: false, vertical: true)
                    if !item.subtitle.isEmpty {
                        Text(item.subtitle).blanc(.button).foregroundStyle(p.ink2.color)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let when = item.when {
                        HStack(spacing: 5) {
                            Icon(.clock, 11)
                            Text(when)
                                .font(Typography.font(Typography.Size.caption, Typography.Weight.bold))
                                .monospacedDigit()
                        }
                        .foregroundStyle(p.accentInk.color)
                        .padding(.top, 5)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, i == 0 ? 11 : 13)
                .padding(.bottom, 2)
                .recordRender(item.id)
            }
            Text(pile.hint)
                .blanc(BlancText(size: Typography.Size.caption, weight: Typography.Weight.regular, leading: 1.5))
                .foregroundStyle(p.ink3.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
        }
        .frame(width: fullWidth ? nil : 300, alignment: .leading)
        .frame(maxWidth: fullWidth ? .infinity : nil, alignment: .leading)
        .padding(.horizontal, 20).padding(.vertical, 18)
        .floatSurface(p, radius: Radius.panel, lift: hovering ? .l3 : .l2)
        .background(alignment: .top) { sheetEdges }
        .offset(y: hovering ? -5 : 0)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancSlide), value: hovering)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(pile.title), \(count) item\(count == 1 ? "" : "s")")
    }

    /// The two sheets peeking out from under the top card — the only decorative
    /// geometry in Blanc. Each needs its own upward shadow: white-on-white, the
    /// edges are invisible without one, and the pile stops reading as a pile.
    private var sheetEdges: some View {
        ZStack(alignment: .top) {
            sheet.padding(.horizontal, 20).offset(y: -11).opacity(0.55)
            sheet.padding(.horizontal, 10).offset(y: -6)
        }
        .accessibilityHidden(true)
    }

    /// The shadow comes from the `Lift` scale (`.sheetEdge`), not a hand-written
    /// value — that is how it drifted to alpha .16 against the prototype's .10.
    private var sheet: some View {
        UnevenRoundedRectangle(topLeadingRadius: Radius.rowDense, bottomLeadingRadius: 0,
                               bottomTrailingRadius: 0, topTrailingRadius: Radius.rowDense,
                               style: .continuous)
            .fill(p.panel.color)
            .lift(.sheetEdge)
            .frame(height: 12)
    }
}

// MARK: - Reply Run

/// Reply Run — the Answer Later pile, one message per screen, with a progress
/// bar that is the only thing telling you how much is left. A modal is right here:
/// the whole point is that nothing else is on screen.
///
/// The action is **Save draft**, not "Done": there is no mailbox in this build, so
/// nothing can be sent and the button says what actually happens. Saving removes
/// the item from the pile, which is why reopening never re-presents it.
public struct FocusReplySheet: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let s: AppState
    let onClose: () -> Void
    @State private var draft = ""
    @FocusState private var editorFocused: Bool

    public init(_ s: AppState, onClose: @escaping () -> Void) { self.s = s; self.onClose = onClose }

    private var queue: [TriageItem] { s.focusReplyQueue }
    private var idx: Int { s.focusReplyIndex }
    private var total: Int { queue.count }

    public var body: some View {
        ZStack {
            p.scrim.color.ignoresSafeArea()
                .onTapGesture { onClose() }
            card
                .frame(maxWidth: 560)
                .padding(16)
        }
        .accessibilityAddTraits(.isModal)
    }

    @ViewBuilder private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            if idx >= total {
                EmptyStateView(glyph: "🕊", title: Copy.focusReplyEmpty, sub: "", topPad: 20)
                PillButton("Back to Triage", kind: .primary, action: onClose)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 8)
            } else {
                let item = queue[idx]
                HStack(spacing: 10) {
                    Text("\(idx + 1) of \(total)").blanc(.chip).monospacedDigit()
                        .foregroundStyle(p.ink3.color)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(p.hair.color)
                            Capsule().fill(p.accent.color)
                                .frame(width: geo.size.width * CGFloat(idx + 1) / CGFloat(max(total, 1)))
                        }
                    }
                    .frame(height: 1.5)
                    .accessibilityHidden(true)
                }
                Text(item.subtitle)
                    .blanc(BlancText(size: Typography.Size.h4, weight: Typography.Weight.heavy,
                                     trackingEm: Typography.Tracking.title))
                    .foregroundStyle(p.ink.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16).padding(.bottom, 2)
                Text(item.title).blanc(.meta).foregroundStyle(p.ink3.color)
                if let preview = item.preview {
                    Text(preview)
                        .blanc(BlancText(size: Typography.Size.body, weight: Typography.Weight.regular, leading: 1.55))
                        .foregroundStyle(p.ink2.color)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                }

                TextEditor(text: $draft)
                    .font(Typography.font(Typography.Size.body, Typography.Weight.regular))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 100)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .wash(Radius.row, p.canvas.color)
                    .hairline(p, radius: Radius.row)
                    .focused($editorFocused)
                    .padding(.top, 16)
                    .accessibilityLabel("Reply to \(item.title)")

                Text(Copy.focusReplySendNote)
                    .blanc(.caption).foregroundStyle(p.ink3.color)
                    .padding(.top, 8)

                HStack(spacing: 8) {
                    PillButton(Copy.focusReplySave, kind: .primary) {
                        s.saveFocusReplyDraft(draft)
                        draft = ""
                    }
                    PillButton("Skip") { s.focusReplySkip(); draft = "" }
                    Spacer(minLength: 0)
                    Hint(["esc"], "exit")
                }
                .padding(.top, 14)
                // The draft belongs to the item on screen: swapping items must not
                // carry typed text across, and a saved draft comes back if you
                // return to that item later.
                .onChange(of: item.id) { _, new in draft = s.drafts[new] ?? "" }
            }
        }
        .padding(.horizontal, 30).padding(.vertical, 26)
        .floatSurface(p, radius: Radius.overlay, lift: .l3)
        .onAppear {
            editorFocused = true
            if idx < total { draft = s.drafts[queue[idx].id] ?? "" }
        }
    }
}
