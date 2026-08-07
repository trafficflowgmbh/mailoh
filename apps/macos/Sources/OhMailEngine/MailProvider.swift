import Foundation

/// THE TWO DOORS, AND THE PROVIDER PRESETS BEHIND DOOR ONE.
///
/// Onboarding opens on a choice — organize this mailbox **on this Mac** or **on ohmail Cloud** — and
/// the choice is a property of the install, made once. Door two signs in to a hosted account and reads
/// and triages its mailboxes here; door one is the local engine, and the provider presets below are
/// what it opens.
///
/// Door one is the local engine, and it begins by asking who hosts the mailbox. The answer fills in
/// server, port and TLS — settings a person cannot be expected to know and providers do not agree on
/// — so that the only thing left to type is a login and a password.
///
/// ── WHY THE TABLE IS STATIC ───────────────────────────────────────────────────────────────
///
/// It is a fixed list, not an autoconfig fetch. The local engine opens exactly the sockets its owner
/// configured — their own IMAP/SMTP server and nothing else — and a domain-to-server lookup over the
/// network would be a request to a host nobody asked to talk to, made while somebody is still typing
/// their address. The five entries below are the servers, not a guess about them.
///
/// ── WHY OUTLOOK IS PRESENT AND REFUSED ────────────────────────────────────────────────────
///
/// Microsoft retired basic IMAP/SMTP auth for personal and work accounts; opening it needs an OAuth
/// sign-in this build does not carry. A **missing** Outlook tile reads as an oversight — the reader
/// assumes it will work and hunts for a password that no longer exists. A tile that states the limit
/// reads as a boundary. So Outlook is a tile with one factual line and no fields.

/// Where an install organizes its mailbox. Chosen once, and remembered per install.
public enum OnboardingDoor: String, Codable, Equatable, Sendable {
    /// The local engine on this Mac, connecting straight to the user's own server.
    case local
    /// ohmail Cloud: sign in to a hosted account and read and triage the mailboxes it already holds.
    case cloud
}

/// How a provider is signed in to over IMAP/SMTP.
public enum ProviderAuthKind: Equatable, Sendable {
    /// A provider-issued app-specific password. The three shipping presets are all this: basic auth
    /// is either app-password-only (Gmail, iCloud) or app-password-recommended (Fastmail).
    case appPassword
    /// An ordinary mailbox password. The generic IMAP path — today's form, unchanged.
    case plain
    /// The provider cannot be opened with a password at all in this build (Outlook: OAuth only).
    case refused
}

/// The server details a domain implies, and how it is authenticated. Everything here is a setting;
/// nothing here is a secret. It PREFILLS a form and never stores a credential.
public struct ProviderPreset: Equatable, Sendable {
    public let imapHost: String
    public let imapPort: Int
    /// Implicit TLS on the IMAP port. `false` would mean STARTTLS/plaintext; all three presets are 993.
    public let imapTLS: Bool
    public let smtpHost: String
    public let smtpPort: Int
    /// Implicit TLS on the SMTP port. `true` for 465 (Gmail, Fastmail); `false` for 587 STARTTLS (iCloud).
    public let smtpSecure: Bool

    public init(imapHost: String, imapPort: Int = 993, imapTLS: Bool = true,
                smtpHost: String, smtpPort: Int, smtpSecure: Bool) {
        self.imapHost = imapHost
        self.imapPort = imapPort
        self.imapTLS = imapTLS
        self.smtpHost = smtpHost
        self.smtpPort = smtpPort
        self.smtpSecure = smtpSecure
    }

    /// A prefilled ``EngineConfig`` with the login and address left blank for the person to complete.
    ///
    /// The IMAP AND SMTP servers are carried together, so send goes out through the same mailbox the
    /// engine reads — one credential, sealed once. There is no SMTP password here and never is: the
    /// preset is settings, and the one credential is typed on the next step and sealed by the engine.
    public func draft() -> EngineConfig {
        EngineConfig(host: imapHost, port: imapPort, user: "", address: "", tls: imapTLS,
                     smtpHost: smtpHost, smtpPort: smtpPort, smtpSecure: smtpSecure)
    }
}

/// Who hosts the mailbox. The tiles behind door one, plus the generic fallback.
public enum MailProvider: String, CaseIterable, Equatable, Sendable {
    case gmail
    case icloud
    case fastmail
    case outlook
    /// Any other IMAP server. No preset — today's form, entered by hand.
    case generic
}

public extension MailProvider {
    /// The tile's label.
    var displayName: String {
        switch self {
        case .gmail: return "Gmail"
        case .icloud: return "iCloud"
        case .fastmail: return "Fastmail"
        case .outlook: return "Outlook"
        case .generic: return "Other (IMAP)"
        }
    }

    var authKind: ProviderAuthKind {
        switch self {
        case .gmail, .icloud, .fastmail: return .appPassword
        case .outlook: return .refused
        case .generic: return .plain
        }
    }

    /// The server preset, or `nil` for a provider with none — Outlook (refused) and generic (by hand).
    var preset: ProviderPreset? {
        switch self {
        case .gmail:
            return ProviderPreset(imapHost: "imap.gmail.com",
                                  smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true)
        case .icloud:
            return ProviderPreset(imapHost: "imap.mail.me.com",
                                  smtpHost: "smtp.mail.me.com", smtpPort: 587, smtpSecure: false)
        case .fastmail:
            return ProviderPreset(imapHost: "imap.fastmail.com",
                                  smtpHost: "smtp.fastmail.com", smtpPort: 465, smtpSecure: true)
        case .outlook, .generic:
            return nil
        }
    }

    /// The one factual line for a provider this build cannot open, or `nil` for one it can.
    var refusal: String? {
        switch self {
        case .outlook:
            return "Microsoft requires OAuth sign-in, which this build doesn't have yet."
        default:
            return nil
        }
    }

    /// The app-password note and where to make one, for the providers that need it. `nil` otherwise.
    ///
    /// The URL is shown as text rather than opened by the app: this shell links Foundation and
    /// AppKit and opens no network of its own, and a plain, copyable address keeps that true while
    /// still telling a person exactly where to go.
    var appPasswordGuidance: (line: String, url: String)? {
        switch self {
        case .gmail:
            return (line: "Gmail needs an app password. Turn on 2-Step Verification, then create one and "
                        + "paste it below — your login is your full Gmail address.",
                    url: "https://myaccount.google.com/apppasswords")
        case .icloud:
            return (line: "iCloud needs an app-specific password from your Apple Account.",
                    url: "https://appleid.apple.com")
        case .fastmail:
            return (line: "Fastmail needs an app password, created under Settings › Privacy & Security.",
                    url: "https://app.fastmail.com/settings/security/apppasswords")
        case .outlook, .generic:
            return nil
        }
    }

    /// Whether a pasted password should have its spaces stripped before it is sent.
    ///
    /// App-specific passwords are shown in blocks — `abcd efgh ijkl mnop` — and a person pastes them
    /// verbatim. The provider accepts them without the spaces, so removing them turns a paste that
    /// would be rejected into one that works, for exactly the providers that issue them.
    var stripsPasswordSpaces: Bool { authKind == .appPassword }

    /// The domains that resolve to this provider.
    var domains: [String] {
        switch self {
        case .gmail: return ["gmail.com", "googlemail.com"]
        case .icloud: return ["icloud.com", "me.com", "mac.com"]
        case .fastmail: return ["fastmail.com", "fastmail.fm"]
        case .outlook: return ["outlook.com", "hotmail.com", "live.com", "msn.com",
                               "hotmail.co.uk", "outlook.co.uk", "live.co.uk"]
        case .generic: return []
        }
    }

    /// The provider a login or address belongs to, or ``generic`` when no preset claims it.
    ///
    /// Accepts a full address (`someone@Gmail.com`) or a bare domain (`gmail.com`), case-insensitively.
    /// A Workspace or hosted domain that happens to sit on Google's servers does not resolve here —
    /// that is correct, not a miss: the honest answer for an unknown domain is the generic form, not a
    /// guess at somebody's provider.
    static func forEmail(_ text: String) -> MailProvider {
        let lowered = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !lowered.isEmpty else { return .generic }
        let domain = lowered.contains("@") ? String(lowered.split(separator: "@").last ?? "") : lowered
        for provider in MailProvider.allCases where provider.domains.contains(domain) {
            return provider
        }
        return .generic
    }
}
