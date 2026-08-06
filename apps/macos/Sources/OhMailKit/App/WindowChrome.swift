import SwiftUI
import AppKit

/// The window's chrome — one unified, transparent titlebar with no divider.
///
/// The default `Window` scene draws a titled bar with the app name and a hairline
/// separator under it, so the traffic-light strip reads as a browser-style band bolted
/// onto the top of the app. This makes it one continuous surface instead: the titlebar
/// is transparent, the content runs full height up under the controls, and the canvas
/// (which already ignores the safe area) is what shows behind the close/minimize/zoom
/// buttons — in whichever appearance the OS is in, because the canvas is scheme-aware.
///
/// **The configuration is a pure function on purpose.** Window chrome is otherwise only
/// observable by running the app, so the flags that make it unified live in one place a
/// test can call against a throwaway `NSWindow` — see `WindowChromeTests`.
public enum OhMailWindow {

    /// Turn a standard titled window into the unified, dividerless titlebar.
    ///
    /// The traffic lights are deliberately left in place: `.hidden` refers to the *title
    /// text*, not the controls, and nothing here touches `standardWindowButton(_:)`. The
    /// window still drags from its titlebar region — that is the default for a full-size
    /// content window and is not disabled, so the transparent band at the top continues to
    /// move the window while the app's own content keeps its clicks.
    public static func applyUnifiedTitlebar(to window: NSWindow) {
        // The content view extends up under the titlebar, so the two are one surface.
        window.styleMask.insert(.fullSizeContentView)
        // No app name in the bar; the app draws its own wordmark in the rail.
        window.titleVisibility = .hidden
        // The bar itself paints nothing, so the canvas behind it is what shows.
        window.titlebarAppearsTransparent = true
        // THE HARD LINE. `.automatic` draws a hairline under the titlebar the moment
        // content scrolls beneath it; `.none` is what removes the divider for good.
        window.titlebarSeparatorStyle = .none
        // Drag stays on the titlebar region only — not the whole background — so a drag
        // that starts on a message row or a button is the app's, not a window move.
        window.isMovableByWindowBackground = false
    }
}

/// Applies ``OhMailWindow/applyUnifiedTitlebar(to:)`` to the window this view lands in.
///
/// `.windowStyle(.hiddenTitleBar)` on the scene already asks SwiftUI for most of this; this
/// is the belt-and-suspenders that also clears the titlebar separator (`.hiddenTitleBar`
/// leaves it `.automatic`, which is the hairline the redesign is removing) and pins the
/// flags even if SwiftUI re-creates the window.
struct UnifiedTitlebar: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        // The window is not attached yet inside `makeNSView`, so defer one runloop turn.
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
            OhMailWindow.applyUnifiedTitlebar(to: window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard let window = nsView.window else { return }
        OhMailWindow.applyUnifiedTitlebar(to: window)
    }
}
