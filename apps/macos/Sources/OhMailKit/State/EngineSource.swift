import Foundation
import OhMailEngine

/// A request/response round trip to the local engine.
///
/// Declared here rather than taken as a concrete `EngineTransport` for one reason: it is the seam
/// a test drives without a child process. `EngineTransport` conforms to it below with no adapter —
/// its `send` already has this exact signature, because it was shaped as the one `URLSession`
/// would have given a caller.
public protocol EngineRequesting: Sendable {
    func send(_ request: URLRequest) async throws -> (HTTPURLResponse, Data)
}

extension EngineTransport: EngineRequesting {}

/// What it takes to take an applied intent back.
///
/// **Declared here and implemented nowhere yet, deliberately.** Undo against a mailbox is a
/// forward request — `MailSource.swift` is explicit that keeping a copy of the world and writing
/// it back "works perfectly against fixtures and is a lie against a mailbox" — so the inverse of a
/// decision is a sequence of moves, a rule to revoke and a read state to restore, each of which
/// can fail out loud. That is a slice of its own, and it lands in `EngineUndo.swift`.
///
/// Until it does, ``EngineSource`` mints no receipts at all. That is the honest arrangement rather
/// than a gap: `IntentAck.receipt` is `nil` for anything the source cannot take back, and a `nil`
/// receipt is precisely how the shell knows not to offer an Undo it would have to withdraw.
@MainActor
public protocol EngineUndo: AnyObject {
    /// Whether this receipt names something that can still be reversed.
    func canReverse(_ receipt: Receipt) -> Bool
    func reverse(_ receipt: Receipt) async -> IntentOutcome
}

/// The stand-in until the undo slice lands. It refuses everything, with a reason, and it refuses
/// it out loud rather than by doing nothing.
@MainActor
public final class EngineUndoUnimplemented: EngineUndo {
    public init() {}
    public func canReverse(_ receipt: Receipt) -> Bool { false }
    public func reverse(_ receipt: Receipt) async -> IntentOutcome {
        .refused(SourceFailure(
            kind: .unsupported,
            reason: "That change cannot be taken back yet.",
            isRetryable: false))
    }
}

/// THE MAILBOX, BEHIND THE SEAM.
///
/// It speaks the same REST routes the web client's adapter speaks — `GET /sync`, `GET
/// /messages/:id/body`, `PATCH /messages`, `GET /mailboxes` — over the frame transport instead of
/// a socket, authenticated with the per-launch bearer from the engine's `ready` frame. There is no
/// second protocol and no second projection: the mapping from those responses to a `MailWorld` is
/// `EngineProjection`, and it is pure.
///
/// ── THE WORLD IS READ WHOLE EVERY CYCLE ──────────────────────────────────────────────────────
///
/// `since=0`, drained to the end, mirror rebuilt, world re-projected. `MailSource.swift` ruled it,
/// and the reason is worth restating: a delta/cursor protocol here would be a second implementation
/// of the client protocol in a second language, and the first one is 800 lines with its own test
/// suite. When somebody measures a mailbox where this is too slow, that measurement is the
/// argument for changing it.
///
/// ── WHY `apply` ANSWERS BEFORE THE MAILBOX DOES ──────────────────────────────────────────────
///
/// The seam's `apply` is synchronous and the engine is a pipe away, so the ack it returns is what
/// this source can say AT THAT INSTANT — computed from the mirror, which is itself the engine's
/// last word. It is not a guess about the future: for the one write this slice performs, "was this
/// message unread a moment ago" is exactly what `affected` means, and the shell announces on it.
///
/// The mailbox's own answer arrives afterwards, and it is the one the tests assert:
/// ``perform(_:)`` returns the ack built from the engine's response — the engine's before-state
/// from `/sync` against the engine's after-state from the `PATCH` echo. Every mutation is followed
/// by a re-drain, so the world on screen is never the optimistic one for longer than a round trip,
/// and a write the mailbox refuses reverts by the same path a write it accepted lands by.
///
/// Writes are SERIAL. Two marks in flight at once would race their own re-drains and the later
/// world could be built from the earlier read.
@MainActor
public final class EngineSource: MailSource {

    private let requester: any EngineRequesting
    private let token: Secret
    private let baseURL: URL
    private let clock: () -> Date

    /// Whether a cycle RESUMES from where the last one stopped, or re-reads the world whole.
    ///
    /// False over the pipe (the default), where a full drain from `since=0` every cycle is what
    /// `MailSource.swift` ruled and costs nothing — the engine is a memcpy away. True for door two,
    /// where the same drain re-downloads the whole hosted mailbox on every poll over HTTPS. When true,
    /// the projection is kept across cycles and each cycle asks only for the deltas past ``cursor``.
    private let incremental: Bool
    /// The high-water `/sync` cursor, retained across cycles when ``incremental``. In memory only: the
    /// session is re-minted per launch (there is no persisted mirror to resume a disk cursor against,
    /// and a cursor ahead of an empty projection would silently hide every message before it).
    private var cursor = "0"

    private var projection = EngineProjection()
    private var index = EngineIndex()
    private var identity = EngineIdentity()
    private var bodies: [String: BodyState] = [:]
    private var world = MailWorld()
    private weak var sink: (any MailSourceSink)?
    private var queue: Task<Void, Never>?

    /// How an applied intent is taken back. See ``EngineUndo`` — nothing is implemented yet, and
    /// this source therefore mints no receipts.
    public var undo: any EngineUndo = EngineUndoUnimplemented()

    /// Pages of `/sync` one cycle will read before it stops.
    ///
    /// A bound rather than a `while (hasMore)`, because an engine that answered `hasMore: true`
    /// forever — a cursor bug, a clock going backwards — would otherwise be an app that never
    /// finishes opening and never says why. At the page sizes this endpoint serves, the cap is far
    /// past any real mailbox; reaching it is a failure, and it is reported as one.
    static let maxPagesPerCycle = 200

    public init(requester: any EngineRequesting,
                token: Secret,
                baseURL: URL = URL(string: "http://sidecar")!,
                incremental: Bool = false,
                clock: @escaping () -> Date = Date.init) {
        self.requester = requester
        self.token = token
        self.baseURL = baseURL
        self.incremental = incremental
        self.clock = clock
    }

    // MARK: - MailSource

    /// Whatever has been projected so far — an empty world before the first drain lands, which
    /// together with the `.syncing` that `start` returns says "still loading" without blocking.
    public func openingWorld() -> MailWorld { world }

    @discardableResult
    public func start(sink: any MailSourceSink) -> SyncState {
        self.sink = sink
        enqueue { [weak self] in
            await self?.readIdentity()
            await self?.readWorld(announcing: true)
        }
        return .syncing(SyncActivity(what: "Opening your mailbox"))
    }

    public func bodyState(for id: String, in place: Place) -> BodyState {
        bodies[id] ?? .notFetched
    }

    /// Ask for a body. Returns immediately; the answer arrives through the sink.
    ///
    /// On explicit intent only — a selection, an expand — and never pile-wide: the route reads the
    /// stored body of one message, and prefetching a whole stream would be this client deciding to
    /// spend on somebody's behalf.
    public func requestBody(for id: String, in place: Place) {
        switch bodies[id] {
        case .fetching, .available: return   // already in hand or already asked
        case nil, .notFetched, .failed: break
        }
        bodies[id] = .fetching
        sink?.bodyDidChange(id: id, in: place, to: .fetching)
        enqueue { [weak self] in await self?.readBody(id, in: place) }
    }

    @discardableResult
    public func apply(_ intent: MailIntent) -> IntentOutcome {
        switch intent {
        case .markSeen(let id):
            // The mirror's answer, now — and it is the engine's own last word about this message,
            // not a local edit the shell made. Zero when the message is already seen, which is a
            // legitimate answer and the one the shell must not announce a change for.
            let wasUnread = index.unreadByID[id] ?? false
            if wasUnread, projection.setUnread(id, false) { reproject() }
            enqueue { [weak self] in _ = await self?.markSeen(id, before: wasUnread) }
            // NO RECEIPT. Nothing this source does can be taken back yet, and a receipt handed out
            // here would put an Undo in front of the reader that the source would then refuse.
            return .applied(IntentAck(affected: wasUnread ? 1 : 0, createdIDs: [], receipt: nil))

        case .reverse(let receipt):
            guard undo.canReverse(receipt) else {
                return .refused(SourceFailure(
                    kind: .unsupported,
                    reason: "That change is no longer on record — it cannot be taken back.",
                    isRetryable: false))
            }
            enqueue { [weak self] in _ = await self?.undo.reverse(receipt) }
            return .applied(IntentAck())

        default:
            return .refused(Self.notWired(intent))
        }
    }

    // MARK: - The engine's own answer

    /// The same work ``apply(_:)`` dispatches, awaited — and the ack is the MAILBOX'S, built from
    /// the response rather than from the mirror. This is what a test asserts on, because "the
    /// engine said nothing moved" and "we believed nothing would move" are different claims and
    /// only one of them is evidence.
    @discardableResult
    public func perform(_ intent: MailIntent) async -> IntentOutcome {
        switch intent {
        case .markSeen(let id):
            return await markSeen(id, before: index.unreadByID[id] ?? false)
        case .reverse(let receipt):
            guard undo.canReverse(receipt) else {
                return .refused(SourceFailure(
                    kind: .unsupported,
                    reason: "That change is no longer on record — it cannot be taken back.",
                    isRetryable: false))
            }
            return await undo.reverse(receipt)
        default:
            return .refused(Self.notWired(intent))
        }
    }

    /// Read the whole world again and push it. Exposed so a caller — a test, or a refresh
    /// gesture — can wait for a cycle rather than sleep for one.
    public func refresh() async {
        await readWorld(announcing: true)
    }

    /// Wait for everything already dispatched. A test's alternative to a sleep.
    public func settle() async {
        await queue?.value
    }

    // MARK: - Reading

    private func readIdentity() async {
        // Identity, once. Not part of the per-cycle read: a second whole read per cycle is a second
        // snapshot taken at a different instant, and mail truth and account truth disagreeing by one
        // instant is how a sender shows up in two lists at the same time.
        guard let (status, data) = try? await get("/mailboxes"), (200..<300).contains(status) else { return }
        guard let list = try? JSONDecoder().decode(WireMailboxList.self, from: data) else { return }
        identity = EngineIdentity.from(list)
    }

    /// One cycle. Over the pipe: drain `/sync` from the beginning, rebuild the mirror, re-project. Over
    /// HTTPS (``incremental``): resume from ``cursor`` and apply the deltas onto the mirror already in
    /// hand, so a poll costs a page of changes rather than the whole mailbox again.
    ///
    /// - Parameter announcing: whether the reader is told a sync is running. False for the drain
    ///   that follows a write, where the status strip narrating a mark-as-read would be chrome.
    private func readWorld(announcing: Bool) async {
        if announcing { sink?.syncStateDidChange(.syncing(SyncActivity(what: "Reading your mailbox"))) }

        // Incremental keeps the accumulated mirror and starts where the last cycle stopped; a full
        // drain starts empty from `since=0`. `working` is a value copy either way, so a cycle that
        // fails part-way is discarded whole and the previous world stands.
        var working = incremental ? projection : EngineProjection()
        var mark = incremental ? cursor : "0"
        var pages = 0
        while true {
            let response: (status: Int, data: Data)
            do {
                response = try await get("/sync?since=\(mark.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? mark)")
            } catch {
                sink?.syncStateDidChange(.failed(Self.transportFailure(error)))
                return
            }
            guard (200..<300).contains(response.status) else {
                sink?.syncStateDidChange(.failed(Self.failure(status: response.status, body: response.data)))
                return
            }
            guard let page = try? JSONDecoder().decode(WireSyncResponse.self, from: response.data) else {
                sink?.syncStateDidChange(.failed(SourceFailure(
                    kind: .server,
                    reason: "The mailbox sent mail this version of ohmail could not read.",
                    isRetryable: false)))
                return
            }
            working.apply(page)
            pages += 1
            // Advance ON EVERY page, the last one included: `cursor` is the high-water mark the NEXT
            // cycle resumes from, so dropping the final page's cursor would re-fetch it forever.
            mark = page.cursor
            guard page.hasMore else { break }
            guard pages < Self.maxPagesPerCycle else {
                // Said out loud rather than served as a partial mailbox that looks complete.
                sink?.syncStateDidChange(.failed(SourceFailure(
                    kind: .server,
                    reason: "The mailbox kept sending mail without ever finishing. "
                        + "Some of it is not shown.",
                    isRetryable: true)))
                return
            }
        }

        projection = working
        if incremental { cursor = mark }
        reproject()
        sink?.syncStateDidChange(.idle(lastCompleted: clock()))
    }

    private func readBody(_ id: String, in place: Place) async {
        let state: BodyState
        do {
            let (status, data) = try await get("/messages/\(Self.escape(id))/body")
            if (200..<300).contains(status), let body = try? JSONDecoder().decode(WireBody.self, from: data) {
                // Stored exactly as it arrived. The text is already sensitivity-redacted by the
                // engine, and a second redaction here would be a second place for that rule to be
                // wrong. `html` is deliberately not rendered by this shell — see the report.
                state = .available(body.text)
            } else {
                state = .failed(Self.failure(status: status, body: data))
            }
        } catch {
            state = .failed(Self.transportFailure(error))
        }
        bodies[id] = state
        sink?.bodyDidChange(id: id, in: place, to: state)
        reproject()
    }

    // MARK: - Writing

    /// `PATCH /messages { ids, unread: false }`.
    ///
    /// ── HOW `affected` IS COUNTED, AND WHY IT IS NOT `items.count` ───────────────────────────
    ///
    /// The route answers one DTO per id ALWAYS — it sets an end state rather than toggling one, so
    /// a message that was already seen comes back in `items` exactly like one that was not.
    /// Counting the array would report that something moved every single time, and the shell
    /// announces on this number.
    ///
    /// So it is a comparison of two engine facts: the read state the last `/sync` reported for this
    /// id, against the read state this response carries for it. Both sides come from the mailbox;
    /// neither is a local assumption. Marking an already-seen message seen therefore answers 0, and
    /// the request is still SENT — a source that decided locally not to ask would be reporting its
    /// own belief as the mailbox's answer, which is the thing this method exists to avoid.
    private func markSeen(_ id: String, before: Bool) async -> IntentOutcome {
        let outcome: IntentOutcome
        do {
            let (status, data) = try await patch("/messages", body: ["ids": [id], "unread": false])
            if (200..<300).contains(status) {
                let result = (try? JSONDecoder().decode(WireMarkSeenResult.self, from: data))
                    ?? WireMarkSeenResult()
                let moved = result.items.filter { $0.unread != before }.count
                outcome = .applied(IntentAck(affected: moved, createdIDs: [], receipt: nil))
            } else {
                outcome = .refused(Self.failure(status: status, body: data))
            }
        } catch {
            outcome = .refused(Self.transportFailure(error))
        }
        // ON A REFUSAL, PUT THE OPTIMISTIC EDIT BACK BEFORE RECONCILING.
        //
        // A full drain (the pipe) rebuilds the mirror from `since=0`, so a refused write self-heals —
        // the reverted state is read back from source. An INCREMENTAL drain (HTTPS) keeps the mirror
        // and applies only new deltas, and a refusal produces none, so the optimistic `setUnread` from
        // `apply(.markSeen)` would otherwise stand. Restoring `before` here makes the reconciliation
        // "a refused write reverts by the same path an accepted one lands by" true in both modes: the
        // restore is discarded by the full drain (harmless) and is what the incremental drain keeps.
        if case .refused = outcome, projection.setUnread(id, before) { reproject() }
        // The drain is the reconciliation: it replaces the optimistic world with the mailbox's on
        // success, and confirms the restored state on a refusal. One path, so a refused write cannot
        // leave the screen claiming the write happened.
        await readWorld(announcing: false)
        return outcome
    }

    // MARK: - Intents with no wire

    /// Everything this slice does not speak, refused with a sentence rather than swallowed.
    ///
    /// A refusal reaches the reader as a toast and leaves the mail where it is. Doing nothing
    /// quietly would leave a control that appears to work and does not — which is how a fully built
    /// tag UI once shipped against a wire that had no vocabulary for a tag.
    static func notWired(_ intent: MailIntent) -> SourceFailure {
        let what: String
        switch intent {
        case .decide: what = "Filing a sender from the Screener"
        case .allow: what = "Releasing a screened-out sender's mail"
        case .notSpam: what = "Moving mail out of Spam"
        case .deleteSpam: what = "Deleting spam"
        case .setScope: what = "Changing a rule's scope"
        case .setTag: what = "Tagging"
        case .addToPile, .removeFromPile: what = "Triage"
        case .saveDraft: what = "Saving a draft"
        case .addVIP: what = "Adding a VIP"
        case .setNotification: what = "Changing notifications"
        case .markSeen, .reverse: what = "That"
        }
        return SourceFailure(
            kind: .unsupported,
            reason: "\(what) is not connected to your mailbox in this build, so nothing was changed.",
            isRetryable: false)
    }

    // MARK: - Projection

    private func reproject() {
        let projected = projection.world(bodies: bodies, identity: identity, now: clock())
        world = projected.world
        index = projected.index
        sink?.worldDidChange(world)
    }

    // MARK: - Requests

    private func get(_ path: String) async throws -> (status: Int, data: Data) {
        try await send("GET", path, body: nil)
    }

    private func patch(_ path: String, body: [String: Any]) async throws -> (status: Int, data: Data) {
        try await send("PATCH", path, body: body)
    }

    private func send(_ method: String, _ path: String, body: [String: Any]?) async throws -> (status: Int, data: Data) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw EngineWireError("\(path) is not a usable address")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // The per-launch bearer, exposed at the one line that has to write it and nowhere else.
        // It travels on a pipe only this process holds; `Secret` is what keeps it out of every log
        // line and crash report in between.
        request.setValue("Bearer \(token.expose())", forHTTPHeaderField: "authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (response, data) = try await requester.send(request)
        return (response.statusCode, data)
    }

    /// Serial. One write and its re-drain finish before the next starts, so a later world can never
    /// be built from an earlier read.
    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = queue
        queue = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    // MARK: - Failures, with the engine's own words

    static func failure(status: Int, body: Data) -> SourceFailure {
        let envelope = try? JSONDecoder().decode(WireErrorEnvelope.self, from: body)
        let stated = envelope?.message?.trimmingCharacters(in: .whitespacesAndNewlines)
        let kind: SourceFailure.Kind
        switch status {
        case 401, 403: kind = .authentication
        case 404: kind = .server
        case 501: kind = .unsupported
        default: kind = .server
        }
        // The engine's own sentence when it wrote one. A seam that could only report a status code
        // forces every surface to invent copy, and invented copy is how an app tells somebody their
        // mailbox is empty when the truth is that the password expired.
        let reason = (stated?.isEmpty == false ? stated : nil)
            ?? "Your mailbox could not be reached (the local engine answered \(status))."
        return SourceFailure(kind: kind,
                             reason: reason,
                             isRetryable: envelope?.retryable ?? (status >= 500 || status == 429))
    }

    static func transportFailure(_ error: Error) -> SourceFailure {
        SourceFailure(kind: .network,
                      reason: "The local engine stopped answering (\(error)).",
                      isRetryable: true)
    }

    static func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}

