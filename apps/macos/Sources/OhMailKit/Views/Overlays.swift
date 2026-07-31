import SwiftUI

/// ⌘K — a floating panel over a scrim, with ↑↓ to move and ↵ to run. Fuzzy
/// filtering means "gtr" finds "Go to Reads"; the keycaps on the right teach the
/// direct shortcut for next time, which is the whole point of a palette.
public struct CommandPalette: View {
    @Environment(\.palette) private var p
    let s: AppState
    let onClose: () -> Void

    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    public init(_ s: AppState, onClose: @escaping () -> Void) { self.s = s; self.onClose = onClose }

    private var items: [PaletteCommand] { s.filteredCommands(query) }

    public var body: some View {
        ZStack(alignment: .top) {
            p.scrim.color.ignoresSafeArea().onTapGesture { onClose() }
            panelBody
                .frame(width: 520)
                .padding(.top, 100)
        }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.return) { run(); return .handled }
        .onKeyPress(.escape) { onClose(); return .handled }
        // The deck underneath is already `accessibilityHidden` while this is up; the
        // modal trait tells VoiceOver why.
        .accessibilityAddTraits(.isModal)
    }

    private var panelBody: some View {
        VStack(spacing: 0) {
            TextField(Copy.paletteHint, text: $query)
                .textFieldStyle(.plain)
                .font(Typography.font(Typography.Size.prose, Typography.Weight.regular))
                .foregroundStyle(p.ink.color)
                .padding(.horizontal, 22).padding(.vertical, 16)
                .focused($focused)
                .onChange(of: query) { _, _ in selection = 0 }
            Rectangle().fill(p.hairSoft.color).frame(height: 1)

            ScrollViewReader { proxy in
                VScroll {
                    VStack(spacing: 0) {
                        if items.isEmpty {
                            Text(Copy.paletteEmpty).blanc(.body)
                                .foregroundStyle(p.ink3.color)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14).padding(.vertical, 9)
                        }
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, cmd in
                            // A real Button: `onTapGesture` gives VoiceOver no
                            // activation action, so the palette was mouse-only for
                            // anyone using assistive tech.
                            Button { onClose(); s.runCommand(cmd) } label: {
                                row(cmd, selected: i == clampedSelection)
                            }
                            .buttonStyle(.plain)
                            .id(i)
                            .accessibilityLabel(cmd.label)
                            .accessibilityAddTraits(i == clampedSelection ? [.isSelected] : [])
                        }
                    }
                    .padding(7)
                }
                .frame(maxHeight: 300)
                .onChange(of: clampedSelection) { _, i in
                    withAnimation(nil) { proxy.scrollTo(i, anchor: .bottom) }
                }
            }

            HStack(spacing: 12) {
                Hint(["↑", "↓"], "navigate")
                Hint(["↵"], "run")
                Hint(["esc"], "close")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .floatSurface(p, radius: Radius.card, lift: .l3)
        .clip(Radius.card)
        .onAppear { focused = true }
        .accessibilityLabel("Command palette")
    }

    private var clampedSelection: Int { min(selection, max(items.count - 1, 0)) }

    private func row(_ cmd: PaletteCommand, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Icon(cmd.icon == .tag ? .tag : .spark, 13)
                .foregroundStyle(selected ? p.accentInk.color : p.ink3.color)
            Text(cmd.label).blanc(.body).foregroundStyle(p.ink.color)
            Spacer(minLength: 8)
            HStack(spacing: 4) { ForEach(cmd.keys, id: \.self) { Kbd($0) } }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .wash(Radius.paletteItem, selected ? p.accentSoft.color : .clear)
        .contentShape(Rectangle())
    }

    private func move(_ d: Int) {
        guard !items.isEmpty else { return }
        selection = min(max(clampedSelection + d, 0), items.count - 1)
    }
    private func run() {
        guard !items.isEmpty else { return }
        let cmd = items[clampedSelection]
        onClose()
        s.runCommand(cmd)
    }
}

// MARK: - Tag picker

/// The tag picker — a small popover anchored to the chip that opened it. `↵`
/// toggles, so tagging is two keystrokes: `t` then return.
public struct TagPicker: View {
    @Environment(\.palette) private var p
    let s: AppState
    let messageID: String
    let onClose: () -> Void

    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    public init(_ s: AppState, messageID: String, onClose: @escaping () -> Void) {
        self.s = s; self.messageID = messageID; self.onClose = onClose
    }

    private var items: [TagID] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? TagID.allCases : TagID.allCases.filter { $0.name.lowercased().contains(q) }
    }

    public var body: some View {
        VStack(spacing: 0) {
            TextField("Tag this message…", text: $query)
                .textFieldStyle(.plain)
                .font(Typography.font(Typography.Size.control, Typography.Weight.regular))
                .padding(.horizontal, 16).padding(.vertical, 11)
                .focused($focused)
                .onChange(of: query) { _, _ in selection = 0 }
            Rectangle().fill(p.hairSoft.color).frame(height: 1)

            VStack(spacing: 0) {
                if items.isEmpty {
                    Text("No such tag — three exist in this preview.")
                        .blanc(.button).foregroundStyle(p.ink3.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 11).padding(.vertical, 8)
                }
                ForEach(Array(items.enumerated()), id: \.element.id) { i, t in
                    let on = s.tags(messageID).contains(t)
                    // A toggle, exposed as one: VoiceOver gets an activation action
                    // and hears whether the tag is on.
                    Button { s.toggleTag(messageID, t) } label: {
                        HStack(spacing: 9) {
                            TagDot(t)
                            Text(t.name).blanc(.button).foregroundStyle(p.ink.color)
                            Spacer(minLength: 6)
                            if on {
                                Icon(.check, 11).foregroundStyle(p.accentInk.color)
                            }
                        }
                        .padding(.horizontal, 11).padding(.vertical, 8)
                        .wash(Radius.menuItem, i == min(selection, items.count - 1) ? p.tint.color : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(t.name)
                    .accessibilityValue(on ? "on" : "off")
                    .accessibilityAddTraits(on ? [.isSelected] : [])
                }
            }
            .padding(6)

            Text("↵ toggles").blanc(.badge).foregroundStyle(p.ink3.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.top, 7).padding(.bottom, 9)
        }
        .frame(width: 240)
        .floatSurface(p, radius: Radius.input, lift: .l3)
        .clip(Radius.input)
        .onAppear { focused = true }
        .onKeyPress(.downArrow) { selection = min(selection + 1, max(items.count - 1, 0)); return .handled }
        .onKeyPress(.upArrow) { selection = max(selection - 1, 0); return .handled }
        .onKeyPress(.return) {
            if !items.isEmpty { s.toggleTag(messageID, items[min(selection, items.count - 1)]) }
            return .handled
        }
        .onKeyPress(.escape) { onClose(); return .handled }
        .accessibilityLabel("Add tag")
        .accessibilityAddTraits(.isModal)
    }
}

// MARK: - Toast

/// One line, centred low, with an Undo when there is something to undo. Every
/// destructive-feeling action in the app is reversible from here.
public struct ToastView: View {
    @Environment(\.palette) private var p
    let toast: ToastState
    let onAction: () -> Void

    public init(toast: ToastState, onAction: @escaping () -> Void) {
        self.toast = toast; self.onAction = onAction
    }

    public var body: some View {
        HStack(spacing: 12) {
            Text(toast.message).blanc(.button).foregroundStyle(p.ink.color)
                .multilineTextAlignment(.center)
            if let label = toast.actionLabel {
                Button(action: onAction) {
                    Text(label)
                        .font(Typography.font(Typography.Size.control, Typography.Weight.heavy))
                        .foregroundStyle(p.accentInk.color)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 9)
        .floatSurface(p, radius: Radius.pill, lift: .l2)
        .frame(maxWidth: 640)
        .accessibilityAddTraits(.isStaticText)
    }
}

// MARK: - Dock

/// The floating dock — the ⌘K affordance, the theme flip, and an About panel.
/// It fades away in reading mode, because reading mode is the one place where the
/// app should have no chrome at all.
public struct DockView: View {
    @Environment(\.palette) private var p
    let onPalette: () -> Void
    let onTheme: () -> Void
    let onAbout: () -> Void

    public init(onPalette: @escaping () -> Void, onTheme: @escaping () -> Void,
                onAbout: @escaping () -> Void) {
        self.onPalette = onPalette; self.onTheme = onTheme; self.onAbout = onAbout
    }

    public var body: some View {
        HStack(spacing: 2) {
            Button(action: onPalette) {
                HStack(spacing: 8) {
                    Text(Copy.command)
                        .font(Typography.font(Typography.Size.control, Typography.Weight.semibold))
                    Kbd("⌘K")
                }
                .foregroundStyle(p.ink2.color)
                .padding(.horizontal, 16).padding(.vertical, 7)
            }
            .buttonStyle(.plain)

            Rectangle().fill(p.hairSoft.color).frame(width: 1, height: 18)
                .padding(.horizontal, 3)

            QuietButton(size: 32, action: onTheme) { Icon(.sun, 15) }
                .help("Toggle light / dark")
            QuietButton(size: 32, action: onAbout) { Icon(.info, 15) }
                .help("About this preview")
        }
        .padding(5)
        .floatSurface(p, radius: Radius.pill, lift: .l3)
    }
}

/// About — states exactly what this build is and is not. Factual, and the one
/// place the app talks about itself.
public struct AboutPanel: View {
    @Environment(\.palette) private var p
    let onClose: () -> Void
    public init(onClose: @escaping () -> Void) { self.onClose = onClose }

    public var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Icon(.info, 14).foregroundStyle(p.accentInk.color)
                Text("ohmail for macOS")
                    .font(Typography.font(Typography.Size.body, Typography.Weight.heavy))
                    .foregroundStyle(p.ink.color)
                Spacer(minLength: 12)
                QuietButton(size: 28, action: onClose) { Icon(.x, 13) }
                    .accessibilityLabel("Close")
            }
            ForEach(paragraphs, id: \.self) { t in
                Text(t)
                    .blanc(BlancText(size: Typography.Size.control, weight: Typography.Weight.regular, leading: 1.62))
                    .foregroundStyle(p.ink2.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 22)
        .frame(width: 380, alignment: .leading)
        .floatSurface(p, radius: Radius.card, lift: .l3)
    }

    private var paragraphs: [String] {
        [
            "The free desktop tier, built on the Blanc design system: white panels on an off-white canvas, structure read from layered warm shadows instead of borders.",
            "This build runs on fixture data with no network — the IMAP sync engine wires in behind the same views. Nothing here leaves the device because there is nothing here to send.",
            "Keyboard: j / k to move, ↵ to read or expand, t to tag, / to search, c to compose, ⌘K for commands. In the Screener, y accepts the suggestion and o / r / c / n / x file directly (⇧ marks read).",
        ]
    }
}
