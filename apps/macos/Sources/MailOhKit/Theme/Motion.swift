import SwiftUI

/// Blanc's two easing voices, expressed as SwiftUI timing curves (which take the
/// same cubic-bezier control points as the CSS custom properties):
///   spring `cubic-bezier(.22,1,.3,1)` — arrivals, entrances, slides
///   swift  `cubic-bezier(.3,.9,.2,1)` — state flips, hovers, shadow transitions
/// Reduced motion is honored at call sites via `@Environment(\.accessibilityReduceMotion)`
/// — matching the prototype's policy of collapsing transitions to instant, not slow.
public enum Motion {
    public enum Duration {
        public static let instant = 0.15, fast = 0.16, swift = 0.2, base = 0.25
        public static let gentle = 0.3, entrance = 0.32, drawer = 0.35, shell = 0.4, expand = 0.5
    }
    public static func spring(_ d: Double) -> Animation { .timingCurve(0.22, 1, 0.3, 1, duration: d) }
    public static func swift(_ d: Double) -> Animation { .timingCurve(0.3, 0.9, 0.2, 1, duration: d) }
}

public extension Animation {
    static let blancEntrance = Motion.spring(Motion.Duration.entrance)
    static let blancSlide = Motion.spring(Motion.Duration.gentle)
    static let blancFlip = Motion.swift(Motion.Duration.swift)
    static let blancFast = Motion.swift(Motion.Duration.fast)
    static let blancExpand = Motion.spring(Motion.Duration.expand)
    /// The compact rail drawer — `transform .32s var(--spring)` in the prototype's
    /// mobile block, driven off the `drawer` duration step.
    static let blancDrawer = Motion.spring(Motion.Duration.drawer)
    static let blancSeen = Motion.swift(0.7) // dot fades over .7s in place, no reshuffle
}
