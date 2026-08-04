import Foundation

/// Where the per-install key-encryption key comes from.
///
/// The credential design: **the native shell owns the keystore and stores exactly one per-install
/// KEK.** Mailbox credentials themselves flow through the envelope encryption Cloud already uses,
/// so there is one credential-at-rest design rather than two; the engine seals the password under
/// this key and reads it back on every later launch. The password is therefore typed once, over the
/// bridge, and the environment carries the key instead.
///
/// **This protocol is a hole, deliberately.** The implementation that reaches the macOS Keychain is
/// separate work, and ``KeyProviderDefault`` — which answers `nil` — belongs to it the moment this
/// lands. The seam is declared here rather than there because of how the key was lost the first
/// time: the engine side and the shell side each assumed the key was the other's, so nothing minted
/// it and a local install could not store a password at all. A named protocol with a stub behind it
/// cannot be assumed away by either side.
///
/// `nil` and a thrown error are different answers and must stay that way. `nil` is "there is no key
/// yet", which is ``EngineStatus/notConfigured(missing:)`` and names `OHMAIL_KEK` on screen. A throw
/// is "the key store could not be read", which is ``EngineStatus/failed(reason:last:)`` — a
/// different sentence, because minting a fresh key over a keychain that is merely locked would seal
/// the next password under a key that replaced one the stored credentials still need.
public protocol KeyProvider: Sendable {
    /// The 64-hex-character AES-256 key the engine seals credentials under, or `nil` if this install
    /// has none yet.
    func kek() throws -> String?
}
