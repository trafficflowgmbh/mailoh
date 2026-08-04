import SwiftUI

/// THE WINDOW WHEN THERE IS NO MAIL TO SHOW, AND WHY THERE IS NONE.
///
/// One panel, one title, one sentence, and — when there is something to press — one button. It is
/// deliberately not a spinner and not an illustration: every state that reaches this view is one
/// somebody may have to act on, and the only useful thing a screen can do about that is say what
/// happened in words that name the next step.
///
/// **Every string arrives as a value.** There is no copy in this file, which is the same rule
/// `EngineNoticeStrip` follows and it matters here for the same reason: the words this surface has
/// to be able to say include the names of environment variables and the supervisor's own reason
/// string, and a view that spelled either would be a second place to keep them right. They are
/// composed in `SourceSelection`, beside the states they describe.
struct EngineStateView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact

    let notice: EngineNoticeText
    /// Shown only when there is something to press. A button that re-attempts what has already
    /// failed four times is not an action, it is a way to be told the same thing again.
    var action: (label: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            panel
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, compact ? Space.deckCompact : Space.deck)
        .background(p.canvas.color.ignoresSafeArea())
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(notice.title)
                .blanc(compact
                       ? BlancText(size: Typography.Size.cardTitle, weight: Typography.Weight.bold,
                                   trackingEm: Typography.Tracking.title, leading: 1.3)
                       : .heldTitle)
                .foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)

            Text(notice.detail)
                .blanc(BlancText(size: Typography.Size.body, weight: Typography.Weight.regular,
                                 leading: 1.6))
                .foregroundStyle(p.ink2.color)
                .fixedSize(horizontal: false, vertical: true)
                // Wrapping is the point: these sentences name paths and variables, and a line that
                // truncated one would remove the only actionable thing on screen.
                .padding(.top, 8)

            if let action {
                PillButton(action.label, kind: .primary, action: action.run)
                    .padding(.top, 18)
            }
        }
        .frame(maxWidth: 460, alignment: .leading)
        .padding(.horizontal, 26).padding(.vertical, 24)
        .panel(p)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(notice.title)
    }
}
