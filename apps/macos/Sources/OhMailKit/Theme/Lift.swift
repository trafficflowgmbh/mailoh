import SwiftUI

/// One box-shadow layer. Blanc's shadows are authored as multi-layer CSS
/// `box-shadow` stacks: a tight contact layer plus wide, warm-tinted ambient
/// layers that sculpt each panel out of the page. SwiftUI's `.shadow` has no
/// spread parameter, so we approximate: **radius = CSS blur / 2**, offsets 1:1,
/// and negative CSS spread is dropped (the halved radius already tightens the
/// falloff enough that the visual weight matches). The `0 0 0 1px` contact ring
/// becomes a hairline-radius shadow.
public struct ShadowLayer: Sendable {
    public let color: OKLCH
    public let radius: CGFloat
    public let x: CGFloat
    public let y: CGFloat
    public init(_ color: OKLCH, _ radius: CGFloat, x: CGFloat = 0, y: CGFloat = 0) {
        self.color = color; self.radius = radius; self.x = x; self.y = y
    }
}

/// The four-step lift scale, the decision-bar occlusion edge, and the upward edge
/// under a triage pile's stacked sheets.
///   lift0 small control · lift1 resting panel · lift2 raised object · lift3 floating layer
///
/// **Every shadow in the app comes from this enum.** `Views/` carries no `OKLCH(…)`
/// literal and no bare `.shadow(…)`; `OhMailKitTests.testNoUntrackedVisualConstants`
/// audits the sources for both, so a hand-tuned value cannot drift in again the way
/// the pile sheet edge did (it was authored at alpha .16 against the prototype's .10).
public enum Lift: Sendable {
    case l0, l1, l2, l3, barEdge, sheetEdge

    public func layers(_ scheme: ColorScheme) -> [ShadowLayer] {
        scheme == .dark ? dark : light
    }

    // Light: warm-tinted (hue ~50-55) contact + ambient. Colors verbatim from tokens.ts.
    private var light: [ShadowLayer] {
        switch self {
        case .l0: return [
            ShadowLayer(OKLCH(0.40, 0.05, 55, 0.04), 0.5),
            ShadowLayer(OKLCH(0.40, 0.05, 55, 0.05), 1, y: 1),
            ShadowLayer(OKLCH(0.36, 0.05, 52, 0.08), 5, y: 4),
        ]
        case .l1: return [
            ShadowLayer(OKLCH(0.40, 0.05, 55, 0.025), 0.5),
            ShadowLayer(OKLCH(0.40, 0.05, 55, 0.03), 2, y: 2),
            ShadowLayer(OKLCH(0.35, 0.05, 52, 0.07), 16, y: 14),
            ShadowLayer(OKLCH(0.30, 0.05, 50, 0.10), 48, y: 40),
        ]
        case .l2: return [
            ShadowLayer(OKLCH(0.40, 0.05, 55, 0.05), 1, y: 1),
            ShadowLayer(OKLCH(0.38, 0.05, 52, 0.09), 8, y: 6),
            ShadowLayer(OKLCH(0.33, 0.05, 50, 0.14), 28, y: 24),
            ShadowLayer(OKLCH(0.30, 0.05, 50, 0.15), 65, y: 60),
        ]
        case .l3: return [
            ShadowLayer(OKLCH(0.40, 0.05, 55, 0.06), 2.5, y: 2),
            ShadowLayer(OKLCH(0.36, 0.05, 52, 0.13), 20, y: 16),
            ShadowLayer(OKLCH(0.30, 0.05, 50, 0.20), 55, y: 48),
            ShadowLayer(OKLCH(0.28, 0.05, 50, 0.22), 105, y: 96),
        ]
        case .barEdge: return [
            ShadowLayer(OKLCH(0.33, 0.05, 50, 0.40), 11, y: 14),
        ]
        // `.pile-stack::before/::after` — verbatim `0 -2px 8px -4px oklch(0.35 0.05 52/.10)`.
        case .sheetEdge: return [ShadowLayer(OKLCH(0.35, 0.05, 52, 0.10), 4, y: -2)]
        }
    }

    // Dark: pure black at rising opacity — depth reads through darkness, not tint.
    private var dark: [ShadowLayer] {
        switch self {
        case .l0: return [
            ShadowLayer(OKLCH(0, 0, 0, 0.22), 0.5),
            ShadowLayer(OKLCH(0, 0, 0, 0.32), 1, y: 1),
            ShadowLayer(OKLCH(0, 0, 0, 0.30), 5, y: 4),
        ]
        case .l1: return [
            ShadowLayer(OKLCH(0, 0, 0, 0.30), 1, y: 1),
            ShadowLayer(OKLCH(0, 0, 0, 0.38), 10, y: 8),
            ShadowLayer(OKLCH(0, 0, 0, 0.36), 28, y: 24),
        ]
        case .l2: return [
            ShadowLayer(OKLCH(0, 0, 0, 0.38), 2, y: 2),
            ShadowLayer(OKLCH(0, 0, 0, 0.50), 17, y: 14),
            ShadowLayer(OKLCH(0, 0, 0, 0.46), 42, y: 40),
        ]
        case .l3: return [
            ShadowLayer(OKLCH(0, 0, 0, 0.44), 4, y: 3),
            ShadowLayer(OKLCH(0, 0, 0, 0.58), 33, y: 28),
            ShadowLayer(OKLCH(0, 0, 0, 0.50), 85, y: 80),
        ]
        case .barEdge: return [
            ShadowLayer(OKLCH(0, 0, 0, 0.70), 11, y: 14),
        ]
        // The prototype does not override the sheet edge in dark — same value, so
        // fidelity is exact rather than "improved".
        case .sheetEdge: return [ShadowLayer(OKLCH(0.35, 0.05, 52, 0.10), 4, y: -2)]
        }
    }
}

private extension View {
    @ViewBuilder
    func shadowLayer(_ layers: [ShadowLayer], _ i: Int) -> some View {
        if i < layers.count {
            shadow(color: layers[i].color.color, radius: layers[i].radius, x: layers[i].x, y: layers[i].y)
        } else {
            self
        }
    }
}

private struct LiftModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    let lift: Lift
    func body(content: Content) -> some View {
        let layers = lift.layers(scheme)   // every Blanc lift has ≤ 4 layers
        content
            .shadowLayer(layers, 0)
            .shadowLayer(layers, 1)
            .shadowLayer(layers, 2)
            .shadowLayer(layers, 3)
    }
}

public extension View {
    /// Apply a Blanc lift shadow (scheme-aware).
    func lift(_ level: Lift) -> some View { modifier(LiftModifier(lift: level)) }
}
