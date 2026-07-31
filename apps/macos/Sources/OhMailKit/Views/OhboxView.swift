import SwiftUI

/// Ohbox — the two-pane home: accepted mail on the left, the message on the
/// right. Reading here is non-destructive: opening a message never marks it seen,
/// so the unread badge only moves when *you* decide something.
public struct OhboxView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let s: AppState
    let onEnterReader: () -> Void
    let onTag: (String) -> Void

    public init(_ s: AppState, onEnterReader: @escaping () -> Void, onTag: @escaping (String) -> Void) {
        self.s = s; self.onEnterReader = onEnterReader; self.onTag = onTag
    }

    public var body: some View {
        SplitPane(compactPane: .list) {
            VStack(spacing: 0) {
                ViewHead("Ohbox", meta: s.ohboxMeta)
                if !s.waiting.isEmpty { Doorbell(s) }
                Scroller {
                    GroupLabel(Copy.groupNew)
                    Rows { ForEach(s.ohboxNew) { row($0) } }
                    GroupLabel(Copy.groupSeen)
                    Rows { ForEach(s.ohboxSeen) { row($0) } }
                    TailRow(Copy.ohboxTail(s.ohbox.count))
                }
                HintBar {
                    Hint(["j", "k"], "move"); Hint(["↵"], "read")
                    Hint(["t"], "tag"); Hint(["esc"], "back")
                }
            }
            .panel(p)
        } detail: {
            VScroll {
                if let m = s.selectedOhbox {
                    MessageView(s, m, inReader: false, onEnterReader: onEnterReader) { onTag(m.id) }
                        .frame(maxWidth: .infinity)
                        .id(m.id)
                }
            }
            .safeAreaPadding(.bottom, Space.dockClearance)
            .panel(p)
        }
    }

    private func row(_ m: Message) -> some View {
        MessageRow(m, tags: s.tags(m.id), selected: m.id == s.selectedOhboxID) {
            // Compact has no reading column, so a tap opens the reader directly —
            // the prototype's `matchMedia("(max-width:900px)")` branch.
            if compact {
                s.selectedOhboxID = m.id
                onEnterReader()
            } else if m.id == s.selectedOhboxID {
                onEnterReader()
            } else {
                s.selectedOhboxID = m.id
            }
        }
    }
}

/// The Screener doorbell — a knock, not a nag. It states how many first-time
/// senders are waiting, and disappears the moment the queue is empty.
struct Doorbell: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.compactLayout) private var compact
    @State private var hovering = false
    let s: AppState
    init(_ s: AppState) { self.s = s }

    var body: some View {
        Button { s.route = .screener(.waiting) } label: {
            HStack(spacing: 12) {
                HStack(spacing: -7) {
                    ForEach(s.waiting) { Avatar($0.initial, size: 26) }
                }
                (Text(Copy.doorbell(s.waiting.count))
                    .font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
                    .foregroundStyle(p.ink.color)
                 + Text(" " + Copy.doorbellRest).foregroundStyle(p.ink2.color))
                    .blanc(.meta)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(Copy.doorbellGo)
                    .font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
                    .foregroundStyle(p.accentInk.color)
            }
            .padding(.leading, 10).padding(.trailing, 16).padding(.vertical, 9)
            .modifier(DoorbellSurface(hovering: hovering))
            .offset(y: hovering ? -1 : 0)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancFast), value: hovering)
        .padding(.horizontal, compact ? 14 : 26).padding(.top, compact ? 12 : 16)
        .accessibilityLabel("\(s.waiting.count) new senders waiting — open the Screener")
    }
}

private struct DoorbellSurface: ViewModifier {
    @Environment(\.palette) private var p
    let hovering: Bool
    func body(content: Content) -> some View {
        if hovering { content.surface(Radius.pill, p.accentSoft.color, .l0) }
        else { content.wash(Radius.pill, p.accentSoft.color) }
    }
}

/// The `--split` grid: one list-column width shared by Ohbox · Reads · Receipts ·
/// Screener, so switching views never shifts the layout, plus a 16pt gutter.
///
/// Below `Space.mobileMax` there is not room for two panes (rail + list minimums
/// alone exceed 390pt), so the grid becomes `1fr` and each view declares which pane
/// survives — exactly as the prototype's mobile block does per view: the Ohbox and
/// the Screener keep their list, Reads and Receipts keep their stream.
public struct SplitPane<List: View, Detail: View>: View {
    @Environment(\.compactLayout) private var compact

    public enum CompactPane: Sendable { case list, detail }

    let compactPane: CompactPane
    @ViewBuilder let list: List
    @ViewBuilder let detail: Detail

    public init(compactPane: CompactPane = .list,
                @ViewBuilder list: () -> List, @ViewBuilder detail: () -> Detail) {
        self.compactPane = compactPane; self.list = list(); self.detail = detail()
    }

    public var body: some View {
        if compact {
            switch compactPane {
            case .list: list.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            case .detail: detail.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        } else {
            HStack(alignment: .top, spacing: Space.deck) {
                list.frame(minWidth: Space.listColMin, maxWidth: Space.listColMax)
                detail.frame(maxWidth: .infinity)
            }
        }
    }
}
