import Foundation
import Security

/// THE PER-INSTALL KEY, MINTED ONCE AND KEPT IN THE MACOS KEYCHAIN.
///
/// This is the ``KeyProvider`` the app actually runs with. One item, one key, for the life of the
/// install: 32 random bytes rendered as 64 lowercase hex characters, which is the AES-256 key the
/// engine seals the mailbox password under. The password is therefore typed once — the environment
/// carries the key on every later launch and never the password.
///
/// ── WHAT IS STORED, AND UNDER WHAT ────────────────────────────────────────────────────────
///
/// A `kSecClassGenericPassword` item at service ``defaultService`` / account ``defaultAccount``,
/// added with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and `kSecAttrSynchronizable`
/// false.
///
/// **`ThisDeviceOnly` is the load-bearing half, not the "after first unlock" half.** A key that
/// reached iCloud Keychain would arrive on every other Mac signed into the same Apple Account, and
/// a restored backup would then be a SECOND install holding the first one's credential — which is
/// exactly the property "per-install" is supposed to deny. `AfterFirstUnlock` is the other half of
/// the pair: the app can be relaunched after a reboot without the user standing at the machine,
/// which `WhenUnlocked` would not allow.
///
/// **Those two attributes are passed and are NOT recorded, and that is measured rather than
/// assumed.** These items land in the file keychain, and reading one back returns `acct`, `svce`,
/// `class`, `labl` and two dates — no `accessible`, no `sync`. The device-local property therefore
/// comes from WHERE the item is rather than from what it is marked: a file-keychain item is a
/// `SecKeychainItem` in the user's login keychain, and iCloud Keychain carries data-protection
/// keychain items marked synchronizable, which this is not and cannot become. The attributes are
/// still passed because they are the correct ones and they bind the day this moves — see below.
///
/// The reason it has not moved: asking for the data-protection keychain
/// (`kSecUseDataProtectionKeychain`) answers **`errSecMissingEntitlement` (-34018)** for a binary
/// without a keychain access group, which is every build this project produces today. Granting one
/// is a signing change, not a code change, and until it happens the file keychain is the only
/// keychain this app can reach.
///
/// ── MINTING IS A RACE, SO IT IS RESOLVED RATHER THAN AVOIDED ──────────────────────────────
///
/// Two launches of a first run can reach ``kek()`` at the same moment. Both read nothing, both mint
/// 32 bytes, and both try to add — so the mint is written with `SecItemAdd` and `errSecDuplicateItem`
/// is treated as **"someone else won; read theirs"**, never as an error and never as a reason to
/// overwrite. An overwrite there is the worst outcome available: the loser's key replaces the
/// winner's after the winner has already sealed a password under it, and the mailbox stops opening
/// with nothing on screen able to explain why. `SecItemAdd` is the whole of the mutual exclusion —
/// the keychain enforces uniqueness on (class, service, account), so there is no window between a
/// check and a write for a second process to fit in.
///
/// The race this resolves is between PROCESSES, and it has to be: four concurrent `SecItem` calls
/// from ONE process wedge inside the keychain indefinitely, measured, while two complete in
/// hundredths of a second. Nothing here is a reason to call this from several threads at once — a
/// launch reads the key once — but a caller that decided to should know it is not a place to
/// parallelise.
///
/// ── WHAT THIS TYPE DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
///
/// It never writes the key to a file, a log, a process argument or a crash report. It holds no key
/// material in a stored property either — a `Mirror` of one of these values reaches a service name
/// and an account name and nothing else — so there is no leak for a printer to find. The key exists
/// as a value in flight and reaches exactly one place: the environment of the engine this shell
/// spawns.
///
/// A stored value that is not 64 hex characters throws. It is NOT repaired by minting over it: the
/// bytes that cannot be read here are, as far as anything in this process knows, the bytes some
/// stored credential still needs.
///
/// ── ONE ITEM, ONE CREATOR ─────────────────────────────────────────────────────────────────
///
/// The keychain ties an item to the program that created it. A release signed with a stable
/// identity keeps its access across updates; a build whose signature changes on every compile does
/// not, and **blocks on an authorization dialog** the first time a new build reads an item an older
/// one wrote — measured, by watching a recompiled binary sit on `SecItemCopyMatching` until it was
/// killed. ``serviceVariable`` exists for that case: a development build can be pointed at its own
/// item, so it neither prompts for nor competes with the one an installed copy owns. It names a
/// keychain service and never carries key material.
public struct KeychainKeyStore: KeyProvider {
    /// The shipped item's service. One per install, not one per mailbox: a single key scales to any
    /// number of mailboxes, whereas an item per mailbox would be a second credential-at-rest design
    /// competing with the envelope the stored credential already uses.
    public static let defaultService = "io.ohmail.desktop"

    /// The account name. Versioned, because the engine's key ring is: `kek.v1` is version 1, and a
    /// later rotation adds `kek.v2` beside it rather than replacing this one — the old version has
    /// to outlive every credential still sealed under it.
    public static let defaultAccount = "kek.v1"

    /// Names a different keychain service for this process. Empty or unset means ``defaultService``.
    public static let serviceVariable = "OHMAIL_KEYCHAIN_SERVICE"

    public let service: String
    public let account: String

    public init(service: String = KeychainKeyStore.defaultService,
                account: String = KeychainKeyStore.defaultAccount) {
        self.service = service
        self.account = account
    }

    /// The install's key, minting one on first run.
    ///
    /// Never `nil`: with a keystore behind it there is always a key, which is what makes
    /// ``EngineStatus/notConfigured(missing:)`` unreachable for `OHMAIL_KEK` in a shipped build. The
    /// optional stays in the protocol because a shell with no keystore at all is still a thing the
    /// type has to be able to say.
    public func kek() throws -> String? {
        if let existing = try storedKey() { return existing }

        var minted = [UInt8](repeating: 0, count: 32)
        // `SecRandomCopyBytes` and nothing else. `arc4random` is seeded per process and a UUID is
        // 122 bits of randomness dressed as 128 — neither is a key.
        let random = SecRandomCopyBytes(kSecRandomDefault, minted.count, &minted)
        guard random == errSecSuccess else {
            throw KeychainUnavailable(status: random, doing: "generating a new key")
        }
        let hex = Self.hex(minted)
        // The raw bytes are overwritten as soon as the hex exists, so the only copy left in this
        // process is the one the caller asked for.
        for i in minted.indices { minted[i] = 0 }

        var add = query()
        add[kSecValueData as String] = Data(hex.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        add[kSecAttrSynchronizable as String] = false

        let status = SecItemAdd(add as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return hex
        case errSecDuplicateItem:
            // Another launch minted first. Theirs is the key any credential sealed in the meantime
            // needs, so this one is discarded unread rather than written over it.
            guard let theirs = try storedKey() else {
                throw KeychainUnavailable(status: status,
                                          doing: "reading the key another launch had just added")
            }
            return theirs
        default:
            throw KeychainUnavailable(status: status, doing: "storing this install's new key")
        }
    }

    /// Forget this install's key. The mail is untouched — the key wraps the stored password and
    /// nothing else — so the cost of losing it is one prompt.
    ///
    /// Answers whether an item was there to remove, so a caller can tell "deleted" from "there was
    /// nothing".
    @discardableResult
    public func forget() throws -> Bool {
        let status = SecItemDelete(query() as CFDictionary)
        switch status {
        case errSecSuccess: return true
        case errSecItemNotFound: return false
        default: throw KeychainUnavailable(status: status, doing: "removing this install's key")
        }
    }

    // MARK: -

    /// The item's identity: class, service, account. Nothing else, and deliberately — a lookup that
    /// also matched on `kSecAttrAccessible` would miss an item stored by a version that chose a
    /// different one and would then mint a second key over a live credential.
    private func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// The stored key, or `nil` when this install has never minted one.
    ///
    /// Any other failure throws, and the difference matters more than it looks: a locked or
    /// unreadable keychain answered as "no key yet" would send ``kek()`` on to mint a replacement
    /// for a key that is merely out of reach, and seal the next password under it.
    private func storedKey() throws -> String? {
        var read = query()
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &item)
        switch status {
        case errSecItemNotFound:
            return nil
        case errSecSuccess:
            guard var data = item as? Data else {
                throw KeychainMalformed(reason: "the stored key is not data")
            }
            let value = String(decoding: data, as: UTF8.self)
            for i in data.indices { data[i] = 0 }
            guard Self.isKeyShaped(value) else {
                // The LENGTH, never the value. A malformed key is still key-adjacent material and
                // an error message is the one place it would be written down.
                throw KeychainMalformed(
                    reason: "the stored key is \(value.count) characters, and the engine requires "
                          + "64 hex characters (a 32-byte key). Nothing has been overwritten")
            }
            return value
        default:
            throw KeychainUnavailable(status: status, doing: "reading this install's key")
        }
    }

    /// 64 lowercase hex characters — the spelling the engine's configuration reader accepts, and
    /// the only one this store ever writes.
    static func hex(_ bytes: [UInt8]) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(bytes.count * 2)
        for byte in bytes {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Exactly 64 lowercase hex characters. Written as a character walk rather than a regular
    /// expression so that "64 hex" is the whole of the check — a pattern without anchors would
    /// accept a key with a newline after it, which is what a value pasted into a file has.
    static func isKeyShaped(_ value: String) -> Bool {
        guard value.count == 64 else { return false }
        for character in value.unicodeScalars where !(("0"..."9").contains(character)
                                                      || ("a"..."f").contains(character)) {
            return false
        }
        return true
    }
}

/// The keychain could not be reached. A different answer from "there is no key yet", and the
/// distinction is the reason this type exists: see ``KeyProvider``.
public struct KeychainUnavailable: Error, Equatable, CustomStringConvertible {
    public let status: OSStatus
    /// What was being attempted, as a phrase that completes "the key store failed while …".
    public let doing: String

    public init(status: OSStatus, doing: String) {
        self.status = status
        self.doing = doing
    }

    public var description: String {
        let explanation = SecCopyErrorMessageString(status, nil).map { $0 as String }
        return "the key store failed while \(doing): \(explanation ?? "OSStatus \(status)") (\(status))"
    }
}

/// There is an item and it is not a key. Never carries the value.
public struct KeychainMalformed: Error, Equatable, CustomStringConvertible {
    public let reason: String

    public init(reason: String) { self.reason = reason }

    public var description: String { "the key store holds something that is not a key: \(reason)" }
}
