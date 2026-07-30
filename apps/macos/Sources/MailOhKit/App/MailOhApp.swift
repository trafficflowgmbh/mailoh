import SwiftUI

/// The SwiftUI scene. Deliberately thin: one window, no toolbar (the design has
/// its own chrome — a rail and a floating dock), plus the standard macOS menu
/// commands the app can honestly service.
public struct MailOhApp: App {
    @State private var state = AppState()

    public init() {}

    public var body: some Scene {
        Window("MailOh", id: "mailoh") {
            // 390pt is the floor the design is verified at (invariant #7), not 1040 —
            // the shell has a real compact layout below `Space.mobileMax`.
            RootView(state)
                .frame(minWidth: Space.minWidth, minHeight: Space.minHeight)
        }
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .defaultSize(width: 1440, height: 900)
        .commands { MailOhCommands(state: state) }
    }
}

/// Menu-bar commands mirror the in-app keyboard map, so the shortcuts are
/// discoverable without a cheat sheet.
struct MailOhCommands: Commands {
    let state: AppState

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Message") { state.route = .compose }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandMenu("Go") {
            Button("Ohbox") { state.route = .ohbox }.keyboardShortcut("1", modifiers: .command)
            Button("Screener") { state.route = .screener(.waiting) }.keyboardShortcut("2", modifiers: .command)
            Button("Reads") { state.route = .reads }.keyboardShortcut("3", modifiers: .command)
            Button("Receipts") { state.route = .receipts }.keyboardShortcut("4", modifiers: .command)
            Button("Triage") { state.route = .triage }.keyboardShortcut("5", modifiers: .command)
            Divider()
            Button("Search") { state.route = .search }.keyboardShortcut("f", modifiers: .command)
            Button("Settings") { state.route = .settings }.keyboardShortcut(",", modifiers: .command)
        }
        CommandMenu("View") {
            Picker("Theme", selection: Binding(get: { state.themePref },
                                               set: { state.themePref = $0 })) {
                Text("Light").tag(ThemePreference.light)
                Text("System").tag(ThemePreference.system)
                Text("Dark").tag(ThemePreference.dark)
            }
        }
    }
}
