import SwiftUI
import AppKit

/// Blanc's type is one well-tuned system sans (SF on macOS) at fixed px sizes —
/// product UI, not fluid type. Its signature is a **micro-graded weight scale**:
/// 450 / 500 / 550 / 600 / 650, never jumping a full hundred where fifty reads
/// calmer. SwiftUI's named `Font.Weight` can't express half-steps, so we drop to
/// `NSFont.systemFont(ofSize:weight:)` with interpolated optical weights.
///
/// CSS→NSFont.Weight anchors: 400→0.0, 500→0.23, 600→0.30, 700→0.40; the Blanc
/// half-steps are linear interpolations between those anchors.
public enum Typography {

    public enum Weight {
        public static let regular  = NSFont.Weight(0.115) // css 450
        public static let medium   = NSFont.Weight(0.23)  // css 500
        public static let semibold = NSFont.Weight(0.265) // css 550
        public static let bold     = NSFont.Weight(0.30)  // css 600
        public static let heavy    = NSFont.Weight(0.35)  // css 650
    }

    /// Exact px sizes from `typography.size`, by role.
    public enum Size {
        public static let micro: CGFloat = 10.5   // keycaps, badges, footers
        public static let caption: CGFloat = 11    // rail labels, hints, timestamps
        public static let label: CGFloat = 11.5    // chips, meta labels
        public static let bodyS: CGFloat = 12      // decision buttons, notes
        public static let control: CGFloat = 12.5  // buttons, compose CTA, from-line
        public static let body: CGFloat = 13       // rows (sender), settings labels
        public static let bodyL: CGFloat = 13.5    // subjects, stream/held bodies
        public static let base: CGFloat = 14       // root
        public static let prose: CGFloat = 14.5    // reading-pane body, search input
        public static let wordmark: CGFloat = 15
        public static let proseReader: CGFloat = 15.5 // reader body — the exhale
        public static let h4: CGFloat = 16         // focus-reply title, protected code
        public static let cardTitle: CGFloat = 16.5
        public static let heldTitle: CGFloat = 17
        public static let h1Mobile: CGFloat = 22
        public static let h2: CGFloat = 24         // message subject
        public static let h1: CGFloat = 26         // view h1
        public static let readerTitle: CGFloat = 29
    }

    /// Letter-spacing in em (converted to points at the call site: em × size).
    public enum Tracking {
        public static let display: CGFloat = -0.025
        public static let wordmark: CGFloat = -0.02
        public static let title: CGFloat = -0.015
        public static let heading: CGFloat = -0.01
        public static let subject: CGFloat = -0.008
        public static let name: CGFloat = -0.005
        public static let code: CGFloat = 0.18
    }

    public static func font(_ size: CGFloat, _ weight: NSFont.Weight) -> Font {
        Font(NSFont.systemFont(ofSize: size, weight: weight))
    }

    public static let mono = Font.system(size: Size.h4, design: .monospaced)
}

/// A resolved text style: font + tracking (points) + optional extra line spacing.
public struct BlancText: Sendable {
    public let font: Font
    public let tracking: CGFloat
    public let lineSpacing: CGFloat

    public init(size: CGFloat, weight: NSFont.Weight, trackingEm: CGFloat = 0, leading: CGFloat = 1.0) {
        self.font = Typography.font(size, weight)
        self.tracking = size * trackingEm
        // CSS `line-height` multiplier → SwiftUI extra `lineSpacing`. SwiftUI stacks
        // lines at the font's own default line height, which for SF Pro is ≈1.21×
        // the point size, so only the remainder above that is ours to add. (Using
        // 1.15 here over-leads every block by ~4%, which reads as a loose page.)
        self.lineSpacing = max(0, size * (leading - 1.21))
    }
}

public extension View {
    func blanc(_ style: BlancText) -> some View {
        self.font(style.font).tracking(style.tracking).lineSpacing(style.lineSpacing)
    }
    /// Inline convenience for one-off styling.
    func blanc(_ size: CGFloat, _ weight: NSFont.Weight, tracking: CGFloat = 0, leading: CGFloat = 1.0) -> some View {
        blanc(BlancText(size: size, weight: weight, trackingEm: tracking, leading: leading))
    }
}

/// Named presets for the roles that recur across views (keeps call sites calm).
public extension BlancText {
    static let wordmark    = BlancText(size: Typography.Size.wordmark, weight: Typography.Weight.heavy, trackingEm: Typography.Tracking.wordmark)
    static let h1          = BlancText(size: Typography.Size.h1, weight: Typography.Weight.bold, trackingEm: Typography.Tracking.display)
    static let h2          = BlancText(size: Typography.Size.h2, weight: Typography.Weight.bold, trackingEm: Typography.Tracking.display, leading: 1.25)
    static let readerTitle = BlancText(size: Typography.Size.readerTitle, weight: Typography.Weight.bold, trackingEm: Typography.Tracking.display, leading: 1.25)
    static let cardTitle   = BlancText(size: Typography.Size.cardTitle, weight: Typography.Weight.bold, trackingEm: Typography.Tracking.title, leading: 1.3)
    static let heldTitle   = BlancText(size: Typography.Size.heldTitle, weight: Typography.Weight.bold, trackingEm: Typography.Tracking.title, leading: 1.3)
    static let rowSender   = BlancText(size: Typography.Size.body, weight: Typography.Weight.bold, trackingEm: Typography.Tracking.name)
    static let rowSenderSeen = BlancText(size: Typography.Size.body, weight: Typography.Weight.medium, trackingEm: Typography.Tracking.name)
    static let rowSubject  = BlancText(size: Typography.Size.bodyL, weight: Typography.Weight.medium, trackingEm: Typography.Tracking.subject)
    static let rowSubjectSeen = BlancText(size: Typography.Size.bodyL, weight: Typography.Weight.regular, trackingEm: Typography.Tracking.subject)
    static let body        = BlancText(size: Typography.Size.body, weight: Typography.Weight.regular)
    static let msgBody     = BlancText(size: Typography.Size.prose, weight: Typography.Weight.regular, leading: 1.72)
    static let readerBody  = BlancText(size: Typography.Size.proseReader, weight: Typography.Weight.regular, leading: 1.78)
    static let streamBody  = BlancText(size: Typography.Size.bodyL, weight: Typography.Weight.regular, leading: 1.7)
    static let meta        = BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.regular)
    static let caption     = BlancText(size: Typography.Size.caption, weight: Typography.Weight.regular)
    static let railLabel   = BlancText(size: Typography.Size.caption, weight: Typography.Weight.bold)
    static let railItem    = BlancText(size: Typography.Size.body, weight: Typography.Weight.regular)
    static let railItemOn  = BlancText(size: Typography.Size.body, weight: Typography.Weight.bold)
    static let chip        = BlancText(size: Typography.Size.label, weight: Typography.Weight.regular)
    static let tagchip     = BlancText(size: Typography.Size.micro, weight: Typography.Weight.bold)
    static let badge       = BlancText(size: Typography.Size.micro, weight: Typography.Weight.medium)
    static let button      = BlancText(size: Typography.Size.control, weight: Typography.Weight.semibold)
    static let decision    = BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.semibold)
    static let kbd         = BlancText(size: Typography.Size.micro, weight: Typography.Weight.regular)
    static let pileTitle   = BlancText(size: Typography.Size.bodyL, weight: Typography.Weight.heavy, trackingEm: Typography.Tracking.heading)
    static let settingsLabel = BlancText(size: Typography.Size.body, weight: Typography.Weight.bold)
}
