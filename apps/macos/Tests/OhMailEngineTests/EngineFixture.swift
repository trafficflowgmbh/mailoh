import Foundation
import XCTest
@testable import OhMailEngine

/// The stand-in engine, and the two probes that ask the operating system rather than this shell.
///
/// Nothing in the supervisor tests is a mock. Every test that says "the engine" starts an actual
/// operating-system process, over an actual pipe, and the assertions are about processes: whether
/// one is running, whether it is gone, how many times it was started. A supervisor tested against a
/// fake process table would prove nothing about the failure this module exists to prevent — an
/// engine left running after the app has quit, holding an authenticated IMAP connection against a
/// server that caps them.
///
/// The stand-in is Node, which is what the real engine is. It speaks the same frames and honours the
/// same stdin-EOF contract, so a test that passes here is a test about this shell's half of the
/// protocol rather than about a script that was written to agree with it.
///
/// The modes, in the order the tests use them:
///
///  · `serve`          — announce ready, then leave when stdin ends. What the real one does.
///  · `serve-then-die` — announce ready, then exit non-zero after a moment.
///  · `serve-deaf`     — announce ready and then ignore stdin entirely. Never leaves.
///  · `die`            — exit 1 without ever announcing. What a locked data directory looks like.
///  · `mute`           — run forever and never announce. A live pid that is not a running engine.
///  · `noise`          — announce ready, then write a line of prose to the frame stream.
///  · `oversize`       — announce ready, then declare a body one byte over the 32 MiB cap.
///  · `badheader`      — announce ready, then send a frame whose header is not JSON.
///  · `echo`           — announce ready, then answer requests **slowest first**, so a client that
///                       correlated by arrival order would return the wrong body.
///
/// Every mode appends a line to `$FAKE_LOG` on start and on exit, which is how a test counts starts
/// and proves an exit independently of anything this shell reports about itself.
let fakeEngineSource = #"""
const fs = require("node:fs");
const mode = process.argv[2];
const log = process.env.FAKE_LOG;
const note = (what) => { if (log) fs.appendFileSync(log, what + " " + process.pid + "\n"); };
note("start");
process.on("exit", () => note("exit"));

function raw(bytes) { process.stdout.write(bytes); }
function frame(header, body) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const b = body ?? Buffer.alloc(0);
  const pre = Buffer.alloc(8);
  pre.writeUInt32BE(h.length, 0);
  pre.writeUInt32BE(b.length, 4);
  raw(Buffer.concat([pre, h, b]));
}
const TOKEN = process.env.FAKE_TOKEN || ("tok_" + "a".repeat(24));
const ready = () => frame({
  v: 1, t: "ready", baseUrl: "http://sidecar",
  sessionToken: TOKEN,
  accountId: "acc-1", userId: "usr-1", mailboxId: "mbx-1",
});

if (mode === "die") { process.exit(1); }

if (mode !== "mute") { ready(); }

// The real engine leaves when its stdin ends; `serve-deaf` is the one that does not.
if (mode !== "serve-deaf") {
  process.stdin.on("end", () => process.exit(0));
}

if (mode === "echo") {
  // A length-prefixed decoder, so the stand-in reads requests the way the engine does.
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 8) return;
      const hl = buf.readUInt32BE(0), bl = buf.readUInt32BE(4);
      if (buf.length < 8 + hl + bl) return;
      const header = JSON.parse(buf.subarray(8, 8 + hl).toString("utf8"));
      const body = buf.subarray(8 + hl, 8 + hl + bl);
      buf = buf.subarray(8 + hl + bl);
      // SLOWEST FIRST. `?delay=<ms>` on the request decides when it is answered, so a client that
      // matched answers to requests by arrival order gets them swapped.
      const delay = Number(new URL(header.url).searchParams.get("delay") || 0);
      setTimeout(() => {
        frame({
          v: 1, t: "res", id: header.id, status: 200, statusText: "OK",
          h: [["content-type", "text/plain"], ["x-echo-method", header.method]],
          sc: (new URL(header.url).searchParams.get("cookies") || "").split("|").filter(Boolean),
        }, body.length ? body : Buffer.from(String(header.id), "utf8"));
      }, delay);
    }
  });
}

process.stdin.resume();

if (mode === "serve-then-die") { setTimeout(() => process.exit(9), 60); }
if (mode === "noise") { setTimeout(() => raw("a stray console.log\n"), 30); }
if (mode === "oversize") {
  setTimeout(() => {
    const h = Buffer.from(JSON.stringify({ v: 1, t: "res", id: 1 }), "utf8");
    const pre = Buffer.alloc(8);
    pre.writeUInt32BE(h.length, 0);
    pre.writeUInt32BE(32 * 1024 * 1024 + 1, 4);   // one byte over the cap
    raw(Buffer.concat([pre, h]));
  }, 30);
}
if (mode === "badheader") {
  setTimeout(() => {
    const h = Buffer.from("not json at all", "utf8");
    const pre = Buffer.alloc(8);
    pre.writeUInt32BE(h.length, 0);
    pre.writeUInt32BE(0, 4);
    raw(Buffer.concat([pre, h]));
  }, 30);
}
setInterval(() => {}, 1000);
"""#

/// Node, which the engine is written in and which every build of this app already needs.
///
/// Absent on a machine that has only the Swift toolchain, which is the public CI runner's shape for
/// the packaging job — so the supervisor tests skip rather than fail there, and say so.
func nodePath() throws -> String {
    if let explicit = ProcessInfo.processInfo.environment["OHMAIL_TEST_NODE"] { return explicit }
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    where FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    let which = Process()
    which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    which.arguments = ["which", "node"]
    let out = Pipe()
    which.standardOutput = out
    which.standardError = FileHandle.nullDevice
    try? which.run()
    which.waitUntilExit()
    let found = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !found.isEmpty { return found }
    throw XCTSkip("node is not on this machine, and the stand-in engine is a Node process")
}

/// Fast timings. The behaviour under test is the ordering and the bounds, not the numbers —
/// `EngineContractTests` is what pins the numbers.
let quickTimings = EngineTimings(stopGrace: 0.4, healthyFor: 60, backoffBase: 0.02, backoffCap: 0.04, poll: 0.01)

final class EngineFixture {
    let directory: URL
    let script: URL
    let logFile: URL
    private let node: String

    init(_ name: String) throws {
        node = try nodePath()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ohmail-engine-test-\(getpid())-\(name)-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        script = directory.appendingPathComponent("fake-engine.cjs")
        try Data(fakeEngineSource.utf8).write(to: script)
        logFile = directory.appendingPathComponent("starts.log")
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    func launch(_ mode: String, token: String? = nil) -> EngineLaunch {
        var environment: [(name: String, value: String)] = [("FAKE_LOG", logFile.path)]
        if let token { environment.append(("FAKE_TOKEN", token)) }
        return EngineLaunch(program: URL(fileURLWithPath: node),
                            arguments: [script.path, mode],
                            environment: environment)
    }

    var lines: [String] {
        (try? String(contentsOf: logFile, encoding: .utf8))?
            .split(separator: "\n").map(String.init) ?? []
    }

    var starts: Int { lines.filter { $0.hasPrefix("start ") }.count }
    var exits: Int { lines.filter { $0.hasPrefix("exit ") }.count }
}

/// A thread-safe list, for the tests that collect what a background thread produced.
final class Collected<Element>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    func add(_ item: Element) {
        lock.lock(); defer { lock.unlock() }
        items.append(item)
    }

    var all: [Element] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    var count: Int { all.count }
}

/// Poll until `done`, or fail the test.
func waitFor(_ what: String, within: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line,
             _ done: () -> Bool) {
    let deadline = Date().addingTimeInterval(within)
    while Date() < deadline {
        if done() { return }
        Thread.sleep(forTimeInterval: 0.01)
    }
    XCTFail("timed out after \(within)s waiting for \(what)", file: file, line: line)
}

/// Is this process id one the operating system still knows about?
///
/// `kill -0` is the portable probe — it asks the kernel and changes nothing. It shells out rather
/// than take a dependency on a signal-handling detour for one line in one test.
///
/// It **fails the test** when the probe itself cannot be run. An earlier version of the Rust
/// original used `ps -p` and returned `false` when the command failed, which made
/// `XCTAssertFalse(alive(pid))` pass on a machine where the probe did not work — a guard that cannot
/// fail, asserting nothing, in the one test that exists to catch a leaked process.
func isAlive(_ pid: Int32, file: StaticString = #filePath, line: UInt = #line) -> Bool {
    for kill in ["/bin/kill", "/usr/bin/kill"] where FileManager.default.isExecutableFile(atPath: kill) {
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: kill)
        probe.arguments = ["-0", String(pid)]
        probe.standardOutput = FileHandle.nullDevice
        probe.standardError = FileHandle.nullDevice
        do {
            try probe.run()
        } catch {
            XCTFail("could not run \(kill) to probe pid \(pid): \(error)", file: file, line: line)
            return true
        }
        probe.waitUntilExit()
        return probe.terminationStatus == 0
    }
    XCTFail("no kill(1) to probe pid \(pid) with — this test cannot tell a live process from a dead one",
            file: file, line: line)
    return true
}

/// Every `ohmail-engine`-ish process the kernel currently has, by full command line.
func processTable() -> String {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-Ao", "pid,command"]
    let out = Pipe()
    ps.standardOutput = out
    ps.standardError = FileHandle.nullDevice
    try? ps.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    ps.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
}
