import SwiftUI

/// Search — one field, typo-tolerant, matching locally over everything the app
/// holds. The result count and the elapsed time are measured, not decorative: the
/// point of a local index is that it really is that fast.
public struct SearchView: View {
    @Environment(\.palette) private var p
    @Environment(\.compactLayout) private var compact
    let s: AppState
    @State private var query: String
    @State private var outcome: SearchOutcome = .empty
    @State private var elapsedMs: Double = 0
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var fieldFocused: Bool

    public init(_ s: AppState) {
        self.s = s
        _query = State(initialValue: s.initialSearchQuery)
    }

    public var body: some View {
        VStack(spacing: 0) {
            ViewHead("Search")
            Scroller {
                VStack(alignment: .leading, spacing: 0) {
                    field
                    switch outcome {
                    case .results(let hits, let fuzzy):
                        resultsHead(hits.count)
                        // `.search-cols{grid-template-columns:1fr}` below the breakpoint:
                        // the facets move under the results instead of squeezing them.
                        if compact {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(hits) { hit in
                                    HitRow(hit: hit, showFuzzy: fuzzy) { open(hit) }
                                }
                                FacetColumn(facets: s.facets(for: hits))
                            }
                        } else {
                            HStack(alignment: .top, spacing: 28) {
                                VStack(spacing: 6) {
                                    ForEach(hits) { hit in
                                        HitRow(hit: hit, showFuzzy: fuzzy) { open(hit) }
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                FacetColumn(facets: s.facets(for: hits)).frame(width: 180)
                            }
                        }
                    case .empty:
                        EmptyStateView(glyph: "🌫", title: Copy.searchEmptyTitle, sub: Copy.searchEmptySub)
                    case .easterEgg:
                        EmptyStateView(glyph: "🤍", title: Copy.searchEggTitle, sub: Copy.searchEggSub)
                    }
                }
                .frame(maxWidth: 740, alignment: .leading)
                .padding(.horizontal, compact ? 14 : Space.paneX)
                .frame(maxWidth: .infinity)
            }
        }
        .onAppear { fieldFocused = true; run(debounce: false) }
        .onChange(of: query) { _, _ in run(debounce: true) }
        .onDisappear { searchTask?.cancel() }
    }

    /// Debounced, and the scan itself runs off the main actor — the previous version
    /// ran a synchronous edit-distance pass over every word of every body on the UI
    /// actor, once per keystroke.
    private func run(debounce: Bool) {
        searchTask?.cancel()
        let q = query
        searchTask = Task {
            if debounce {
                try? await Task.sleep(for: .milliseconds(120))
                if Task.isCancelled { return }
            }
            let t0 = DispatchTime.now().uptimeNanoseconds
            let result = await s.searchOffActor(q)
            if Task.isCancelled { return }
            elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
            outcome = result
        }
    }

    private func open(_ hit: SearchHit) {
        guard let m = s.message(hit.id) else { return }
        switch m.place {
        case .ohbox: s.selectedOhboxID = m.id; s.route = .ohbox
        case .reads: s.streamReadsCur = m.id; s.requestScroll(.reads, to: m.id); s.route = .reads
        case .receipts: s.streamReceiptsCur = m.id; s.requestScroll(.receipts, to: m.id); s.route = .receipts
        }
    }

    private var field: some View {
        HStack(spacing: 11) {
            Icon(.search, 15).foregroundStyle(p.ink3.color)
            TextField(Copy.searchPlaceholder, text: $query)
                .textFieldStyle(.plain)
                .font(Typography.font(Typography.Size.prose, Typography.Weight.regular))
                .foregroundStyle(p.ink.color)
                .focused($fieldFocused)
            Kbd("↵")
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .surface(Radius.pill, p.panel.color, fieldFocused ? .l2 : .l1)
        .accentRing(p, radius: Radius.pill, on: fieldFocused)
        .accessibilityLabel("Search")
    }

    private func resultsHead(_ n: Int) -> some View {
        (Text("\(n) result\(n == 1 ? "" : "s")")
            .font(Typography.font(Typography.Size.bodyS, Typography.Weight.bold))
            .foregroundStyle(p.ink.color)
         + Text(String(format: " · %.0f ms · ", max(elapsedMs, 1)) + Copy.searchIndex)
            .foregroundStyle(p.ink2.color))
            .blanc(.meta)
            .monospacedDigit()
            .padding(.top, 16).padding(.bottom, 10).padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct HitRow: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false
    let hit: SearchHit
    let showFuzzy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(hit.who)
                        .font(Typography.font(Typography.Size.body, Typography.Weight.bold))
                        .foregroundStyle(p.ink.color)
                    Spacer(minLength: 8)
                    Text(hit.origin).blanc(.caption).monospacedDigit()
                        .foregroundStyle(p.ink3.color).fixedSize()
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    subjectText
                    if hit.fuzzy, showFuzzy, let term = matchedTerm {
                        Badge(Copy.fuzzyNote(term), kind: .ai)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18).padding(.vertical, 14)
            .modifier(HitBackground(hovering: hovering))
            .offset(y: hovering ? -1 : 0)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(motion(reduceMotion, .blancFast), value: hovering)
    }

    /// The word the fuzzy pass actually landed on, so the chip can name it.
    private var matchedTerm: String? {
        let words = hit.subject.split { !$0.isLetter && !$0.isNumber }.map { String($0).lowercased() }
        return words.first { editDistance($0, hit.matchTerm ?? "") <= 1 } ?? words.first
    }

    /// Highlight the matched substring the way `<mark>` does — an accent wash.
    @ViewBuilder private var subjectText: some View {
        if let term = hit.matchTerm, !term.isEmpty,
           let range = hit.subject.range(of: term, options: .caseInsensitive) {
            (Text(hit.subject[hit.subject.startIndex..<range.lowerBound])
             + Text(hit.subject[range]).foregroundStyle(p.accentInk.color)
             + Text(hit.subject[range.upperBound...]))
                .blanc(.body).foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(hit.subject).blanc(.body).foregroundStyle(p.ink.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct HitBackground: ViewModifier {
    @Environment(\.palette) private var p
    let hovering: Bool
    func body(content: Content) -> some View {
        if hovering { content.surface(Radius.row, p.float.color, .l2) }
        else { content }
    }
}

/// Facets derived from the actual hits — never a fixed list pretending to count.
private struct FacetColumn: View {
    @Environment(\.palette) private var p
    let facets: AppState.Facets

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !facets.senders.isEmpty {
                heading("From")
                ForEach(facets.senders, id: \.name) { f in
                    row(f.name, count: "×\(f.count)")
                }
            }
            if !facets.places.isEmpty {
                heading("Folder")
                ForEach(facets.places, id: \.self) { row($0, count: nil) }
            }
            if facets.hasAttachment {
                heading("Refine")
                row("Has attachment", count: nil)
            }
        }
        .padding(.top, 16)
    }

    private func heading(_ t: String) -> some View {
        Text(t).blanc(.railLabel).foregroundStyle(p.ink3.color)
            .padding(.top, 4).padding(.bottom, 6)
    }

    private func row(_ t: String, count: String?) -> some View {
        HStack(spacing: 8) {
            Text(t).blanc(.button).foregroundStyle(p.ink2.color)
            Spacer(minLength: 4)
            if let count {
                Text(count).blanc(.chip).monospacedDigit().foregroundStyle(p.ink3.color)
            }
        }
        .padding(.vertical, 3)
        .padding(.bottom, 2)
    }
}
