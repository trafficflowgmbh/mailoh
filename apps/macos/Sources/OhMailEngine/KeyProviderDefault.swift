import Foundation

/// No keystore. Answers `nil`, so this install has no key and the shell says so out loud.
///
/// **OWNERSHIP OF THIS FILE TRANSFERS TO WHOEVER ADDS THE KEYCHAIN.** It is the stub that makes the missing
/// keystore visible instead of assumed: with it in place, an app launched with nothing set renders
/// `OHMAIL_KEK` by name and starts nothing, which is the honest behaviour until a real keystore
/// exists. Replacing it means minting one key on first run, storing it in the macOS Keychain, and
/// never writing it to disk.
///
/// Nothing here reaches `Security.framework`, and that is load-bearing today rather than laziness:
/// the packaging step fails the build if the shipped Mach-O links `Security.framework`,
/// because the download's first-run notes tell a stranger this build has no network code. Whoever
/// adds the Keychain also owns updating that claim.
public struct KeyProviderDefault: KeyProvider {
    public init() {}

    public func kek() throws -> String? { nil }
}
