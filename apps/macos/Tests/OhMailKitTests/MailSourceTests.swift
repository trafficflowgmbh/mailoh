import XCTest
@testable import OhMailKit

/// The seam, driven by a source that is not the fixtures.
///
/// The point of these is that the boundary is load-bearing rather than decorative.
/// A protocol nothing but one implementation has ever been behind is a protocol
/// shaped like that implementation, so each test here asks for something fixtures
/// can never do: a sync still running, a body that has not arrived, an intent
/// refused with a reason, an undo the source declines to perform.
@MainActor
final class MailSourceTests: XCTestCase {

    // MARK: - A source that is not the fixture world

    /// Records what the shell asked for and answers however a test tells it to.
    final class StubSource: MailSource {
        var world: MailWorld
        var syncOnStart: SyncState = .idle(lastCompleted: nil)
        /// When set, every `apply` returns this instead of doing anything.
        var refuseWith: SourceFailure?
        var bodies: [String: BodyState] = [:]

        private(set) var received: [MailIntent] = []
        private(set) var bodyRequests: [String] = []
        private weak var sink: (any MailSourceSink)?
        private var seq = 0

        init(world: MailWorld = .oneMessage) { self.world = world }

        func openingWorld() -> MailWorld { world }

        @discardableResult
        func start(sink: any MailSourceSink) -> SyncState {
            self.sink = sink
            return syncOnStart
        }

        func bodyState(for id: String, in place: Place) -> BodyState {
            bodies[id] ?? .notFetched
        }

        func requestBody(for id: String, in place: Place) { bodyRequests.append(id) }

        @discardableResult
        func apply(_ intent: MailIntent) -> IntentOutcome {
            received.append(intent)
            if let failure = refuseWith { return .refused(failure) }
            seq += 1
            return .applied(IntentAck(affected: 1, receipt: Receipt(id: "stub\(seq)")))
        }

        // What a real source would do when the mailbox changed under it.
        func push(_ world: MailWorld) { self.world = world; sink?.worldDidChange(world) }
        func push(_ state: SyncState) { sink?.syncStateDidChange(state) }
        func push(body id: String, in place: Place, _ state: BodyState) {
            bodies[id] = state
            sink?.bodyDidChange(id: id, in: place, to: state)
        }
    }

    // MARK: - Injection

    func testTheShellRendersWhateverTheSourceReportsAndNothingElse() {
        let s = AppState(source: StubSource())
        XCTAssertEqual(s.ohbox.map(\.id), ["only"],
                       "the shell showed something other than the world it was given")
        XCTAssertTrue(s.reads.isEmpty)
        XCTAssertTrue(s.waiting.isEmpty)
        XCTAssertEqual(s.ohboxUnread, 1)
        XCTAssertEqual(s.renderManifest(.ohbox, compact: true), ["only"],
                       "the no-collapse manifest follows the source too")
    }

    func testAPushedWorldReplacesTheProjection() {
        let source = StubSource()
        let s = AppState(source: source)
        XCTAssertEqual(s.ohbox.count, 1)

        var arrived = MailWorld.oneMessage
        arrived.ohbox.append(Message(id: "arrived", place: .ohbox, from: "Someone",
                                     addr: "someone@example.test", subj: "New mail", time: "10:02",
                                     unread: true, preview: "Arrived while the app was open."))
        source.push(arrived)

        XCTAssertEqual(s.ohbox.map(\.id), ["only", "arrived"],
                       "mail arriving at the source did not reach the shell")
        XCTAssertEqual(s.ohboxUnread, 2)
        XCTAssertEqual(s.search("arrived").hitCount, 1,
                       "the search index did not rebuild after the world changed")
    }

    /// The shell owns the source; the source must not own the shell back.
    func testTheSourceDoesNotKeepTheShellAlive() {
        let source = StubSource()
        var state: AppState? = AppState(source: source)
        weak var observed = state
        XCTAssertNotNil(observed)
        state = nil
        XCTAssertNil(observed, "the source is holding the shell — the sink must be weak")
    }

    // MARK: - Intents carry mailbox identities

    func testDecideReachesTheSourceAsAnAddressNotARowID() {
        let source = StubSource(world: .oneWaitingSender)
        let s = AppState(source: source)
        s.decide(s.waiting[0], to: .reads, read: true)

        guard case .decide(let sender, let scope, let dest, let markRead) = source.received.first else {
            return XCTFail("the decision never reached the source: \(source.received)")
        }
        XCTAssertEqual(sender, "hello@newsletter.test",
                       "the intent named a local row id — a mailbox cannot resolve that")
        XCTAssertEqual(scope, .sender)
        XCTAssertEqual(dest, .reads)
        XCTAssertTrue(markRead)
    }

    func testEveryMailMutationGoesOutAsAnIntent() {
        let source = StubSource(world: .oneMessage)
        let s = AppState(source: source)
        s.markSeen("only")
        s.toggleTag("only", .pottery)
        s.replyLater(s.ohbox[0])
        XCTAssertEqual(source.received.count, 3,
                       "a mutation reached the projection without passing the source")
    }

    // MARK: - Refusal, with a reason

    func testARefusedIntentChangesNothingAndSaysWhy() {
        let source = StubSource(world: .oneWaitingSender)
        let s = AppState(source: source)
        source.refuseWith = SourceFailure(kind: .network,
                                          reason: "The mailbox could not be reached — this will retry.",
                                          isRetryable: true)

        let receipt = s.decide(s.waiting[0], to: .ohbox, read: false)

        XCTAssertNil(receipt)
        XCTAssertEqual(s.waiting.count, 1, "a refused decision still moved the mail")
        XCTAssertEqual(s.toast?.message, "The mailbox could not be reached — this will retry.",
                       "the reader was not told why")
        XCTAssertNil(s.toast?.actionLabel, "a refusal must not offer an Undo")
        XCTAssertNil(s.pendingUndo)
    }

    /// The undo the old design could not have: an inverse the source declines.
    func testUndoIsARequestTheSourceCanRefuse() {
        let source = StubSource(world: .oneWaitingSender)
        let s = AppState(source: source)
        s.decide(s.waiting[0], to: .ohbox, read: false)
        XCTAssertNotNil(s.pendingUndo, "the toast offered no Undo to refuse")

        source.refuseWith = SourceFailure(kind: .server,
                                          reason: "That mail was moved on another device.",
                                          isRetryable: false)
        XCTAssertFalse(s.undoPending(), "the shell reported success for an undo that did not happen")
        XCTAssertEqual(s.toast?.message, "That mail was moved on another device.")

        guard case .reverse = source.received.last else {
            return XCTFail("the undo did not go out as a reverse request: \(source.received)")
        }
    }

    // MARK: - States fixtures cannot reach

    func testASyncStillRunningIsVisibleToTheShell() {
        let source = StubSource()
        source.syncOnStart = .syncing(SyncActivity(what: "Fetching Ohbox", done: 3, total: 40))
        let s = AppState(source: source)

        guard case .syncing(let activity) = s.syncState else {
            return XCTFail("the shell lost the sync state the source reported: \(s.syncState)")
        }
        XCTAssertEqual(activity.what, "Fetching Ohbox")
        XCTAssertEqual(activity.done, 3)

        source.push(SyncState.failed(SourceFailure(kind: .authentication,
                                                   reason: "Sign in again to keep syncing.",
                                                   isRetryable: false)))
        guard case .failed(let failure) = s.syncState else {
            return XCTFail("a sync failure did not reach the shell: \(s.syncState)")
        }
        XCTAssertEqual(failure.reason, "Sign in again to keep syncing.")
        XCTAssertEqual(failure.kind, .authentication)
    }

    func testABodyThatHasNotBeenFetchedIsNotTheSameAsAnEmptyBody() {
        let source = StubSource(world: .oneReadsItem)
        let s = AppState(source: source)

        XCTAssertEqual(s.bodyState(for: "issue", in: .reads), .notFetched)
        XCTAssertNil(s.bodyState(for: "issue", in: .reads).text,
                     "an unfetched body must not read as text")
        XCTAssertEqual(s.body(for: s.reads[0]), "The preview line.",
                       "the string shim falls back to the preview rather than rendering nothing")

        s.requestBody(for: "issue", in: .reads)
        XCTAssertEqual(source.bodyRequests, ["issue"])

        source.push(body: "issue", in: .reads, .fetching)
        XCTAssertEqual(s.bodyState(for: "issue", in: .reads), .fetching)

        source.push(body: "issue", in: .reads, .available("The whole issue."))
        XCTAssertEqual(s.body(for: s.reads[0]), "The whole issue.")
        XCTAssertEqual(s.search("whole issue").hitCount, 1,
                       "a body that arrived late never reached the search index")

        let gone = SourceFailure(kind: .server, reason: "That message is no longer on the server.",
                                 isRetryable: false)
        source.push(body: "issue", in: .reads, .failed(gone))
        XCTAssertEqual(s.bodyState(for: "issue", in: .reads), .failed(gone))
        XCTAssertNil(s.bodyState(for: "issue", in: .reads).text)
    }

    // MARK: - The fixture source still answers for the app it ships as

    func testTheFixtureSourceReportsIdleAndHasEveryBodyInHand() {
        let s = AppState()
        guard case .idle(let last) = s.syncState else {
            return XCTFail("the fixture source is not idle: \(s.syncState)")
        }
        XCTAssertNil(last, "fixtures have never completed a sync, because there is nothing to sync")
        for m in s.reads {
            XCTAssertNotNil(s.bodyState(for: m.id, in: .reads).text, "\(m.id) has no body in hand")
        }
    }

    /// Intents name a sender by address, so an address has to identify one sender
    /// within a segment. It does in a mailbox; it has to in the fixtures too, or
    /// the source resolves the wrong one and nothing anywhere says so.
    func testEveryScreenerSegmentIdentifiesItsSendersByAddress() {
        let s = AppState()
        XCTAssertEqual(Set(s.waiting.map(\.addr)).count, s.waiting.count,
                       "two waiting senders share an address")
        XCTAssertEqual(Set(s.screened.map(\.sender)).count, s.screened.count,
                       "two screened-out senders share an address")
        XCTAssertEqual(Set(s.spam.map(\.from)).count, s.spam.count,
                       "two spam senders share an address")
    }

    func testReversingSomethingNotOnRecordIsRefusedRatherThanIgnored() {
        let s = AppState()
        let outcome = FixtureSource().apply(.reverse(Receipt(id: "never-happened")))
        guard case .refused(let failure) = outcome else {
            return XCTFail("an unknown receipt was accepted: \(outcome)")
        }
        XCTAssertFalse(failure.reason.isEmpty, "a refusal must carry a reason")
        XCTAssertEqual(s.undoPending(), false, "with no toast there is nothing to undo")
    }
}

// MARK: - Small worlds

private extension MailWorld {
    static var oneMessage: MailWorld {
        var w = MailWorld()
        w.ownerAddress = "reader@example.test"
        w.ohbox = [Message(id: "only", place: .ohbox, from: "A Sender",
                           addr: "sender@example.test", subj: "The only message", time: "09:00",
                           unread: true, preview: "Nothing else is in this world.",
                           body: "Nothing else is in this world.")]
        w.piles = PileKind.allCases.map { TriagePile(kind: $0, title: "\($0)", items: [], hint: "") }
        return w
    }

    static var oneWaitingSender: MailWorld {
        var w = MailWorld()
        w.ownerAddress = "reader@example.test"
        w.waiting = [WaitingSender(
            id: "row-7", from: "A Newsletter", addr: "hello@newsletter.test", initial: "A",
            time: "08:30",
            ai: AISuggestion(dest: .reads, conf: "0.90", why: "newsletter shape"),
            held: HeldMailbag(HeldMail(id: "held-1", subj: "Issue 1", time: "08:30",
                                       content: .plain(body: "Issue one.", preview: "Issue one."))))]
        return w
    }

    static var oneReadsItem: MailWorld {
        var w = MailWorld()
        w.ownerAddress = "reader@example.test"
        w.reads = [Message(id: "issue", place: .reads, from: "A Newsletter",
                           addr: "hello@newsletter.test", subj: "Issue 1", time: "08:30",
                           unread: true, preview: "The preview line.")]
        // No entry in `readsBodies` at all — which is exactly "not fetched".
        return w
    }
}

private extension SearchOutcome {
    var hitCount: Int {
        if case .results(let hits, _) = self { return hits.count }
        return 0
    }
}
