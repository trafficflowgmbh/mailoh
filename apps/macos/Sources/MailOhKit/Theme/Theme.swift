import SwiftUI

/// Corner radii from `radius` in tokens.ts (px).
public enum Radius {
    public static let dot: CGFloat = 3
    public static let keycap: CGFloat = 6
    public static let focus: CGFloat = 8
    public static let item: CGFloat = 10
    public static let menuItem: CGFloat = 11
    public static let paletteItem: CGFloat = 13
    public static let rowDense: CGFloat = 14
    public static let row: CGFloat = 16
    public static let input: CGFloat = 18
    public static let panel: CGFloat = 20
    public static let card: CGFloat = 22
    public static let overlay: CGFloat = 24
    public static let reader: CGFloat = 28
    public static let pill: CGFloat = 999
}

/// Spacing steps + named layout constants from `spacing` / `layout`.
public enum Space {
    public static let deck: CGFloat = 16       // shell padding + column gap
    public static let deckCompact: CGFloat = 10 // `.deck{padding:0 10px 10px}` below the breakpoint
    public static let paneX: CGFloat = 30      // list-column horizontal padding
    public static let paneXCompact: CGFloat = 20
    public static let messageX: CGFloat = 34   // message column padding
    public static let dockClearance: CGFloat = 132
    public static let rail: CGFloat = 224
    public static let listColMin: CGFloat = 320
    public static let listColMax: CGFloat = 400
    public static let streamMax: CGFloat = 620
    public static let messageMax: CGFloat = 640
    public static let readerMax: CGFloat = 660
    /// `layout.mobileMax` — at or below this width the rail becomes a drawer and
    /// every two-pane view collapses to one pane.
    public static let mobileMax: CGFloat = 900
    /// Invariant #7: the shell must be clean at 390pt, so that is the floor the
    /// window enforces — not 1040.
    public static let minWidth: CGFloat = 390
    public static let minHeight: CGFloat = 480
}

// MARK: - Compact layout in the environment

private struct CompactLayoutKey: EnvironmentKey {
    static let defaultValue = false
}

public extension EnvironmentValues {
    /// True at or below `Space.mobileMax`. Set once by `RootView` from the measured
    /// shell width, so every view resolves the same breakpoint.
    var compactLayout: Bool {
        get { self[CompactLayoutKey.self] }
        set { self[CompactLayoutKey.self] = newValue }
    }
}

// MARK: - Palette in the environment

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.light
}

public extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

private struct BlancThemeModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content.environment(\.palette, Palette.of(scheme))
    }
}

public extension View {
    /// Resolve `\.palette` from the active color scheme. Apply once near the root
    /// (inside any `.preferredColorScheme`) so every descendant reads the right
    /// scheme's tokens.
    func blancTheme() -> some View { modifier(BlancThemeModifier()) }
}
