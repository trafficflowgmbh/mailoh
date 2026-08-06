import XCTest
@testable import OhMailKit
import OhMailEngine

/// DOOR TWO'S TRANSPORT, EXERCISED — AND THE UNTESTED BRANCH THIS FILE EXISTS FOR.
///
/// Every other test in the suite stubs `EngineRequesting`, so the real `URLSession` conformance — the
/// cookie session, the CSRF header on mutations, refresh-on-401, the two-step sign-in — was the
/// default-untested branch, the exact shape that shipped an adapter bug past dozens of green tests.
/// These drive the genuine `CloudRequester` and `CloudSignIn` code over a real `URLSession`, with a
/// `URLProtocol` answering in place of a socket, so the request shapes and the refresh dance are
/// watched rather than assumed. The one thing a stub cannot stand in for — that the live API answers
/// these shapes — is the mandated live contract run against `api.ohmail.app` (login → verify → cookie
/// → GET reads → CSRF refresh → logout, all 2xx/204); see the slice report.
@MainActor
final class CloudRequesterTests: XCTestCase {

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func stubbedSession() -> URLSession {
        makeCloudURLSession(protocolClasses: [StubURLProtocol.self])
    }

    private func seedCSRF(_ session: URLSession, _ value: String) {
        session.configuration.httpCookieStorage?.setCookie(HTTPCookie(properties: [
            .domain: "api.ohmail.app", .path: "/", .name: "tf_csrf", .value: value,
        ])!)
    }

    // MARK: - CSRF double-submit

    /// **THE CSRF HEADER IS SENT ON MUTATIONS, FROM THE `tf_csrf` COOKIE — AND NOT ON READS.** A
    /// `PATCH` carries `X-CSRF-Token` equal to the cookie; a `GET` carries none. This is the header the
    /// live host 403's a mutation without.
    func testTheCSRFHeaderIsSentOnMutationsFromTheCookieAndNotOnReads() async throws {
        let log = CallLog()
        StubURLProtocol.install { req in log.record(req); return Reply(200, "{}") }
        let session = stubbedSession()
        seedCSRF(session, "csrf-xyz")
        let requester = CloudRequester(urlSession: session)

        var patch = URLRequest(url: URL(string: "/messages", relativeTo: cloudAPIBaseURL)!)
        patch.httpMethod = "PATCH"
        _ = try await requester.send(patch)
        XCTAssertEqual(log.header(path: "/messages", "X-CSRF-Token"), "csrf-xyz",
                       "a mutation did not carry the double-submit header from the cookie")

        _ = try await requester.send(URLRequest(url: URL(string: "/sync", relativeTo: cloudAPIBaseURL)!))
        XCTAssertNil(log.header(path: "/sync", "X-CSRF-Token"), "a read carried a CSRF header")
    }

    /// The placeholder bearer `EngineSource` writes is stripped — the cookie is the credential, and an
    /// empty `Authorization` must never reach the host.
    func testThePlaceholderBearerHeaderIsStripped() async throws {
        let log = CallLog()
        StubURLProtocol.install { req in log.record(req); return Reply(200, "{}") }
        let requester = CloudRequester(urlSession: stubbedSession())

        var req = URLRequest(url: URL(string: "/sync", relativeTo: cloudAPIBaseURL)!)
        req.setValue("Bearer ", forHTTPHeaderField: "authorization")   // what EngineSource writes
        _ = try await requester.send(req)
        XCTAssertNil(log.header(path: "/sync", "Authorization"),
                     "an empty bearer header reached the host instead of being stripped")
    }

    // MARK: - Refresh on 401

    /// **A 401 REFRESHES ONCE AND RETRIES.** The first `/sync` is answered 401; `/auth/refresh` rotates
    /// the session; the retry succeeds. The branch a stubbed requester never runs.
    func testA401TriggersRefreshAndRetry() async throws {
        let log = CallLog()
        StubURLProtocol.install { req in
            log.record(req)
            switch req.url?.path {
            case "/sync": return log.count(path: "/sync") == 1 ? Reply(401, "{}") : Reply(200, "{}")
            case "/auth/refresh": return Reply(204, "")
            default: return Reply(404, "{}")
            }
        }
        let requester = CloudRequester(urlSession: stubbedSession())
        let (http, _) = try await requester.send(URLRequest(url: URL(string: "/sync?since=0", relativeTo: cloudAPIBaseURL)!))

        XCTAssertEqual(http.statusCode, 200, "the request was not retried after the session refreshed")
        XCTAssertEqual(log.count(path: "/auth/refresh"), 1, "the refresh route was not called")
        XCTAssertEqual(log.count(path: "/sync"), 2, "the request was not retried")
    }

    /// A 401 whose refresh ALSO fails surfaces the 401 — never a crash and never invented mail. The
    /// projection reads it as an authentication failure and the window states it.
    func testA401WithAFailedRefreshSurfacesThe401() async throws {
        StubURLProtocol.install { req in
            switch req.url?.path {
            case "/sync": return Reply(401, "{}")
            case "/auth/refresh": return Reply(401, #"{"error":{"code":"unauthorized"}}"#)
            default: return Reply(404, "{}")
            }
        }
        let requester = CloudRequester(urlSession: stubbedSession())
        let (http, _) = try await requester.send(URLRequest(url: URL(string: "/sync", relativeTo: cloudAPIBaseURL)!))
        XCTAssertEqual(http.statusCode, 401, "a dead refresh should leave the 401 standing")
    }

    // MARK: - The two-step sign-in

    /// **SIGN-IN IS `/auth/login` THEN `/auth/2fa/totp/verify`, and it connects on `authenticated`.**
    /// The field is `loginToken`, not `challengeToken` — the trap the ux-suite README names. On a
    /// cookie host the verify body carries no tokens; the session rides in the jar.
    func testSignInDoesLoginThenVerifyAndConnects() async {
        let log = CallLog()
        StubURLProtocol.install { req in
            log.record(req)
            switch req.url?.path {
            case "/auth/login":
                return Reply(200, #"{"status":"twofa_required","loginToken":"lt","methods":["totp"]}"#)
            case "/auth/2fa/totp/verify":
                return Reply(200, #"{"status":"authenticated","user":{"id":"u1"}}"#)
            default:
                return Reply(404, "{}")
            }
        }
        let signIn = CloudSignIn(baseURL: cloudAPIBaseURL, makeSession: { makeCloudURLSession(protocolClasses: [StubURLProtocol.self]) })
        let outcome = await signIn.signIn(email: "a@b.test", password: "pw", code: "123456")

        guard case .connected = outcome else { return XCTFail("sign-in did not connect: \(outcome)") }
        XCTAssertEqual(log.paths, ["/auth/login", "/auth/2fa/totp/verify"],
                       "sign-in did not make the two calls in order")
    }

    /// A wrong password is a rejection to show beside the field — not a degraded panel.
    func testSignInRejectsAWrongPassword() async {
        StubURLProtocol.install { req in
            req.url?.path == "/auth/login"
                ? Reply(401, #"{"error":{"code":"invalid_credentials"}}"#)
                : Reply(404, "{}")
        }
        let outcome = await CloudSignIn(baseURL: cloudAPIBaseURL, makeSession: { makeCloudURLSession(protocolClasses: [StubURLProtocol.self]) })
            .signIn(email: "a@b.test", password: "wrong", code: "123456")
        guard case .rejected = outcome else { return XCTFail("a wrong password produced \(outcome)") }
    }

    /// A wrong code, after a correct password, is a rejection naming the code.
    func testSignInRejectsAWrongCode() async {
        StubURLProtocol.install { req in
            switch req.url?.path {
            case "/auth/login": return Reply(200, #"{"status":"twofa_required","loginToken":"lt"}"#)
            case "/auth/2fa/totp/verify": return Reply(401, #"{"error":{"code":"bad_code"}}"#)
            default: return Reply(404, "{}")
            }
        }
        let outcome = await CloudSignIn(baseURL: cloudAPIBaseURL, makeSession: { makeCloudURLSession(protocolClasses: [StubURLProtocol.self]) })
            .signIn(email: "a@b.test", password: "pw", code: "000000")
        guard case .rejected(let why) = outcome else { return XCTFail("a wrong code produced \(outcome)") }
        XCTAssertTrue(why.lowercased().contains("code"), "the rejection did not name the code: \(why)")
    }

    /// A 5xx is a faulting host — a NAMED degraded state, never a wrong-password message and never the
    /// sample world.
    func testSignInReportsAServerFaultAsUnavailable() async {
        StubURLProtocol.install { req in
            req.url?.path == "/auth/login" ? Reply(503, "{}") : Reply(404, "{}")
        }
        let outcome = await CloudSignIn(baseURL: cloudAPIBaseURL, makeSession: { makeCloudURLSession(protocolClasses: [StubURLProtocol.self]) })
            .signIn(email: "a@b.test", password: "pw", code: "123456")
        guard case .unavailable = outcome else { return XCTFail("a 503 produced \(outcome)") }
    }

    /// An account with no second factor cannot finish here — door two is a sign-in, not onboarding —
    /// so it says so plainly rather than opening a flow it cannot complete.
    func testSignInRejectsAnAccountWithNoFactor() async {
        StubURLProtocol.install { req in
            req.url?.path == "/auth/login"
                ? Reply(200, #"{"status":"enrollment","enrollmentToken":"et"}"#)
                : Reply(404, "{}")
        }
        let outcome = await CloudSignIn(baseURL: cloudAPIBaseURL, makeSession: { makeCloudURLSession(protocolClasses: [StubURLProtocol.self]) })
            .signIn(email: "a@b.test", password: "pw", code: "123456")
        guard case .rejected = outcome else { return XCTFail("a factorless account produced \(outcome)") }
    }

    // MARK: - No credential persisted on device

    /// **THE PRIVACY CLAIM, AT THE CONFIGURATION LEVEL.** The session is ephemeral with its own
    /// in-memory cookie jar and no URL cache, so the host-only session cookie lives only in RAM —
    /// "no credential persisted on device" is a property of the transport rather than a promise.
    func testTheCloudSessionIsEphemeralAndUncached() {
        let cfg = makeCloudURLSession().configuration
        XCTAssertNotNil(cfg.httpCookieStorage, "the cookie session needs a jar to hold the session cookie")
        XCTAssertFalse(cfg.httpCookieStorage === HTTPCookieStorage.shared,
                       "the cloud session shares the process-wide cookie jar — it must be private/in-memory")
        XCTAssertTrue(cfg.httpShouldSetCookies)
        XCTAssertNil(cfg.urlCache, "the cloud session caches responses on disk")
    }

    // MARK: - Incremental sync (cursor persistence over HTTPS)

    /// **INCREMENTAL RESUMES FROM THE CURSOR AND ACCUMULATES**, rather than re-draining the whole
    /// mailbox every cycle. The first cycle asks `since=0`; the second asks `since=<cursor>` and adds
    /// the new message to the mirror already in hand.
    func testIncrementalResumesFromTheCursorAndAccumulates() async {
        let requester = ScriptedRequester { _, path, query, _ in
            switch (path, query["since"]) {
            case ("/mailboxes", _): return (200, Self.identity)
            case ("/sync", "0"): return (200, Self.page(id: "m1", cursor: "10"))
            case ("/sync", _): return (200, Self.page(id: "m2", cursor: "20"))
            default: return (404, "{}")
            }
        }
        let source = EngineSource(requester: requester, token: Secret(""),
                                  baseURL: cloudAPIBaseURL, incremental: true)
        let sink = CapturingSink()
        source.start(sink: sink)
        await source.settle()
        XCTAssertEqual(sink.world.ohbox.map(\.id).sorted(), ["m1"])

        await source.refresh()
        XCTAssertEqual(requester.sinceSeen, ["0", "10"],
                       "the incremental cycle did not resume from the cursor")
        XCTAssertEqual(sink.world.ohbox.map(\.id).sorted(), ["m1", "m2"],
                       "the incremental mirror did not accumulate — it re-drained")
    }

    /// The pipe default re-reads from zero every cycle, exactly as `MailSource.swift` ruled. The
    /// contrast that keeps the incremental change from silently applying to the local path too.
    func testTheFullDrainReReadsFromZeroEachCycle() async {
        let requester = ScriptedRequester { _, path, _, _ in
            path == "/mailboxes" ? (200, Self.identity) : (200, Self.page(id: "m1", cursor: "10"))
        }
        let source = EngineSource(requester: requester, token: Secret(""))   // incremental: false
        let sink = CapturingSink()
        source.start(sink: sink)
        await source.settle()
        await source.refresh()
        XCTAssertEqual(requester.sinceSeen, ["0", "0"],
                       "the pipe drain must re-read from zero every cycle")
    }

    /// **A REFUSED WRITE REVERTS, EVEN UNDER INCREMENTAL SYNC.** A full drain self-heals a refusal by
    /// rebuilding from source; incremental keeps the mirror and sees no delta for the refused message,
    /// so the rollback in `markSeen` is what puts the optimistic edit back. Without it, the row would
    /// stay read.
    func testARefusedWriteRevertsUnderIncrementalSync() async {
        let requester = ScriptedRequester { method, path, query, _ in
            switch (method, path, query["since"]) {
            case (_, "/mailboxes", _): return (200, Self.identity)
            case ("GET", "/sync", "0"): return (200, Self.page(id: "m1", cursor: "10", unread: true))
            case ("GET", "/sync", _): return (200, Self.emptyPage(cursor: "10"))
            case ("PATCH", "/messages", _): return (500, #"{"error":{"code":"server"}}"#)
            default: return (404, "{}")
            }
        }
        let source = EngineSource(requester: requester, token: Secret(""),
                                  baseURL: cloudAPIBaseURL, incremental: true)
        let sink = CapturingSink()
        source.start(sink: sink)
        await source.settle()
        XCTAssertEqual(sink.world.ohbox.first?.unread, true, "m1 should start unread")

        _ = source.apply(.markSeen(message: "m1"))
        await source.settle()

        XCTAssertEqual(sink.world.ohbox.first?.unread, true,
                       "a refused mark-seen left the row read under incremental sync — the rollback is gone")
    }

    // MARK: - Fixtures

    static let identity = #"{"items":[{"address":"me@x.test","displayName":"Me","provider":"imap","status":"connected"}]}"#

    static func page(id: String, cursor: String, unread: Bool = false) -> String {
        """
        {"changes":{"creates":[{"type":"message","op":"create","id":"\(id)","seq":1,\
        "entity":{"id":"\(id)","folder":"INBOX","subject":"s","from":{"address":"\(id)@x.test"},\
        "unread":\(unread)}}],"updates":[],"moves":[],"deletes":[]},"cursor":"\(cursor)","hasMore":false}
        """
    }

    static func emptyPage(cursor: String) -> String {
        #"{"changes":{"creates":[],"updates":[],"moves":[],"deletes":[]},"cursor":"\#(cursor)","hasMore":false}"#
    }
}

// MARK: - Test doubles

/// A canned reply for the `URLProtocol` stub.
struct Reply {
    let status: Int
    let body: Data
    init(_ status: Int, _ body: String) { self.status = status; self.body = Data(body.utf8) }
}

/// Answers `URLSession` requests without a socket, so the real `CloudRequester`/`CloudSignIn` code runs
/// against synthetic responses. Registered as the session's only protocol class.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var responder: ((URLRequest) -> Reply)?
    private static let lock = NSLock()

    static func install(_ responder: @escaping (URLRequest) -> Reply) {
        lock.lock(); Self.responder = responder; lock.unlock()
    }
    static func reset() { lock.lock(); Self.responder = nil; lock.unlock() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock(); let responder = Self.responder; Self.lock.unlock()
        guard let responder else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let reply = responder(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Records each request's path and headers, from a background delegate thread.
final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(path: String, headers: [String: String])] = []

    func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        entries.append((request.url?.path ?? "", request.allHTTPHeaderFields ?? [:]))
    }
    var paths: [String] { lock.lock(); defer { lock.unlock() }; return entries.map(\.path) }
    func count(path: String) -> Int { lock.lock(); defer { lock.unlock() }; return entries.filter { $0.path == path }.count }
    /// The header value on the FIRST request to `path`, case-insensitively.
    func header(path: String, _ name: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let e = entries.first(where: { $0.path == path }) else { return nil }
        return e.headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

/// An `EngineRequesting` that answers scripted JSON and records the `since` it was asked for and the
/// mutations it received — for driving `EngineSource` without a transport.
final class ScriptedRequester: EngineRequesting, @unchecked Sendable {
    private let lock = NSLock()
    private var sinceRecorded: [String] = []
    private let handle: (_ method: String, _ path: String, _ query: [String: String], _ body: Data?) -> (Int, String)

    var sinceSeen: [String] { lock.lock(); defer { lock.unlock() }; return sinceRecorded }

    init(_ handle: @escaping (String, String, [String: String], Data?) -> (Int, String)) {
        self.handle = handle
    }

    func send(_ request: URLRequest) async throws -> (HTTPURLResponse, Data) {
        let comps = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        var query: [String: String] = [:]
        for item in comps.queryItems ?? [] { query[item.name] = item.value ?? "" }
        record(query["since"])
        let (status, json) = handle(request.httpMethod ?? "GET", comps.path, query, request.httpBody)
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
        return (response, Data(json.utf8))
    }

    /// Synchronous, so the lock is never held across a suspension point.
    private func record(_ since: String?) {
        guard let since else { return }
        lock.lock(); sinceRecorded.append(since); lock.unlock()
    }
}

/// Captures the latest world and the sync states pushed to it.
@MainActor
final class CapturingSink: MailSourceSink {
    private(set) var world = MailWorld()
    private(set) var syncStates: [SyncState] = []

    func worldDidChange(_ world: MailWorld) { self.world = world }
    func bodyDidChange(id: String, in place: Place, to state: BodyState) {}
    func syncStateDidChange(_ state: SyncState) { syncStates.append(state) }
}
