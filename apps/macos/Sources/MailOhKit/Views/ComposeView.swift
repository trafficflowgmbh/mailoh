import SwiftUI

/// Compose — the AI draft sits *above* the editor as a proposal on its own tinted
/// surface, with the sources it was drafted from named underneath. It is never in
/// the editor until you put it there, and the send row says what state you are in.
public struct ComposeView: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let s: AppState
    @State private var editor = ""
    @State private var draftVisible = true
    @State private var shimmer = false
    @FocusState private var editorFocused: Bool

    public init(_ s: AppState) { self.s = s }

    public var body: some View {
        VStack(spacing: 0) {
            ViewHead("Compose")
            Scroller {
                VStack(alignment: .leading, spacing: 0) {
                    field("To", s.composeTo)
                    field("Subject", s.composeSubject)
                    if draftVisible { draftCard.padding(.top, 20).padding(.bottom, 18) }
                    TextEditor(text: $editor)
                        .font(Typography.font(Typography.Size.bodyL, Typography.Weight.regular))
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 150)
                        .padding(.horizontal, 16).padding(.vertical, 14)
                        .wash(Radius.input, p.canvas.color)
                        .hairline(p, radius: Radius.input)
                        .accentRing(p, radius: Radius.input, on: editorFocused)
                        .focused($editorFocused)
                        .padding(.top, 4)
                        .overlay(alignment: .topLeading) {
                            if editor.isEmpty {
                                Text(Copy.composePlaceholder)
                                    .blanc(.streamBody).foregroundStyle(p.ink2.color)
                                    .padding(.horizontal, 21).padding(.top, 18)
                                    .allowsHitTesting(false)
                            }
                        }
                    HStack(spacing: 12) {
                        PillButton("Send", kind: .primary) {
                            s.showToast(editor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        ? "Message is empty."
                                        : "Sending needs a connected mailbox — nothing left this device.")
                        }
                        Text(Copy.sendNote).blanc(.chip).foregroundStyle(p.ink2.color)
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 18).padding(.bottom, 20)
                }
                .padding(.horizontal, 28).padding(.top, 10).padding(.bottom, 24)
                .frame(maxWidth: Space.readerMax, alignment: .leading)
                .panel(p)
                .padding(.horizontal, Space.paneX)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(label).blanc(.chip).foregroundStyle(p.ink3.color)
                    .frame(width: 56, alignment: .leading)
                Text(value).blanc(.body).foregroundStyle(p.ink.color)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 10).padding(.horizontal, 2)
            Rectangle().fill(p.hairSoft.color).frame(height: 1)
        }
    }

    private var draftCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Icon(.spark, 12)
                Text(Copy.draftTag)
                    .font(Typography.font(Typography.Size.caption, Typography.Weight.heavy))
            }
            .foregroundStyle(p.accentInk.color)
            .padding(.bottom, 12)

            Text(s.composeDraft)
                .blanc(BlancText(size: Typography.Size.bodyL, weight: Typography.Weight.regular, leading: 1.65))
                .foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)
                .opacity(shimmer ? 0.2 : 1)

            HStack(spacing: 6) {
                Icon(.route, 12).foregroundStyle(p.accentInk.color)
                Text(s.composeGrounding)
                    .blanc(BlancText(size: Typography.Size.label, weight: Typography.Weight.regular, leading: 1.45))
                    .foregroundStyle(p.ink2.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .wash(Radius.pill, p.float.color.opacity(0.55))
            .padding(.top, 14)

            FlowRow(spacing: 7) {
                PillButton("Use draft", kind: .primary) {
                    editor = s.composeDraft
                    draftVisible = false
                    editorFocused = true
                    s.showToast("Draft moved to the editor.")
                }
                PillButton("Edit") {
                    editor = s.composeDraft
                    draftVisible = false
                    editorFocused = true
                }
                PillButton("Regenerate") {
                    withAnimation(motion(reduceMotion, .blancFast)) { shimmer = true }
                    Task {
                        try? await Task.sleep(for: .milliseconds(260))
                        withAnimation(motion(reduceMotion, .blancFast)) { shimmer = false }
                    }
                    s.showToast("Draft regenerated from the same sources.")
                }
                PillButton("Discard", kind: .ghost) {
                    draftVisible = false
                    s.showToast("Draft discarded.")
                }
            }
            .padding(.top, 16)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 22).padding(.vertical, 20)
        .wash(Radius.panel, p.accentSoft.color)
    }
}
