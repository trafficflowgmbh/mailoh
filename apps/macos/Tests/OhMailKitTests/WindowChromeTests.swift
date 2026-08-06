import XCTest
import AppKit
@testable import OhMailKit

/// THE UNIFIED TITLEBAR, ASSERTED ON A REAL WINDOW.
///
/// Window chrome is otherwise only observable by launching the app and looking, so the flags that
/// make the titlebar one continuous, dividerless surface are set by a pure function and checked here
/// against a throwaway `NSWindow`. Each assertion is a distinct line of
/// ``OhMailWindow/applyUnifiedTitlebar(to:)``: delete the `titlebarSeparatorStyle` line and the
/// divider assertion goes red; delete the `fullSizeContentView` insert and the content-inset one
/// does; and so on. The "before" block is what keeps this honest — it proves the window starts in
/// the opposite state, so a green run is the function's doing and not the default's.
@MainActor
final class WindowChromeTests: XCTestCase {

    private func standardTitledWindow() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                 styleMask: [.titled, .closable, .miniaturizable, .resizable],
                 backing: .buffered, defer: false)
    }

    func testAStandardWindowStartsWithTheBrowserStyleTitlebar() {
        let window = standardTitledWindow()
        // The state the redesign is moving away from — asserted so the test below is meaningful.
        XCTAssertFalse(window.styleMask.contains(.fullSizeContentView),
                       "a titled window already ran full-size content; the config proves nothing")
        XCTAssertFalse(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titleVisibility, .visible)
        XCTAssertEqual(window.titlebarSeparatorStyle, .automatic,
                       "the hairline divider is not the default, so removing it is untested")
    }

    func testUnifiedTitlebarIsTransparentFullSizeAndDividerless() {
        let window = standardTitledWindow()
        OhMailWindow.applyUnifiedTitlebar(to: window)

        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView),
                      "content does not run up under the titlebar")
        XCTAssertTrue(window.titlebarAppearsTransparent,
                      "the titlebar still paints its own band instead of the canvas")
        XCTAssertEqual(window.titleVisibility, .hidden, "the window title is still drawn")
        XCTAssertEqual(window.titlebarSeparatorStyle, .none,
                       "the hard divider under the titlebar is still there")
    }

    /// `.hidden` is the *title text*, never the controls. Close/minimize/zoom must survive — a
    /// window you cannot close is a far worse regression than a divider.
    func testTheTrafficLightsSurviveAndStayVisible() {
        let window = standardTitledWindow()
        OhMailWindow.applyUnifiedTitlebar(to: window)

        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            let button = window.standardWindowButton(kind)
            XCTAssertNotNil(button, "the \(kind) traffic-light control was removed")
            XCTAssertFalse(button?.isHidden ?? true, "the \(kind) traffic-light control was hidden")
        }
    }

    /// The window still moves. Drag stays on the titlebar region (the default for a full-size
    /// content window); it is not promoted to the whole background, which would swallow the clicks
    /// the app's own rows and buttons need.
    func testTheWindowStillDragsFromItsTitlebarAndNotItsWholeBackground() {
        let window = standardTitledWindow()
        OhMailWindow.applyUnifiedTitlebar(to: window)

        XCTAssertTrue(window.isMovable, "the window cannot be moved at all")
        XCTAssertFalse(window.isMovableByWindowBackground,
                       "dragging the whole background would hijack the app's own clicks")
    }
}
