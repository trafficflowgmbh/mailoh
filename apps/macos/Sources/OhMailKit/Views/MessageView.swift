import SwiftUI

/// One message, rendered twice: inside the Ohbox reading column, and — larger,
/// on a floating surface — inside reading mode. The chips above the body are the
/// product's whole argument made visible: *why* this mail is here (the rule or
/// the Yes that filed it), and what was blocked on the way in.
public struct MessageView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let s: AppState
    let m: Message
    let inReader: Bool
    let onEnterReader: () -> Void
    let onTag: () -> Void

    public init(_ s: AppState, _ m: Message, inReader: Bool,
                onEnterReader: @escaping () -> Void, onTag: @escaping () -> Void) {
        self.s = s; self.m = m; self.inReader = inReader
        self.onEnterReader = onEnterReader; self.onTag = onTag
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            fromLine
            Text(m.subj)
                .blanc(inReader ? .readerTitle : .h2)
                .foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, inReader ? 18 : 14)
                .padding(.bottom, inReader ? 16 : 14)
            chips.padding(.bottom, 22)
            // No-collapse: a thread badge saying "4" means four bodies here.
            if !m.earlier.isEmpty { earlierMessages }
            if let meta = m.sensitive { ProtectedBlock(meta) } else { bodyText }
            if let attach { attachment(attach) }
            actions.padding(.top, 34)
        }
        .frame(maxWidth: inReader ? Space.readerMax : Space.messageMax, alignment: .leading)
        .padding(.horizontal, inReader ? (compact ? 22 : 52) : (compact ? Space.paneXCompact : Space.messageX))
        .padding(.top, inReader ? (compact ? 30 : 46) : 26)
        .padding(.bottom, inReader ? 40 : 48)
        .recordRender(m.id)
    }

    /// The rest of the conversation, oldest first, each with its own subject and
    /// time so no message loses its identity to a count.
    private var earlierMessages: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(m.earlier) { h in
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(h.subj)
                            .font(Typography.font(Typography.Size.control, Typography.Weight.bold))
                            .foregroundStyle(p.ink2.color)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Text(h.time).blanc(.caption).monospacedDigit()
                            .foregroundStyle(p.ink3.color).fixedSize()
                    }
                    .padding(.bottom, 6)
                    if h.isProtected {
                        Text(Copy.protectedRedactedBody)
                            .blanc(.body).foregroundStyle(p.ink3.color)
                    } else {
                        Text(h.body ?? "")
                            .blanc(inReader ? .readerBody : .msgBody)
                            .foregroundStyle(p.ink2.color)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            // Same optical measure as the newest message, so the
                            // thread reads as one page rather than two column widths.
                            .frame(maxWidth: proseMeasure, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 14)
                .recordRender(h.id)
                SoftRule(inset: 0).padding(.bottom, 14)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Earlier in this thread — \(m.earlier.count) message\(m.earlier.count == 1 ? "" : "s")")
    }

    private var attach: String? { m.attach }

    private var fromLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text(m.from)
                .blanc(BlancText(size: Typography.Size.control, weight: Typography.Weight.bold))
                .foregroundStyle(p.ink.color)
            Text(m.addr).blanc(.meta).foregroundStyle(p.ink3.color)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 10)
            HStack(spacing: 10) {
                Text(threadTime).blanc(.chip).monospacedDigit().foregroundStyle(p.ink3.color)
                if !inReader {
                    QuietButton(size: 26, action: onEnterReader) { Icon(.open, 13) }
                        .help("Read (↵)")
                        .accessibilityLabel("Open reading mode")
                }
            }
            .fixedSize()
        }
    }

    private var threadTime: String {
        if let t = m.thread { return "thread (\(t)) · \(m.time)" }
        return m.time
    }

    private var chips: some View {
        FlowRow(spacing: 7) {
            if let r = m.rationale { Chip(r, glyph: .route) }
            if let t = m.tracker { Chip(t, glyph: .shield) }
            ForEach(s.tags(m.id)) { TagChipView($0, big: true) }
            AddTagChip(action: onTag)
        }
    }

    /// ~60 characters of measure at the reading-pane size — the one optical limit in
    /// the message column.
    private var proseMeasure: CGFloat { 60 * Typography.Size.prose * 0.5 }

    private var bodyText: some View {
        Text(m.body ?? "")
            .blanc(inReader ? .readerBody : .msgBody)
            .foregroundStyle(p.ink.color)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: proseMeasure, alignment: .leading)
    }

    private func attachment(_ a: String) -> some View {
        let parts = a.split(separator: " (", maxSplits: 1).map(String.init)
        return Button {
            s.showToast("Attachments open in Preview once a mailbox is connected.")
        } label: {
            HStack(spacing: 8) {
                Icon(.clip, 14)
                Text(parts.first ?? a).blanc(.button)
                if parts.count > 1 {
                    Text("(" + parts[1]).blanc(.meta).foregroundStyle(p.ink3.color)
                }
            }
            .foregroundStyle(p.ink.color)
            .padding(.horizontal, 15).padding(.vertical, 9)
            .surface(Radius.pill, p.panel.color, .l0)
        }
        .buttonStyle(.plain)
        .padding(.top, 20)
    }

    private var actions: some View {
        FlowRow(spacing: 7) {
            PillButton("Reply") { s.route = .compose }
            PillButton("Answer Later") { s.replyLater(m) }
            PillButton("Park") { s.setAside(m) }
            PillButton("Resurface") { s.resurface(m) }
            PillButton(Copy.move, kind: .ghost) {
                s.showToast("Move lands with the folder picker in the engine slice.")
            }
            PillButton(Copy.draftReply, glyph: .spark, kind: .primary) { s.route = .compose }
        }
        .opacity(inReader ? 0.999 : 1)
    }
}

/// The `+ Tag` affordance — the one outlined chip in Blanc, because an
/// add-control should read as an empty field waiting to be filled.
struct AddTagChip: View {
    @Environment(\.palette) private var p
    @State private var hovering = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Icon(.plus, 11)
                Text("Tag").blanc(.chip)
                Kbd("t", bare: true)
            }
            .foregroundStyle(hovering ? p.ink.color : p.ink3.color)
            .padding(.horizontal, 12).padding(.vertical, 5)
            .wash(Radius.pill, hovering ? p.tint.color : .clear)
            .hairline(p, radius: Radius.pill)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// **The sensitive-mail invariant, made visible.** An OTP body is never stored,
/// so there is nothing to render — the block states the policy instead of showing
/// a code. The dots animate in once, then hold; the copy is factual, not a boast.
public struct ProtectedBlock: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = 0

    /// The metadata is all there is — a class and a length. No content reaches here
    /// because `MailContent.sensitiveRedacted` carries none.
    let metadata: SensitiveMetadata

    public init(_ metadata: SensitiveMetadata = SensitiveMetadata()) {
        self.metadata = metadata
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Icon(.lock, 26).foregroundStyle(p.accentInk.color)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Copy.protectedCodeLabel)
                Text(String(repeating: "·", count: shown))
                    .tracking(Typography.Size.h4 * Typography.Tracking.code)
                Text(Copy.protectedRedacted)
                    .font(Typography.font(Typography.Size.caption, Typography.Weight.regular))
                    .foregroundStyle(p.ink3.color)
            }
            .font(Typography.mono)
            .foregroundStyle(p.ink.color)
            .padding(.vertical, 12)

            (Text(Copy.protectedLead)
                .font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
                .foregroundStyle(p.ink.color)
             + Text(Copy.protectedPolicy).foregroundStyle(p.ink2.color))
                .blanc(BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.regular, leading: 1.55))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 24).padding(.vertical, 22)
        .frame(maxWidth: 460, alignment: .leading)
        .wash(Radius.panel, p.accentSoft.color)
        .padding(.top, 4).padding(.bottom, 8)
        .task {
            guard !reduceMotion else { shown = metadata.redactedLength; return }
            for _ in 0..<metadata.redactedLength {
                try? await Task.sleep(for: .milliseconds(90))
                withAnimation(.blancFast) { shown += 1 }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Copy.protectedCodeLabel + " redacted. "
                            + Copy.protectedLead + Copy.protectedPolicy)
    }
}

/// A wrapping row of chips/buttons. SwiftUI has no `flex-wrap`, and a `Grid`
/// would impose columns the design doesn't have — so this is a real flow layout.
public struct FlowRow: Layout {
    public var spacing: CGFloat
    public var lineSpacing: CGFloat
    public init(spacing: CGFloat = 7, lineSpacing: CGFloat = 7) {
        self.spacing = spacing; self.lineSpacing = lineSpacing
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let size = v.sizeThatFits(.unspecified)
            if x > 0, x + spacing + size.width > maxWidth {
                widest = max(widest, x); x = 0; y += lineHeight + lineSpacing; lineHeight = 0
            }
            x += (x > 0 ? spacing : 0) + size.width
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: min(max(widest, x), maxWidth), height: y + lineHeight)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
                              subviews: Subviews, cache: inout ()) {
        let maxWidth = bounds.width
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        for v in subviews {
            let size = v.sizeThatFits(.unspecified)
            if x > 0, x + spacing + size.width > maxWidth {
                x = 0; y += lineHeight + lineSpacing; lineHeight = 0
            }
            if x > 0 { x += spacing }
            v.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                    proposal: ProposedViewSize(size))
            x += size.width
            lineHeight = max(lineHeight, size.height)
        }
    }
}
