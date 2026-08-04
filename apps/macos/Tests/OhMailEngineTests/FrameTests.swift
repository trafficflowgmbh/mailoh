import XCTest
@testable import OhMailEngine

/// The codec, driven with bytes this shell did not shape.
///
/// Every case here feeds the decoder input that a hostile or broken peer could send, because the
/// decoder is the only thing standing between a wrong number on the wire and a 4 GiB allocation.
final class FrameTests: XCTestCase {
    private func header(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func readyHeader() -> Data {
        header(["v": 1, "t": "ready", "baseUrl": "http://sidecar", "sessionToken": "tok",
                "accountId": "a", "userId": "u", "mailboxId": "m"])
    }

    // MARK: - The contract

    /// These four numbers belong to the engine's codec, not to this shell. They are asserted here so
    /// that changing one is a deliberate act with a red test attached — nothing in a Swift test can
    /// reach the engine's own codec and compare, and saying so is the point.
    func testFrameContractIsTheEngines() {
        XCTAssertEqual(PROTOCOL_VERSION, 1)
        XCTAssertEqual(PREAMBLE_BYTES, 8)
        XCTAssertEqual(MAX_HEADER_BYTES, 64 * 1024)
        XCTAssertEqual(MAX_BODY_BYTES, 32 * 1024 * 1024)
    }

    // MARK: - Reassembly

    func testAFrameSplitAcrossEveryByteBoundaryStillArrivesWhole() throws {
        let bytes = encodeFrame(header: readyHeader(), body: Data("a body".utf8))
        let decoder = FrameDecoder()
        var frames: [Frame] = []
        for byte in bytes {
            frames += try decoder.push(Data([byte]))
        }
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].header, readyHeader())
        XCTAssertEqual(frames[0].body, Data("a body".utf8))
        XCTAssertTrue(decoder.isIdle, "a whole frame leaves nothing half-read")
    }

    func testManyFramesInOneChunkAllComeOut() throws {
        var bytes = Data()
        for i in 0..<5 {
            bytes += encodeFrame(header: header(["v": 1, "t": "res", "id": i]), body: Data([UInt8(i)]))
        }
        let decoder = FrameDecoder()
        let frames = try decoder.push(bytes)
        XCTAssertEqual(frames.count, 5)
        XCTAssertEqual(frames.map(\.body), (0..<5).map { Data([UInt8($0)]) })
    }

    func testAnEmptyBodyIsAnEmptyBodyAndNotAMissingOne() throws {
        let decoder = FrameDecoder()
        let frames = try decoder.push(encodeFrame(header: readyHeader()))
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].body, Data())
    }

    func testAPartialFrameIsHeldRatherThanGuessedAt() throws {
        let bytes = encodeFrame(header: readyHeader(), body: Data("xyz".utf8))
        let decoder = FrameDecoder()
        XCTAssertEqual(try decoder.push(bytes.prefix(bytes.count - 1)).count, 0)
        XCTAssertFalse(decoder.isIdle, "a clean EOF must be able to tell this apart from a boundary")
        XCTAssertEqual(try decoder.push(bytes.suffix(1)).count, 1)
        XCTAssertTrue(decoder.isIdle)
    }

    // MARK: - A cap breach is fatal, deliberately

    func testABodyLengthOverTheCapThrowsBeforeAnythingIsAllocated() {
        var preamble = Data()
        preamble.append(be32(12))
        preamble.append(be32(UInt32(MAX_BODY_BYTES + 1)))
        let decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push(preamble)) { error in
            XCTAssertTrue("\(error)".contains("exceeds the \(MAX_BODY_BYTES)-byte cap"), "\(error)")
        }
    }

    func testAHeaderLengthOutsideTheCapsThrows() {
        for headerLen in [UInt32(0), UInt32(MAX_HEADER_BYTES + 1)] {
            var preamble = Data()
            preamble.append(be32(headerLen))
            preamble.append(be32(0))
            let decoder = FrameDecoder()
            XCTAssertThrowsError(try decoder.push(preamble), "header length \(headerLen)") { error in
                XCTAssertTrue("\(error)".contains("lost frame alignment"), "\(error)")
            }
        }
    }

    /// The cap is checked against the DECLARED length, not against what has arrived. A decoder that
    /// waited for the bytes before judging them would buffer up to the wrong number first, which is
    /// the whole attack.
    func testTheCapIsJudgedOnTheDeclarationAndNotOnArrival() {
        var preamble = Data()
        preamble.append(be32(12))
        preamble.append(be32(UInt32(MAX_BODY_BYTES + 1)))
        let decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push(preamble.prefix(8)))
    }

    func testAHeaderThatIsNotJSONIsFatal() {
        let decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push(encodeFrame(header: Data("not json".utf8)))) { error in
            XCTAssertTrue("\(error)".contains("not JSON"), "\(error)")
        }
    }

    func testAHeaderThatIsJSONButNotAnObjectIsFatal() {
        let decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push(encodeFrame(header: Data("[1,2,3]".utf8)))) { error in
            XCTAssertTrue("\(error)".contains("must be a JSON object"), "\(error)")
        }
    }

    /// A stray write to the frame stream — the thing the engine replaces its own `process.stdout`
    /// to prevent. Prose read as a preamble gives a nonsense header length, and there is nothing to
    /// resynchronise to.
    func testProseOnTheWireIsFatalRatherThanSkipped() {
        let decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push(Data("a stray console.log\n".utf8)))
    }

    // MARK: - Writing

    func testTheWriterRefusesABodyOverTheCapRatherThanTruncatingIt() throws {
        let pipe = Pipe()
        let writer = FrameWriter(pipe.fileHandleForWriting, limits: FrameLimits(maxHeaderBytes: 64, maxBodyBytes: 4))
        XCTAssertThrowsError(try writer.write(header: Data("{}".utf8), body: Data(repeating: 0, count: 5)))
        XCTAssertThrowsError(try writer.write(header: Data(repeating: 0x20, count: 65)))
        writer.close()
    }

    func testAClosedWriterThrowsRatherThanWritingIntoAReusedDescriptor() {
        let pipe = Pipe()
        let writer = FrameWriter(pipe.fileHandleForWriting)
        writer.close()
        XCTAssertFalse(writer.isOpen)
        XCTAssertThrowsError(try writer.write(header: Data("{}".utf8)))
    }

    /// The write happens on its own thread on purpose. A 100 KiB body is larger than a pipe buffer,
    /// so a writer and a reader on ONE thread deadlock — which is the same shape as the deadlock
    /// `frame.ts` is written to avoid, arriving in the test instead of in the code.
    func testWhatTheWriterWritesIsWhatTheDecoderReads() throws {
        let pipe = Pipe()
        let writer = FrameWriter(pipe.fileHandleForWriting)
        let body = Data(repeating: 0xAB, count: 100 * 1024)
        let header = readyHeader()
        Thread.detachNewThread {
            try? writer.write(header: header, body: body)
            writer.close()
        }

        let decoder = FrameDecoder()
        var frames: [Frame] = []
        while let chunk = try pipe.fileHandleForReading.read(upToCount: 64 * 1024), !chunk.isEmpty {
            frames += try decoder.push(chunk)
        }
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].body, body)
    }

    /// Concurrent writers must not interleave a preamble into another frame's body. Serialization is
    /// the property; a peer cannot resynchronise from bytes that were shuffled.
    func testConcurrentFramesAreNotInterleaved() throws {
        let pipe = Pipe()
        let writer = FrameWriter(pipe.fileHandleForWriting)
        let bodies = (0..<8).map { Data(repeating: UInt8($0), count: 200 * 1024) }

        // Read concurrently: 8 × 200 KiB is far more than a pipe buffer, so a writer that is not
        // drained blocks and the test would deadlock rather than fail.
        let collected = Collected<Data>()
        let reading = Thread {
            let decoder = FrameDecoder()
            while let chunk = try? pipe.fileHandleForReading.read(upToCount: 64 * 1024), !chunk.isEmpty {
                if let frames = try? decoder.push(chunk) {
                    for frame in frames { collected.add(frame.body) }
                } else {
                    return
                }
            }
        }
        reading.start()

        let headers = (0..<bodies.count).map { header(["v": 1, "t": "res", "id": $0]) }
        DispatchQueue.concurrentPerform(iterations: bodies.count) { i in
            try? writer.write(header: headers[i], body: bodies[i])
        }
        writer.close()
        waitFor("every frame to arrive") { collected.count == bodies.count }

        let seen = collected.all
        for body in seen {
            XCTAssertEqual(Set(body), Set([body.first!]), "a frame body carries another frame's bytes")
            XCTAssertEqual(body.count, 200 * 1024)
        }
        XCTAssertEqual(Set(seen.map { $0.first! }), Set(bodies.map { $0.first! }))
    }
}
