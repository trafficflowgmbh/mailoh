import Foundation

/// THE STDIO FRAME CODEC — the Swift half of the engine's own codec.
///
/// The local engine is a Node sidecar reached over the shell's
/// stdin/stdout — **no TCP listener**, so there is no port to authenticate and no local attack
/// surface. That makes this file the whole transport, and it has to survive the two things a pipe
/// does that an HTTP socket hides from you: chunks arrive at arbitrary boundaries, and a writer
/// that outruns its reader blocks.
///
/// ── THE WIRE ───────────────────────────────────────────────────────────────────────────────
///
///     uint32BE headerLen · uint32BE bodyLen · header JSON (headerLen bytes) · body (bodyLen bytes)
///
/// Both lengths are read together, in one 8-byte preamble, so BOTH caps are checked before a
/// single byte of either is allocated.
///
/// ── A CAP BREACH IS FATAL, DELIBERATELY ────────────────────────────────────────────────────
///
/// `bodyLen` comes off the wire. Without ``FrameLimits/maxBodyBytes`` a corrupted or hostile length
/// makes the decoder wait for — and eventually allocate — as many bytes as the number says. And
/// there is **no resync point** in a length-prefixed stream: once the two ends disagree about where
/// a frame starts, every subsequent byte is misread. So a breach throws ``FrameError`` and the
/// caller tears the child down rather than trying to recover from a position it cannot know.
///
/// ── THE FOUR NUMBERS ARE THE ENGINE'S ──────────────────────────────────────────────────────
///
/// They belong to the engine's codec, not to this shell, and a disagreement is a stream
/// that cannot be read. They are duplicated here because the shell is Swift and the engine is
/// TypeScript; there is no shared artifact to import. `FrameContractTests` records the source, and
/// the honest limitation is that it can only assert what this file says — nothing in a Swift test
/// can reach the engine's own source and compare.

/// Bumped when a change would make an older peer misread a frame.
public let PROTOCOL_VERSION = 1

/// Fixed-size preamble: two big-endian uint32 lengths.
public let PREAMBLE_BYTES = 8

/// The longest header JSON accepted. A header is a few hundred bytes; this is pure defence.
public let MAX_HEADER_BYTES = 64 * 1024

/// The largest body accepted in one frame. Sized against `DEFAULT_SYNC_BATCH_MAX_BYTES` in the
/// IMAP adapter, which is what a `/sync` page and an on-demand attachment fetch are bounded by.
public let MAX_BODY_BYTES = 32 * 1024 * 1024

public struct FrameLimits: Sendable, Equatable {
    public var maxHeaderBytes: Int
    public var maxBodyBytes: Int

    public init(maxHeaderBytes: Int = MAX_HEADER_BYTES, maxBodyBytes: Int = MAX_BODY_BYTES) {
        self.maxHeaderBytes = maxHeaderBytes
        self.maxBodyBytes = maxBodyBytes
    }

    public static let `default` = FrameLimits()
}

/// A protocol-level failure. **Fatal for the stream**: the peer and we no longer agree on framing.
public struct FrameError: Error, CustomStringConvertible, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// A decoded frame: its header bytes (already proven to be a JSON object) and its body bytes.
///
/// The header arrives as `Data` rather than a parsed dictionary because a parsed `[String: Any]` is
/// not `Sendable`, and this value crosses from the reader thread to whoever is waiting. `Protocol`
/// turns it into a typed, `Sendable` header. The cost is one extra parse of at most 64 KiB.
public struct Frame: Sendable, Equatable {
    public let header: Data
    public let body: Data

    public init(header: Data, body: Data) {
        self.header = header
        self.body = body
    }
}

/// A FIFO of byte chunks with no whole-buffer concatenation.
///
/// The obvious implementation — keep one `Data` and append each arriving chunk — is O(n²) in the
/// body size: an 8 MB body arriving in 64 KB pipe reads copies ~512 MB. This keeps the chunks and
/// copies each byte exactly once, when it is taken.
struct ByteQueue {
    private var chunks: [Data] = []
    private var head = 0          // how far into `chunks[0]` has already been consumed
    private(set) var count = 0

    mutating func push(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        chunks.append(chunk)
        count += chunk.count
    }

    /// The first `n` bytes, without consuming them. Callers check ``count`` first.
    func peek(_ n: Int) -> Data {
        var out = Data()
        out.reserveCapacity(n)
        var index = 0
        var skip = head
        while out.count < n, index < chunks.count {
            let chunk = chunks[index]
            let from = chunk.startIndex + skip
            let want = min(n - out.count, chunk.count - skip)
            out.append(chunk[from..<(from + want)])
            skip = 0
            index += 1
        }
        return out
    }

    /// Remove and return the first `n` bytes. Callers check ``count`` first.
    mutating func take(_ n: Int) -> Data {
        var out = Data()
        out.reserveCapacity(n)
        while out.count < n, !chunks.isEmpty {
            let chunk = chunks[0]
            let from = chunk.startIndex + head
            let available = chunk.count - head
            let want = min(n - out.count, available)
            out.append(chunk[from..<(from + want)])
            if want == available {
                chunks.removeFirst()
                head = 0
            } else {
                head += want
            }
        }
        count -= out.count
        return out
    }

    /// Drop the first `n` bytes without copying them out.
    mutating func drop(_ n: Int) {
        var remaining = n
        while remaining > 0, !chunks.isEmpty {
            let available = chunks[0].count - head
            if remaining >= available {
                chunks.removeFirst()
                head = 0
                remaining -= available
            } else {
                head += remaining
                remaining = 0
            }
        }
        count -= n - remaining
    }
}

/// Chunks in, whole frames out. Synchronous and allocation-frugal, so the read loop that feeds it
/// can never be the thing that blocks.
///
/// Not `Sendable`, and not locked: exactly one thread drives it — the frame reader started for one
/// run of the child.
public final class FrameDecoder {
    private var q = ByteQueue()
    /// Set once a preamble has been read and its header+body are still arriving.
    private var awaiting: (headerLen: Int, bodyLen: Int)?
    private let limits: FrameLimits

    public init(limits: FrameLimits = .default) {
        self.limits = limits
    }

    /// Whether anything is half-read. A clean EOF must find this true.
    public var isIdle: Bool { awaiting == nil && q.count == 0 }

    /// - Throws: ``FrameError`` on a malformed header or a length outside the caps — always fatal.
    public func push(_ chunk: Data) throws -> [Frame] {
        q.push(chunk)
        var out: [Frame] = []
        while true {
            if awaiting == nil {
                if q.count < PREAMBLE_BYTES { return out }
                let pre = q.peek(PREAMBLE_BYTES)
                let headerLen = Int(be32(pre, 0))
                let bodyLen = Int(be32(pre, 4))
                // Checked BEFORE the preamble is consumed and before anything is allocated, so a
                // wrong length is reported against the frame that carried it.
                if headerLen == 0 || headerLen > limits.maxHeaderBytes {
                    throw FrameError(
                        "frame header length \(headerLen) is outside 1...\(limits.maxHeaderBytes) — the peer "
                        + "is not speaking this protocol, or an earlier body length was wrong and the stream "
                        + "has lost frame alignment")
                }
                if bodyLen > limits.maxBodyBytes {
                    throw FrameError("frame body length \(bodyLen) exceeds the \(limits.maxBodyBytes)-byte cap")
                }
                q.drop(PREAMBLE_BYTES)
                awaiting = (headerLen, bodyLen)
            }
            guard let (headerLen, bodyLen) = awaiting else { return out }
            if q.count < headerLen + bodyLen { return out }
            let header = q.take(headerLen)
            try Self.assertJSONObject(header)
            let body = bodyLen == 0 ? Data() : q.take(bodyLen)
            awaiting = nil
            out.append(Frame(header: header, body: body))
        }
    }

    /// A header that is not a JSON object is as fatal as a wrong length: it means the bytes at that
    /// offset were never a header, so the stream has already lost alignment.
    static func assertJSONObject(_ bytes: Data) throws {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: bytes, options: [])
        } catch {
            throw FrameError("frame header is not JSON: \(error.localizedDescription)")
        }
        guard parsed is [String: Any] else {
            throw FrameError("frame header must be a JSON object")
        }
    }

    private func be32(_ d: Data, _ at: Int) -> UInt32 {
        let i = d.startIndex + at
        return (UInt32(d[i]) << 24) | (UInt32(d[i + 1]) << 16) | (UInt32(d[i + 2]) << 8) | UInt32(d[i + 3])
    }
}

/// Serialize one frame to bytes. Exported so a test can feed the decoder hand-built input.
public func encodeFrame(header: Data, body: Data = Data()) -> Data {
    var out = Data()
    out.reserveCapacity(PREAMBLE_BYTES + header.count + body.count)
    out.append(be32(UInt32(header.count)))
    out.append(be32(UInt32(body.count)))
    out.append(header)
    out.append(body)
    return out
}

func be32(_ v: UInt32) -> Data {
    Data([UInt8(truncatingIfNeeded: v >> 24), UInt8(truncatingIfNeeded: v >> 16),
          UInt8(truncatingIfNeeded: v >> 8), UInt8(truncatingIfNeeded: v)])
}

/// Frames out, with the pieces of one frame kept adjacent.
///
/// The serialization is load-bearing, not tidiness: a `write(2)` is only atomic up to `PIPE_BUF`, so
/// two concurrent frames each writing a preamble then a body would interleave into bytes the peer
/// cannot resynchronise from. Every frame therefore goes through one lock.
///
/// Backpressure needs no code here and does in Node: a blocking `write` on a full pipe simply waits,
/// which is the behaviour `FrameWriter` in `frame.ts` has to reconstruct out of `drain` events.
public final class FrameWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let limits: FrameLimits
    /// Nil once the far end is closed. Reading and closing both happen under ``lock``, so a close
    /// can never land between the check and the write and hand the write a reused descriptor.
    private var out: FileHandle?

    public init(_ out: FileHandle, limits: FrameLimits = .default) {
        self.out = out
        self.limits = limits
    }

    public func write(header: Data, body: Data = Data()) throws {
        if header.count > limits.maxHeaderBytes {
            throw FrameError("refusing to write a \(header.count)-byte header (cap \(limits.maxHeaderBytes))")
        }
        if body.count > limits.maxBodyBytes {
            throw FrameError("refusing to write a \(body.count)-byte body (cap \(limits.maxBodyBytes))")
        }
        lock.lock()
        defer { lock.unlock() }
        guard let out else { throw FrameError("the engine's input is closed") }
        // Preamble and header together, body separate: a 32 MB body is never copied into a second
        // 32 MB buffer just to be handed to the descriptor.
        var head = Data()
        head.reserveCapacity(PREAMBLE_BYTES + header.count)
        head.append(be32(UInt32(header.count)))
        head.append(be32(UInt32(body.count)))
        head.append(header)
        try out.write(contentsOf: head)
        if !body.isEmpty { try out.write(contentsOf: body) }
    }

    /// Close the far end. This is the graceful stop — see ``EngineProcess``.
    public func close() {
        lock.lock()
        defer { lock.unlock() }
        try? out?.close()
        out = nil
    }

    public var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return out != nil
    }
}
