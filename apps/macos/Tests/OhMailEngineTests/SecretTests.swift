import XCTest
@testable import OhMailEngine

/// **The vacuity trap, and why this file is not the whole answer.**
///
/// A redaction type asserted only through its own `description` proves that `Secret.description`
/// returns `"<redacted>"`, which nobody doubted. What matters is that the token does not reach the
/// process's stderr, and no test in this file can see that — the token would have to travel through
/// a real `ready` frame, through the supervisor, through every log line the shell writes, and out
/// of a whole process's lifetime.
///
/// `OrphanAndLeakTests.testTheSessionTokenNeverReachesStderrAcrossAWholeLaunchAndQuit` is that test.
/// The cases here are the narrower claim they rest on: every spelling of "print this value" is
/// covered, including the ones a struct that merely *contains* a `Secret` goes through.
final class SecretTests: XCTestCase {
    private struct Envelope {
        let label: String
        let secret: Secret
    }

    func testEverySpellingOfPrintingASecretIsRedacted() {
        let secret = Secret("tok_do_not_print_me")
        for printed in ["\(secret)",
                        String(describing: secret),
                        String(reflecting: secret),
                        secret.description,
                        secret.debugDescription] {
            XCTAssertFalse(printed.contains("tok_do_not_print_me"), "the token was printed as: \(printed)")
            XCTAssertEqual(printed, "<redacted>")
        }
        XCTAssertEqual(secret.expose(), "tok_do_not_print_me", "and the value is still readable, on purpose")
    }

    /// **The one that was missed, and was caught here rather than reasoned about.**
    ///
    /// A `Secret` inside another value is printed by walking the enclosing value's `Mirror`, which
    /// reads the stored `String` directly — it does not go through the call site and it does not ask
    /// the enclosing type for permission. With `CustomStringConvertible` and
    /// `CustomDebugStringConvertible` alone, this assertion failed with the token in the message
    /// while every assertion in the test above it passed. `CustomReflectable` on `Secret` is the fix,
    /// and it is the right one because it makes redaction a property of the secret rather than an
    /// obligation on every type that will ever hold one.
    ///
    /// `Envelope` is deliberately a plain struct declared HERE, with no conformances of its own:
    /// it stands in for the types other slices have not written yet.
    func testASecretInsideAnotherValueIsStillRedacted() {
        let envelope = Envelope(label: "session", secret: Secret("tok_do_not_print_me"))
        for printed in ["\(envelope)", String(describing: envelope), String(reflecting: envelope)] {
            XCTAssertFalse(printed.contains("tok_do_not_print_me"), "the token was printed as: \(printed)")
            XCTAssertTrue(printed.contains("<redacted>"), printed)
        }
        var dumped = ""
        dump(envelope, to: &dumped)
        XCTAssertFalse(dumped.contains("tok_do_not_print_me"), dumped)
    }

    func testTheReadyFrameCannotBePrintedIntoALog() {
        let ready = EngineReady(baseURL: "http://sidecar", accountID: "acc-1", userID: "usr-1",
                                mailboxID: "mbx-1", sessionToken: Secret("tok_do_not_print_me"))
        for printed in ["\(ready)", String(describing: ready), String(reflecting: ready)] {
            XCTAssertFalse(printed.contains("tok_do_not_print_me"), printed)
        }
        var dumped = ""
        dump(ready, to: &dumped)
        XCTAssertFalse(dumped.contains("tok_do_not_print_me"), dumped)
    }

    /// Deliberately not the data directory: a path under the user's home carries the account name,
    /// and the shell that set it already knows what it is.
    func testTheServingStatusNamesTheMailboxAndNothingElse() {
        let status = EngineStatus.serving(mailboxID: "mbx-1")
        XCTAssertEqual(status.description, "serving mailbox mbx-1")
        XCTAssertFalse(status.description.lowercased().contains("token"))
    }

    /// A `Secret` that could be encoded is a `Secret` that ends up in `config.json`. There is no
    /// `Codable` conformance, and this records that as a decision rather than an omission — the
    /// assertion is that the type does not conform, which a future conformance turns red.
    func testASecretIsNotEncodable() {
        XCTAssertFalse((Secret("x") as Any) is any Encodable,
                       "a Codable Secret is a Secret somebody writes to disk without meaning to")
    }
}
