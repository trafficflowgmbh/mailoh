import Foundation
import CryptoKit

/// THE SIGNATURE CHECK THAT MAKES AN UNSIGNED APP'S UPDATES SAFE.
///
/// ohmail ships without an Apple Developer ID, so nothing about the *download* is vouched for by
/// Apple. What vouches for an *update* is this: every release archive is signed with an Ed25519
/// private key that lives only in the maintainer's secrets, and the app trusts a fetched archive
/// only if its signature verifies against the public key baked into the bundle
/// (`SUPublicEDKey` in Info.plist). Without that check an updater is a remote-code-execution channel
/// — anyone who can sit between the app and the feed, or swap the file it downloads, replaces the app.
///
/// Sparkle performs exactly this verification inside its framework using the same `SUPublicEDKey`.
/// This type reproduces the identical primitive with CryptoKit — Ed25519 over the raw archive bytes —
/// so the property "a tampered payload is refused" can be *watched* in a unit test with the real
/// committed key format, rather than only asserted from Sparkle's documentation. That Sparkle's key
/// material round-trips through CryptoKit was verified against the generated pair: the base64 seed
/// `generate_keys` exports derives, via `Curve25519.Signing.PrivateKey(rawRepresentation:)`, exactly
/// the `SUPublicEDKey` string it prints.
public enum EdSignature {

    /// Verify an Ed25519 signature over `data` against a base64 public key (Sparkle's `SUPublicEDKey`
    /// encoding: base64 of the 32-byte Ed25519 public key) and a base64 signature (64 bytes).
    ///
    /// Returns `false` — never throws — for a bad key, a bad signature encoding, or a failed check.
    /// A verifier that distinguished "malformed" from "wrong" by throwing would tempt a caller into a
    /// `try?` that swallows both; the only safe answer to anything short of a valid signature is no.
    public static func verify(_ data: Data, signatureBase64: String, publicKeyBase64: String) -> Bool {
        guard let keyBytes = Data(base64Encoded: publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
              let sigBytes = Data(base64Encoded: signatureBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
        else { return false }
        return key.isValidSignature(sigBytes, for: data)
    }

    /// Whether a string is a well-formed `SUPublicEDKey` — base64 that decodes to a 32-byte Ed25519
    /// public key CryptoKit will accept. This is what the packaging step checks so a build can never
    /// ship a missing or malformed key and, with it, a feed it would trust unsigned.
    public static func isValidPublicKey(_ base64: String) -> Bool {
        let s = base64.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, let bytes = Data(base64Encoded: s), bytes.count == 32 else { return false }
        return (try? Curve25519.Signing.PublicKey(rawRepresentation: bytes)) != nil
    }
}
