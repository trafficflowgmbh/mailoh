import SwiftUI

/// Reads — newsletters, with the seen-waterline. The list is the index; the
/// stream beside it is the reading. Everything above the waterline arrived since
/// your last visit; scrolling past an item retires it, one at a time.
///
/// Below the breakpoint the stream *is* the view (`#view-reads .list-col{display:none}`),
/// so `SplitPane` keeps the detail pane and the stream grows its own header.
public struct ReadsView: View {
    @Environment(\.palette) private var p
    let s: AppState

    public init(_ s: AppState) { self.s = s }

    public var body: some View {
        SplitPane(compactPane: .detail) {
            VStack(spacing: 0) {
                ViewHead("Reads", meta: s.readsMeta)
                Scroller {
                    Rows {
                        ForEach(Array(s.readsUnseen.enumerated()), id: \.element.id) { i, m in
                            row(m)
                            // The chip belongs to a message, so it appears only when
                            // that message has a classification to state.
                            if i == 0, let c = m.classification {
                                ReadsClassifierChip(s, of: c).padding(.vertical, 2)
                            }
                        }
                    }
                    WaterlineView(meta: s.readsWaterlineMeta)
                    Rows { ForEach(s.readsSeen) { row($0) } }
                    TailRow(Copy.readsTail(s.reads.count))
                }
                HintBar {
                    Hint(["j", "k"], "move"); Hint(["↵"], "expand")
                    Hint("click a row — the stream jumps to it")
                }
            }
            .panel(p)
        } detail: {
            StreamView(s, place: .reads)
        }
    }

    private func row(_ m: Message) -> some View {
        MessageRow(m, tags: s.tags(m.id), selected: s.streamReadsCur == m.id) {
            s.markSeen(m.id)
            s.streamReadsCur = m.id
            s.requestScroll(.reads, to: m.id)
        }
    }
}

/// Receipts — the same anatomy as Reads, with amounts right-aligned on tabular
/// figures and hairline day rules for scanability. No waterline here: a receipt is
/// a record, not a queue.
public struct ReceiptsView: View {
    @Environment(\.palette) private var p
    let s: AppState

    public init(_ s: AppState) { self.s = s }

    public var body: some View {
        SplitPane(compactPane: .detail) {
            VStack(spacing: 0) {
                ViewHead("Receipts", meta: s.receiptsMeta)
                Scroller {
                    ForEach(s.receiptRows, id: \.label) { group in
                        GroupLabel(group.label)
                        Rows {
                            ForEach(Array(group.items.enumerated()), id: \.element.id) { i, m in
                                if i > 0 { SoftRule() }
                                row(m)
                            }
                        }
                    }
                    TailRow(Copy.receiptsTail(s.receipts.count))
                }
                HintBar {
                    Hint(["j", "k"], "move"); Hint(["↵"], "expand")
                    Hint("click a row — the stream jumps to it")
                }
            }
            .panel(p)
        } detail: {
            StreamView(s, place: .receipts)
        }
    }

    private func row(_ m: Message) -> some View {
        MessageRow(m, tags: s.tags(m.id), selected: s.streamReceiptsCur == m.id, dense: true) {
            s.markSeen(m.id)
            s.streamReceiptsCur = m.id
            s.requestScroll(.receipts, to: m.id)
        }
    }
}

/// The pending-classification chip under the newest issue: the AI states what it
/// thinks and why, and offers the two answers. Nothing has been decided silently —
/// the mail is already filed by rule; this only teaches the rule.
///
/// **Every fact on this chip comes from the message.** The destination, the
/// confidence and the reason are that issue's classification; `Copy` supplies the
/// sentence they sit in and nothing else.
struct ReadsClassifierChip: View {
    @Environment(\.palette) private var p
    let s: AppState
    let classification: Classification
    init(_ s: AppState, of classification: Classification) {
        self.s = s; self.classification = classification
    }

    /// The classification as it currently stands with the reader.
    ///
    /// The reader's answer is still shell state (`AppState.readsChipState`) rather
    /// than an intent the source hears about, so the *decision* is read from there
    /// while everything the chip asserts about the mail comes from the model. When
    /// answering becomes a `MailIntent`, this collapses to `classification`.
    private var stated: Classification {
        var c = classification
        switch s.readsChipState {
        case .pending: c.decision = .pending
        case .approved: c.decision = .approved
        case .corrected: c.decision = .corrected
        }
        return c
    }

    var body: some View {
        HStack {
            switch stated.decision {
            case .approved:
                Chip(Copy.readsChip(stated), glyph: .check)
            case .corrected:
                Chip(Copy.readsChip(stated), glyph: .route)
            case .pending:
                Chip(Copy.readsChip(stated), glyph: .spark, pending: true) {
                    HStack(spacing: 4) {
                        MiniButton("Approve") { s.readsChipState = .approved
                            s.showToast(Copy.readsChipApprovedToast) }
                        Text("·").foregroundStyle(p.ink3.color.opacity(0.4))
                            .accessibilityHidden(true)
                        MiniButton("Correct") { s.readsChipState = .corrected
                            s.showToast(Copy.readsChipCorrectedToast(stated.correction)) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
    }
}

private struct MiniButton: View {
    @Environment(\.palette) private var p
    @State private var hovering = false
    let title: String
    let action: () -> Void
    init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Typography.font(Typography.Size.label, Typography.Weight.bold))
                .foregroundStyle(p.accentInk.color)
                .underline(hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// One tag, across everything — a single centred column, because a tag view has
/// no second pane to fill. Rows carry a place badge so you know where each lives.
public struct TagView: View {
    @Environment(\.palette) private var p
    let s: AppState
    let tag: TagID
    public init(_ s: AppState, tag: TagID) { self.s = s; self.tag = tag }

    private var items: [Message] { s.tagged(tag) }

    public var body: some View {
        HStack {
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                ViewHead(tag.name, meta: "\(items.count) message\(items.count == 1 ? "" : "s")")
                Scroller {
                    if items.isEmpty {
                        EmptyStateView(glyph: "🏷", title: Copy.tagEmpty, sub: Copy.tagEmptySub)
                    } else {
                        Rows {
                            ForEach(items) { m in
                                MessageRow(m, tags: s.tags(m.id), showPlace: true) { open(m) }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 680)
            .panel(p)
            Spacer(minLength: 0)
        }
    }

    private func open(_ m: Message) {
        switch m.place {
        case .ohbox: s.selectedOhboxID = m.id; s.route = .ohbox
        case .reads: s.streamReadsCur = m.id; s.requestScroll(.reads, to: m.id); s.route = .reads
        case .receipts: s.streamReceiptsCur = m.id; s.requestScroll(.receipts, to: m.id); s.route = .receipts
        }
    }
}
