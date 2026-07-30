import SwiftUI

/// The rail — a white panel sculpted by light, no border. Compose sits at the
/// top, then the three mail places, the Screener, the Triage piles with the Tags
/// group nested under them, utilities, and the real mailboxes at the foot. Counts
/// are live: they read straight off the arrays, so a screener decision ticks the
/// Ohbox badge in the same frame the row leaves.
public struct RailView: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let s: AppState
    @Binding var tagsOpen: Bool
    /// Below the breakpoint the rail is presented as an off-canvas drawer: it floats
    /// (lift-3), fills the height, and closes itself after a navigation.
    let inDrawer: Bool

    public init(_ s: AppState, tagsOpen: Binding<Bool>, inDrawer: Bool = false) {
        self.s = s; self._tagsOpen = tagsOpen; self.inDrawer = inDrawer
    }

    /// Navigating from the drawer dismisses it — otherwise the route changes behind
    /// a panel that still covers it.
    private func go(_ route: Route) {
        s.route = route
        if inDrawer {
            withAnimation(motion(reduceMotion, .blancDrawer)) { s.isRailOpen = false }
        }
    }

    public var body: some View {
        VScroll(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                wordmark
                composeCTA

                group {
                    item("Ohbox", route: .ohbox, count: s.ohboxUnread, hot: true,
                         help: "\(s.ohboxUnread) unread of \(s.ohboxTotal)")
                    item("Reads", route: .reads, count: s.readsNew, help: "\(s.readsNew) new")
                    item("Receipts", route: .receipts, count: s.receiptsNew, help: "\(s.receiptsNew) new")
                }

                group {
                    item("Screener", route: .screener(.waiting), count: s.screenerWaiting, hot: true,
                         help: "\(s.screenerWaiting) waiting")
                }

                group {
                    label("Triage")
                    item("Answer Later", route: .triage, count: s.replyCount)
                    item("Parked", route: .triage, count: s.asideCount)
                    item("Resurface", route: .triage, count: s.resurfaceCount)
                    tagsGroup
                }

                group {
                    item("Search", route: .search, keycap: "/")
                    item("Settings", route: .settings)
                }

                group {
                    label("Mailboxes")
                    ForEach(s.railMailboxes) { mb in
                        mailboxRow(mb.shortName, mb.kind)
                    }
                }

                Spacer(minLength: 14)
                Text(s.ownerAddress)
                    .blanc(BlancText(size: Typography.Size.micro, weight: Typography.Weight.regular))
                    .foregroundStyle(p.ink3.color)
                    .padding(.horizontal, 8).padding(.top, 14)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.init(top: 18, leading: 16, bottom: 18, trailing: 12))
        .frame(width: Space.rail)
        .modifier(RailSurface(inDrawer: inDrawer))
        .accessibilityLabel("Main navigation")
    }

    // MARK: Pieces

    /// Two runs, not one string: the second half is accent-ink so the rail
    /// echoes the "oh." app mark. Split at the word boundary — mail | oh — and
    /// lower-case, which is how the name is written everywhere a human reads it.
    private var wordmark: some View {
        (Text("mail").foregroundStyle(p.ink.color) + Text("oh").foregroundStyle(p.accentInk.color))
            .blanc(.wordmark)
            .padding(.horizontal, 8)
            .padding(.top, 2)
            .padding(.bottom, 14)
            .accessibilityLabel("mailoh")
    }

    private var composeCTA: some View {
        let on = s.route == .compose
        return Button { go(.compose) } label: {
            HStack(spacing: 8) {
                Icon(.pen, 14).foregroundStyle(p.accentInk.color)
                Text("Compose").blanc(.button).foregroundStyle(p.ink.color)
                Spacer(minLength: 6)
                Kbd("c", bare: true)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .surface(Radius.pill, p.float.color, .l0)
            .accentRing(p, radius: Radius.pill, on: on)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 4)
        .padding(.bottom, 16)
    }

    private func group<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 1) { content() }
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ t: String) -> some View {
        Text(t).blanc(.railLabel).foregroundStyle(p.ink3.color)
            .padding(.horizontal, 8).padding(.vertical, 4)
    }

    @ViewBuilder
    private func item(_ title: String, route: Route, count: Int? = nil, hot: Bool = false,
                      keycap: String? = nil, help: String? = nil, sub: Bool = false,
                      leading: (() -> AnyView)? = nil) -> some View {
        RailItem(title: title, isOn: isOn(route), count: count, hot: hot, keycap: keycap,
                 help: help, sub: sub, leading: leading) { go(route) }
    }

    private var tagsGroup: some View {
        VStack(alignment: .leading, spacing: 1) {
            Button {
                withAnimation(motion(reduceMotion, .blancSlide)) { tagsOpen.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Text("Tags").blanc(.railLabel).foregroundStyle(p.ink3.color)
                    Icon(.chevron, 11)
                        .foregroundStyle(p.ink3.color)
                        .rotationEffect(.degrees(tagsOpen ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tags")
            .accessibilityValue(tagsOpen ? "expanded" : "collapsed")

            if tagsOpen {
                ForEach(TagID.allCases) { t in
                    RailItem(title: t.name, isOn: isOn(.tag(t)), count: s.tagCount(t),
                             hot: false, keycap: nil, help: nil, sub: true,
                             leading: { AnyView(TagDot(t)) }) { go(.tag(t)) }
                }
            }
        }
        .padding(.top, 3)
        .padding(.leading, 10)
    }

    private func mailboxRow(_ name: String, _ kind: String) -> some View {
        HStack(alignment: .center, spacing: 7) {
            Circle().fill(p.ink3.color).opacity(0.7).frame(width: 4, height: 4)
            Text(name).blanc(.chip).foregroundStyle(p.ink2.color)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 6)
            Text(kind).blanc(.badge).foregroundStyle(p.ink3.color).fixedSize()
        }
        .padding(.horizontal, 8).padding(.vertical, 3.5)
    }

    /// The rail marks the *first* matching item, so the three Triage rows don't
    /// all light up at once when the Triage route is active.
    private func isOn(_ route: Route) -> Bool {
        switch (s.route, route) {
        case (.screener, .screener): return true
        case (.triage, .triage): return title(of: route) == "Answer Later"
        default: return s.route == route
        }
    }
    private func title(of r: Route) -> String { r.title }
}

/// Resting panel in the deck; floating layer in the compact drawer.
private struct RailSurface: ViewModifier {
    @Environment(\.palette) private var p
    let inDrawer: Bool
    func body(content: Content) -> some View {
        if inDrawer { content.floatSurface(p, radius: Radius.panel, lift: .l3) }
        else { content.panel(p) }
    }
}

private struct RailItem: View {
    @Environment(\.palette) private var p
    @State private var hovering = false
    let title: String
    let isOn: Bool
    let count: Int?
    let hot: Bool
    let keycap: String?
    let help: String?
    let sub: Bool
    let leading: (() -> AnyView)?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                if let leading { leading() }
                Text(title)
                    .font(Typography.font(sub ? Typography.Size.control : Typography.Size.body,
                                          isOn ? Typography.Weight.bold : Typography.Weight.regular))
                    .tracking(0)
                Spacer(minLength: 6)
                if let keycap { Kbd(keycap) }
                else if let count {
                    Text("\(count)")
                        .font(Typography.font(sub ? Typography.Size.caption : Typography.Size.label,
                                              Typography.Weight.semibold))
                        .monospacedDigit()
                        .foregroundStyle(hot ? p.accentInk.color : p.ink3.color)
                        .contentTransition(.numericText())
                }
            }
            .foregroundStyle(isOn || hovering ? p.ink.color : p.ink2.color)
            .padding(.horizontal, 8)
            .padding(.vertical, sub ? 5 : 6)
            .wash(Radius.item, hovering && !isOn ? p.tint.color : .clear)
            .overlay(alignment: .leading) {
                // the active marker sits outside the item, in the rail's own margin
                Circle().fill(p.accent.color).frame(width: 4, height: 4)
                    .offset(x: -10).opacity(isOn ? 1 : 0)
            }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help ?? "")
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}
