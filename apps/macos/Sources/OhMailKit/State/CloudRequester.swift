import Foundation
import OhMailEngine

/// DOOR TWO, BEHIND THE SEAM — the hosted mailbox reached over HTTPS.
///
/// This is the SECOND ``EngineRequesting`` conformance. The first, ``EngineTransport``, marshals the
/// same REST routes over a pipe to the local engine; this one speaks them to `api.ohmail.app` over
/// `URLSession`. Both feed the one ``EngineProjection`` through the one ``EngineSource`` — there is no
/// second client and no second projection. Cloud mode is a **viewer**: it never spawns the engine,
/// never touches the sidecar, the PGlite mirror or `ohmail/_meta`. The worker owns the `cloud` lease,
/// and the one-organizer invariant holds here by construction — ``SourceSelection`` gives this branch
/// `spawnEngine: false` and there is no IMAP client in this file to organize with.
///
/// ── COOKIE SESSION ────────────────────────────────────────────────────────────────────────────
///
/// `api.ohmail.app` is a **cookie surface**: the hosted sign-in strips the tokens from the response
/// body and sets four session cookies (`tf_session`, `tf_refresh`, `tf_csrf`, `tf_resume`), and every
/// authenticated request replays them. The state-changing routes (`/auth/refresh`, `/auth/logout`)
/// additionally require the double-submit `X-CSRF-Token` header — its value is the `tf_csrf` cookie —
/// and reject the request with 403 without it. So this transport is a cookie jar, not a bearer holder.
///
/// **The session cookie is host-only (no `Domain=`) and is NEVER widened.** The jar is the ephemeral
/// session's own in-memory store, so the credential lives only in RAM and is re-minted per launch: "no
/// credential persisted on device" is a property of the transport, not a promise. Nothing here writes
/// a token to disk.
///
/// ── REFRESH IS SINGLE-FLIGHT ──────────────────────────────────────────────────────────────────
///
/// A 401 means the session expired; ``CloudRefresher`` posts `/auth/refresh` (the jar replays the
/// path-scoped `tf_refresh`, and the `X-CSRF-Token` header is added), which rotates the cookies, and
/// the request is retried once with the fresh `tf_csrf`. A burst of concurrent 401s — the projection
/// drain and a body fetch racing — must not each rotate the family, so the refresh is a single shared
/// task the actor hands to every caller. A refresh that itself fails leaves the 401 standing, which
/// the projection reads as an authentication failure and the window states — never invented mail.

/// The hosted API.
public let cloudAPIBaseURL = URL(string: "https://api.ohmail.app")!

/// A session with nothing written to disk: an **ephemeral** configuration keeps cookies and the URL
/// cache in RAM only, so the host-only session cookie never reaches the filesystem.
///
/// Exposed so the sign-in and the transport share one configuration — the sign-in's cookies must be in
/// the same jar the transport later replays — and so a test can substitute a `URLProtocol`-backed
/// session that answers without a socket.
public func makeCloudURLSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral   // cookies + cache in RAM, never on disk
    cfg.httpShouldSetCookies = true
    cfg.httpCookieAcceptPolicy = .always
    cfg.urlCache = nil
    cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    cfg.tlsMinimumSupportedProtocolVersion = .TLSv12
    if let protocolClasses { cfg.protocolClasses = protocolClasses }
    return URLSession(configuration: cfg)
}

/// The `tf_csrf` cookie's value from a session's jar, for the double-submit header. `nil` before a
/// session exists.
func cloudCSRFToken(session: URLSession, baseURL: URL) -> String? {
    session.configuration.httpCookieStorage?
        .cookies(for: baseURL)?
        .first { $0.name == "tf_csrf" }?.value
}

/// Whether a method mutates, and therefore carries the CSRF header. The read routes the viewer uses —
/// `/sync`, `/mailboxes`, a body fetch — do not; `PATCH /messages` (mark-seen) and `/auth/refresh` do.
func cloudMethodMutates(_ method: String?) -> Bool {
    switch (method ?? "GET").uppercased() {
    case "GET", "HEAD": return false
    default: return true
    }
}

/// Single-flight `/auth/refresh`. An actor so a burst of concurrent 401s rotates the family once.
public actor CloudRefresher {
    private let baseURL: URL
    private let urlSession: URLSession
    private var inflight: Task<Bool, Never>?

    public init(baseURL: URL, urlSession: URLSession) {
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    func refresh() async -> Bool {
        if let inflight { return await inflight.value }
        let task = Task { await self.performRefresh() }
        inflight = task
        let ok = await task.value
        inflight = nil
        return ok
    }

    private func performRefresh() async -> Bool {
        guard let url = URL(string: "/auth/refresh", relativeTo: baseURL) else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = Data("{}".utf8)
        // The double-submit header. The jar replays `tf_refresh` (path-scoped to this route); the
        // response rotates every cookie, which the ephemeral jar captures for the retry.
        if let csrf = cloudCSRFToken(session: urlSession, baseURL: baseURL) {
            request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        }
        guard let (_, response) = try? await urlSession.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return false
        }
        return true
    }
}

/// The `URLSession` conformance of ``EngineRequesting``. The cookie jar authenticates every request;
/// mutations carry the CSRF header; a 401 refreshes once and retries.
public final class CloudRequester: EngineRequesting {
    private let baseURL: URL
    private let urlSession: URLSession
    private let refresher: CloudRefresher

    public init(baseURL: URL = cloudAPIBaseURL, urlSession: URLSession) {
        self.baseURL = baseURL
        self.urlSession = urlSession
        self.refresher = CloudRefresher(baseURL: baseURL, urlSession: urlSession)
    }

    /// The session's jar, for the composition root and for tests that assert what it holds.
    public var session: URLSession { urlSession }

    public func send(_ request: URLRequest) async throws -> (HTTPURLResponse, Data) {
        let (http, data) = try await roundTrip(request)
        guard http.statusCode == 401 else { return (http, data) }
        // Expired session. Rotate once; the retry re-reads the fresh `tf_csrf`. If the refresh fails
        // the 401 stands and the projection states an authentication failure rather than a blank
        // mailbox. A 403 (a CSRF mismatch) is NOT refreshed — refreshing cannot fix it.
        guard await refresher.refresh() else { return (http, data) }
        return try await roundTrip(request)
    }

    private func roundTrip(_ request: URLRequest) async throws -> (HTTPURLResponse, Data) {
        var r = request
        // `EngineSource` writes an `authorization` header from a placeholder token; the cookie is the
        // credential here, so drop it rather than present an empty bearer to the host.
        r.setValue(nil, forHTTPHeaderField: "Authorization")
        if cloudMethodMutates(r.httpMethod), let csrf = cloudCSRFToken(session: urlSession, baseURL: baseURL) {
            r.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        }
        let (data, response) = try await urlSession.data(for: r)
        let http = response as? HTTPURLResponse
            ?? HTTPURLResponse(url: request.url ?? baseURL, statusCode: 0,
                               httpVersion: "HTTP/1.1", headerFields: nil)!
        return (http, data)
    }
}

// MARK: - Sign-in (door two, step one and two)

/// What a cloud sign-in produced. Every non-success is NAMED — a rejection the person can act on, or
/// a reachability failure — and none of them is the invented world.
public enum CloudSignInOutcome: Sendable {
    /// Signed in. The requester wraps the session whose jar now holds the four cookies, and is what
    /// ``EngineSource`` drives.
    case connected(CloudRequester)
    /// The host was reached and said no to what was typed — a wrong password, a wrong code, an
    /// account with no code set up. Shown beside the field; the person can try again.
    case rejected(String)
    /// The host could not be reached, or answered with a fault. A degraded state, stated as one.
    case unavailable(String)
}

/// The two-step hosted sign-in: password, then the TOTP code. **Passkeys are a later follow-up** —
/// this build does password + code only. Adding a mailbox to Cloud stays on ohmail.app; door two is
/// sign-in and read/triage of mailboxes Cloud already holds, so there is no connect-flow ceremony
/// here and no new route — the three it calls (`/auth/login`, `/auth/2fa/totp/verify`,
/// `/auth/refresh`) already exist (GOALS #11).
public protocol CloudSignInService: Sendable {
    func signIn(email: String, password: String, code: String) async -> CloudSignInOutcome
}

public struct CloudSignIn: CloudSignInService {
    private let baseURL: URL
    /// The session whose jar catches the sign-in cookies and is handed on to the requester. Built once
    /// per sign-in so a fresh attempt starts from a clean jar.
    private let makeSession: @Sendable () -> URLSession

    public init(baseURL: URL = cloudAPIBaseURL,
                makeSession: @escaping @Sendable () -> URLSession = { makeCloudURLSession() }) {
        self.baseURL = baseURL
        self.makeSession = makeSession
    }

    public func signIn(email: String, password: String, code: String) async -> CloudSignInOutcome {
        let session = makeSession()

        // Step one: password. A 200 here is NOT a session — it is a challenge (`twofa_required`) or,
        // for an account with no factor, an enrollment session this build cannot use.
        let login: (status: Int, data: Data)
        do {
            login = try await post("/auth/login", ["email": email, "password": password], session)
        } catch {
            return .unavailable(Self.unreachable)
        }
        guard (200..<300).contains(login.status) else {
            return Self.rejectionOrFault(status: login.status,
                                         rejected: "That email and password weren't accepted.")
        }
        guard let challenge = try? JSONDecoder().decode(CloudLoginResponse.self, from: login.data) else {
            return .unavailable(Self.malformed)
        }
        guard challenge.status == "twofa_required", let loginToken = challenge.loginToken else {
            // An `enrollment` status means the account has no second factor to verify. Door two cannot
            // finish that here — it is a sign-in, not an onboarding — so it says so plainly.
            return .rejected("This account isn't set up for a code yet. Finish setting it up on "
                + "ohmail.app, then sign in here.")
        }

        // Step two: the code. The field is `loginToken`, not `challengeToken` — the one-hour trap the
        // ux-suite README calls out. The session's jar catches the four cookies from the response.
        let verify: (status: Int, data: Data)
        do {
            verify = try await post("/auth/2fa/totp/verify", ["loginToken": loginToken, "code": code], session)
        } catch {
            return .unavailable(Self.unreachable)
        }
        guard (200..<300).contains(verify.status) else {
            return Self.rejectionOrFault(status: verify.status, rejected: "That code wasn't accepted.")
        }
        guard let established = try? JSONDecoder().decode(CloudVerifyResponse.self, from: verify.data),
              established.status == "authenticated" else {
            return .unavailable(Self.malformed)
        }

        return .connected(CloudRequester(baseURL: baseURL, urlSession: session))
    }

    private func post(_ path: String, _ body: [String: String], _ session: URLSession) async throws -> (status: Int, data: Data) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw EngineTransportError.unavailable("\(path) is not a usable address")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    /// A 4xx is the host refusing what was typed; a 5xx is the host failing. The first is recoverable
    /// and shown beside the field; the second is a degraded state.
    static func rejectionOrFault(status: Int, rejected: String) -> CloudSignInOutcome {
        if (500..<600).contains(status) {
            return .unavailable("ohmail Cloud responded with an error (\(status)). Try again shortly.")
        }
        return .rejected(rejected)
    }

    static let unreachable = "Couldn't reach ohmail Cloud. Check your connection and try again."
    static let malformed = "ohmail Cloud sent a response this version of ohmail couldn't read."
}

// MARK: - The wire shapes of the two sign-in routes

struct CloudLoginResponse: Decodable {
    var status: String?
    var loginToken: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? nil
        loginToken = try c.decodeIfPresent(String.self, forKey: .loginToken) ?? nil
    }
    private enum CodingKeys: String, CodingKey { case status, loginToken }
}

/// `/auth/2fa/totp/verify`. On a cookie host the `tokens` are stripped and the session rides in the
/// `Set-Cookie` the jar captures, so `status` is all this reads — the credential is not on the wire
/// here, it is in the jar.
struct CloudVerifyResponse: Decodable {
    var status: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? nil
    }
    private enum CodingKeys: String, CodingKey { case status }
}
