import SwiftUI

/// The loud empty hole.
///
/// One line at the top of the deck when the local engine did not start, naming what is missing.
/// It draws nothing when the engine is fine, so the ordinary window is unchanged.
///
/// **Every string it shows arrives as a value.** There is not a literal in this file, which is the
/// same rule the rest of `Views/` follows for mail — and it matters more here, because the words
/// this strip has to be able to say are the names of environment variables, and a view that spelled
/// one would be a second place to keep them right.
struct EngineNoticeStrip: View {
    @Environment(\.palette) private var p

    let notice: EngineNoticeText

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(notice.title)
                .blanc(.settingsLabel)
                .foregroundStyle(p.ink.color)
            Text(notice.detail)
                .blanc(.meta)
                .foregroundStyle(p.ink2.color)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wash(Radius.item, p.accentSoft.color)
        .hairline(p, radius: Radius.item, soft: true)
        .accessibilityElement(children: .combine)
    }
}
