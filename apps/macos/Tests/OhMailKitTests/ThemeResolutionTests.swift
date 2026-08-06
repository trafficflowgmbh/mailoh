import XCTest
import SwiftUI
@testable import OhMailKit

/// Dark mode must follow the system. These guard the two Swift-side facts the whole theme chain
/// rests on — and they exist because the offscreen render pass (`Smoke`) FORCES the color scheme,
/// so it never exercises either one. Without these, a default flipped to a fixed appearance, or a
/// resolver that stopped passing the system's scheme through, would ship a window that ignores the
/// system setting, and nothing here would go red.
///
///   1. A fresh install follows the system: `themePref` defaults to `.system`.
///   2. Under `.system`, the resolver returns the system's own scheme unchanged; an explicit
///      Light/Dark choice overrides it.
final class ThemeResolutionTests: XCTestCase {

    @MainActor
    func testDefaultsToFollowingTheSystem() {
        XCTAssertEqual(AppState().themePref, .system,
                       "A fresh install must follow the system appearance, not a fixed one.")
    }

    @MainActor
    func testSystemPreferenceReturnsTheSystemScheme() {
        let state = AppState()
        state.themePref = .system
        XCTAssertEqual(state.effectiveScheme(system: .dark), .dark,
                       "In Dark Mode the app must resolve dark.")
        XCTAssertEqual(state.effectiveScheme(system: .light), .light,
                       "In Light Mode the app must resolve light.")
    }

    @MainActor
    func testExplicitPreferenceOverridesTheSystem() {
        let state = AppState()
        state.themePref = .dark
        XCTAssertEqual(state.effectiveScheme(system: .light), .dark,
                       "An explicit Dark choice must win over a light system.")
        state.themePref = .light
        XCTAssertEqual(state.effectiveScheme(system: .dark), .light,
                       "An explicit Light choice must win over a dark system.")
    }
}
