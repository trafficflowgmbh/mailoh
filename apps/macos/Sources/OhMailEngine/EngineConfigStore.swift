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

    /// The SMTP server this mailbox sends through — settings, never a credential.
    ///
    /// **Send goes out through the SAME login the engine reads mail with**: one credential per
    /// mailbox, typed once and sealed by the engine under the per-install key. So there is a host,
    /// a port and a TLS choice here, and there is deliberately no password — the same reason the
    /// IMAP password is not a field either. Absent for a generic install that supplied no SMTP
    /// server; a preset fills all three at once.
    public var smtpHost: String?
    public var smtpPort: Int?
    /// Implicit TLS on the SMTP port. `nil` tracks `smtpHost`; the engine reads it as "not `0`".
    public var smtpSecure: Bool?

    public init(host: String, port: Int = 993, user: String, address: String, tls: Bool = true,
                smtpHost: String? = nil, smtpPort: Int? = nil, smtpSecure: Bool? = nil) {
        self.host = host
        self.port = port
        self.user = user
        self.address = address
        self.tls = tls
        self.smtpHost = smtpHost
        self.smtpPort = smtpPort
        self.smtpSecure = smtpSecure
    }

    /// The keys this file is ALLOWED to contain — the whole set, IMAP and SMTP. A test asserts the
    /// encoded object is a subset of this and that none of its keys looks like a credential, so a
    /// later slice that adds a password field to either half turns a test red rather than shipping a
    /// plaintext secret beside the mailbox. The optional SMTP keys are omitted when unset, which is
    /// why the check is a subset and not an equality.
    public static let encodedKeys: Set<String> = [
        "host", "port", "user", "address", "tls", "smtpHost", "smtpPort", "smtpSecure",
    ]
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

    // MARK: - The onboarding door

    /// `onboarding.json`, beside the mailbox configuration.
    ///
    /// The chosen door is a property of the install, made once: which of the two ways this Mac
    /// organizes its mailbox. It lives here rather than in `UserDefaults` for the same reason the
    /// mailbox does — "quit ohmail and remove that folder" has to remove the choice too, so the next
    /// launch opens on the chooser again rather than resuming a door the person thought they had left.
    public var doorURL: URL { directory.appendingPathComponent("onboarding.json") }

    private struct DoorRecord: Codable { var door: OnboardingDoor }

    /// The chosen door, or `nil` if none has been chosen — a corrupt or hand-edited file reads as
    /// `nil`, which shows the chooser rather than throwing on a launch.
    public func loadDoor() -> OnboardingDoor? {
        guard let data = FileManager.default.contents(atPath: doorURL.path),
              let record = try? JSONDecoder().decode(DoorRecord.self, from: data) else { return nil }
        return record.door
    }

    public func saveDoor(_ door: OnboardingDoor) throws {
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(DoorRecord(door: door))
        let temporary = directory.appendingPathComponent("onboarding.json.\(UUID().uuidString)")
        try data.write(to: temporary, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        _ = try FileManager.default.replaceItemAt(doorURL, withItemAt: temporary)
    }

    public func removeDoor() throws {
        if FileManager.default.fileExists(atPath: doorURL.path) {
            try FileManager.default.removeItem(at: doorURL)
        }
    }
}
