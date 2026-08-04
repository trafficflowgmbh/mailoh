import XCTest
@testable import OhMailEngine

final class ProtocolTests: XCTestCase {
    private func frame(_ object: [String: Any], body: Data = Data()) -> Frame {
        Frame(header: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), body: body)
    }

    // MARK: - ready

    func testAReadyFrameCarriesTheSessionAndTheMailbox() throws {
        let header = try EngineProtocol.decode(frame([
            "v": 1, "t": "ready", "baseUrl": "http://sidecar", "sessionToken": "tok_secret",
            "accountId": "acc-1", "userId": "usr-1", "mailboxId": "mbx-1",
        ]))
        guard case .ready(let ready) = header else { return XCTFail("expected ready, got \(header)") }
        XCTAssertEqual(ready.baseURL, "http://sidecar")
        XCTAssertEqual(ready.mailboxID, "mbx-1")
        XCTAssertEqual(ready.accountID, "acc-1")
        XCTAssertEqual(ready.userID, "usr-1")
        XCTAssertEqual(ready.sessionToken.expose(), "tok_secret")
    }

    func testAReadyFrameMissingAFieldIsATerminalFaultAndNotAHalfReady() {
        for missing in ["baseUrl", "sessionToken", "accountId", "userId", "mailboxId"] {
            var object: [String: Any] = [
                "v": 1, "t": "ready", "baseUrl": "http://sidecar", "sessionToken": "tok",
                "accountId": "a", "userId": "u", "mailboxId": "m",
            ]
            object.removeValue(forKey: missing)
            XCTAssertThrowsError(try EngineProtocol.decode(frame(object)), "missing \(missing)") { error in
                XCTAssertTrue("\(error)".contains(missing), "\(error)")
            }
        }
    }

    // MARK: - version skew

    /// Checked on BOTH sides, so a shell updated ahead of its engine — or the reverse — is one clear
    /// error instead of two ends quietly misreading each other's fields.
    func testAFrameFromAnotherProtocolVersionIsRefused() {
        XCTAssertThrowsError(try EngineProtocol.decode(frame(["v": 2, "t": "ready"]))) { error in
            XCTAssertTrue("\(error)".contains("version 2"), "\(error)")
        }
        XCTAssertThrowsError(try EngineProtocol.decode(frame(["t": "ready"]))) { error in
            XCTAssertTrue("\(error)".contains("no protocol version"), "\(error)")
        }
    }

    /// A well-formed frame of a type this shell has no opinion about is not a fault. A version that
    /// adds a notification must not take the stream down on a shell that predates it.
    func testAnUnknownFrameTypeIsNotAFault() throws {
        guard case .other(let type) = try EngineProtocol.decode(frame(["v": 1, "t": "hello"])) else {
            return XCTFail("an unknown type should decode as .other")
        }
        XCTAssertEqual(type, "hello")
    }

    // MARK: - responses, and the cookie trap

    func testAResponseCarriesItsHeadersAndItsCorrelationID() throws {
        let header = try EngineProtocol.decode(frame([
            "v": 1, "t": "res", "id": 7, "status": 201, "statusText": "Created",
            "h": [["content-type", "application/json"], ["x-sync-seq", "42"]], "sc": [],
        ], body: Data("{}".utf8)))
        guard case .response(let response) = header else { return XCTFail("expected res, got \(header)") }
        XCTAssertEqual(response.id, 7)
        XCTAssertEqual(response.status, 201)
        XCTAssertEqual(response.statusText, "Created")
        XCTAssertEqual(response.headers.map(\.name), ["content-type", "x-sync-seq"])
        XCTAssertEqual(response.body, Data("{}".utf8))
    }

    /// **The reason `sc` exists.** A cookie value may contain a comma — `Expires=Wed, 09 Jun 2027` —
    /// so two cookies combined with `", "` are one malformed string that no parser can split back
    /// apart. Carried as an array, both survive whole.
    func testTwoCookiesEachContainingACommaSurviveTheRoundTrip() throws {
        let cookies = [
            "sid=abc; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; HttpOnly",
            "csrf=def; Path=/; Expires=Thu, 10 Jun 2027 10:18:14 GMT",
        ]
        let header = try EngineProtocol.decode(frame([
            "v": 1, "t": "res", "id": 1, "status": 200, "statusText": "OK", "h": [], "sc": cookies,
        ]))
        guard case .response(let response) = header else { return XCTFail("expected res") }
        XCTAssertEqual(response.setCookie, cookies, "each cookie arrives whole and separate")

        // And the documented loss, asserted so nobody discovers it: the `HTTPURLResponse` shape
        // CANNOT hold two headers of one name, which is exactly why `setCookie` is the reader that
        // callers who care about cookies must use.
        let combined = response.httpURLResponse(for: URL(string: "http://sidecar/x")!)
        let field = combined.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        XCTAssertNotEqual(field, cookies[0], "the lossy accessor is lossy, and this records it")
        XCTAssertTrue(field.contains(cookies[0]) && field.contains(cookies[1]))
    }

    func testAStatusThatMayNotCarryABodyDoesNot() throws {
        for status in [204, 304] {
            let header = try EngineProtocol.decode(frame([
                "v": 1, "t": "res", "id": 1, "status": status, "statusText": "", "h": [], "sc": [],
            ], body: Data("leftovers".utf8)))
            guard case .response(let response) = header else { return XCTFail("expected res") }
            XCTAssertEqual(response.payload, Data(), "\(status) must not be handed a body")
        }
    }

    func testAResponseWithNoCorrelationIDIsATerminalFault() {
        XCTAssertThrowsError(try EngineProtocol.decode(frame(["v": 1, "t": "res", "status": 200]))) { error in
            XCTAssertTrue("\(error)".contains("no correlation id"), "\(error)")
        }
    }

    func testAnErrorFrameIsATransportFailureForOneRequest() throws {
        let header = try EngineProtocol.decode(frame([
            "v": 1, "t": "err", "id": 3, "code": "sidecar_failed", "message": "the host threw",
        ]))
        guard case .failure(let failure) = header else { return XCTFail("expected err") }
        XCTAssertEqual(failure.id, 3)
        XCTAssertEqual(failure.code, "sidecar_failed")
        XCTAssertEqual(failure.message, "the host threw")
    }

    // MARK: - requests

    func testARequestIsFramedWithItsMethodURLAndHeaders() throws {
        var request = URLRequest(url: URL(string: "http://sidecar/api/mail?q=a%2Cb")!)
        request.httpMethod = "post"
        request.setValue("Bearer tok", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("payload".utf8)

        let framed = try EngineProtocol.encodeRequest(id: 9, request, baseURL: URL(string: "http://sidecar")!)
        let object = try JSONSerialization.jsonObject(with: framed.header) as! [String: Any]
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(object["t"] as? String, "req")
        XCTAssertEqual(object["id"] as? Int, 9)
        XCTAssertEqual(object["method"] as? String, "POST", "the method is normalised, as the host expects")
        XCTAssertEqual(object["url"] as? String, "http://sidecar/api/mail?q=a%2Cb")
        XCTAssertEqual(framed.body, Data("payload".utf8))
        let headers = (object["h"] as? [[String]] ?? []).map { $0[0] }
        XCTAssertTrue(headers.contains("Authorization"))
    }

    func testARequestBodyOverTheCapIsRefusedRatherThanFramed() {
        var request = URLRequest(url: URL(string: "http://sidecar/x")!)
        request.httpMethod = "POST"
        request.httpBody = Data(count: MAX_BODY_BYTES + 1)
        XCTAssertThrowsError(try EngineProtocol.encodeRequest(id: 1, request, baseURL: URL(string: "http://sidecar")!))
    }
}
