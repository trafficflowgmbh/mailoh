import XCTest
@testable import OhMailEngine

final class EngineConfigStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ohmail-config-\(UUID().uuidString.prefix(8))")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testAnInstallWithNoConfigurationSaysSoRatherThanThrowing() throws {
        let store = EngineConfigStore(directory: directory)
        XCTAssertFalse(store.isConfigured)
        XCTAssertNil(try store.load())
    }

    func testWhatIsSavedIsWhatComesBack() throws {
        let store = EngineConfigStore(directory: directory)
        let config = EngineConfig(host: "imap.example.org", port: 143,
                                  user: "someone", address: "someone@example.org", tls: false)
        try store.save(config)
        XCTAssertTrue(store.isConfigured)
        XCTAssertEqual(try store.load(), config)
    }

    /// **The whole reason this store exists as a typed struct.**
    ///
    /// The credential design puts mailbox credentials in the OS keystore, "never a plaintext or
    /// app-managed file" — and this IS the app-managed file. The defence is that `EngineConfig` has
    /// nowhere to put a password, so a later slice in a hurry cannot add one to a call site; it
    /// would have to add a field, and this assertion is what makes that a red test.
    func testTheFileOnDiskHoldsOnlyAllowedKeysAndNoneOfThemIsACredential() throws {
        let store = EngineConfigStore(directory: directory)
        try store.save(EngineConfig(host: "imap.example.org", user: "someone",
                                    address: "someone@example.org"))
        let raw = try Data(contentsOf: store.url)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        // A subset, not an equality: the SMTP keys are optional and omitted when unset, so a mailbox
        // with no send server writes just the five IMAP keys. What must hold is that every key is on
        // the allow-list AND none looks like a credential — the second is the real guard, and it
        // still turns red if a later slice adds `smtpPass` to either half.
        XCTAssertTrue(Set(object.keys).isSubset(of: EngineConfig.encodedKeys),
                      "config.json holds a key that is not on the allow-list: \(object.keys)")
        XCTAssertTrue(EngineConfig.encodedKeys.isSuperset(of: ["host", "port", "user", "address", "tls"]),
                      "the IMAP keys dropped off the allow-list")
        for forbidden in ["pass", "password", "secret", "token", "kek", "credential"] {
            XCTAssertFalse(Set(object.keys).contains { $0.lowercased().contains(forbidden) },
                           "config.json holds a key that looks like a credential: \(object.keys)")
        }
        let text = String(decoding: raw, as: UTF8.self).lowercased()
        XCTAssertFalse(text.contains("password"), text)
    }

    /// **The send server round-trips, and it is still not a place a credential can go.**
    ///
    /// A preset fills IMAP and SMTP together; both survive save/load, and the file still holds only
    /// non-secret settings. iCloud is the awkward one — its send port is STARTTLS — so `smtpSecure`
    /// is `false` and has to come back `false`, not lost to a default.
    func testTheSmtpSettingsRoundTripAndCarryNoCredential() throws {
        let store = EngineConfigStore(directory: directory)
        let config = EngineConfig(host: "imap.mail.me.com", port: 993, user: "someone",
                                  address: "someone@icloud.com", tls: true,
                                  smtpHost: "smtp.mail.me.com", smtpPort: 587, smtpSecure: false)
        try store.save(config)
        XCTAssertEqual(try store.load(), config)

        let raw = try Data(contentsOf: store.url)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(object["smtpHost"] as? String, "smtp.mail.me.com")
        XCTAssertEqual(object["smtpPort"] as? Int, 587)
        XCTAssertEqual(object["smtpSecure"] as? Bool, false)
        XCTAssertTrue(Set(object.keys).isSubset(of: EngineConfig.encodedKeys), "\(object.keys)")
        let text = String(decoding: raw, as: UTF8.self).lowercased()
        XCTAssertFalse(text.contains("password"), text)
    }

    /// A configuration written before SMTP existed decodes fine — the new fields are absent, which is
    /// `nil`, which is a generic mailbox with no send server. No migration, no corrupt-install panel.
    func testAConfigWithNoSmtpDecodesWithNilSendServer() throws {
        let store = EngineConfigStore(directory: directory)
        let json = Data(#"{"address":"a","host":"h","port":993,"tls":true,"user":"u"}"#.utf8)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try json.write(to: store.url)
        let loaded = try XCTUnwrap(try store.load())
        XCTAssertNil(loaded.smtpHost)
        XCTAssertNil(loaded.smtpPort)
        XCTAssertNil(loaded.smtpSecure)
    }

    // MARK: - The onboarding door

    func testTheChosenDoorIsRememberedAndCanBeForgotten() throws {
        let store = EngineConfigStore(directory: directory)
        XCTAssertNil(store.loadDoor(), "an install that has chosen nothing must not report a door")

        try store.saveDoor(.local)
        XCTAssertEqual(store.loadDoor(), .local)
        try store.saveDoor(.cloud)
        XCTAssertEqual(store.loadDoor(), .cloud, "a second choice did not replace the first")

        try store.removeDoor()
        XCTAssertNil(store.loadDoor())
        try store.removeDoor()   // idempotent: reconsidering twice must not throw
    }

    /// A hand-edited or truncated door file reads as "nothing chosen" and shows the chooser, rather
    /// than throwing on a launch.
    func testACorruptDoorFileReadsAsNoChoice() throws {
        let store = EngineConfigStore(directory: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: store.doorURL)
        XCTAssertNil(store.loadDoor())
    }

    // MARK: - The FileVault nudge dismissal

    func testTheFileVaultNudgeDismissalDefaultsToFalseAndIsRemembered() throws {
        let store = EngineConfigStore(directory: directory)
        XCTAssertFalse(store.loadFileVaultNudgeDismissed(), "a fresh install must not report the nudge dismissed")
        try store.saveFileVaultNudgeDismissed()
        XCTAssertTrue(store.loadFileVaultNudgeDismissed())
        // A second launch reading the same directory still sees it dismissed.
        XCTAssertTrue(EngineConfigStore(directory: directory).loadFileVaultNudgeDismissed())
    }

    /// A hand-edited or truncated file reads as "not dismissed" — the nudge is shown rather than
    /// swallowed by a bad read.
    func testACorruptFileVaultFileReadsAsNotDismissed() throws {
        let store = EngineConfigStore(directory: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: store.fileVaultURL)
        XCTAssertFalse(store.loadFileVaultNudgeDismissed())
    }

    func testTheDoorFileIsOwnerReadableOnly() throws {
        let store = EngineConfigStore(directory: directory)
        try store.saveDoor(.local)
        let attributes = try FileManager.default.attributesOfItem(atPath: store.doorURL.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        XCTAssertEqual(permissions & 0o077, 0)
    }

    func testTheFileIsOwnerReadableOnly() throws {
        let store = EngineConfigStore(directory: directory)
        try store.save(EngineConfig(host: "h", user: "u", address: "a"))
        let attributes = try FileManager.default.attributesOfItem(atPath: store.url.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        XCTAssertEqual(permissions & 0o077, 0, "another user on this Mac can read the mailbox address")
    }

    /// A crash part-way through a rewrite must not leave a truncated file that the next launch
    /// reports as a corrupt install.
    func testARewriteReplacesTheFileWholeAndLeavesNoLitter() throws {
        let store = EngineConfigStore(directory: directory)
        try store.save(EngineConfig(host: "first", user: "u", address: "a"))
        try store.save(EngineConfig(host: "second", user: "u", address: "a"))
        XCTAssertEqual(try store.load()?.host, "second")
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(left, ["config.json"], "a temporary file was left behind: \(left)")
    }

    func testRemovingTheConfigurationLeavesAnUnconfiguredInstall() throws {
        let store = EngineConfigStore(directory: directory)
        try store.save(EngineConfig(host: "h", user: "u", address: "a"))
        try store.remove()
        XCTAssertFalse(store.isConfigured)
        try store.remove()   // idempotent: a second quit must not throw
    }

    /// The bundle identifier is the one in `Info.plist` and in the packaging step. A disagreement
    /// means the app and its own data directory part company on the next release.
    func testTheDefaultDirectoryIsTheBundlesOwn() {
        XCTAssertEqual(EngineProcess.defaultDataDirectory.lastPathComponent, "io.ohmail.desktop")
        XCTAssertTrue(EngineProcess.defaultDataDirectory.path.contains("Application Support"))
    }
}
