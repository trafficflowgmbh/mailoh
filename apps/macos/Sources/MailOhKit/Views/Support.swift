import SwiftUI
import AppKit

// MARK: - Surfaces

/// Blanc's core move: an opaque rounded surface whose **shape** casts the lift
/// shadow. The shadow must never be chained onto the content — `.shadow` over a
/// `Text` embosses the glyphs. Painting it on a background shape keeps the
/// falloff on the panel edge, exactly like a CSS `box-shadow` on the box.
public extension View {
    func surface(_ radius: CGFloat, _ fill: Color, _ level: Lift?) -> some View {
        background {
            ShadowShape(radius: radius, fill: fill, level: level)
        }
    }
    /// Panel = resting surface (rail, list panes, reading column, settings panes).
    func panel(_ palette: Palette, radius: CGFloat = Radius.panel, lift: Lift? = .l1) -> some View {
        surface(radius, palette.panel.color, lift)
    }
    /// Float = raised/floating surface (dock, palette, cards, reader, selected rows).
    func floatSurface(_ palette: Palette, radius: CGFloat, lift: Lift? = .l0) -> some View {
        surface(radius, palette.float.color, lift)
    }
    /// A translucent wash with no shadow (accent-soft blocks, tint chips).
    func wash(_ radius: CGFloat, _ fill: Color) -> some View {
        background { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(fill) }
    }
    func clip(_ radius: CGFloat) -> some View {
        clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
    /// The AI-preselect / focused-input ring: 1.5pt accent hairline over the lift.
    func accentRing(_ palette: Palette, radius: CGFloat, on: Bool = true) -> some View {
        overlay {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(on ? palette.accentHair.color : .clear, lineWidth: 1.5)
        }
    }
    /// Functional hairline border (keycaps, input fields).
    func hairline(_ palette: Palette, radius: CGFloat, soft: Bool = false) -> some View {
        overlay {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(soft ? palette.hairSoft.color : palette.hair.color, lineWidth: 1)
        }
    }
}

private struct ShadowShape: View {
    let radius: CGFloat
    let fill: Color
    let level: Lift?
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous).fill(fill)
        if let level { shape.lift(level) } else { shape }
    }
}

// MARK: - Motion, reduced-motion aware

/// Blanc's reduced-motion policy is *instant*, never *slow* — so the honest
/// native translation is `nil` (no animation), not a shortened duration. Views
/// read `\.accessibilityReduceMotion` and pass it through here.
@inlinable public func motion(_ reduce: Bool, _ animation: Animation) -> Animation? {
    reduce ? nil : animation
}

// MARK: - Icons

/// The prototype ships a 20-glyph geometric set at 1.3px stroke. SF Symbols is
/// the native equivalent; `.light` weight matches the thin-stroke drawing, and
/// every glyph below is the closest structural match to its SVG counterpart.
public enum Glyph: String, Sendable {
    case ohbox = "tray"
    case clock = "clock"
    case pause = "pause"
    case up = "arrow.up.circle"
    case search = "magnifyingglass"
    case shield = "shield"
    case clip = "paperclip"
    case route = "arrow.triangle.branch"
    case spark = "sparkles"
    case sun = "sun.max"
    case info = "info.circle"
    case x = "xmark"
    case check = "checkmark"
    case menu = "line.3.horizontal"
    case open = "arrow.up.left.and.arrow.down.right"
    case tag = "tag"
    case plus = "plus"
    case chevron = "chevron.right"
    case pen = "pencil"
    case lock = "lock"
}

public struct Icon: View {
    let glyph: Glyph
    let size: CGFloat
    public init(_ glyph: Glyph, _ size: CGFloat = 15) { self.glyph = glyph; self.size = size }
    public var body: some View {
        Image(systemName: glyph.rawValue)
            .font(.system(size: size * 0.86, weight: .light))
            .frame(width: size, height: size)
    }
}

// MARK: - Keycap

/// `kbd` — the one place Blanc keeps a legibility hairline.
///
///   `.solid` hint bars and standalone keycaps: panel fill + `hair` border
///   `.soft`  inside buttons: transparent fill, `hair-soft` border
///   `.naked` inside the decision bar's split pills: no chrome at all
public struct Kbd: View {
    @Environment(\.palette) private var p
    public enum Style: Sendable { case solid, soft, naked }
    let key: String
    let style: Style

    public init(_ key: String, style: Style = .solid) { self.key = key; self.style = style }
    /// Convenience for the common in-button case.
    public init(_ key: String, bare: Bool) { self.init(key, style: bare ? .soft : .solid) }

    public var body: some View {
        Text(key)
            .font(.system(size: Typography.Size.micro, design: .monospaced))
            .foregroundStyle(style == .solid ? p.ink3.color : Color.primary.opacity(0.7))
            .frame(minWidth: style == .naked ? 0 : 18)
            .padding(.horizontal, style == .naked ? 1 : 5)
            .padding(.vertical, style == .naked ? 0 : 1)
            .background {
                switch style {
                case .solid:
                    RoundedRectangle(cornerRadius: Radius.keycap, style: .continuous)
                        .fill(p.panel.color)
                        .hairline(p, radius: Radius.keycap)
                case .soft:
                    RoundedRectangle(cornerRadius: Radius.keycap, style: .continuous)
                        .strokeBorder(p.hairSoft.color, lineWidth: 1)
                case .naked:
                    EmptyView()
                }
            }
    }
}

/// A run of keycaps followed by a label — the hint-bar unit.
public struct Hint: View {
    @Environment(\.palette) private var p
    let keys: [String]
    let label: String
    public init(_ keys: [String], _ label: String) { self.keys = keys; self.label = label }
    public init(_ label: String) { self.keys = []; self.label = label }
    public var body: some View {
        HStack(spacing: 4) {
            ForEach(keys, id: \.self) { Kbd($0) }
            if !label.isEmpty {
                Text(label).blanc(.caption).foregroundStyle(p.ink3.color)
                    .padding(.leading, keys.isEmpty ? 0 : 2)
            }
        }
        // A hint is atomic: it either fits on the line or the row wraps it to the
        // next one. Letting it compress produces "e…" instead of "esc", which
        // teaches nothing — the whole point of the bar.
        .fixedSize()
    }
}

/// The bottom rail of a list column: `j k move · ↵ read · t tag`.
///
/// It **wraps** rather than truncates. The list column is only ~400pt wide and the
/// Screener's map (`y accept suggestion`, `o r c n x file`, `⇧ +key marks read`)
/// is far wider than that; in an `HStack` the labels collapse to ellipses and the
/// hint bar teaches nothing, which is worse than a second line.
/// Hidden below the breakpoint, exactly as `.list-hints{display:none}` — there is
/// no hardware keyboard to teach on a 390pt-wide window.
public struct HintBar<Content: View>: View {
    @Environment(\.compactLayout) private var compact
    @ViewBuilder let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        if !compact {
            FlowRow(spacing: 12, lineSpacing: 6) { content }
                .padding(.horizontal, Space.paneX)
                .padding(.top, 10)
                .padding(.bottom, 14)
        }
    }
}

// MARK: - Badges & chips

/// Row badge — thread counts, attachment, place, the protected shield, AI dest.
public struct Badge: View {
    @Environment(\.palette) private var p
    public enum Kind: Sendable { case plain, shield, place, ai }
    let text: String?
    let glyph: Glyph?
    let kind: Kind
    let numeric: Bool
    public init(_ text: String? = nil, glyph: Glyph? = nil, kind: Kind = .plain, numeric: Bool = false) {
        self.text = text; self.glyph = glyph; self.kind = kind; self.numeric = numeric
    }
    private var fg: Color { kind == .shield || kind == .ai ? p.accentInk.color : p.ink3.color }
    private var bg: Color {
        switch kind {
        case .shield, .ai: return p.accentSoft.color
        case .place: return p.tint.color
        case .plain: return p.tint2.color
        }
    }
    public var body: some View {
        HStack(spacing: 3) {
            if let glyph { Icon(glyph, 10) }
            if let text {
                Text(text)
                    .font(Typography.font(Typography.Size.micro,
                                          kind == .plain ? Typography.Weight.medium : Typography.Weight.semibold))
                    .modifier(MaybeMonoDigit(on: numeric))
            }
        }
        .foregroundStyle(fg)
        .padding(.horizontal, 7)
        .padding(.vertical, 1)
        .wash(Radius.pill, bg)
    }
}

private struct MaybeMonoDigit: ViewModifier {
    let on: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if on { content.monospacedDigit() } else { content }
    }
}

/// Reading-pane chip — the filing rationale, tracker note, AI confidence.
public struct Chip<Trailing: View>: View {
    @Environment(\.palette) private var p
    let glyph: Glyph?
    let text: String
    let pending: Bool
    @ViewBuilder let trailing: Trailing

    public init(_ text: String, glyph: Glyph? = nil, pending: Bool = false,
                @ViewBuilder trailing: () -> Trailing) {
        self.text = text; self.glyph = glyph; self.pending = pending; self.trailing = trailing()
    }
    public var body: some View {
        HStack(spacing: 6) {
            if let glyph { Icon(glyph, 12).foregroundStyle(p.accentInk.color) }
            Text(text).blanc(.chip).foregroundStyle(p.ink2.color)
            trailing
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .wash(Radius.pill, pending ? p.accentSoft.color : p.tint.color)
        .fixedSize(horizontal: false, vertical: true)
    }
}

public extension Chip where Trailing == EmptyView {
    init(_ text: String, glyph: Glyph? = nil, pending: Bool = false) {
        self.init(text, glyph: glyph, pending: pending) { EmptyView() }
    }
}

/// A tag chip — muted hue pair, never candy.
public struct TagChipView: View {
    @Environment(\.palette) private var p
    let tag: TagID
    let big: Bool
    public init(_ tag: TagID, big: Bool = false) { self.tag = tag; self.big = big }
    public var body: some View {
        let hue = p.tag(tag.hue)
        HStack(spacing: 4) {
            Text(tag.name).blanc(.tagchip)
        }
        .foregroundStyle(hue.ink.color)
        .padding(.horizontal, big ? 12 : 8)
        .padding(.vertical, big ? 5 : 1)
        .wash(Radius.pill, hue.bg.color)
    }
}

/// The rail's rounded tag square.
public struct TagDot: View {
    @Environment(\.palette) private var p
    let tag: TagID
    public init(_ tag: TagID) { self.tag = tag }
    public var body: some View {
        RoundedRectangle(cornerRadius: Radius.dot, style: .continuous)
            .fill(p.tag(tag.hue).ink.color.opacity(0.75))
            .frame(width: 8, height: 8)
    }
}

// MARK: - Buttons

/// Blanc's capsule button — held up by light, lifts on hover, sinks on press.
public struct PillButton: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    public enum Kind: Sendable { case normal, primary, ghost }
    let title: String
    let glyph: Glyph?
    let key: String?
    let kind: Kind
    let compact: Bool
    let action: () -> Void

    public init(_ title: String, glyph: Glyph? = nil, key: String? = nil,
                kind: Kind = .normal, compact: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.glyph = glyph; self.key = key
        self.kind = kind; self.compact = compact; self.action = action
    }

    private var fg: Color {
        switch kind {
        case .primary: return p.onAccent.color
        case .ghost: return hovering ? p.ink.color : p.ink2.color
        case .normal: return p.ink.color
        }
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if let glyph { Icon(glyph, 13) }
                Text(title).blanc(compact ? .decision : .button)
                if let key { Kbd(key, bare: true) }
            }
            .foregroundStyle(fg)
            .padding(.horizontal, compact ? 13 : 15)
            .padding(.vertical, compact ? 5.5 : 7)
            .modifier(PillBackground(kind: kind, hovering: hovering))
            .offset(y: hovering && kind != .ghost ? -1 : 0)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancFast), value: hovering)
    }
}

private struct PillBackground: ViewModifier {
    @Environment(\.palette) private var p
    let kind: PillButton.Kind
    let hovering: Bool
    func body(content: Content) -> some View {
        switch kind {
        case .primary:
            content.wash(Radius.pill, p.accent.color.opacity(hovering ? 0.92 : 1))
        case .ghost:
            content.wash(Radius.pill, hovering ? p.tint.color : .clear)
        case .normal:
            content.surface(Radius.pill, p.panel.color, hovering ? .l2 : .l0)
        }
    }
}

/// A borderless text/icon button that only tints on hover (dock icons, close ✕).
public struct QuietButton<Label: View>: View {
    @Environment(\.palette) private var p
    @State private var hovering = false
    let size: CGFloat?
    let action: () -> Void
    @ViewBuilder let label: Label
    public init(size: CGFloat? = nil, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.size = size; self.action = action; self.label = label()
    }
    public var body: some View {
        Button(action: action) {
            label
                .foregroundStyle(hovering ? p.ink.color : p.ink2.color)
                .frame(width: size, height: size)
                .padding(size == nil ? 6 : 0)
                .wash(Radius.pill, hovering ? p.tint.color : .clear)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

// MARK: - Segmented control

public struct Segmented<T: Hashable>: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let options: [(value: T, label: String, count: Int?)]
    let selection: T
    let dense: Bool
    let onSelect: (T) -> Void

    public init(_ options: [(value: T, label: String, count: Int?)], selection: T,
                dense: Bool = false, onSelect: @escaping (T) -> Void) {
        self.options = options; self.selection = selection; self.dense = dense; self.onSelect = onSelect
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.value) { opt in
                let on = opt.value == selection
                Button { onSelect(opt.value) } label: {
                    HStack(spacing: 6) {
                        Text(opt.label)
                            .font(Typography.font(dense ? Typography.Size.caption : Typography.Size.bodyS,
                                                  on ? Typography.Weight.bold : Typography.Weight.regular))
                        if let c = opt.count, c > 0 {
                            Text("\(c)").blanc(.badge).monospacedDigit()
                                .foregroundStyle(on ? p.ink2.color : p.ink3.color)
                        }
                    }
                    .foregroundStyle(on ? p.ink.color : p.ink3.color)
                    .padding(.horizontal, dense ? 10 : 13)
                    .padding(.vertical, dense ? 3.5 : 5.5)
                    .modifier(SegPill(on: on))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(2)
        .wash(Radius.pill, p.tint2.color)
        .animation(motion(reduceMotion, .blancSlide), value: selection)
    }
}

private struct SegPill: ViewModifier {
    @Environment(\.palette) private var p
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.surface(Radius.pill, p.float.color, .l0) }
        else { content }
    }
}

// MARK: - Switch

public struct BlancSwitch: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var isOn: Bool
    let label: String
    public init(_ label: String, isOn: Binding<Bool>) { self.label = label; self._isOn = isOn }
    public var body: some View {
        Button { isOn.toggle() } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? p.accent.color : p.tint2.color)
                Circle().fill(p.float.color).lift(.l0)
                    .frame(width: 19, height: 19)
                    .padding(2)
            }
            .frame(width: 40, height: 23)
        }
        .buttonStyle(.plain)
        .animation(motion(reduceMotion, .blancSlide), value: isOn)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

// MARK: - Avatar

public struct Avatar: View {
    @Environment(\.palette) private var p
    let initial: String
    let size: CGFloat
    public init(_ initial: String, size: CGFloat = 30) { self.initial = initial; self.size = size }
    public var body: some View {
        Text(initial)
            .font(Typography.font(size <= 26 ? Typography.Size.micro : Typography.Size.label,
                                  Typography.Weight.heavy))
            .foregroundStyle(p.ink2.color)
            .frame(width: size, height: size)
            .background { Circle().fill(p.float.color).lift(.l0) }
    }
}

// MARK: - Structure atoms

public struct ViewHead<Trailing: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let title: String
    let meta: String?
    @ViewBuilder let trailing: Trailing
    public init(_ title: String, meta: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title; self.meta = meta; self.trailing = trailing()
    }
    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            // `.vhead h1{font-size:22px}` below the breakpoint.
            Text(title)
                .blanc(compact
                       ? BlancText(size: Typography.Size.h1Mobile, weight: Typography.Weight.bold,
                                   trackingEm: Typography.Tracking.display)
                       : .h1)
                .foregroundStyle(p.ink.color)
                .lineLimit(1).minimumScaleFactor(0.8)
            if let meta {
                Text(meta).blanc(.meta).monospacedDigit().foregroundStyle(p.ink3.color).fixedSize()
            }
            trailing
            Spacer(minLength: 0)
        }
        // Pinned left. Without this the header centres itself in any view that
        // isn't a stretched panel — Triage, Search, Compose, Settings.
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, compact ? Space.paneXCompact : Space.paneX)
        .padding(.top, compact ? 14 : 22)
        .padding(.bottom, compact ? 10 : 14)
    }
}

public extension ViewHead where Trailing == EmptyView {
    init(_ title: String, meta: String? = nil) { self.init(title, meta: meta) { EmptyView() } }
}

public struct GroupLabel: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .blanc(BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.bold))
            .foregroundStyle(p.ink3.color)
            .padding(.horizontal, compact ? Space.paneXCompact : Space.paneX)
            .padding(.top, 16)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A closing note at the end of a list — states where the rest of the mail is.
public struct TailRow: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text).blanc(.meta).foregroundStyle(p.ink3.color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, compact ? Space.paneXCompact : Space.paneX)
            .padding(.top, 14)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The Reads waterline — a boundary that IS a line, so the hairline stays.
public struct WaterlineView: View {
    @Environment(\.palette) private var p
    let meta: String
    let inset: CGFloat
    public init(meta: String, inset: CGFloat = Space.paneX) { self.meta = meta; self.inset = inset }
    public var body: some View {
        HStack(spacing: 12) {
            rule
            // Both labels stay on one line and the rules absorb the slack — in the
            // ~400pt list column an unpinned HStack wraps "Seen up to here" in two.
            Text(Copy.waterline)
                .blanc(BlancText(size: Typography.Size.label, weight: Typography.Weight.bold))
                .foregroundStyle(p.ink2.color)
                .fixedSize()
            Text(meta).blanc(.caption).monospacedDigit().foregroundStyle(p.ink3.color)
                .fixedSize()
            rule
        }
        .padding(.horizontal, inset)
        .padding(.top, 20)
        .padding(.bottom, 16)
        .accessibilityElement()
        .accessibilityLabel("Seen up to here")
    }
    private var rule: some View {
        Rectangle().fill(p.hairSoft.color).frame(height: 1)
    }
}

public struct SoftRule: View {
    @Environment(\.palette) private var p
    let inset: CGFloat
    public init(inset: CGFloat = 14) { self.inset = inset }
    public var body: some View {
        Rectangle().fill(p.hairSoft.color).frame(height: 1)
            .padding(.horizontal, inset).padding(.vertical, 2)
    }
}

/// Empty states teach the surface — glyph, what it is, what fills it.
public struct EmptyStateView: View {
    @Environment(\.palette) private var p
    let glyph: String
    let title: String
    let sub: String
    let topPad: CGFloat
    public init(glyph: String, title: String, sub: String, topPad: CGFloat = 52) {
        self.glyph = glyph; self.title = title; self.sub = sub; self.topPad = topPad
    }
    public var body: some View {
        VStack(spacing: 0) {
            Text(glyph).font(.system(size: 26)).opacity(0.55).padding(.bottom, 12)
            Text(title).blanc(BlancText(size: Typography.Size.body, weight: Typography.Weight.bold))
                .foregroundStyle(p.ink.color).padding(.bottom, 4)
            Text(sub).blanc(.body).foregroundStyle(p.ink2.color)
                .multilineTextAlignment(.center).frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, topPad).padding(.bottom, 52).padding(.horizontal, 20)
    }
}

// MARK: - Scroller

/// Every scrolling region keeps 132pt of tail room so the floating dock and the
/// full shadow falloff of the last card both have air. The stack is **lazy**: a
/// fifteen-issue Reads list otherwise built and measured every card's body,
/// including the twelve below the fold.
public struct Scroller<Content: View>: View {
    let showsIndicators: Bool
    @ViewBuilder let content: Content
    public init(showsIndicators: Bool = true, @ViewBuilder content: () -> Content) {
        self.showsIndicators = showsIndicators; self.content = content()
    }
    public var body: some View {
        VScroll(showsIndicators: showsIndicators) {
            LazyStack { content }
                .padding(.bottom, Space.dockClearance)
        }
    }
}

// MARK: - Measuring

/// Text measurement for the stream's clamp decision.
///
/// The clamp needs the body's *natural* height, which used to come from a hidden
/// second copy of the whole body view (`HeightProbe`) — so every card in the list
/// existed twice, off-screen bodies included, each with its own geometry observer.
/// One `boundingRect` through the same text engine gives the same answer for a
/// string + width, and the result is cached, so a card measures once ever.
@MainActor
public enum BodyMetrics {
    private struct Key: Hashable { let text: String; let width: CGFloat }
    private static var cache: [Key: CGFloat] = [:]

    /// Height of the stream-card body at `cardWidth`, including the chunk paddings
    /// and any inline figure — the same geometry `StreamCard.bodyStack` lays out.
    public static func streamBodyHeight(_ body: String, cardWidth: CGFloat) -> CGFloat {
        let content = max(80, cardWidth - 52)          // 26pt padding each side
        let key = Key(text: body, width: content)
        if let hit = cache[key] { return hit }

        let chunks = body.components(separatedBy: MailContent.imageMarker)
        var total: CGFloat = CGFloat(chunks.count) * 27 // .top 9 + .bottom 18 per chunk
        for chunk in chunks {
            total += textHeight(chunk.trimmingCharacters(in: .whitespacesAndNewlines), width: content)
        }
        // Each marker inserts one figure: art at the 520×216 aspect + caption row.
        total += CGFloat(chunks.count - 1) * (content * 216.0 / 520.0 + 41)
        cache[key] = total
        return total
    }

    /// One measured paragraph block at the `.streamBody` metrics.
    static func textHeight(_ text: String, width: CGFloat) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        let font = NSFont.systemFont(ofSize: Typography.Size.bodyL, weight: Typography.Weight.regular)
        let style = NSMutableParagraphStyle()
        // Same conversion `BlancText` uses: only the remainder above SF Pro's own
        // ≈1.21× default line height is extra spacing.
        style.lineSpacing = max(0, Typography.Size.bodyL * (1.7 - 1.21))
        let attributed = NSAttributedString(string: text, attributes: [
            .font: font, .paragraphStyle: style,
        ])
        let rect = attributed.boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        return ceil(rect.height)
    }
}

// MARK: - Lazy / static stack

/// A `LazyVStack` when the app is running, a plain `VStack` when rendering a still.
/// `ImageRenderer` needs the whole tree materialised; the interactive app must not
/// build fifteen newsletter bodies to show three.
public struct LazyStack<Content: View>: View {
    @Environment(\.staticRender) private var staticRender
    @ViewBuilder let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        if staticRender {
            VStack(spacing: 0) { content }
        } else {
            LazyVStack(spacing: 0) { content }
        }
    }
}
