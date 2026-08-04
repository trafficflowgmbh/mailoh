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
    /// A refusal about what was typed, beside the field rather than instead of the screen.
    let problem: String?
    let submitting: Bool
    let onSaveMailbox: (EngineConfig) -> Void
    let onSubmitPassword: (String) -> Void
    let onBack: () -> Void

    @State private var host = ""
    @State private var port = "993"
    @State private var user = ""
    @State private var address = ""
    @State private var tls = true
    @State private var password = ""
    /// Whether Continue has been pressed. Gates the one line of validation copy; see the form.
    @State private var attempted = false
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
        case .mailbox(let stored):
            panel {
                heading("Open your mailbox.",
                        "ohmail reads it over IMAP from this machine. Nothing is sent anywhere else.")
                mailboxFields
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
                        onSubmitPassword(password)
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
            tls: tls))
    }

    private func prefill(_ stored: EngineConfig?) {
        guard let stored else { focus = .host; return }
        host = stored.host
        port = String(stored.port)
        user = stored.user
        address = stored.address == stored.user ? "" : stored.address
        tls = stored.tls
        focus = .host
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
