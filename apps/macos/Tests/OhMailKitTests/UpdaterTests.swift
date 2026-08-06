import XCTest
import CryptoKit
@testable import OhMailKit

/// THE UPDATER IS A REMOTE-CODE-EXECUTION SURFACE, SO THESE TESTS ARE THE DELIVERABLE.
///
/// An auto-updater fetches and runs new code. Three things have to be true for that to be safe, and
/// each is asserted here so it can be *watched* rather than trusted:
///
///  1. a payload that does not verify against the trusted key is refused (one flipped byte is enough);
///  2. a version older than what is installed is never offered;
///  3. the updater does not even come into existence outside a real installed bundle — so the render
///     checks and the tests, which run as bare executables, take no updater code path.
///
/// Each was watched failing before it was trusted: `EdSignature.verify` was stubbed to `return true`
/// and the tamper cases went red; `UpdateDecision.decide`'s downgrade branch was flipped to `.update`
/// and the downgrade rows went red; `shouldRun`'s identifier check was loosened and the guard rows
/// went red. The Sparkle framework performs (1) itself inside its own process; this reproduces the
/// identical Ed25519 primitive with the identical key encoding (proven: the base64 seed Sparkle's
/// `generate_keys` exports derives exactly the committed `SUPublicEDKey` through CryptoKit), which is
/// what makes the refusal observable at all — Sparkle's own check cannot be reached from a unit test.
final class UpdaterTests: XCTestCase {

    // MARK: - (1) A tampered payload is refused

    func testValidEd25519SignatureIsAccepted() {
        let key = Curve25519.Signing.PrivateKey()
        let pub = key.publicKey.rawRepresentation.base64EncodedString()
        let payload = Self.samplePayload
        let sig = try! key.signature(for: payload).base64EncodedString()
        XCTAssertTrue(EdSignature.verify(payload, signatureBase64: sig, publicKeyBase64: pub),
                      "an untampered payload signed by the matching key must verify")
    }

    func testOneFlippedPayloadByteIsRefused() {
        let key = Curve25519.Signing.PrivateKey()
        let pub = key.publicKey.rawRepresentation.base64EncodedString()
        let payload = Self.samplePayload
        let sig = try! key.signature(for: payload).base64EncodedString()

        var tampered = payload
        tampered[100] ^= 0xFF   // exactly one byte
        XCTAssertFalse(EdSignature.verify(tampered, signatureBase64: sig, publicKeyBase64: pub),
                       "a payload with one byte changed must NOT verify against the original signature")
    }

    func testAFlippedSignatureByteIsRefused() {
        let key = Curve25519.Signing.PrivateKey()
        let pub = key.publicKey.rawRepresentation.base64EncodedString()
        let payload = Self.samplePayload
        var sigBytes = try! Data(key.signature(for: payload))
        sigBytes[10] ^= 0xFF
        XCTAssertFalse(EdSignature.verify(payload, signatureBase64: sigBytes.base64EncodedString(),
                                          publicKeyBase64: pub),
                       "a corrupted signature must NOT verify")
    }

    func testAGoodSignatureFromTheWrongKeyIsRefused() {
        let key = Curve25519.Signing.PrivateKey()
        let payload = Self.samplePayload
        let sig = try! key.signature(for: payload).base64EncodedString()
        let strangerPub = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()
        XCTAssertFalse(EdSignature.verify(payload, signatureBase64: sig, publicKeyBase64: strangerPub),
                       "a valid signature verified against a DIFFERENT public key must be refused — this is what stops a MITM substituting their own signed archive")
    }

    func testGarbageKeyOrSignatureIsRefusedRatherThanCrashing() {
        let payload = Self.samplePayload
        XCTAssertFalse(EdSignature.verify(payload, signatureBase64: "not base64 @@@", publicKeyBase64: "also not"))
        XCTAssertFalse(EdSignature.verify(payload, signatureBase64: "", publicKeyBase64: ""))
    }

    // MARK: - The public-key validator (the packaging gate's counterpart)

    func testPublicKeyValidatorAcceptsARealKeyAndRejectsMalformedOnes() {
        let good = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()
        XCTAssertTrue(EdSignature.isValidPublicKey(good), "a real 32-byte Ed25519 public key must validate")

        XCTAssertFalse(EdSignature.isValidPublicKey(""), "an EMPTY key must be rejected — a build shipping one would trust an unsigned feed")
        XCTAssertFalse(EdSignature.isValidPublicKey("   "), "whitespace is not a key")
        XCTAssertFalse(EdSignature.isValidPublicKey("!!! not base64 !!!"))
        // 31 bytes, correctly base64-encoded, is still the wrong length for Ed25519.
        XCTAssertFalse(EdSignature.isValidPublicKey(Data(count: 31).base64EncodedString()))
        XCTAssertFalse(EdSignature.isValidPublicKey(Data(count: 33).base64EncodedString()))
    }

    // MARK: - (2) Version comparison, table-driven across every boundary

    func testVersionDecisionTable() {
        // installed, candidate, expected. `.upToDate` and `.downgradeRefused` both mean "no update",
        // kept distinct so the reason is legible.
        let rows: [(String, String, UpdateDecision)] = [
            // Same release — never an update.
            ("0.5.0", "0.5.0", .upToDate),
            ("0.4.0-preview", "0.4.0-preview", .upToDate),
            // A pre-release tag does not make a version its own predecessor: `0.4.0-preview` and
            // `0.4.0` are the SAME release. (This is a deliberate divergence from a "preview → stable
            // of the same number is an upgrade" rule — that rule only exists to service a `-preview`
            // suffix, and this beta ships bare `0.5.0`, no suffix.)
            ("0.4.0-preview", "0.4.0", .upToDate),
            ("0.4.0", "0.4.0-preview", .upToDate),

            // Strictly newer — offer it.
            ("0.4.0", "0.5.0", .update),
            ("0.5.0", "0.5.1", .update),
            ("0.5.0", "0.6.0", .update),
            ("0.5.0", "1.0.0", .update),
            // The one real cross-version case this build has: a user left on the older preview string
            // MUST be offered the bare 0.5.0.
            ("0.4.0-preview", "0.5.0", .update),

            // Older — refuse. Never step a user backwards.
            ("0.5.0", "0.4.0", .downgradeRefused),
            ("0.6.0", "0.5.0", .downgradeRefused),
            ("1.0.0", "0.9.9", .downgradeRefused),
            // Plain semver gets this one wrong (it reads 0.4.0-preview < 0.5.0 and would… actually
            // still refuse; the trap is the reverse direction below). Here the numeric triple decides:
            // 0.4.0 < 0.5.0, so offering 0.4.0-preview to a 0.5.0 install is a downgrade.
            ("0.5.0", "0.4.0-preview", .downgradeRefused),

            // Unreadable — never mistaken for "newer".
            ("0.5.0", "not-a-version", .unreadable),
            ("", "0.5.0", .unreadable),
        ]
        for (installed, candidate, expected) in rows {
            XCTAssertEqual(UpdateDecision.decide(installed: installed, candidate: candidate), expected,
                           "decide(installed: \(installed), candidate: \(candidate))")
        }
    }

    func testParsingAndOrdering() {
        XCTAssertEqual(UpdateVersion("0.5.0"), UpdateVersion(major: 0, minor: 5, patch: 0))
        XCTAssertEqual(UpdateVersion("0.4.0-preview")?.prerelease, "preview")
        // Bare integer parses as N.0.0 — so a build-count feed orders correctly too.
        XCTAssertEqual(UpdateVersion("1287"), UpdateVersion(major: 1287, minor: 0, patch: 0))
        XCTAssertNil(UpdateVersion(""))
        XCTAssertNil(UpdateVersion("garbage"))
        XCTAssertTrue(UpdateVersion("0.4.0")! < UpdateVersion("0.5.0")!)
        XCTAssertFalse(UpdateVersion("0.5.0")! < UpdateVersion("0.4.0-preview")!)
    }

    /// The Sparkle bridge orders the way the framework needs: host strictly-older is `.orderedAscending`
    /// (offer), same release is `.orderedSame` (no-op), host newer is `.orderedDescending` (refuse).
    func testSparkleComparatorBridge() {
        let c = OhMailVersionComparator()
        XCTAssertEqual(c.compareVersion("0.4.0", toVersion: "0.5.0"), .orderedAscending)
        XCTAssertEqual(c.compareVersion("0.4.0-preview", toVersion: "0.5.0"), .orderedAscending)
        XCTAssertEqual(c.compareVersion("0.5.0", toVersion: "0.5.0"), .orderedSame)
        XCTAssertEqual(c.compareVersion("0.4.0", toVersion: "0.4.0-preview"), .orderedSame)
        XCTAssertEqual(c.compareVersion("0.5.0", toVersion: "0.4.0"), .orderedDescending)
        XCTAssertEqual(c.compareVersion("0.5.0", toVersion: "junk"), .orderedSame)
    }

    // MARK: - (3) The updater only exists inside a real installed bundle

    func testUpdaterGuardTruthTable() {
        // The one case that runs an updater: an installed .app carrying our identifier, not a render check.
        XCTAssertTrue(UpdaterController.shouldRun(bundleExtension: "app",
                                                  bundleIdentifier: "io.ohmail.desktop",
                                                  isRenderCheck: false))
        // A render check (--smoke / --shot) never does, even from a real bundle.
        XCTAssertFalse(UpdaterController.shouldRun(bundleExtension: "app",
                                                   bundleIdentifier: "io.ohmail.desktop",
                                                   isRenderCheck: true))
        // A bare `swift run` executable has no bundle identifier and no .app wrapper.
        XCTAssertFalse(UpdaterController.shouldRun(bundleExtension: "",
                                                   bundleIdentifier: nil,
                                                   isRenderCheck: false))
        // The xctest host is not us.
        XCTAssertFalse(UpdaterController.shouldRun(bundleExtension: "xctest",
                                                   bundleIdentifier: "com.apple.dt.xctest.tool",
                                                   isRenderCheck: false))
        // Some other app that happens to be a bundle is not us either.
        XCTAssertFalse(UpdaterController.shouldRun(bundleExtension: "app",
                                                   bundleIdentifier: "com.example.other",
                                                   isRenderCheck: false))
    }

    /// The reachable form of Obstacle A: in THIS process — the test bundle, which is the same
    /// no-real-bundle context `--smoke`/`--shot` run in — no updater is constructed and therefore no
    /// Sparkle code runs. If this ever returned a controller, `swift test` would be starting the
    /// updater, which is exactly what must not happen off an installed build.
    @MainActor
    func testNoUpdaterIsConstructedOutsideAnInstalledBundle() {
        XCTAssertNil(UpdaterController.forCurrentProcess(),
                     "the test host is not io.ohmail.desktop.app, so no updater — and no Sparkle — may start")
        XCTAssertNil(UpdaterController.forCurrentProcess(arguments: ["OhMail", "--smoke"]),
                     "a render check must never construct the updater")
    }

    // MARK: -

    /// 4 KB of deterministic bytes — a stand-in for an update archive.
    private static let samplePayload = Data((0..<4096).map { UInt8($0 & 0xFF) })
}
