import SwiftUI

/// **How the no-collapse rule is checked against the view, not the model.**
///
/// Every view that renders one piece of mail — a list row, a stream card, a held-mail
/// card, a message inside a thread — reports the identity it is rendering into a
/// `RenderLog`. The log is only attached when `Smoke` or a test attaches one, so the
/// shipping app pays nothing.
///
/// Because the report happens while the wrapper's `body` is evaluated, the log ends
/// up holding exactly the identities the view actually built. Comparing that against
/// `AppState.renderManifest(_:)` catches the thing an assertion over a model array
/// cannot: a view that iterates `items.prefix(3)` and draws a "12 more" placeholder
/// still has a correct model, but only reports three identities.
///
/// Two earlier attempts are worth recording, because both looked right and neither
/// worked: the offscreen **accessibility tree** exposes nothing at all without an
/// attached accessibility client, and a **`ViewModifier`** whose `body(content:)`
/// returns its content unchanged is elided by SwiftUI — the body is never called.
/// A plain `View` wrapper is the form whose body actually runs.
public final class RenderLog: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String] = []

    public init() {}

    public func record(_ id: String) {
        lock.lock(); ids.append(id); lock.unlock()
    }
    public var recorded: [String] {
        lock.lock(); defer { lock.unlock() }
        return ids
    }
    public func reset() {
        lock.lock(); ids.removeAll(); lock.unlock()
    }

    /// Identities the route promised but the view never built.
    public static func missing(expected: [String], rendered: [String]) -> [String] {
        let seen = Set(rendered)
        return expected.filter { !seen.contains($0) }
    }
}

private struct RenderLogKey: EnvironmentKey {
    static let defaultValue: RenderLog? = nil
}

public extension EnvironmentValues {
    /// Non-nil only under `--smoke` / tests.
    var renderLog: RenderLog? {
        get { self[RenderLogKey.self] }
        set { self[RenderLogKey.self] = newValue }
    }
}

/// A wrapper — deliberately a `View` and not a `ViewModifier` — that reports the
/// mail identity its content renders.
public struct RenderRecorded<Content: View>: View {
    @Environment(\.renderLog) private var log
    let id: String
    @ViewBuilder let content: Content

    public init(id: String, @ViewBuilder content: () -> Content) {
        self.id = id; self.content = content()
    }

    public var body: some View {
        // Instrumentation, not state: `RenderLog` is a plain class, so recording
        // here cannot invalidate the view or loop.
        log?.record(id)
        return content
    }
}

public extension View {
    /// Report that this view is rendering the mail identified by `id`.
    func recordRender(_ id: String) -> some View { RenderRecorded(id: id) { self } }
}
