/**
 * What "a valid Sparkle update-signing public key" means, in one place — so the packaging step
 * (`scripts/package-macos.mjs`) and its regression test agree on it rather than each carrying a
 * slightly different regex that drifts.
 *
 * The macOS app is unsigned; the EdDSA key in Info.plist (`SUPublicEDKey`) is the whole of what makes
 * a downloaded update trustworthy — an archive is installed only if its signature verifies against
 * it. A build that shipped a missing or malformed key would trust an unsigned feed, which is remote
 * code execution. So packaging REFUSES such a build, and this function is the predicate it refuses on.
 *
 * `SUPublicEDKey` is base64 of the 32-byte Ed25519 public key — the exact encoding Sparkle's
 * `generate_keys` prints and CryptoKit's `Curve25519.Signing.PublicKey(rawRepresentation:)` accepts.
 */
export function isValidSparklePublicKey(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  // base64 alphabet only, with 0–2 trailing '='.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  let buf;
  try {
    buf = Buffer.from(s, "base64");
  } catch {
    return false;
  }
  // Exactly 32 bytes — an Ed25519 public key. Buffer.from is lenient about junk, so re-encode and
  // require the canonical form to round-trip: that rejects both the wrong length and non-canonical
  // base64 that decoded to something plausible.
  if (buf.length !== 32) return false;
  return buf.toString("base64") === s;
}
