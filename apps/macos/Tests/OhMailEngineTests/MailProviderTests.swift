import XCTest
@testable import OhMailEngine

/// THE PROVIDER PRESET TABLE — the static server list behind door one.
///
/// The failure this guards against is a wrong host or a wrong TLS choice silently shipped: a person
/// picks their provider, trusts the details it filled in, and cannot connect for a reason that is not
/// theirs. So each entry is asserted against the values the provider actually publishes, and the two
/// awkward ones — iCloud's STARTTLS send port and Outlook's refusal — are named explicitly.
final class MailProviderTests: XCTestCase {

    /// Gmail: implicit-TLS IMAP on 993, implicit-TLS SMTP on 465, app password.
    func testGmailPreset() throws {
        let preset = try XCTUnwrap(MailProvider.gmail.preset)
        XCTAssertEqual(preset.imapHost, "imap.gmail.com")
        XCTAssertEqual(preset.imapPort, 993)
        XCTAssertEqual(preset.imapTLS, true)
        XCTAssertEqual(preset.smtpHost, "smtp.gmail.com")
        XCTAssertEqual(preset.smtpPort, 465)
        XCTAssertEqual(preset.smtpSecure, true, "465 is implicit TLS")
        XCTAssertEqual(MailProvider.gmail.authKind, .appPassword)
        XCTAssertNil(MailProvider.gmail.refusal)
    }

    /// iCloud: IMAP 993, SMTP **587 STARTTLS** — the one whose send port is not implicit TLS.
    func testICloudPreset() throws {
        let preset = try XCTUnwrap(MailProvider.icloud.preset)
        XCTAssertEqual(preset.imapHost, "imap.mail.me.com")
        XCTAssertEqual(preset.imapPort, 993)
        XCTAssertEqual(preset.smtpHost, "smtp.mail.me.com")
        XCTAssertEqual(preset.smtpPort, 587)
        XCTAssertEqual(preset.smtpSecure, false, "587 is STARTTLS, not implicit TLS")
        XCTAssertEqual(MailProvider.icloud.authKind, .appPassword)
    }

    /// Fastmail: IMAP 993, SMTP 465, app password.
    func testFastmailPreset() throws {
        let preset = try XCTUnwrap(MailProvider.fastmail.preset)
        XCTAssertEqual(preset.imapHost, "imap.fastmail.com")
        XCTAssertEqual(preset.smtpHost, "smtp.fastmail.com")
        XCTAssertEqual(preset.smtpPort, 465)
        XCTAssertEqual(preset.smtpSecure, true)
        XCTAssertEqual(MailProvider.fastmail.authKind, .appPassword)
    }

    /// **Outlook is present and refused.** No preset, no fields, one factual line about OAuth — the
    /// difference between a boundary and an oversight.
    func testOutlookIsPresentAndRefusedWithNoServerDetails() {
        XCTAssertTrue(MailProvider.allCases.contains(.outlook), "the tile must exist to be honest")
        XCTAssertNil(MailProvider.outlook.preset, "a refused provider offered server details")
        XCTAssertEqual(MailProvider.outlook.authKind, .refused)
        let line = MailProvider.outlook.refusal
        XCTAssertNotNil(line)
        XCTAssertTrue(line?.contains("OAuth") ?? false, "the line does not say why: \(line ?? "nil")")
    }

    /// The generic path is today's form, unchanged: no preset, an ordinary password, no refusal.
    func testGenericIsTheUnchangedByHandForm() {
        XCTAssertNil(MailProvider.generic.preset)
        XCTAssertEqual(MailProvider.generic.authKind, .plain)
        XCTAssertNil(MailProvider.generic.refusal)
        XCTAssertFalse(MailProvider.generic.stripsPasswordSpaces,
                       "a generic password may contain a space and must not be mangled")
    }

    /// App-specific passwords are pasted in spaced blocks; the three that issue them strip spaces,
    /// the generic one does not.
    func testOnlyAppPasswordProvidersStripSpaces() {
        for provider in [MailProvider.gmail, .icloud, .fastmail] {
            XCTAssertTrue(provider.stripsPasswordSpaces, "\(provider) should strip app-password spaces")
        }
        XCTAssertFalse(MailProvider.generic.stripsPasswordSpaces)
        XCTAssertFalse(MailProvider.outlook.stripsPasswordSpaces)
    }

    /// The app-password providers each say what is needed and where to make one.
    func testAppPasswordProvidersCarryGuidanceAndALink() {
        for provider in [MailProvider.gmail, .icloud, .fastmail] {
            let guidance = provider.appPasswordGuidance
            XCTAssertNotNil(guidance, "\(provider) has no app-password guidance")
            XCTAssertFalse(guidance?.line.isEmpty ?? true)
            XCTAssertTrue(guidance?.url.hasPrefix("https://") ?? false, "\(provider) has no usable link")
        }
        XCTAssertNil(MailProvider.generic.appPasswordGuidance)
        XCTAssertNil(MailProvider.outlook.appPasswordGuidance)
    }

    // MARK: - Domain → preset

    func testDomainMatch() {
        XCTAssertEqual(MailProvider.forEmail("someone@gmail.com"), .gmail)
        XCTAssertEqual(MailProvider.forEmail("SOMEONE@Googlemail.com"), .gmail, "match is case-insensitive")
        XCTAssertEqual(MailProvider.forEmail("me@icloud.com"), .icloud)
        XCTAssertEqual(MailProvider.forEmail("me@me.com"), .icloud)
        XCTAssertEqual(MailProvider.forEmail("me@mac.com"), .icloud)
        XCTAssertEqual(MailProvider.forEmail("me@fastmail.com"), .fastmail)
        XCTAssertEqual(MailProvider.forEmail("me@fastmail.fm"), .fastmail)
        XCTAssertEqual(MailProvider.forEmail("me@outlook.com"), .outlook)
        XCTAssertEqual(MailProvider.forEmail("me@hotmail.com"), .outlook)
        XCTAssertEqual(MailProvider.forEmail("me@live.com"), .outlook)
        // A bare domain resolves too — the picker can seed from either an address or a login.
        XCTAssertEqual(MailProvider.forEmail("gmail.com"), .gmail)
    }

    /// An unknown domain is the GENERIC form, never a guess. A Workspace domain on Google's servers
    /// is unknowable from the address, so the honest answer is "enter it by hand", not ".gmail".
    func testAnUnknownDomainIsGenericNotAGuess() {
        XCTAssertEqual(MailProvider.forEmail("someone@example.org"), .generic)
        XCTAssertEqual(MailProvider.forEmail("someone@my-company.com"), .generic)
        XCTAssertEqual(MailProvider.forEmail(""), .generic)
        XCTAssertEqual(MailProvider.forEmail("not-an-email"), .generic)
    }

    // MARK: - The preset builds an EngineConfig (the SMTP widening)

    /// A preset drafts an ``EngineConfig`` carrying IMAP and SMTP together, with the login blank —
    /// which is the whole SMTP widening: one config, both servers, no send credential.
    func testAPresetDraftsAWidenedEngineConfig() {
        let draft = MailProvider.gmail.preset!.draft()
        XCTAssertEqual(draft.host, "imap.gmail.com")
        XCTAssertEqual(draft.port, 993)
        XCTAssertEqual(draft.tls, true)
        XCTAssertEqual(draft.smtpHost, "smtp.gmail.com")
        XCTAssertEqual(draft.smtpPort, 465)
        XCTAssertEqual(draft.smtpSecure, true)
        XCTAssertEqual(draft.user, "", "the draft leaves the login for the person")
        XCTAssertEqual(draft.address, "")
    }

    func testTheDoorIsCodableEitherWay() throws {
        for door in [OnboardingDoor.local, .cloud] {
            let data = try JSONEncoder().encode(door)
            XCTAssertEqual(try JSONDecoder().decode(OnboardingDoor.self, from: data), door)
        }
    }
}
