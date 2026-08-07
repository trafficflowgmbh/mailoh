import SwiftUI

/// THE ONE-TIME "TURN ON FILEVAULT" SHEET.
///
/// ohmail keeps a copy of the mailbox on this Mac so it reads without a connection, and that copy is
/// plaintext — nothing in the app encrypts it. FileVault is what protects it at rest, so on the first
/// Cloud sign-in of a Mac with FileVault off, this says so, once. It states the fact plainly and does
/// not overstate it: the copy is not encrypted on its own, and FileVault is the thing that fixes that.
///
/// Two ways out, and both dismiss for good — the model remembers it: open the system pane to turn
/// FileVault on, or leave it for now. **Both are closures the composition root supplies** — a view
/// under `Views/` reaches no system service itself, so opening the settings pane is the model's job,
/// not this file's.
struct FileVaultNudge: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact

    /// Open the system FileVault pane and dismiss. Supplied by the composition root.
    let onOpenSettings: () -> Void
    /// Leave it for now, dismissed for good.
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Turn on FileVault")
                .blanc(.heldTitle)
                .foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)

            Text("ohmail keeps a copy of your mail on this Mac so you can read it without a "
                 + "connection. That copy isn't encrypted on its own — FileVault encrypts the whole "
                 + "disk, so it can't be read if this Mac is lost or stolen. It's off right now.")
                .blanc(BlancText(size: Typography.Size.body, weight: Typography.Weight.regular, leading: 1.6))
                .foregroundStyle(p.ink2.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)

            HStack(spacing: 10) {
                PillButton("Open Security Settings", kind: .primary, action: onOpenSettings)
                PillButton("Not now", kind: .ghost, action: onDismiss)
            }
            .padding(.top, 18)
        }
        .frame(maxWidth: 460, alignment: .leading)
        .padding(.horizontal, 26).padding(.vertical, 24)
        .panel(p)
        .padding(compact ? 20 : 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(p.canvas.color.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Turn on FileVault")
    }
}
