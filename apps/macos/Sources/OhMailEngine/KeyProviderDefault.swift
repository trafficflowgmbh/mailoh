import Foundation

/// The keystore this app runs with: ``KeychainKeyStore``, on the macOS Keychain.
///
/// It used to answer `nil` — a stub that made the missing keystore visible instead of assumed, so
/// that an app launched with nothing set rendered `OHMAIL_KEK` by name and started nothing. That
/// was the honest behaviour while there was no keystore. There is one now, so the hole is closed
/// and the honest behaviour changed with it: a first run mints a key, every later run reads the
/// same one back, and the mailbox password is typed once rather than once per launch.
///
/// **The consequence is worth stating rather than discovering.** With a keystore behind it there is
/// always a key, so `OHMAIL_KEK` can no longer be the reason an install reports itself
/// unconfigured. That state is still reachable and still tested — it is what a shell with no
/// keystore does — but it is no longer what this app does.
///
/// The environment is not consulted for key material here, and the ordering that makes that safe
/// lives in the plan: a key from the keystore outranks `OHMAIL_KEK`, so a stale variable in a
/// launch script cannot displace the key a stored credential was sealed under.
public struct KeyProviderDefault: KeyProvider {
    private let store: KeychainKeyStore

    /// Reads ``KeychainKeyStore/serviceVariable`` so a development build can be pointed at its own
    /// keychain item; unset — which is every shipped launch, since a bundle opened from the Finder
    /// has no such variable — means ``KeychainKeyStore/defaultService``.
    public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let named = environment[KeychainKeyStore.serviceVariable]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.store = KeychainKeyStore(service: named.flatMap { $0.isEmpty ? nil : $0 }
                                      ?? KeychainKeyStore.defaultService)
    }

    /// The service this launch reads and writes. Published so a test can assert which item a
    /// default-constructed provider would touch without touching it.
    public var service: String { store.service }

    public func kek() throws -> String? { try store.kek() }
}
