import Foundation

/// `URLRequest`/response ⇄ frame marshalling — the Swift half of the engine's own request/response marshalling.
///
/// `createApp(...).handle` is a plain `Request → Response` function with no server binding, which is
/// what makes the stdio bridge "a shim rather than a port". This
/// file is that shim on the shell's side, and it is deliberately the ONLY place that knows how a
/// request becomes bytes.
///
/// ── SET-COOKIE IS SPECIAL AND SILENTLY LOSSY IF YOU FORGET ────────────────────────────────
///
/// Iterating a header map combines repeated names with `", "`, and for `Set-Cookie` that is
/// destructive: two cookies become one malformed string, because a cookie value may itself contain
/// a comma (`Expires=Wed, 09 Jun 2027 …`). So set-cookie travels in its own `sc` array and is
/// re-appended on decode.
///
/// **`HTTPURLResponse` cannot hold two headers of one name** — its `allHeaderFields` is a
/// dictionary. So ``EngineResponse/setCookie`` is the lossless reader and
/// ``EngineResponse/httpURLResponse(for:)`` is the lossy convenience, with the loss confined to one
/// documented line instead of spread across every caller. The LOCAL sidecar is bearer-only
/// (`allowCookieAuth: false`) and mints no cookies; `sc` exists so that stays true by evidence
/// rather than by nobody having looked.

/// The unsolicited hello the engine sends once it is serving.
///
/// It carries the per-launch session token (sessions are minted per launch
/// and never persisted), which is how the shell authenticates without a login ceremony the desktop
/// tier does not have. It travels in-band on a pipe only this process holds — there is no listener,
/// so there is nobody else it could reach.
public struct EngineReady: Equatable, Sendable {
    public let baseURL: String
    public let accountID: String
    public let userID: String
    public let mailboxID: String
    /// The per-launch bearer token. Never persisted by the engine, never logged by this shell.
    public let sessionToken: Secret

    public init(baseURL: String, accountID: String, userID: String, mailboxID: String, sessionToken: Secret) {
        self.baseURL = baseURL
        self.accountID = accountID
        self.userID = userID
        self.mailboxID = mailboxID
        self.sessionToken = sessionToken
    }
}

/// A transport-level failure for one request: the engine could not produce a response at all.
///
/// Distinct from a 5xx, which IS a response and means the app ran.
public struct EngineErrorFrame: Equatable, Sendable {
    public let id: Int
    public let code: String
    public let message: String
}

/// A response travelling back, before it is narrowed into an `HTTPURLResponse`.
public struct EngineResponse: Sendable {
    public let id: Int
    public let status: Int
    public let statusText: String
    /// Every header except `Set-Cookie`, in wire order. Repeated names are preserved.
    public let headers: [(name: String, value: String)]
    /// `Set-Cookie`, one entry per cookie. **The lossless reader** — see the file header.
    public let setCookie: [String]
    public let body: Data

    /// Statuses `HTTPURLResponse` consumers must not be handed a body for.
    static let bodyless: Set<Int> = [101, 103, 204, 205, 304]

    /// The lossy convenience. Repeated header names — including every cookie past the first — are
    /// combined with `", "`, which is exactly the corruption `sc` exists to avoid. Callers that
    /// care about cookies read ``setCookie``.
    public func httpURLResponse(for url: URL) -> HTTPURLResponse {
        var fields: [String: String] = [:]
        for (name, value) in headers {
            if let existing = fields[name] { fields[name] = existing + ", " + value } else { fields[name] = value }
        }
        if !setCookie.isEmpty { fields["Set-Cookie"] = setCookie.joined(separator: ", ") }
        return HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)
            ?? HTTPURLResponse()
    }

    public var payload: Data { Self.bodyless.contains(status) ? Data() : body }
}

/// One frame's header, typed. `Sendable`, because it crosses from the reader thread.
public enum FrameHeader: Sendable {
    case ready(EngineReady)
    case response(EngineResponse)
    case failure(EngineErrorFrame)
    /// Well-formed, version-correct, and not one this shell acts on.
    case other(type: String)
}

public enum EngineProtocol {
    /// Decode one frame into a typed header.
    ///
    /// - Throws: ``FrameError`` — every failure here is terminal for the stream. A version skew, a
    ///   `ready` with no mailbox, a response with no id: none of them is a frame the next 8 bytes
    ///   can be read past, because a header this shell cannot understand is a header it cannot
    ///   trust the *lengths* of either.
    public static func decode(_ frame: Frame) throws -> FrameHeader {
        guard let object = try? JSONSerialization.jsonObject(with: frame.header, options: []),
              let h = object as? [String: Any] else {
            throw FrameError("frame header must be a JSON object")
        }

        // Checked on BOTH sides, so a version skew — a shell updated ahead of its engine, or the
        // reverse — is one clear error instead of two ends quietly misreading each other's fields.
        guard let version = (h["v"] as? NSNumber)?.intValue else {
            throw FrameError("a frame declared no protocol version, and this shell speaks \(PROTOCOL_VERSION)")
        }
        guard version == PROTOCOL_VERSION else {
            throw FrameError("a frame declared protocol version \(version), and this shell speaks \(PROTOCOL_VERSION)")
        }

        let type = h["t"] as? String ?? ""
        switch type {
        case "ready":
            func field(_ name: String) throws -> String {
                guard let v = h[name] as? String else {
                    throw FrameError("the engine's ready frame carried no \(name)")
                }
                return v
            }
            return .ready(EngineReady(
                baseURL: try field("baseUrl"),
                accountID: try field("accountId"),
                userID: try field("userId"),
                mailboxID: try field("mailboxId"),
                sessionToken: Secret(try field("sessionToken"))))

        case "res":
            guard let id = (h["id"] as? NSNumber)?.intValue else {
                throw FrameError("a response frame carried no correlation id")
            }
            var headers: [(name: String, value: String)] = []
            for pair in h["h"] as? [[String]] ?? [] where pair.count == 2 {
                headers.append((pair[0], pair[1]))
            }
            return .response(EngineResponse(
                id: id,
                status: (h["status"] as? NSNumber)?.intValue ?? 0,
                statusText: h["statusText"] as? String ?? "",
                headers: headers,
                setCookie: h["sc"] as? [String] ?? [],
                body: frame.body))

        case "err":
            guard let id = (h["id"] as? NSNumber)?.intValue else {
                throw FrameError("an error frame carried no correlation id")
            }
            return .failure(EngineErrorFrame(
                id: id,
                code: h["code"] as? String ?? "sidecar_failed",
                message: h["message"] as? String ?? ""))

        default:
            return .other(type: type)
        }
    }

    /// A request → the header bytes that carry it. The body travels beside them, uncopied.
    ///
    /// `URLRequest.allHTTPHeaderFields` has already combined any repeated request header, which is
    /// lossless in practice: the one header a client repeats is `Cookie`, and the LOCAL engine is
    /// bearer-only. Named rather than assumed, because the response direction is where it is *not*
    /// lossless and that asymmetry is easy to mirror by accident.
    public static func encodeRequest(id: Int, _ request: URLRequest, baseURL: URL) throws -> (header: Data, body: Data) {
        guard let url = request.url.map({ $0.scheme == nil ? URL(string: $0.absoluteString, relativeTo: baseURL) ?? $0 : $0 }) else {
            throw FrameError("a request with no URL cannot be framed")
        }
        let headers = (request.allHTTPHeaderFields ?? [:]).map { [$0.key, $0.value] }
        let object: [String: Any] = [
            "v": PROTOCOL_VERSION,
            "t": "req",
            "id": id,
            "method": (request.httpMethod ?? "GET").uppercased(),
            "url": url.absoluteString,
            "h": headers,
        ]
        // `.sortedKeys` so a header is byte-stable across runs: a test that compares two encodings
        // is otherwise at the mercy of dictionary ordering.
        let header = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        if header.count > MAX_HEADER_BYTES {
            throw FrameError("refusing to write a \(header.count)-byte header (cap \(MAX_HEADER_BYTES))")
        }
        let body = request.httpBody ?? Data()
        if body.count > MAX_BODY_BYTES {
            throw FrameError("a \(body.count)-byte request body is over the \(MAX_BODY_BYTES)-byte frame cap")
        }
        return (header, body)
    }

    /// A response → the frame that carries it. Only a test writes these; the engine is the producer
    /// in production. It exists so the decoder can be driven with input this shell did not shape.
    public static func encodeResponse(_ response: EngineResponse) throws -> (header: Data, body: Data) {
        let object: [String: Any] = [
            "v": PROTOCOL_VERSION,
            "t": "res",
            "id": response.id,
            "status": response.status,
            "statusText": response.statusText,
            "h": response.headers.map { [$0.name, $0.value] },
            "sc": response.setCookie,
        ]
        return (try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), response.body)
    }
}
