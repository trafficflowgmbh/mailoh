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
    func testTheFileOnDiskHoldsFiveKeysAndNoneOfThemIsACredential() throws {
        let store = EngineConfigStore(directory: directory)
        try store.save(EngineConfig(host: "imap.example.org", user: "someone",
                                    address: "someone@example.org"))
        let raw = try Data(contentsOf: store.url)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(Set(object.keys), EngineConfig.encodedKeys)
        for forbidden in ["pass", "password", "secret", "token", "kek", "credential"] {
            XCTAssertFalse(Set(object.keys).contains { $0.lowercased().contains(forbidden) },
                           "config.json holds a key that looks like a credential: \(object.keys)")
        }
        let text = String(decoding: raw, as: UTF8.self).lowercased()
        XCTAssertFalse(text.contains("password"), text)
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
