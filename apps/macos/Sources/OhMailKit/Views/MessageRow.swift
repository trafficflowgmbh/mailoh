import SwiftUI

/// **One row language, everywhere.** Ohbox, Reads, Receipts and the Tag view all
/// render this exact anatomy — unread dot · sender · address · time, then subject
/// + badges + (right-aligned) amount, then the preview line. Selection raises the
/// row onto a float surface with lift-2 and a 1pt rise; nothing else moves, so a
/// list never reshuffles under the pointer.
public struct MessageRow: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    let m: Message
    let tags: [TagID]
    let selected: Bool
    /// Shown in the Tag view, where rows come from three different places.
    let showPlace: Bool
    let dense: Bool
    let action: () -> Void

    public init(_ m: Message, tags: [TagID] = [], selected: Bool = false,
                showPlace: Bool = false, dense: Bool = false, action: @escaping () -> Void) {
        self.m = m; self.tags = tags; self.selected = selected
        self.showPlace = showPlace; self.dense = dense; self.action = action
    }

    private var seen: Bool { m.seen || !m.unread }

    public var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                topLine
                midLine.padding(.top, 2)
                if let preview {
                    Text(preview)
                        .blanc(.meta).foregroundStyle(p.ink3.color)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(.top, 1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .modifier(RowBackground(selected: selected, hovering: hovering,
                                    radius: dense ? Radius.rowDense : Radius.row))
            .offset(y: selected ? -1 : 0)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancFlip), value: selected)
        .animation(motion(reduceMotion, .blancFast), value: hovering)
        .accessibilityLabel("\(m.from): \(m.subj)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .recordRender(m.id)
    }

    private var preview: String? {
        if let pv = m.preview { return pv }
        if m.isProtected { return Copy.protectedPreview }
        return nil
    }

    private var topLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            UnreadDot(on: m.unread)
            Text(m.from)
                .blanc(seen ? .rowSenderSeen : .rowSender)
                .foregroundStyle(seen ? p.ink2.color : p.ink.color)
                .lineLimit(1).truncationMode(.tail)
                .layoutPriority(2)
            Text(m.addr)
                .blanc(.caption).foregroundStyle(p.ink3.color)
                .lineLimit(1).truncationMode(.tail)
                .layoutPriority(0)
            Spacer(minLength: 6)
            Text(m.time)
                .blanc(.caption).monospacedDigit().foregroundStyle(p.ink3.color)
                .fixedSize()
        }
    }

    private var midLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(m.subj)
                    .blanc(seen ? .rowSubjectSeen : .rowSubject)
                    .foregroundStyle(seen ? p.ink2.color : p.ink.color)
                    .lineLimit(1).truncationMode(.tail)
                badges
            }
            if let amount = m.amount {
                Spacer(minLength: 8)
                Text(amount)
                    .blanc(BlancText(size: Typography.Size.control, weight: Typography.Weight.semibold))
                    .monospacedDigit()
                    .foregroundStyle(seen ? p.ink2.color : p.ink.color)
                    .fixedSize()
            }
        }
    }

    @ViewBuilder private var badges: some View {
        HStack(spacing: 6) {
            if let t = m.thread { Badge("⤷ \(t)", numeric: true) }
            if m.attach != nil { Badge(glyph: .clip) }
            if m.isProtected { Badge("protected", glyph: .shield, kind: .shield) }
            ForEach(tags) { TagChipView($0) }
            if showPlace { Badge(m.place.title, kind: .place) }
        }
        .fixedSize()
    }
}

/// The unread dot. Marking seen fades it **in place** over 0.7s — the row keeps
/// its position, so a list read top-to-bottom never jumps.
public struct UnreadDot: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let on: Bool
    let size: CGFloat
    public init(on: Bool, size: CGFloat = 5) { self.on = on; self.size = size }
    public var body: some View {
        Circle()
            .fill(p.accent.color)
            .frame(width: size, height: size)
            .opacity(on ? 1 : 0)
            .animation(motion(reduceMotion, .blancSeen), value: on)
            .accessibilityHidden(true)
    }
}

private struct RowBackground: ViewModifier {
    @Environment(\.palette) private var p
    let selected: Bool
    let hovering: Bool
    let radius: CGFloat
    func body(content: Content) -> some View {
        if selected {
            content.surface(radius, p.float.color, .l2)
        } else {
            content.wash(radius, hovering ? p.tint.color : .clear)
        }
    }
}

/// The container the rows sit in. 16pt of side padding so a raised row's shadow
/// is never sheared off at the pane edge (verbatim reason from the prototype); 8pt
/// below the breakpoint, matching `.rows{padding-left:8px;padding-right:8px}`.
public struct Rows<Content: View>: View {
    @Environment(\.compactLayout) private var compact
    @ViewBuilder let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        LazyStack { content }.padding(.horizontal, compact ? 8 : 16)
    }
}
