import SwiftUI

/// Every vertical scrolling region in the app goes through `VScroll`.
///
/// Why the indirection: `ImageRenderer` cannot rasterize `ScrollView` content —
/// it renders an empty box — which makes the `--shot` design-review pass useless
/// on exactly the views that matter. With `\.staticRender` set, `VScroll` lays its
/// content out as a plain stack instead, so a screenshot shows the *whole* list at
/// its real metrics. Interactive builds never set the flag and always get a real
/// `ScrollView`, so this costs the shipping app nothing.
public struct VScroll<Content: View>: View {
    @Environment(\.staticRender) private var staticRender
    let showsIndicators: Bool
    @ViewBuilder let content: Content

    public init(showsIndicators: Bool = true, @ViewBuilder content: () -> Content) {
        self.showsIndicators = showsIndicators
        self.content = content()
    }

    public var body: some View {
        if staticRender {
            // `.fixedSize` first so the stack keeps its ideal height even when the
            // canvas is shorter; without it an overflowing VStack centres itself and
            // the screenshot loses the header we were trying to look at.
            VStack(spacing: 0) { content }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            ScrollView(.vertical, showsIndicators: showsIndicators) { content }
        }
    }
}

private struct StaticRenderKey: EnvironmentKey {
    static let defaultValue = false
}

public extension EnvironmentValues {
    /// True only while rendering stills for design review / visual regression.
    var staticRender: Bool {
        get { self[StaticRenderKey.self] }
        set { self[StaticRenderKey.self] = newValue }
    }
}
