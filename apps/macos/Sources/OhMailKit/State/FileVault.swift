import Foundation

/// WHETHER THE DISK IS ENCRYPTED AT REST — asked once, to decide whether to nudge.
///
/// ohmail keeps a local mirror of the mailbox in plaintext, the same on both doors. Nothing in the
/// app encrypts it; FileVault is what protects it if the Mac is lost or stolen. So on the first Cloud
/// sign-in the shell asks the system whether FileVault is on, and if it is not, it raises a single
/// dismissible nudge. This is the asking half — a thin wrapper over `fdesetup status`, behind a
/// protocol so a test drives the nudge without shelling out on the machine it runs on.
public enum FileVaultStatus: Sendable, Equatable {
    case on
    case off
    /// `fdesetup` could not be run or answered something neither on nor off. Treated as "do not
    /// nudge": a nudge on an answer we could not read would fire on machines where it is meaningless.
    case unknown
}

public protocol FileVaultProbe: Sendable {
    func status() async -> FileVaultStatus
}

/// The shipped probe: `/usr/bin/fdesetup status`, read off the main thread.
///
/// `fdesetup` is a stock macOS tool that needs no privilege for `status`. Its output is a single line
/// — `FileVault is On.` or `FileVault is Off.` — so the parse is a substring match rather than
/// anything structured, and anything else (an unexpected line, a tool that would not run) is
/// ``FileVaultStatus/unknown`` rather than a guess.
public struct SystemFileVaultProbe: FileVaultProbe {
    public init() {}

    public func status() async -> FileVaultStatus {
        await withCheckedContinuation { continuation in
            // Off the main actor: a subprocess round trip is not something to block the UI on, even a
            // fast one.
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: Self.run())
            }
        }
    }

    static func run() -> FileVaultStatus {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/fdesetup")
        process.arguments = ["status"]
        let output = Pipe()
        process.standardOutput = output
        // Drained so a diagnostic line cannot fill the pipe and block the child; the value is ignored.
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return .unknown
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self).lowercased()
        if text.contains("filevault is on") { return .on }
        if text.contains("filevault is off") { return .off }
        return .unknown
    }
}
