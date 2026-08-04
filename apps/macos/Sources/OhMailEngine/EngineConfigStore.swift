import Foundation

/// What mailbox this install opens — and **never how to open it.**
///
/// The credential design: mailbox credentials go in the OS keystore … never a plaintext or
/// app-managed file." This file is the app-managed file, which is exactly why the password is not a
/// field on ``EngineConfig`` rather than a field this code is careful with. A struct with nowhere to
/// put a password cannot be talked into storing one by a later slice in a hurry, and
/// `EngineConfigStoreTests` asserts the encoded JSON's key set so that adding one is a red test
/// rather than a review someone has to catch.
///
/// The password is typed once into the running app and sealed into the engine's own store under the
/// per-install key (see ``KeyProvider``). ``Secret`` is not `Codable` for the same reason.
public struct EngineConfig: Codable, Equatable, Sendable {
    public var host: String
    public var port: Int
    public var user: String
    /// The mailbox address, which is not always the login user — some servers authenticate a
    /// username that is not an address at all.
    public var address: String
    /// Implicit TLS. `false` means STARTTLS or plaintext on `port`, which the engine decides.
    public var tls: Bool

    public init(host: String, port: Int = 993, user: String, address: String, tls: Bool = true) {
        self.host = host
        self.port = port
        self.user = user
        self.address = address
        self.tls = tls
    }

    /// The keys this file is allowed to contain. A test compares the encoded object against it.
    public static let encodedKeys: Set<String> = ["host", "port", "user", "address", "tls"]
}

/// `~/Library/Application Support/io.ohmail.desktop/config.json`.
///
/// Beside the engine's data directory rather than in `UserDefaults`, because the data directory is
/// what a support instruction can name and what a user can delete: "quit ohmail and remove that
/// folder" has to remove the configuration too, or the next launch reopens a mailbox the user just
/// removed.
public struct EngineConfigStore: Sendable {
    public let directory: URL

    public init(directory: URL = EngineProcess.defaultDataDirectory) {
        self.directory = directory
    }

    public var url: URL { directory.appendingPathComponent("config.json") }

    /// Whether this install has been pointed at a mailbox. **Not** whether it can open one — that
    /// also needs the key, and the two are separate questions with separate answers on screen.
    public var isConfigured: Bool { (try? load()) ?? nil != nil }

    public func load() throws -> EngineConfig? {
        guard let data = FileManager.default.contents(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(EngineConfig.self, from: data)
    }

    public func save(_ config: EngineConfig) throws {
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        let data = try encoder.encode(config)

        // Written to a neighbour and moved into place. A crash part-way through a rewrite otherwise
        // leaves a truncated config.json, and the next launch reports a corrupt install for a file
        // it wrote itself.
        let temporary = directory.appendingPathComponent("config.json.\(UUID().uuidString)")
        try data.write(to: temporary, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
    }

    public func remove() throws {
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }
}
