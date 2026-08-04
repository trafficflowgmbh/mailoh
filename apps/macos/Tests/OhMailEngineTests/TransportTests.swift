import XCTest
@testable import OhMailEngine

/// The bridge, over a real pipe to a real child.
final class TransportTests: XCTestCase {
    private func serving(_ name: String) throws -> (EngineFixture, EngineProcess, EngineTransport) {
        let fixture = try EngineFixture(name)
        let engine = EngineProcess(launch: fixture.launch("echo"), timings: quickTimings)
        let transport = EngineTransport(engine: engine)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        return (fixture, engine, transport)
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: "http://sidecar\(path)")!)
        request.httpMethod = method
        request.httpBody = body
        return request
    }

    func testARoundTripGoesDownThePipeAndComesBack() async throws {
        let (_, engine, transport) = try serving("round-trip")
        defer { engine.stop() }

        let (response, body) = try await transport.send(request("/api/mail", method: "POST",
                                                                body: Data("hello".utf8)))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(response.value(forHTTPHeaderField: "x-echo-method"), "POST")
        XCTAssertEqual(body, Data("hello".utf8))
        XCTAssertEqual(transport.pending, 0, "nothing is left waiting")
    }

    /// **Responses arrive out of order.** The stand-in answers slowest first, so a client that
    /// correlated by arrival order — or that awaited one request at a time — returns the wrong body
    /// for two of these three.
    func testResponsesAreCorrelatedByIDAndNotByArrivalOrder() async throws {
        let (_, engine, transport) = try serving("out-of-order")
        defer { engine.stop() }

        let slowRequest = request("/slow?delay=250", method: "POST", body: Data("slow".utf8))
        let middleRequest = request("/middle?delay=120", method: "POST", body: Data("middle".utf8))
        let fastRequest = request("/fast?delay=0", method: "POST", body: Data("fast".utf8))
        async let slow = transport.send(slowRequest)
        async let middle = transport.send(middleRequest)
        async let fast = transport.send(fastRequest)

        let answers = try await [slow, middle, fast]
        XCTAssertEqual(answers.map { String(decoding: $0.1, as: UTF8.self) }, ["slow", "middle", "fast"],
                       "each request got its own answer back")
        XCTAssertEqual(transport.pending, 0)
    }

    /// The engine's `sc` array, end to end over a real pipe. Two cookies, each carrying a comma
    /// inside its own `Expires`, must arrive as two.
    func testSetCookieSurvivesTheWireAsAnArray() async throws {
        let (_, engine, transport) = try serving("cookies")
        defer { engine.stop() }

        let first = "sid=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT"
        let second = "csrf=def; Expires=Thu, 10 Jun 2027 10:18:14 GMT"
        let query = "\(first)|\(second)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        let response = try await transport.response(for: request("/x?cookies=\(query)"))
        XCTAssertEqual(response.setCookie, [first, second])
    }

    /// A promise that silently never settles is the worst failure a bridge can have — the UI shows a
    /// spinner forever and no log says why.
    func testAnEngineThatDiesFailsEverythingInFlightRatherThanHanging() async throws {
        let fixture = try EngineFixture("dies-mid-request")
        // One start and no restarts, so nothing comes back to answer the stranded request.
        var timings = quickTimings
        timings.backoffBase = 30
        timings.backoffCap = 30
        let engine = EngineProcess(launch: fixture.launch("echo"), timings: timings)
        let transport = EngineTransport(engine: engine)
        engine.start()
        waitFor("the engine to announce itself") {
            if case .serving = engine.status { return true }
            return false
        }
        defer { engine.stop() }

        let never = request("/never?delay=60000")
        let pending = Task { try await transport.send(never) }
        waitFor("the request to be in flight") { transport.pending == 1 }

        kill(try XCTUnwrap(engine.pid), SIGKILL)

        do {
            _ = try await pending.value
            XCTFail("a request outstanding when the engine died must fail, not hang")
        } catch {
            XCTAssertTrue(error is EngineTransportError, "\(error)")
        }
        XCTAssertEqual(transport.pending, 0)
    }

    func testARequestWithNoEngineRunningFailsAtOnce() async throws {
        let engine = EngineProcess.inert(.notConfigured(missing: [KEK_VAR]))
        let transport = EngineTransport(engine: engine)
        do {
            _ = try await transport.send(request("/x"))
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? EngineTransportError,
                           .unavailable("the engine is not running"))
        }
        XCTAssertEqual(transport.pending, 0)
    }

    /// A cancelled task must release its waiter. Otherwise a view that goes away leaks one entry per
    /// abandoned request, and the map grows for the life of the app.
    func testACancelledRequestStopsWaiting() async throws {
        let (_, engine, transport) = try serving("cancelled")
        defer { engine.stop() }

        let slow = request("/slow?delay=60000")
        let task = Task { try await transport.send(slow) }
        waitFor("the request to be in flight") { transport.pending == 1 }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertEqual(transport.pending, 0)
    }

    /// Correlation ids must not be reused within a launch: a repeated id makes a late answer to a
    /// dead request resolve a live one, with a body from the wrong route.
    func testCorrelationIDsAreNotReused() async throws {
        let (_, engine, transport) = try serving("ids")
        defer { engine.stop() }

        var seen: Set<String> = []
        for _ in 0..<8 {
            let (_, body) = try await transport.send(request("/id"))
            seen.insert(String(decoding: body, as: UTF8.self))
        }
        XCTAssertEqual(seen.count, 8, "the stand-in echoes the id it was sent: \(seen.sorted())")
    }
}
