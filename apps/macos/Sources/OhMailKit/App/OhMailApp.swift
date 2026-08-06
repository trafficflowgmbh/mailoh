import SwiftUI

/// The SwiftUI scene. Deliberately thin: one window, no toolbar (the design has
/// its own chrome — a rail and a floating dock), plus the standard macOS menu
/// commands the app can honestly service.
///
/// It used to build an `AppState` here, unconditionally. That single line was the whole of the
/// decision about what this app shows, and it always answered "the sample world" — so an install
/// with no mailbox, an install whose engine was missing and an install whose engine had died all
/// opened on nine invented messages. The decision now belongs to ``AppRootModel``, and this scene
/// owns that instead.
public struct OhMailApp: App {
    /// The one place the concrete mail source is named.
    ///
    /// `AppRootModel` takes a factory rather than importing `EngineSource`, so that the decision and
    /// the projection are separable — but somebody has to choose, and a composition root is what that
    /// somebody is. The two values it needs are the two the engine only has once it is serving: the
    /// pipe to send requests down, and the per-launch token that authenticates them. Neither exists
    /// before `ready`, which is exactly when this is called.
    ///
    /// Returning `nil` is a real answer and not a failure path — it means this build cannot draw the
    /// mailbox, and the window says so. It must never mean "show the sample world instead".
    @State private var root = AppRootModel(engineSource: { bridge in
        guard let transport = bridge.transport, let ready = bridge.ready else { return nil }
        return EngineSource(requester: transport, token: ready.sessionToken)
    })

    /// The self-updater, or `nil` when this process must not run one (a `swift run` build, a render
    /// check, the test bundle). Read once at launch off the bundle — the same reason the engine
    /// install is. When it is `nil` the "Check for Updates…" command is present but disabled, which
    /// tells the truth: this build cannot update itself.
    @State private var updater = UpdaterController.forCurrentProcess()

    public init() {}

    public var body: some Scene {
        Window("ohmail", id: "ohmail") {
            // 390pt is the floor the design is verified at (invariant #7), not 1040 —
            // the shell has a real compact layout below `Space.mobileMax`.
            AppRootView(root)
                .frame(minWidth: Space.minWidth, minHeight: Space.minHeight)
                // One continuous surface: the content runs up under a transparent,
                // dividerless titlebar with the traffic lights floating over the canvas.
                .background(UnifiedTitlebar())
        }
        // Transparent, full-size-content titlebar with no title and no bottom divider.
        // The traffic-light controls stay; `UnifiedTitlebar` finishes the job SwiftUI's
        // style leaves undone (the titlebar separator).
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .commands { OhMailCommands(state: root.mail, updater: updater) }
    }
}

/// Menu-bar commands mirror the in-app keyboard map, so the shortcuts are
/// discoverable without a cheat sheet.
///
/// **`state` is optional and the commands are disabled without it.** There is no mail on the setup
/// form or on a failed start, so "Go ▸ Ohbox" has nowhere to go. A greyed-out item says that; an
/// enabled one that silently does nothing does not, and one that conjured a state to act on would
/// be a second place mail could come from.
struct OhMailCommands: Commands {
    let state: AppState?
    /// The self-updater, when this build has one. `nil` on a `swift run` build or a render check, and
    /// the "Check for Updates…" item is disabled there rather than pretending it can act.
    var updater: UpdaterController? = nil

    private var idle: Bool { state == nil }

    var body: some Commands {
        // In the application menu, right after "About ohmail" — the standard home for this on macOS,
        // and it deliberately does NOT depend on `state`: a person can check for updates from the
        // setup form or a failed start, which is exactly when they might need a fix.
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { updater?.checkForUpdates() }
                .disabled(updater == nil)
        }
        CommandGroup(replacing: .newItem) {
            Button("New Message") { state?.route = .compose }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(idle)
        }
        CommandMenu("Go") {
            Button("Ohbox") { state?.route = .ohbox }
                .keyboardShortcut("1", modifiers: .command).disabled(idle)
            Button("Screener") { state?.route = .screener(.waiting) }
                .keyboardShortcut("2", modifiers: .command).disabled(idle)
            Button("Reads") { state?.route = .reads }
                .keyboardShortcut("3", modifiers: .command).disabled(idle)
            Button("Receipts") { state?.route = .receipts }
                .keyboardShortcut("4", modifiers: .command).disabled(idle)
            Button("Triage") { state?.route = .triage }
                .keyboardShortcut("5", modifiers: .command).disabled(idle)
            Divider()
            Button("Search") { state?.route = .search }
                .keyboardShortcut("f", modifiers: .command).disabled(idle)
            Button("Settings") { state?.route = .settings }
                .keyboardShortcut(",", modifiers: .command).disabled(idle)
        }
        CommandMenu("View") {
            Picker("Theme", selection: Binding(get: { state?.themePref ?? .system },
                                               set: { new in state?.themePref = new })) {
                Text("Light").tag(ThemePreference.light)
                Text("System").tag(ThemePreference.system)
                Text("Dark").tag(ThemePreference.dark)
            }
            .disabled(idle)
        }
    }
}
