import XCTest
@testable import OhMailKit
import OhMailEngine

/// ONBOARDING COPY IS A CONTRACT.
///
/// The Cloud door once carried a caption marking it as not-yet-built — written when Cloud had no
/// desktop client at all. The client shipped; the caption did not come off with it, and for a while
/// the door told a person a working feature was absent. This guards the whole class: no door in the
/// chooser may advertise a feature as missing while it is present.
///
/// Mutation-watch it by putting such a caption back on a door in ``SetupView/doorChoices`` — this
/// goes red — then restoring it. The copy is read as a value rather than by rendering the view,
/// because a `Text` in a SwiftUI body is not something a unit test can inspect; holding the door
/// copy in `doorChoices` is what makes it checkable at all.
@MainActor
final class OnboardingCopyTests: XCTestCase {

    /// Phrases that mark a feature as not-here. None may appear in a door's copy now both doors work.
    /// Deliberately narrow: "this build" alone is legitimate elsewhere (a preview build with no
    /// bundled engine), so only phrases that assert absence of a shipped feature are listed.
    private static let placeholders = ["not in this build", "coming soon", "not built yet"]

    func testNoOnboardingDoorAdvertisesAMissingFeature() {
        for choice in SetupView.doorChoices {
            for text in [choice.title, choice.detail, choice.note].compactMap({ $0 }) {
                let lower = text.lowercased()
                for phrase in Self.placeholders {
                    XCTAssertFalse(
                        lower.contains(phrase),
                        "the \(choice.door) door advertises a missing feature: \"\(text)\"")
                }
            }
        }
    }

    /// The chooser still offers exactly the two doors, in order. A door quietly dropped would take its
    /// copy — and this guard's reach over it — with it.
    func testTheChooserOffersBothDoors() {
        XCTAssertEqual(
            SetupView.doorChoices.map(\.door), [.local, .cloud],
            "the chooser must offer the local door and the Cloud door")
    }
}
