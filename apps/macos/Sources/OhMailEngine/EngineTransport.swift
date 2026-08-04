import Foundation

/// THE UI SIDE OF THE BRIDGE — a request/response round trip that goes down a pipe.
///
/// The local-engine design: "The UI keeps `HttpAdapter`, given a `fetch` that marshals
/// `Request`/`Response` over the sidecar's stdin/stdout." This is the Swift equivalent, shaped as
/// `(URLRequest) async throws -> (HTTPURLResponse, Data)` so that whatever eventually drives the
/// mail — a Swift port of the client engine, or a thin client over these routes — is handed the same
/// signature `URLSession` would have given it. **No `URLSession` is involved, and none is linked:**
/// there is no socket here at all.
///
/// ── RESPONSES ARRIVE OUT OF ORDER ─────────────────────────────────────────────────────────
///
/// Frames carry a correlation `id`, and the engine answers them as its handlers finish, so one slow
/// request cannot head-of-line-block the rest. Every waiter is therefore keyed by id and resumed by
/// the reader thread — never by position, and never by assuming the next frame answers the last
/// request.
///
/// ── WHAT HAPPENS WHEN THE ENGINE DIES ─────────────────────────────────────────────────────
///
/// Every in-flight request fails with a clear error. A promise that silently never settles is the
/// worst failure a bridge can have — the UI shows a spinner forever and no log says why.
///
/// The supervisor may then restart the engine, so this object does NOT latch closed: it fails what
/// was in flight and stays usable. A request sent while nothing is running fails immediately at the
/// write, which is the same shape a dead socket gives.
public enum EngineTransportError: Error, CustomStringConvertible, Equatable {
    /// The engine could not produce a response at all — a malformed frame, or the host throwing
    /// outside the app. Distinct from a 5xx, which IS a response and means the app ran.
    case engine(code: String, message: String)
    case unavailable(String)

    public var description: String {
        switch self {
        case .engine(let code, let message): return "\(code): \(message)"
        case .unavailable(let why): return why
        }
    }
}

public final class EngineTransport: EngineFrameSink, @unchecked Sendable {
    private let engine: EngineProcess
    private let baseURL: URL
    private let lock = NSLock()
    private var waiting: [Int: CheckedContinuation<EngineResponse, Error>] = [:]
    private var nextID = 1

    /// Base for relative paths. `http://sidecar` is what the engine's `ready` frame reports and what
    /// its router resolves against; nothing dials it.
    public init(engine: EngineProcess, baseURL: URL = URL(string: "http://sidecar")!) {
        self.engine = engine
        self.baseURL = baseURL
        engine.attach(sink: self)
    }

    /// Requests sent and not yet answered.
    public var pending: Int {
        lock.lock(); defer { lock.unlock() }
        return waiting.count
    }

    /// The shape a `URLSession`-flavoured caller wants.
    ///
    /// Lossy in exactly one place, and it is the documented one: `HTTPURLResponse` cannot hold two
    /// headers of the same name, so repeated `Set-Cookie` values are combined. Callers that read
    /// cookies use ``response(for:)`` and its ``EngineResponse/setCookie`` array. The LOCAL engine is
    /// bearer-only and mints no cookies, which is asserted rather than assumed.
    public func send(_ request: URLRequest) async throws -> (HTTPURLResponse, Data) {
        let response = try await self.response(for: request)
        let url = request.url ?? baseURL
        return (response.httpURLResponse(for: url), response.payload)
    }

    /// The lossless round trip: every header exactly as the engine sent it.
    public func response(for request: URLRequest) async throws -> EngineResponse {
        let id = nextRequestID()
        let framed = try EngineProtocol.encodeRequest(id: id, request, baseURL: baseURL)

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                // A task cancelled BEFORE the body runs would otherwise register a waiter that the
                // cancellation handler has already looked for and not found — and then wait for a
                // response nobody is going to correlate. Checked here, where the continuation exists
                // to resume.
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                lock.lock()
                waiting[id] = continuation
                lock.unlock()
                // Registered BEFORE the write. A response can come back before `send` returns —
                // the reader is a different thread — and a waiter registered afterwards would miss
                // it and then wait forever.
                do {
                    try engine.send(header: framed.header, body: framed.body)
                } catch {
                    if let waiter = take(id) {
                        waiter.resume(throwing: EngineTransportError.unavailable(String(describing: error)))
                    }
                }
            }
        } onCancel: {
            if let waiter = take(id) {
                waiter.resume(throwing: CancellationError())
            }
        }
    }

    // MARK: - EngineFrameSink

    public func engineDidReceive(_ header: FrameHeader) {
        switch header {
        case .response(let response):
            take(response.id)?.resume(returning: response)
        case .failure(let failure):
            take(failure.id)?.resume(throwing: EngineTransportError.engine(code: failure.code,
                                                                          message: failure.message))
        case .ready, .other:
            // `ready` is the supervisor's; an unknown type is a peer saying something this version
            // has no opinion about, which is not a reason to fail a request.
            break
        }
    }

    public func engineStreamDidEnd(_ error: Error) {
        lock.lock()
        let stranded = waiting
        waiting.removeAll()
        lock.unlock()
        for (_, waiter) in stranded {
            waiter.resume(throwing: EngineTransportError.unavailable(String(describing: error)))
        }
    }

    // MARK: -

    private func nextRequestID() -> Int {
        lock.lock(); defer { lock.unlock() }
        let id = nextID
        nextID += 1
        return id
    }

    /// Claim a waiter. Returns nil for a late answer to something already failed, which is harmless
    /// — and is the reason a continuation is removed under the lock rather than resumed under it: a
    /// continuation resumed twice is a crash, not an error.
    private func take(_ id: Int) -> CheckedContinuation<EngineResponse, Error>? {
        lock.lock(); defer { lock.unlock() }
        return waiting.removeValue(forKey: id)
    }
}
