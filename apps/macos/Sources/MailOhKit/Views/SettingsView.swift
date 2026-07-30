import SwiftUI

public enum SettingsPane: String, CaseIterable, Hashable, Sendable {
    case general, notifications, mailboxes, tags
    var title: String {
        switch self {
        case .general: return "General"
        case .notifications: return "Notifications"
        case .mailboxes: return "Mailboxes"
        case .tags: return "Tags"
        }
    }
}

/// Settings — a narrow nav beside one panel, with hairline rules between rows
/// (the same family as the Receipts day rules: they buy scanability in a table,
/// so they stay). Every note states a fact about where data lives.
public struct SettingsView: View {
    @Environment(\.palette) private var p
    @Bindable var s: AppState
    @State private var pane: SettingsPane = .general

    public init(_ s: AppState) { self.s = s }

    public var body: some View {
        VStack(spacing: 0) {
            ViewHead("Settings")
            Scroller {
                HStack(alignment: .top, spacing: 16) {
                    nav.frame(width: 170)
                    panel.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(.horizontal, Space.paneX)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var nav: some View {
        VStack(spacing: 2) {
            ForEach(SettingsPane.allCases, id: \.self) { item in
                NavRow(title: item.title, isOn: pane == item) { pane = item }
            }
        }
        .padding(.vertical, 6).padding(.trailing, 4)
        .accessibilityLabel("Settings sections")
    }

    @ViewBuilder private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch pane {
            case .general: general
            case .notifications: notifications
            case .mailboxes: mailboxes
            case .tags: tags
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 26).padding(.top, 10).padding(.bottom, 22)
        .panel(p)
    }

    // MARK: General

    private var general: some View {
        VStack(spacing: 0) {
            SettingsRow(label: "Language", sub: "More languages coming") {
                Text("English").blanc(.button).foregroundStyle(p.ink2.color)
            }
            Rectangle().fill(p.hairSoft.color).frame(height: 1)
            SettingsRow(label: "Theme", sub: Copy.themeNote) {
                Segmented([(ThemePreference.light, "Light", nil),
                           (.system, "System", nil),
                           (.dark, "Dark", nil)],
                          selection: s.themePref) { s.themePref = $0 }
                    .accessibilityLabel("Theme")
            }
        }
    }

    // MARK: Notifications

    private var notifications: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(s.notificationSettings.enumerated()), id: \.element.id) { i, setting in
                if i > 0 { Rectangle().fill(p.hairSoft.color).frame(height: 1) }
                SettingsRow(label: setting.title, sub: setting.subtitle) {
                    BlancSwitch(setting.title, isOn: Binding(
                        get: { s.notificationSettings[i].on },
                        set: { s.notificationSettings[i].on = $0 }
                    ))
                }
            }

            Text(Copy.vipHeading)
                .font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
                .foregroundStyle(p.ink3.color)
                .padding(.top, 24).padding(.bottom, 2)

            FlowRow(spacing: 8) {
                ForEach(s.vips, id: \.self) { name in
                    HStack(spacing: 7) {
                        Circle().fill(p.accent.color).opacity(0.85).frame(width: 6, height: 6)
                        Text(name)
                            .font(Typography.font(Typography.Size.control, Typography.Weight.semibold))
                            .foregroundStyle(p.ink.color)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .surface(Radius.pill, p.panel.color, .l0)
                }
            }
            .padding(.top, 12).padding(.bottom, 4)

            if !s.learnedDismissed { learnedCard }

            HStack(alignment: .top, spacing: 8) {
                Icon(.shield, 14).foregroundStyle(p.accentInk.color).padding(.top, 1)
                Text(s.notificationsPrivacyNote)
                    .blanc(BlancText(size: Typography.Size.label, weight: Typography.Weight.regular, leading: 1.5))
                    .foregroundStyle(p.ink2.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 20).padding(.bottom, 24)
        }
    }

    /// A learned pattern offered as a question, never applied silently.
    private var learnedCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 7) {
                Icon(.spark, 14).foregroundStyle(p.accentInk.color).padding(.top, 2)
                Text(s.learnedSuggestion)
                    .blanc(BlancText(size: Typography.Size.body, weight: Typography.Weight.regular, leading: 1.5))
                    .foregroundStyle(p.ink.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, 12)
            HStack(spacing: 7) {
                PillButton("Yes", kind: .primary) {
                    s.learnedDismissed = true
                    if !s.vips.contains("Petra Wyss") { s.vips.insert("Petra Wyss", at: 0) }
                    s.showToast("Petra Wyss added to VIP.")
                }
                PillButton("No") {
                    s.learnedDismissed = true
                    s.showToast("Dismissed — no more suggestions for Petra.")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 19).padding(.vertical, 17)
        .wash(Radius.panel, p.accentSoft.color)
        .padding(.top, 20).padding(.bottom, 8)
    }

    // MARK: Mailboxes

    private var mailboxes: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(s.mailboxes.enumerated()), id: \.element.id) { i, mb in
                if i > 0 { Rectangle().fill(p.hairSoft.color).frame(height: 1) }
                SettingsRow(label: mb.address, sub: mb.kind) {
                    Text(Copy.connected).blanc(.button).foregroundStyle(p.ink2.color)
                }
            }
            note(Copy.mailboxesNote)
        }
    }

    // MARK: Tags

    private var tags: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(TagID.allCases.enumerated()), id: \.element.id) { i, t in
                if i > 0 { Rectangle().fill(p.hairSoft.color).frame(height: 1) }
                SettingsRow(label: t.name, sub: "\(s.tagCount(t)) messages", leading: { TagDot(t) }) {
                    HStack(spacing: 6) {
                        PillButton("Rename", kind: .ghost, compact: true) {
                            s.showToast("Renaming tags lands with the labels backend.")
                        }
                        PillButton("Delete", kind: .ghost, compact: true) {
                            s.showToast("Deleting a tag never deletes mail — it lands with the labels backend.")
                        }
                    }
                }
            }
            note(Copy.tagsNote)
        }
    }

    private func note(_ t: String) -> some View {
        Text(t)
            .blanc(BlancText(size: Typography.Size.label, weight: Typography.Weight.regular, leading: 1.5))
            .foregroundStyle(p.ink3.color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2).padding(.bottom, 12)
    }
}

private struct NavRow: View {
    @Environment(\.palette) private var p
    @State private var hovering = false
    let title: String
    let isOn: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Typography.font(Typography.Size.control,
                                      isOn ? Typography.Weight.bold : Typography.Weight.regular))
                .foregroundStyle(isOn || hovering ? p.ink.color : p.ink2.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .modifier(NavRowBackground(isOn: isOn, hovering: hovering))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

private struct NavRowBackground: ViewModifier {
    @Environment(\.palette) private var p
    let isOn: Bool
    let hovering: Bool
    func body(content: Content) -> some View {
        if isOn { content.surface(Radius.item, p.panel.color, .l0) }
        else { content.wash(Radius.item, hovering ? p.tint.color : .clear) }
    }
}

private struct SettingsRow<Leading: View, Trailing: View>: View {
    @Environment(\.palette) private var p
    let label: String
    let sub: String
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing

    init(label: String, sub: String,
         @ViewBuilder leading: () -> Leading = { EmptyView() },
         @ViewBuilder trailing: () -> Trailing) {
        self.label = label; self.sub = sub; self.leading = leading(); self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 0) {
                Text(label).blanc(.settingsLabel).foregroundStyle(p.ink.color)
                Text(sub).blanc(.chip).foregroundStyle(p.ink2.color)
            }
            Spacer(minLength: 12)
            trailing
        }
        .padding(.vertical, 15).padding(.horizontal, 2)
    }
}
