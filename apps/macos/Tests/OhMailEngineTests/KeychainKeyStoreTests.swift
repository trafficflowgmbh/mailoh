import Foundation
import Security
import XCTest
@testable import OhMailEngine

/// Remove a test's keychain item, whichever binary put it there.
///
/// `SecItemDelete` cannot always do this. The keychain ties an item to the program that created it,
/// and several tests here run a SEPARATE shell process that mints its own — deleting one of those
/// from this process answers `-25244` and leaves it behind, which over a few hundred runs is a few
/// hundred abandoned items in somebody's login keychain. `security(1)` removes them, so the cleanup
/// goes through it and reports nothing either way: a missing item is the ordinary case.
func forgetKeychainService(_ service: String) {
    let run = Process()
    run.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    run.arguments = ["delete-generic-password", "-s", service]
    run.standardOutput = FileHandle.nullDevice
    run.standardError = FileHandle.nullDevice
    try? run.run()
    run.waitUntilExit()
}

/// **The per-install key: minted once, read back forever, and never written down anywhere else.**
///
/// Every test here talks to the real macOS Keychain. Nothing is faked — a fake keystore would agree
/// with whatever this file assumed about `SecItemAdd`, and the two properties that matter (a race
/// between two first runs, and an item that cannot reach another device) are properties of the
/// keychain rather than of any code here.
///
/// **Each test gets its own service name.** Not tidiness: the keychain ties an item to the program
/// that created it, and a test bundle is recompiled between runs, so an item left behind by an
/// earlier build would make a later build stop and ask a human for authorization — in a suite,
/// that is a run that never finishes. A fresh service per test can only ever meet an item this
/// build wrote, and `tearDown` removes it.
final class KeychainKeyStoreTests: XCTestCase {
    private var service: String!
    private var store: KeychainKeyStore!

    override func setUpWithError() throws {
        try Self.requireAKeychain()
        service = "io.ohmail.test.\(UUID().uuidString)"
        store = KeychainKeyStore(service: service)
    }

    override func tearDownWithError() throws {
        if let service { forgetKeychainService(service) }
    }

    /// Can this machine reach a keychain at all? A build machine with no login keychain unlocked
    /// answers no, and a skip is honest where a failure would be noise.
    private static func requireAKeychain() throws {
        let probe = KeychainKeyStore(service: "io.ohmail.test.reachable.\(UUID().uuidString)")
        do {
            _ = try probe.kek()
            _ = try probe.forget()
        } catch {
            throw XCTSkip("no keychain is reachable from this process: \(error)")
        }
    }

    // MARK: - The mint

    func testAFirstRunMintsSixtyFourHexCharacters() throws {
        let key = try XCTUnwrap(try store.kek())
        XCTAssertEqual(key.count, 64, "the engine reads a 32-byte AES-256 key as 64 hex characters")
        XCTAssertTrue(KeychainKeyStore.isKeyShaped(key), "not 64 lowercase hex characters: \(key.count) chars")
        XCTAssertEqual(key, key.lowercased())
    }

    /// Two mints must not agree. If they did, the "random" in `SecRandomCopyBytes` would not be.
    func testTwoInstallsDoNotGetTheSameKey() throws {
        let other = KeychainKeyStore(service: "io.ohmail.test.\(UUID().uuidString)")
        defer { _ = try? other.forget() }
        XCTAssertNotEqual(try store.kek(), try other.kek())
    }

    /// **The restart property, at its smallest.** A second reader on the same item — which is what
    /// the next launch of the app is — gets the key the first one minted.
    func testTheSameKeyComesBackToEveryLaterReader() throws {
        let first = try XCTUnwrap(try store.kek())
        let relaunch = KeychainKeyStore(service: service)
        XCTAssertEqual(try relaunch.kek(), first)
        XCTAssertEqual(try relaunch.kek(), first, "and again — reading is not minting")
    }

    /// **Two first runs at once agree on one key.**
    ///
    /// The failure this closes is silent and permanent: the loser of the race overwrites the
    /// winner's item after the winner has sealed a password under it, and the mailbox stops opening
    /// with nothing on screen able to say why. So the loser reads the winner's key and discards its
    /// own, and this is what says so.
    ///
    /// **TWO claimants, and not more, because the keychain itself cannot take more.** The first
    /// version ran sixty-four and the whole test process wedged inside `SecItemCopyMatching` —
    /// measured again outside this suite, where two concurrent callers complete in hundredths of a
    /// second over ten rounds and FOUR hang indefinitely. That is a property of the file keychain
    /// rather than of anything here, and it is not a limit the app can reach: the key is read once
    /// per launch on one thread, and two launches are two PROCESSES, which the keychain serialises
    /// through its own daemon. Two threads is therefore both the largest number that works and the
    /// number the real race has.
    ///
    /// Repeated over fresh items, because two claimants that happen to serialise on one round prove
    /// nothing about the round where they do not.
    func testTwoLaunchesRacingToMintAgreeOnOneKey() throws {
        for round in 0..<25 {
            let contested = "io.ohmail.test.\(UUID().uuidString)"
            defer { _ = try? KeychainKeyStore(service: contested).forget() }

            let answers = Collected<String>()
            let failures = Collected<String>()
            DispatchQueue.concurrentPerform(iterations: 2) { _ in
                do {
                    answers.add(try KeychainKeyStore(service: contested).kek() ?? "<nil>")
                } catch {
                    failures.add(String(describing: error))
                }
            }

            XCTAssertEqual(failures.all, [],
                           "round \(round): a losing claimant reported an error instead of reading "
                           + "the winner's key")
            XCTAssertEqual(answers.count, 2, "round \(round)")
            XCTAssertEqual(Set(answers.all).count, 1,
                           "round \(round): the two claimants disagreed about this install's key")
            // And the one they agreed on is the one that is actually stored.
            XCTAssertEqual(try KeychainKeyStore(service: contested).kek(), answers.all.first,
                           "round \(round)")
        }
    }

    /// **A key that is already there is read, never replaced** — the same rule as the race, asked
    /// deterministically.
    ///
    /// The race above is the only thing that reaches the duplicate branch, and a race is a poor
    /// place to state an invariant. This plants a key the way another install would have left one
    /// and insists the bytes are still those bytes afterwards.
    func testAKeyAlreadyInTheKeychainIsReadAndNotReplaced() throws {
        let planted = String(repeating: "a1b2c3d4", count: 8)
        XCTAssertTrue(KeychainKeyStore.isKeyShaped(planted))
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service!,
            kSecAttrAccount as String: KeychainKeyStore.defaultAccount,
            kSecValueData as String: Data(planted.utf8),
        ]
        XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)

        XCTAssertEqual(try store.kek(), planted)
        XCTAssertEqual(try store.kek(), planted, "a second read did not mint over it either")
    }

    // MARK: - Where it is stored, and where it can go

    /// **THE KEY CANNOT REACH ANOTHER MACHINE — asked of the keychain, not of the call site.**
    ///
    /// This is the whole of "per-install": a key that reached iCloud Keychain would arrive on every
    /// other Mac on the same Apple Account, and a restored backup would be a second install holding
    /// the first one's credential.
    ///
    /// **It is NOT asserted by reading back `kSecAttrAccessible`, and the first version of this test
    /// did exactly that and failed.** The store passes
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and reading the item back returns no
    /// `accessible` attribute at all — the file keychain does not record one. An assertion on the
    /// attribute would therefore have been an assertion about a field that does not exist, and the
    /// honest version asks after the property instead: the key is not in the synchronizing half of
    /// the keychain, which is the half iCloud Keychain carries.
    func testTheKeyIsNotAnItemThatCanReachAnotherMachine() throws {
        _ = try store.kek()

        var read: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service!,
            kSecAttrAccount as String: KeychainKeyStore.defaultAccount,
            kSecMatchLimit as String: kSecMatchLimitAll,
            // A query with no return type answers `errSecSuccess` and hands back nothing, which is
            // indistinguishable from a match at the call site. Asked for, so the count below is a
            // count of something.
            kSecReturnAttributes as String: true,
        ]

        // Not vacuous: with `SynchronizableAny` the same query finds the item, so the empty result
        // below is the sync domain being empty rather than the query being wrong.
        read[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
        var anywhere: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &anywhere), errSecSuccess)
        XCTAssertEqual((anywhere as? [[String: Any]])?.count, 1, "there is exactly one item to find")

        read[kSecAttrSynchronizable as String] = true
        var synced: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &synced), errSecItemNotFound,
                       "this install's key is a synchronizing keychain item")
    }

    /// The shipped item is named by constants, and a stranger reading the app's keychain should find
    /// exactly one entry they can identify.
    func testTheShippedItemIsNamedOnceAndOnly() {
        XCTAssertEqual(KeychainKeyStore.defaultService, "io.ohmail.desktop")
        XCTAssertEqual(KeychainKeyStore.defaultAccount, "kek.v1",
                       "the account carries the key VERSION, so a rotation can add one beside it")
        XCTAssertEqual(KeychainKeyStore().service, KeychainKeyStore.defaultService)
    }

    /// The default provider is the live one, and an environment can point a development build
    /// somewhere else. Asserted on the NAME, so this test touches no keychain item.
    func testTheDefaultProviderIsTheKeychainAndAnEnvironmentCanRedirectIt() {
        XCTAssertEqual(KeyProviderDefault(environment: [:]).service, KeychainKeyStore.defaultService)
        XCTAssertEqual(KeyProviderDefault(environment: [KeychainKeyStore.serviceVariable: "  "]).service,
                       KeychainKeyStore.defaultService,
                       "a variable a launcher materialised as blank is not a service name")
        XCTAssertEqual(
            KeyProviderDefault(environment: [KeychainKeyStore.serviceVariable: "io.ohmail.elsewhere"]).service,
            "io.ohmail.elsewhere")
    }

    // MARK: - What it refuses to do

    /// **An item that is not a key is refused, and is left exactly where it was.**
    ///
    /// Minting over it would be the same mistake as losing the race: whatever those bytes are, they
    /// are the bytes some stored credential may still need, and this process cannot know otherwise.
    func testAStoredValueThatIsNotAKeyIsRefusedAndNothingIsOverwritten() throws {
        let planted = "not a key at all"
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service!,
            kSecAttrAccount as String: KeychainKeyStore.defaultAccount,
            kSecValueData as String: Data(planted.utf8),
        ]
        XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)

        XCTAssertThrowsError(try store.kek()) { error in
            guard let malformed = error as? KeychainMalformed else {
                return XCTFail("a malformed item must not read as a missing one: \(error)")
            }
            XCTAssertTrue(malformed.description.contains("\(planted.count) characters"),
                          "the refusal says how long the value was: \(malformed.description)")
            XCTAssertFalse(malformed.description.contains(planted),
                           "the refusal quoted the stored value back: \(malformed.description)")
        }

        // Still there, untouched.
        var read: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service!,
            kSecAttrAccount as String: KeychainKeyStore.defaultAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &item), errSecSuccess)
        XCTAssertEqual((item as? Data).map { String(decoding: $0, as: UTF8.self) }, planted)
        read.removeValue(forKey: kSecReturnData as String)
    }

    /// `forget` is the "the user threw the key away" path, and it says which of the two things it
    /// did — a delete that silently succeeds on an empty keychain cannot be told from one that
    /// removed a live key.
    func testForgettingSaysWhetherThereWasAnythingToForget() throws {
        XCTAssertFalse(try store.forget(), "there was nothing stored yet")
        _ = try store.kek()
        XCTAssertTrue(try store.forget())
        XCTAssertFalse(try store.forget())
    }

    /// A key thrown away is a prompt, not a catastrophe: the next read mints a new one rather than
    /// failing, and it is a DIFFERENT key — which is precisely why the credential sealed under the
    /// old one has to be entered again.
    func testAKeyThrownAwayIsReplacedByANewOneRatherThanByAFailure() throws {
        let first = try XCTUnwrap(try store.kek())
        XCTAssertTrue(try store.forget())
        let second = try XCTUnwrap(try store.kek())
        XCTAssertNotEqual(second, first)
        XCTAssertTrue(KeychainKeyStore.isKeyShaped(second))
    }

    // MARK: - The shape the engine reads

    /// The engine's configuration reader takes 64 hex characters and nothing else, so these are the
    /// cases that decide whether an install starts at all.
    func testWhatCountsAsAKey() {
        XCTAssertTrue(KeychainKeyStore.isKeyShaped(String(repeating: "0", count: 64)))
        XCTAssertTrue(KeychainKeyStore.isKeyShaped(String(repeating: "abcdef01", count: 8)))
        XCTAssertFalse(KeychainKeyStore.isKeyShaped(String(repeating: "0", count: 63)))
        XCTAssertFalse(KeychainKeyStore.isKeyShaped(String(repeating: "0", count: 65)))
        XCTAssertFalse(KeychainKeyStore.isKeyShaped(String(repeating: "A", count: 64)), "uppercase is not written")
        XCTAssertFalse(KeychainKeyStore.isKeyShaped(String(repeating: "0", count: 63) + "\n"),
                       "a trailing newline is what a value pasted into a file has")
        XCTAssertFalse(KeychainKeyStore.isKeyShaped(""))
    }

    func testHexIsLowercaseAndTwoCharactersPerByte() {
        XCTAssertEqual(KeychainKeyStore.hex([0x00, 0x0f, 0xa5, 0xff]), "000fa5ff")
        XCTAssertEqual(KeychainKeyStore.hex([]), "")
        XCTAssertEqual(KeychainKeyStore.hex([UInt8](repeating: 0, count: 32)).count, 64)
    }

    /// Nothing that prints one of these values can print a key: there is no key in it. The value in
    /// flight is the only copy, and it reaches exactly one place — the environment of the spawn.
    func testTheStoreItselfHoldsNoKeyMaterial() throws {
        let key = try XCTUnwrap(try store.kek())
        for printed in ["\(store!)", String(reflecting: store!), String(describing: store!)] {
            XCTAssertFalse(printed.contains(key), "the store printed this install's key: \(printed)")
        }
        let mirror = Mirror(reflecting: store!)
        for child in mirror.children {
            XCTAssertFalse(String(describing: child.value).contains(key),
                           "a stored property carries the key: \(child.label ?? "?")")
        }
    }
}
