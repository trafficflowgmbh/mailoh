import SwiftUI

/// The window, switched on ``AppRootModel/surface``.
///
/// It is a `switch` and nothing else on purpose. Every branch is a whole surface with its own view,
/// and none of them is a modified version of another — an app that showed the mailbox with an error
/// banner over it, or the setup form behind a spinner, would have states that are half of two things
/// and are properly neither.
///
/// The engine is started and stopped here rather than in the model's initialiser, because a lifetime
/// tied to a window is a lifetime the window can end. The engine's own defence does not depend on it
/// — closing the pipe is what asks it to leave, and the kernel closes the pipe even if this process
/// is killed — but a clean quit should still be a clean quit.
public struct AppRootView: View {
    @Environment(\.colorScheme) private var systemScheme

    let root: AppRootModel

    public init(_ root: AppRootModel) { self.root = root }

    public var body: some View {
        Group {
            switch root.surface {
            case .demo:
                // The sample world says what it is, permanently, in the one line above the deck.
                // Nothing here is anybody's mail and nothing behind it is running.
                mailSurface(AppRootModel.demoNotice)

            case .mail:
                mailSurface(root.mailNotice)
                    // The cloud mirror's reachability drives the offline read-only chrome. Bound to
                    // this surface's lifetime, so it stops when the mailbox is not on screen and is a
                    // no-op off the cloud door.
                    .task { await pollCloudHealth() }

            case .setup:
                SetupView(step: root.setupStep,
                          provider: root.chosenProvider,
                          problem: root.passwordProblem,
                          submitting: root.submittingPassword,
                          cloudSubmitting: root.submittingCloud,
                          onChooseDoor: { root.chooseDoor($0) },
                          onChooseProvider: { root.chooseProvider($0) },
                          onReconsider: { root.reconsiderDoor() },
                          onSaveMailbox: { root.saveMailbox($0) },
                          onSubmitPassword: { password in
                              Task { await root.submitPassword(password) }
                          },
                          onSubmitCloudSignIn: { email, password, code in
                              Task { await root.submitCloudSignIn(email: email, password: password, code: code) }
                          },
                          onBack: { root.dismissSetupFailure() })
                    .blancTheme()

            case .engineState(let notice):
                EngineStateView(notice: notice).blancTheme()
            }
        }
        .frame(minWidth: Space.minWidth, minHeight: Space.minHeight)
        .onAppear {
            root.begin()
            root.materialize()
        }
        .onDisappear { root.end() }
        // The engine changes state on its own thread and hops to this actor; every one of those
        // hops can be the moment a source becomes buildable.
        .onChange(of: root.surface) { _, _ in root.materialize() }
    }

    /// Poll `/health` while the cloud mailbox is on screen. Off the cloud door this returns at once;
    /// the model's own guard means door one never sends the probe. The five-second cadence is a
    /// reachability hint, not a heartbeat — the sidecar's 503 is what actually stops a write offline.
    private func pollCloudHealth() async {
        guard root.door == .cloud else { return }
        while !Task.isCancelled {
            await root.refreshCloudOnline()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    @ViewBuilder
    private func mailSurface(_ notice: EngineNoticeText?) -> some View {
        if let mail = root.mail {
            RootView(mail, notice: notice)
        } else {
            // Not the sample world. A surface that says it has mail and has none is a bug worth
            // seeing, and the invented world is what hides it.
            EngineStateView(notice: AppRootModel.noProjection).blancTheme()
        }
    }
}
