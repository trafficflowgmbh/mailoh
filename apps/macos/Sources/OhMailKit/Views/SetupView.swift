import SwiftUI
import OhMailEngine

/// ONBOARDING — the window on an install that has not been pointed at a mailbox.
///
/// Two things are collected and they are collected separately, because they are kept in different
/// places and one of them is not kept by this app at all:
///
///  1. **Where the mailbox is** — server, port, login, address, TLS. Written to a file beside the
///     local mirror, so that "quit ohmail and remove that folder" removes the mailbox too.
///  2. **The password**, which is typed once, sent down the pipe to the local engine, and sealed
///     into the engine's own store under a key this app never writes to disk. It is not a field on
///     the configuration and there is nowhere here for it to be saved.
///
/// Between the two there is a wait, and the wait is real rather than cosmetic: the engine has to be
/// running before there is anything to seal a password into. A form that took both at once would
/// have to hold the password while a process started, and then explain a failure that had nothing
/// to do with what was typed.
///
/// This view reads and writes nothing. Everything arrives as ``SetupStep`` and leaves through a
/// callback, which is the same rule every other file here follows and the reason the composition
/// root can be tested without a window.
struct SetupView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact

    let step: SetupStep
    /// The provider chosen behind door one, or `nil` for the generic path. Drives the form's
    /// prefill guidance and whether a pasted app password has its spaces stripped.
    let provider: MailProvider?
    /// A refusal about what was typed, beside the field rather than instead of the screen.
    let problem: String?
    let submitting: Bool
    let onChooseDoor: (OnboardingDoor) -> Void
    let onChooseProvider: (MailProvider) -> Void
    let onReconsider: () -> Void
    let onSaveMailbox: (EngineConfig) -> Void
    let onSubmitPassword: (String) -> Void
    let onBack: () -> Void

    init(step: SetupStep, provider: MailProvider? = nil, problem: String? = nil,
         submitting: Bool = false,
         onChooseDoor: @escaping (OnboardingDoor) -> Void = { _ in },
         onChooseProvider: @escaping (MailProvider) -> Void = { _ in },
         onReconsider: @escaping () -> Void = {},
         onSaveMailbox: @escaping (EngineConfig) -> Void = { _ in },
         onSubmitPassword: @escaping (String) -> Void = { _ in },
         onBack: @escaping () -> Void = {}) {
        self.step = step
        self.provider = provider
        self.problem = problem
        self.submitting = submitting
        self.onChooseDoor = onChooseDoor
        self.onChooseProvider = onChooseProvider
        self.onReconsider = onReconsider
        self.onSaveMailbox = onSaveMailbox
        self.onSubmitPassword = onSubmitPassword
        self.onBack = onBack
    }

    @State private var host = ""
    @State private var port = "993"
    @State private var user = ""
    @State private var address = ""
    @State private var tls = true
    /// The send server, carried invisibly through the form from the preset. It is not edited here —
    /// no field asks for it — and it rides out on the ``EngineConfig`` the form emits so that a
    /// preset's SMTP is not dropped between the prefill and the save. `nil` for the generic path.
    @State private var smtpHost: String?
    @State private var smtpPort: Int?
    @State private var smtpSecure: Bool?
    @State private var password = ""
    /// Whether Continue has been pressed. Gates the one line of validation copy; see the form.
    @State private var attempted = false
    /// Whether Outlook's tile has been tapped, which reveals its one factual line in place rather
    /// than advancing to fields the build cannot use.
    @State private var outlookTapped = false
    @FocusState private var focus: FieldID?

    private enum FieldID: Hashable { case host, port, user, address, password }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            content
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, compact ? Space.deckCompact : Space.deck)
        .background(p.canvas.color.ignoresSafeArea())
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .chooseDoor:
            panel {
                heading("Where should ohmail organize this mailbox?",
                        "Pick once. You can change this later.")
                VStack(spacing: 12) {
                    doorCard(title: "On this Mac",
                             detail: "ohmail runs here and connects straight to your mailbox over IMAP. "
                                 + "Nothing goes to our servers.",
                             note: nil) { onChooseDoor(.local) }
                    doorCard(title: "On ohmail Cloud",
                             detail: "Always-on organizing on our servers, so it keeps working while this "
                                 + "Mac is asleep.",
                             note: "Not in this build yet") { onChooseDoor(.cloud) }
                }
                .padding(.top, 22)
            }

        case .cloudUnavailable:
            panel {
                heading("ohmail Cloud isn't in this build yet.",
                        "This build organizes your mail here, on this Mac. Cloud organizing — always-on, "
                            + "on our servers — arrives in a later release.")
                HStack(spacing: 10) {
                    PillButton("Set up on this Mac", kind: .primary) { onChooseDoor(.local) }
                    PillButton("Back", kind: .ghost, action: onReconsider)
                }
                .padding(.top, 22)
            }

        case .pickProvider:
            panel {
                heading("Who hosts this mailbox?",
                        "This fills in the server details. You still enter your own login.")
                VStack(spacing: 10) {
                    ForEach(MailProvider.allCases, id: \.self) { provider in
                        providerTile(provider)
                    }
                }
                .padding(.top, 20)
                PillButton("Back", kind: .ghost, action: onReconsider)
                    .padding(.top, 16)
            }

        case .mailbox(let stored):
            panel {
                heading("Open your mailbox.",
                        "ohmail reads it over IMAP from this machine. Nothing is sent anywhere else.")
                if let guidance = provider?.appPasswordGuidance {
                    guidanceBlock(guidance)
                }
                mailboxFields
                // The send server, stated where a person can see it. It is not editable — it came
                // from the preset with the IMAP details — and it is only here at all so that "opening
                // a mailbox" does not quietly also configure sending without saying so.
                if let smtpHost, !smtpHost.isEmpty {
                    Text("Sends through \(smtpHost).")
                        .blanc(.meta).foregroundStyle(p.ink3.color)
                        .padding(.top, 12)
                }
                // Shown only after somebody has pressed Continue. A form that opens already telling
                // you a server is required is scolding you for not having typed yet, and it makes
                // the one case that matters — you typed something and it is wrong — look identical
                // to the case where you have done nothing at all.
                Text(attempted ? (mailboxProblem ?? "") : "")
                    .blanc(.meta).foregroundStyle(p.ink.color)
                    .opacity(attempted && mailboxProblem != nil ? 1 : 0)
                    .padding(.top, 12)
                // Enabled whatever the fields say. A button that greys itself out cannot tell you
                // why, and there is no other way to find out.
                PillButton("Continue", kind: .primary) { save() }
                    .padding(.top, 10)
            }
            .onAppear { prefill(stored) }

        case .starting:
            panel {
                heading("Starting the local engine.",
                        "It has to be running before a password can be stored on this machine.")
            }

        case .password:
            panel {
                heading("Now the password.",
                        "It goes straight to the local engine, which seals it on this machine. "
                            + "ohmail does not keep a copy and does not send it anywhere.")
                field("Password", text: $password, id: .password, secure: true)
                    .padding(.top, 22)
                if let problem {
                    Text(problem)
                        .blanc(.meta).foregroundStyle(p.ink.color)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                }
                HStack(spacing: 10) {
                    PillButton(submitting ? "Storing…" : "Store password", kind: .primary) {
                        onSubmitPassword(submittedPassword)
                    }
                    .disabled(submitting || password.isEmpty)
                    PillButton("Change the mailbox", kind: .ghost, action: onBack)
                        .disabled(submitting)
                }
                .padding(.top, 16)
            }
            .onAppear { focus = .password }

        case .failed(let notice):
            EngineStateView(notice: notice, action: (label: "Back", run: onBack))
        }
    }

    // MARK: - The mailbox step

    @ViewBuilder private var mailboxFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("Server", text: $host, id: .host, hint: "imap.example.org")
            HStack(alignment: .top, spacing: 12) {
                field("Port", text: $port, id: .port).frame(width: 110)
                VStack(alignment: .leading, spacing: 6) {
                    label("TLS")
                    HStack(spacing: 10) {
                        BlancSwitch("TLS", isOn: $tls)
                        Text(tls ? "On" : "Off")
                            .blanc(.meta).foregroundStyle(p.ink2.color)
                    }
                    .frame(height: 34)
                }
                Spacer(minLength: 0)
            }
            field("Login", text: $user, id: .user, hint: "you@example.org")
            field("Mailbox address", text: $address, id: .address,
                  hint: "Only when it differs from the login")
        }
        .padding(.top, 22)
    }

    /// What is wrong with the form, or `nil`. Shown as one line, not per field: four rules and one
    /// short form does not need four places to put a message.
    private var mailboxProblem: String? {
        if host.trimmed.isEmpty { return "A server is required." }
        if user.trimmed.isEmpty { return "A login is required." }
        guard let number = Int(port.trimmed), (1...65535).contains(number) else {
            return "The port has to be a number between 1 and 65535."
        }
        return nil
    }

    private func save() {
        attempted = true
        guard mailboxProblem == nil, let number = Int(port.trimmed) else { return }
        let login = user.trimmed
        onSaveMailbox(EngineConfig(
            host: host.trimmed,
            port: number,
            user: login,
            // Some servers authenticate a username that is not an address at all, and some accept
            // the address as the login. Blank means "they are the same", which is the common case
            // and the one nobody should have to type twice.
            address: address.trimmed.isEmpty ? login : address.trimmed,
            tls: tls,
            // Carried straight through from the preset. The send server is a setting, not something
            // this form collects; passing it here is what keeps a preset's SMTP from being dropped
            // between the prefill and the save.
            smtpHost: smtpHost, smtpPort: smtpPort, smtpSecure: smtpSecure))
    }

    private func prefill(_ stored: EngineConfig?) {
        guard let stored else { focus = .host; return }
        host = stored.host
        port = String(stored.port)
        user = stored.user
        address = stored.address == stored.user ? "" : stored.address
        tls = stored.tls
        smtpHost = stored.smtpHost
        smtpPort = stored.smtpPort
        smtpSecure = stored.smtpSecure
        // When a preset has already filled the server, the one thing left to type is the login, so
        // start there. A blank server (the generic path) starts at the top.
        focus = stored.host.isEmpty ? .host : .user
    }

    /// The password as it is sent: an app-specific password pasted with its spaces is accepted
    /// without them, so they are stripped for exactly the providers that issue them and left alone
    /// for a generic mailbox, whose password may legitimately contain a space.
    private var submittedPassword: String {
        (provider?.stripsPasswordSpaces ?? false)
            ? password.replacingOccurrences(of: " ", with: "")
            : password
    }

    // MARK: - Parts

    @ViewBuilder
    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: 460, alignment: .leading)
            .padding(.horizontal, 26).padding(.vertical, 26)
            .panel(p)
    }

    @ViewBuilder
    private func heading(_ title: String, _ sub: String) -> some View {
        Text(title)
            .blanc(compact
                   ? BlancText(size: Typography.Size.cardTitle, weight: Typography.Weight.bold,
                               trackingEm: Typography.Tracking.title, leading: 1.3)
                   : .heldTitle)
            .foregroundStyle(p.ink.color)
            .fixedSize(horizontal: false, vertical: true)
        Text(sub)
            .blanc(BlancText(size: Typography.Size.body, weight: Typography.Weight.regular,
                             leading: 1.6))
            .foregroundStyle(p.ink2.color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
    }

    @ViewBuilder
    private func label(_ text: String) -> some View {
        Text(text).blanc(.chip).foregroundStyle(p.ink3.color)
    }

    // MARK: - The two doors

    /// One of the two doors: a title, a line of what it means, and — for a door this build cannot
    /// open — a quiet note so the choice is not a bait. Tapping it is the whole surface.
    @ViewBuilder
    private func doorCard(title: String, detail: String, note: String?,
                          action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(title)
                        .blanc(BlancText(size: Typography.Size.cardTitle, weight: Typography.Weight.bold,
                                         trackingEm: Typography.Tracking.title))
                        .foregroundStyle(p.ink.color)
                    if let note {
                        Text(note).blanc(.caption).foregroundStyle(p.ink3.color)
                    }
                    Spacer(minLength: 0)
                    Icon(.chevron, 13).foregroundStyle(p.ink3.color)
                }
                Text(detail)
                    .blanc(BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.regular,
                                     leading: 1.5))
                    .foregroundStyle(p.ink2.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .surface(Radius.item, p.panel.color, .l0)
            .hairline(p, radius: Radius.item, soft: true)
        }
        .buttonStyle(.plain)
    }

    // MARK: - The provider tiles

    /// A provider row. The three shipping presets and the generic path advance; Outlook states its
    /// one factual line in place and does not — a tile that is present and honest, not missing.
    @ViewBuilder
    private func providerTile(_ provider: MailProvider) -> some View {
        let refused = provider.authKind == .refused
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if refused { outlookTapped = true } else { onChooseProvider(provider) }
            } label: {
                HStack(spacing: 8) {
                    Text(provider.displayName)
                        .blanc(.button).foregroundStyle(p.ink.color)
                    if provider.authKind == .appPassword {
                        Text("app password").blanc(.caption).foregroundStyle(p.ink3.color)
                    }
                    Spacer(minLength: 0)
                    Icon(refused ? .info : .chevron, 13).foregroundStyle(p.ink3.color)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .surface(Radius.item, p.panel.color, .l0)
                .hairline(p, radius: Radius.item, soft: true)
            }
            .buttonStyle(.plain)
            if refused, outlookTapped, let line = provider.refusal {
                Text(line)
                    .blanc(.meta).foregroundStyle(p.ink2.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
            }
        }
    }

    /// The app-password note for a preset provider: what is needed and where to make it. The URL is
    /// selectable text, not a link this shell opens — it links no network of its own.
    @ViewBuilder
    private func guidanceBlock(_ guidance: (line: String, url: String)) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(guidance.line)
                .blanc(BlancText(size: Typography.Size.bodyS, weight: Typography.Weight.regular,
                                 leading: 1.5))
                .foregroundStyle(p.ink2.color)
                .fixedSize(horizontal: false, vertical: true)
            Text(guidance.url)
                .blanc(.meta).foregroundStyle(p.ink3.color)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 14)
    }

    @ViewBuilder
    private func field(_ title: String, text: Binding<String>, id: FieldID,
                       hint: String = "", secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            label(title)
            Group {
                if secure {
                    SecureField(hint, text: text)
                } else {
                    TextField(hint, text: text)
                }
            }
            .textFieldStyle(.plain)
            .font(Typography.font(Typography.Size.body, Typography.Weight.regular))
            .foregroundStyle(p.ink.color)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .surface(Radius.item, p.panel.color, .l0)
            .hairline(p, radius: Radius.item, soft: focus != id)
            .focused($focus, equals: id)
            .accessibilityLabel(title)
        }
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
