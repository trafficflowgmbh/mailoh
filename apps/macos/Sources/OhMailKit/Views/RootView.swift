import SwiftUI

/// The shell. A 16pt-inset deck of floating panels on the canvas: the rail, then
/// the routed view. Reading mode recedes the whole shell to 5% and floats the
/// message above it; every other overlay is a scrim plus one panel.
///
/// On the outer structure: Blanc's deck is a set of panels *inset on all four
/// sides* with a 16pt gutter between them. `NavigationSplitView` cannot express
/// that — its sidebar is flush to the window edge, full-height, and carries a
/// sidebar material plus a divider. Adopting it would trade away the design's
/// defining move (surfaces sculpted by light, floating on the canvas) for a
/// resize handle, so the deck is laid out directly and the two-pane geometry lives
/// in `SplitPane`. Rail · list · detail is intact; only the container differs.
///
/// **Compact (≤ `Space.mobileMax`, and clean down to 390pt).** The shell measures
/// itself and publishes `\.compactLayout`, which drives exactly the canonical
/// `@media (max-width:900px)` behaviour: a top bar appears, the rail becomes an
/// off-canvas drawer over a scrim, the deck goes single-column, the Ohbox shows its
/// list and opens mail in the reader, Reads/Receipts show the stream alone, and the
/// Screener shows its list with the decision pane presented full-screen.
public struct RootView: View {
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let s: AppState

    @State private var tagsOpen = true
    @State private var toastTask: Task<Void, Never>?
    @State private var visibleToast: ToastState?
    @FocusState private var shellFocused: Bool

    public init(_ s: AppState) { self.s = s }

    private var scheme: ColorScheme { s.effectiveScheme(system: systemScheme) }
    private var palette: Palette { Palette.of(scheme) }

    /// Any layer that owns the screen — the deck goes out of the accessibility
    /// tree while one is up, so VoiceOver cannot walk what the eye cannot reach.
    private var overlayOwnsScreen: Bool {
        s.isReading || s.isPaletteOpen || s.isFocusReplyOpen || s.tagPickerFor != nil
    }

    public var body: some View {
        GeometryReader { geo in
            let compact = geo.size.width <= Space.mobileMax
            shell(compact: compact)
                .environment(\.compactLayout, compact)
        }
        .environment(\.colorScheme, scheme)
        .environment(\.palette, palette)
        .preferredColorScheme(s.themePref == .system ? nil : scheme)
        .tint(palette.accent.color)
        .frame(minWidth: Space.minWidth, minHeight: Space.minHeight)
        .focusable()
        .focusEffectDisabled()
        .focused($shellFocused)
        .onAppear { shellFocused = true }
        .background { paletteShortcut }
        .onKeyPress(phases: .down) { handle($0) }
        .onChange(of: s.toast) { _, new in showToast(new) }
    }

    @ViewBuilder
    private func shell(compact: Bool) -> some View {
        ZStack {
            palette.canvas.color.ignoresSafeArea()

            content(compact: compact)
                .opacity(s.isReading ? 0.05 : 1)
                .scaleEffect(s.isReading ? 0.994 : 1)
                .allowsHitTesting(!s.isReading)
                .accessibilityHidden(overlayOwnsScreen)
                .animation(motion(reduceMotion, Motion.spring(Motion.Duration.shell)), value: s.isReading)

            if compact, s.isScreenerDetailOpen, case .screener(let seg) = s.route {
                screenerDetail(seg)
            }
            if compact { railDrawer }

            if s.isReading { readingMode }
            if s.isFocusReplyOpen { FocusReplySheet(s) { s.isFocusReplyOpen = false } }
            if s.isPaletteOpen { CommandPalette(s) { s.isPaletteOpen = false } }

            dockLayer(compact: compact)
            if let id = s.tagPickerFor { tagPickerLayer(id) }
            if s.isAboutOpen { aboutLayer }
            if let t = visibleToast { toastLayer(t) }
        }
    }

    // MARK: Deck

    @ViewBuilder
    private func content(compact: Bool) -> some View {
        VStack(spacing: 0) {
            if compact {
                TopBar(title: s.route.title,
                       onMenu: { withAnimation(motion(reduceMotion, .blancDrawer)) { s.isRailOpen = true } },
                       onSearch: { s.route = .search })
            }
            deck(compact: compact)
        }
    }

    @ViewBuilder
    private func deck(compact: Bool) -> some View {
        HStack(alignment: .top, spacing: Space.deck) {
            if !compact { RailView(s, tagsOpen: $tagsOpen) }
            // Top-anchored: routed views always fill the deck, so this is a no-op
            // interactively — but it keeps an oversized static render (the `--shot`
            // pass, where scrollers lay out at full height) pinned to its header
            // instead of centring and cutting the top off.
            routed.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .padding(.horizontal, compact ? Space.deckCompact : Space.deck)
        .padding(.bottom, compact ? Space.deckCompact : Space.deck)
        .padding(.top, compact ? 0 : Space.deck)
    }

    @ViewBuilder private var routed: some View {
        switch s.route {
        case .ohbox:
            OhboxView(s, onEnterReader: { s.isReading = true }, onTag: { s.tagPickerFor = $0 })
        case .reads: ReadsView(s)
        case .receipts: ReceiptsView(s)
        case .screener(let seg): ScreenerView(s, seg: seg)
        case .triage: TriageView(s)
        case .tag(let t): TagView(s, tag: t)
        case .search: SearchView(s)
        case .compose: ComposeView(s)
        case .settings: SettingsView(s)
        }
    }

    // MARK: Compact — the rail drawer

    @ViewBuilder private var railDrawer: some View {
        if s.isRailOpen {
            ZStack(alignment: .leading) {
                palette.scrim.color.ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(motion(reduceMotion, .blancDrawer)) { s.isRailOpen = false }
                    }
                    .accessibilityLabel("Close navigation")
                    .accessibilityAddTraits(.isButton)
                RailView(s, tagsOpen: $tagsOpen, inDrawer: true)
                    .frame(maxHeight: .infinity)
                    .padding(.vertical, 8)
                    .padding(.leading, 8)
                    .transition(.move(edge: .leading))
            }
            .transition(.opacity)
            .accessibilityAddTraits(.isModal)
        }
    }

    // MARK: Compact — the Screener's decision pane, full screen

    @ViewBuilder private func screenerDetail(_ seg: ScreenerSeg) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    s.isScreenerDetailOpen = false
                } label: {
                    HStack(spacing: 6) {
                        Icon(.chevron, 12).rotationEffect(.degrees(180))
                        Text(Copy.back)
                            .font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
                    }
                    .foregroundStyle(palette.ink2.color)
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 6)
            ScreenerPreview(s, seg: seg)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(palette.canvas.color.ignoresSafeArea())
        .transition(.move(edge: .trailing))
        .accessibilityAddTraits(.isModal)
    }

    // MARK: Reading mode — the exhale

    private var readingMode: some View {
        ZStack(alignment: .top) {
            palette.scrim.color.ignoresSafeArea()
                .onTapGesture { s.isReading = false }
            VScroll {
                if let m = s.selectedOhbox {
                    MessageView(s, m, inReader: true, onEnterReader: {}) { s.tagPickerFor = m.id }
                        .floatSurface(palette, radius: Radius.reader, lift: .l3)
                        .frame(maxWidth: Space.readerMax)
                        .padding(.horizontal, 24)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                        .padding(.bottom, 120)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            Hint(["esc"], "to return").padding(.top, 18)
        }
        .transition(.opacity)
        .accessibilityAddTraits(.isModal)
    }

    // MARK: Floating layers

    private func dockLayer(compact: Bool) -> some View {
        VStack {
            Spacer()
            DockView(
                onPalette: { s.isPaletteOpen.toggle() },
                onTheme: { s.themePref = scheme == .dark ? .light : .dark },
                onAbout: { s.isAboutOpen.toggle() }
            )
            .padding(.bottom, compact ? 32 : 18)
            .opacity(s.isReading ? 0 : 1)
            .offset(y: s.isReading ? 10 : 0)
            .allowsHitTesting(!s.isReading)
            .accessibilityHidden(overlayOwnsScreen)
            .animation(motion(reduceMotion, .blancSlide), value: s.isReading)
        }
    }

    private func tagPickerLayer(_ id: String) -> some View {
        ZStack {
            Color.clear.contentShape(Rectangle()).onTapGesture { s.tagPickerFor = nil }
            TagPicker(s, messageID: id) { s.tagPickerFor = nil }
        }
        .accessibilityAddTraits(.isModal)
    }

    private var aboutLayer: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                AboutPanel { s.isAboutOpen = false }
                    .padding(.trailing, 18).padding(.bottom, 64)
            }
        }
        .transition(.opacity)
    }

    private func toastLayer(_ t: ToastState) -> some View {
        VStack {
            Spacer()
            ToastView(toast: t) {
                // The toast's Undo runs the pending operation itself — exactly once,
                // because `undoPending()` clears it.
                s.toast = nil
                visibleToast = nil
                s.undoPending()
            }
            .padding(.bottom, 72)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
        .animation(motion(reduceMotion, .blancSlide), value: t.token)
    }

    private func showToast(_ new: ToastState?) {
        toastTask?.cancel()
        withAnimation(motion(reduceMotion, .blancSlide)) { visibleToast = new }
        guard let new else { return }
        // VoiceOver otherwise never learns that anything happened.
        AccessibilityNotification.Announcement(new.message).post()
        toastTask = Task {
            try? await Task.sleep(for: .milliseconds(new.actionLabel == nil ? 3200 : 6000))
            guard !Task.isCancelled else { return }
            withAnimation(motion(reduceMotion, .blancSlide)) { visibleToast = nil }
        }
    }

    /// ⌘K needs to fire while a text field owns the keyboard, so it rides a real
    /// `keyboardShortcut` rather than the key-press chain.
    private var paletteShortcut: some View {
        Button("") { s.isPaletteOpen.toggle() }
            .keyboardShortcut("k", modifiers: .command)
            .opacity(0)
            .accessibilityHidden(true)
    }

    // MARK: Keyboard map

    /// Global keys, then per-route keys. Text fields consume their own characters
    /// before this runs, so typing a `j` into Search never navigates a list.
    private func handle(_ press: KeyPress) -> KeyPress.Result {
        if press.key == .escape { return escape() }

        // Overlays own the keyboard while they are up.
        if s.isPaletteOpen || s.isFocusReplyOpen || s.tagPickerFor != nil { return .ignored }

        let ch = press.characters
        let shift = press.modifiers.contains(.shift)
        guard press.modifiers.subtracting(.shift).isEmpty else { return .ignored }

        if case .screener(let seg) = s.route, let r = screenerKey(ch, seg: seg, shift: shift) {
            return r
        }
        switch ch.lowercased() {
        case "/": s.route = .search; return .handled
        case "c" where !s.route.isScreener: s.route = .compose; return .handled
        default: break
        }
        switch s.route {
        case .ohbox: return ohboxKey(ch, press: press)
        case .reads, .receipts: return streamKey(ch, press: press)
        case .triage:
            if ch == "f" { s.startFocusReply(); return .handled }
        default: break
        }
        return .ignored
    }

    private func escape() -> KeyPress.Result {
        if s.tagPickerFor != nil { s.tagPickerFor = nil; return .handled }
        if s.isPaletteOpen { s.isPaletteOpen = false; return .handled }
        if s.isFocusReplyOpen { s.isFocusReplyOpen = false; return .handled }
        if s.isReading {
            withAnimation(motion(reduceMotion, Motion.spring(Motion.Duration.shell))) { s.isReading = false }
            return .handled
        }
        if s.isRailOpen {
            withAnimation(motion(reduceMotion, .blancDrawer)) { s.isRailOpen = false }
            return .handled
        }
        if s.isScreenerDetailOpen { s.isScreenerDetailOpen = false; return .handled }
        if s.isAboutOpen { s.isAboutOpen = false; return .handled }
        return .ignored
    }

    /// `y` accepts the suggestion; o / r / c / n / x file directly; ⇧ files as read.
    private func screenerKey(_ ch: String, seg: ScreenerSeg, shift: Bool) -> KeyPress.Result? {
        if ch == "j" || ch == "k" {
            s.moveScreenerSelection(seg, by: ch == "j" ? 1 : -1)
            return .handled
        }
        guard seg == .waiting else { return nil }
        guard let cur = s.currentWaiting else {
            if ch == "a" { s.applyAllSuggestions(); return .handled }
            if ch == "s" { s.markAllSpam(); return .handled }
            return nil
        }
        if ch.lowercased() == "y" {
            decide(cur, cur.ai.dest, read: shift || ch == "Y")
            return .handled
        }
        if let dest = Destination.allCases.first(where: { $0.key == ch.lowercased() }) {
            decide(cur, dest, read: shift || ch != ch.lowercased())
            return .handled
        }
        if ch == "a" { s.applyAllSuggestions(); return .handled }
        if ch == "s" { s.markAllSpam(); return .handled }
        return nil
    }

    private func decide(_ w: WaitingSender, _ d: Destination, read: Bool) {
        withAnimation(motion(reduceMotion, .blancSlide)) { _ = s.decide(w, to: d, read: read) }
    }

    private func ohboxKey(_ ch: String, press: KeyPress) -> KeyPress.Result {
        switch ch {
        case "j": s.moveOhboxSelection(by: 1); return .handled
        case "k": s.moveOhboxSelection(by: -1); return .handled
        case "t": s.tagPickerFor = s.selectedOhboxID; return .handled
        default: break
        }
        if press.key == .return {
            withAnimation(motion(reduceMotion, Motion.spring(Motion.Duration.shell))) { s.isReading = true }
            return .handled
        }
        return .ignored
    }

    /// j / k move **and scroll** the stream; ↵ expands or collapses the current
    /// card — both by driving state the stream reads, which is why the hint bar's
    /// promise is now true.
    private func streamKey(_ ch: String, press: KeyPress) -> KeyPress.Result {
        guard let place = s.route.place, !s.streamItems(for: place).isEmpty else { return .ignored }
        switch ch {
        case "j":
            withAnimation(motion(reduceMotion, .blancSlide)) { s.moveStreamSelection(place, by: 1) }
            return .handled
        case "k":
            withAnimation(motion(reduceMotion, .blancSlide)) { s.moveStreamSelection(place, by: -1) }
            return .handled
        default: break
        }
        if press.key == .return, let cur = s.streamCurrent(place) {
            withAnimation(motion(reduceMotion, .blancExpand)) { _ = s.toggleStreamExpanded(cur) }
            return .handled
        }
        return .ignored
    }
}

// MARK: - Compact top bar

/// `.topbar` — only exists below the breakpoint, where the rail is a drawer and
/// the route title has nowhere else to live.
struct TopBar: View {
    @Environment(\.palette) private var p
    let title: String
    let onMenu: () -> Void
    let onSearch: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onMenu) {
                HStack(spacing: 6) {
                    Icon(.menu, 14)
                    Text(Copy.menu).blanc(.chip)
                }
                .foregroundStyle(p.ink2.color)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .surface(Radius.pill, p.panel.color, .l0)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open navigation")

            Text(title)
                .blanc(BlancText(size: Typography.Size.bodyL, weight: Typography.Weight.heavy,
                                 trackingEm: Typography.Tracking.heading))
                .foregroundStyle(p.ink.color)
                .lineLimit(1)
            Spacer(minLength: 6)

            Button(action: onSearch) {
                HStack(spacing: 6) {
                    Icon(.search, 13)
                    Text("Search").blanc(.chip)
                }
                .foregroundStyle(p.ink2.color)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .surface(Radius.pill, p.panel.color, .l0)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
    }
}
