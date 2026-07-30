import SwiftUI

/// The skim stream — the newsletters and receipts themselves, clamped into cards
/// on the canvas beside their list. One machinery, two instances.
///
/// Four couplings make it feel alive, all of them from the prototype:
///   • **the stream drives the list** — whatever card is at the top is selected
///   • **the list drives the stream** — clicking a row scrolls the stream to it
///   • **the keyboard drives both** — j / k move *and* scroll, ↵ expands
///   • **passing a card marks it seen** — the dot fades in place, the count ticks
/// Nothing reshuffles while you read; the waterline stays where your last visit
/// left it.
///
/// Expansion and the scroll request live in `AppState`, not in `@State` here,
/// because `↵` and `j` / `k` are global keys handled by the shell — private view
/// state would have made the hint bar's promise unkeepable.
public struct StreamView: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.compactLayout) private var compact

    let s: AppState
    let place: Place

    @State private var viewport: CGSize = CGSize(width: Space.streamMax, height: 800)
    @State private var userScrolled = false

    /// A card whose bottom has risen above this fraction of the viewport counts
    /// as read — the native reading of the prototype's `rootMargin: -62%`.
    private let seenFraction: CGFloat = 0.38
    /// The topmost card within this many points of the top edge is "current".
    private let currentBand: CGFloat = 90

    public init(_ s: AppState, place: Place) {
        self.s = s; self.place = place
    }

    private var items: [Message] { s.streamItems(for: place) }
    private var hPad: CGFloat { compact ? 6 : 12 }
    /// One measurement for the whole stream, not one per card.
    private var cardWidth: CGFloat { min(Space.streamMax, max(240, viewport.width - hPad * 2)) }

    public var body: some View {
        ScrollViewReader { proxy in
            VScroll {
                LazyStack {
                    // Below the breakpoint the list column is gone, so the stream
                    // carries the view's own header (`.stream-top`).
                    if compact { streamTop }
                    if !compact { hints }
                    if place == .reads {
                        cards(s.readsUnseen)
                        WaterlineView(meta: s.readsWaterlineMeta, inset: 12)
                            .frame(maxWidth: Space.streamMax)
                        cards(s.readsSeen)
                        TailRow(Copy.readsStreamTail).frame(maxWidth: Space.streamMax)
                    } else {
                        cards(items)
                        TailRow(Copy.receiptsTail(items.count)).frame(maxWidth: Space.streamMax)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, hPad)
                .padding(.top, 2)
                .padding(.bottom, Space.dockClearance)
            }
            .coordinateSpace(.named(spaceName))
            .onGeometryChange(for: CGSize.self) { $0.size } action: { viewport = $0 }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, new in
                if new > 0.5 { userScrolled = true }
            }
            .onChange(of: s.scrollRequest(place)) { _, target in
                guard let target else { return }
                withAnimation(motion(reduceMotion, .blancSlide)) {
                    proxy.scrollTo(target, anchor: .top)
                }
                s.clearScrollRequest(place)
            }
        }
        .accessibilityLabel("\(place.title) reading stream")
    }

    private var spaceName: String { "stream-\(place.rawValue)" }

    private var streamTop: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(place.title)
                .blanc(BlancText(size: Typography.Size.h1Mobile, weight: Typography.Weight.bold,
                                 trackingEm: Typography.Tracking.display))
                .foregroundStyle(p.ink.color)
            Text(place == .reads ? s.readsMeta : s.receiptsMeta)
                .blanc(.meta).monospacedDigit().foregroundStyle(p.ink3.color)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: Space.streamMax, alignment: .leading)
        .padding(.horizontal, Space.paneXCompact).padding(.top, 8).padding(.bottom, 8)
    }

    private var hints: some View {
        HStack(spacing: 14) {
            Hint(["j", "k"], "next / previous")
            Hint(["↵"], "expand")
            Hint(Copy.streamSeenHint)
        }
        .frame(maxWidth: Space.streamMax, alignment: .leading)
        .padding(.horizontal, 26).padding(.top, 10).padding(.bottom, 14)
    }

    @ViewBuilder
    private func cards(_ list: [Message]) -> some View {
        ForEach(list) { m in
            StreamCard(
                m: m,
                body: s.body(for: m),
                cardWidth: cardWidth,
                figureCaption: s.streamArtCaption,
                isCurrent: s.streamCurrent(place) == m.id,
                isExpanded: s.isStreamExpanded(m.id),
                onToggle: { toggle(m.id) },
                onSelect: { s.setStreamCurrent(place, m.id) }
            )
            .id(m.id)
            .frame(maxWidth: Space.streamMax)
            .padding(.bottom, 20)
            .onGeometryChange(for: CardGeometry.self) { proxy in
                let f = proxy.frame(in: .named(spaceName))
                return CardGeometry(top: f.minY, bottom: f.maxY)
            } action: { geo in
                track(m, geo)
            }
        }
    }

    private func toggle(_ id: String) {
        withAnimation(motion(reduceMotion, .blancExpand)) { _ = s.toggleStreamExpanded(id) }
    }

    /// Scroll-spy + seen-marking, from one geometry sample per card.
    private func track(_ m: Message, _ geo: CardGeometry) {
        guard userScrolled else { return }
        if geo.top <= currentBand, geo.bottom > currentBand, s.streamCurrent(place) != m.id {
            s.setStreamCurrent(place, m.id)
        }
        if m.unread, geo.bottom <= viewport.height * seenFraction {
            withAnimation(motion(reduceMotion, .blancSeen)) { _ = s.markSeen(m.id) }
        }
    }
}

private struct CardGeometry: Equatable {
    let top: CGFloat
    let bottom: CGFloat
}

// MARK: - One card

/// A stream card: sender line, subject, the mail itself clamped to 348pt behind a
/// fade, and an Expand pill. Cards shorter than the clamp show no pill at all —
/// there is no point clamping four lines, and a dead control is worse than none.
///
/// The clamp decision comes from `BodyMetrics` (one cached `boundingRect` per body
/// + width), not from a hidden second copy of the body — so the card's view tree
/// contains its content exactly once.
struct StreamCard: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.compactLayout) private var compact

    let m: Message
    let body_: String
    let cardWidth: CGFloat
    /// Passed down rather than read from `Fixtures`: the caption is content.
    let figureCaption: String
    let isCurrent: Bool
    let isExpanded: Bool
    let onToggle: () -> Void
    let onSelect: () -> Void

    private let clamp: CGFloat = 348

    init(m: Message, body: String, cardWidth: CGFloat, figureCaption: String,
         isCurrent: Bool, isExpanded: Bool,
         onToggle: @escaping () -> Void, onSelect: @escaping () -> Void) {
        self.m = m; self.body_ = body; self.cardWidth = cardWidth
        self.figureCaption = figureCaption; self.isCurrent = isCurrent
        self.isExpanded = isExpanded; self.onToggle = onToggle; self.onSelect = onSelect
    }

    private var naturalHeight: CGFloat { BodyMetrics.streamBodyHeight(body_, cardWidth: cardWidth) }
    /// Long enough to be worth clamping? (`+28` = the prototype's slack.)
    private var clampable: Bool { naturalHeight > clamp + 28 }
    private var clipped: Bool { clampable && !isExpanded }
    private var padX: CGFloat { compact ? Space.paneXCompact : 26 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            bodyStack
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .frame(height: clipped ? clamp : nil, alignment: .top)
                .clipped()
                .overlay(alignment: .bottom) {
                    if clipped {
                        LinearGradient(colors: [p.float.color.opacity(0), p.float.color],
                                       startPoint: .top, endPoint: .bottom)
                            .frame(height: 88)
                            .allowsHitTesting(false)
                    }
                }
            if clampable { expandPill }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .floatSurface(p, radius: Radius.card, lift: isCurrent ? .l2 : .l1)
        .animation(motion(reduceMotion, .blancFlip), value: isCurrent)
        .contentShape(Rectangle())
        .onTapGesture { onSelect() }
        // The card holds selectable text, so it cannot *be* a Button — but it still
        // has to be reachable and activatable from the keyboard and VoiceOver.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(m.from): \(m.subj)")
        .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
        .accessibilityValue(clampable ? (isExpanded ? "expanded" : "collapsed") : "")
        .accessibilityAction(named: "Select") { onSelect() }
        .accessibilityAction(named: isExpanded ? "Collapse" : "Expand") {
            if clampable { onToggle() }
        }
        .recordRender(m.id)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                UnreadDot(on: m.unread)
                Text(m.from)
                    .font(Typography.font(Typography.Size.control, Typography.Weight.bold))
                    .foregroundStyle(p.ink.color)
                Text(m.addr).blanc(.chip).foregroundStyle(p.ink3.color)
                    .lineLimit(1).truncationMode(.tail)
                if let amount = m.amount {
                    Text(amount)
                        .font(Typography.font(Typography.Size.bodyS, Typography.Weight.semibold))
                        .monospacedDigit().foregroundStyle(p.ink.color).fixedSize()
                }
                Spacer(minLength: 8)
                Text(m.time).blanc(.caption).monospacedDigit()
                    .foregroundStyle(p.ink3.color).fixedSize()
            }
            Text(m.subj)
                .blanc(.cardTitle).foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 5)
        }
        .padding(.horizontal, padX).padding(.top, compact ? 16 : 20)
    }

    /// The body, split around the inline figure placeholder.
    private var bodyStack: some View {
        let chunks = body_.components(separatedBy: MailContent.imageMarker)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(chunks.enumerated()), id: \.offset) { i, chunk in
                if i > 0 { FaltoFigure(caption: figureCaption, artWidth: max(120, cardWidth - padX * 2)) }
                Text(chunk.trimmingCharacters(in: .whitespacesAndNewlines))
                    .blanc(.streamBody)
                    .foregroundStyle(p.ink.color)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, padX)
                    .padding(.top, 9).padding(.bottom, 18)
            }
        }
    }

    private var expandPill: some View {
        HStack {
            Spacer()
            ExpandPill(isExpanded: isExpanded, action: onToggle)
            Spacer()
        }
        .padding(.top, -12).padding(.bottom, 16)
    }
}

private struct ExpandPill: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false
    let isExpanded: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(isExpanded ? "Collapse" : "Expand")
                    .font(Typography.font(Typography.Size.label, Typography.Weight.bold))
                Icon(.chevron, 12)
                    .rotationEffect(.degrees(isExpanded ? -90 : 90))
            }
            .foregroundStyle(hovering ? p.ink.color : p.ink2.color)
            .padding(.horizontal, 15).padding(.vertical, 5)
            .surface(Radius.pill, p.float.color, hovering ? .l2 : .l0)
            .offset(y: hovering ? -1 : 0)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancFast), value: hovering)
        .animation(motion(reduceMotion, .blancSlide), value: isExpanded)
        .accessibilityLabel(isExpanded ? "Collapse message" : "Expand message")
    }
}

// MARK: - The one inline figure

/// The product drawing inside the Hejmo Living issue. Redrawn as a native path —
/// a line illustration on a tint wash, no photography, no gradient.
///
/// The height is **computed**, not inferred: a stroked `Shape` has no ideal size, so
/// `.aspectRatio(_:contentMode: .fit)` inside a vertically-`fixedSize`d card gets no
/// height to fit into and the artwork collapses to nothing, leaving a caption over
/// blank space. The card already knows its own width, so the figure derives its
/// height from the authored 520 × 216 artboard — which is also exactly what
/// `BodyMetrics` assumes when it decides whether the card needs clamping.
struct FaltoFigure: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact

    static let artboard = CGSize(width: 520, height: 216)

    let caption: String
    /// The card's inner content width.
    let artWidth: CGFloat

    private var artHeight: CGFloat {
        max(60, artWidth * Self.artboard.height / Self.artboard.width)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            FaltoArt()
                .stroke(p.ink3.color, style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                .frame(width: artWidth, height: artHeight)
                .wash(Radius.rowDense, p.tint.color)
            if !caption.isEmpty {
                Text(caption).blanc(.caption).foregroundStyle(p.ink3.color)
            }
        }
        .padding(.horizontal, compact ? Space.paneXCompact : 26)
        .padding(.top, 2).padding(.bottom, 16)
        .accessibilityElement()
        .accessibilityLabel("Produktbild: Klapptisch, an der Wand montiert")
    }
}

struct FaltoArt: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 520, sy = rect.height / 216
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        func line(_ a: (CGFloat, CGFloat), _ b: (CGFloat, CGFloat), _ p: inout Path) {
            p.move(to: pt(a.0, a.1)); p.addLine(to: pt(b.0, b.1))
        }
        var path = Path()
        line((96, 26), (96, 178), &path)      // the wall
        line((60, 178), (464, 178), &path)    // the floor
        line((98, 96), (322, 96), &path)      // table top
        line((98, 104), (322, 104), &path)
        line((310, 104), (264, 178), &path)   // folding legs
        line((310, 104), (318, 178), &path)
        path.addEllipse(in: CGRect(x: pt(141, 77).x, y: pt(141, 77).y,
                                   width: 18 * sx, height: 18 * sy))  // wall hook
        line((159, 86), (166, 86), &path)
        line((418, 178), (418, 114), &path)   // the plant beside it
        line((404, 114), (432, 114), &path)
        path.move(to: pt(410, 100)); path.addLine(to: pt(418, 86)); path.addLine(to: pt(426, 100))
        return path
    }
}
