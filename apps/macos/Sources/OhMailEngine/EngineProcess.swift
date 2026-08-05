import Dispatch
import Foundation

/// THE LOCAL ENGINE'S LIFECYCLE — start it with the app, watch it while it runs, and make certain
/// it is gone when the app is.
///
/// The Swift port of `apps/desktop/src-tauri/src/engine.rs`. The reasoning below is that file's and
/// is repeated rather than referenced, because a shell that has to open another artifact's source to
/// know why its stdin may not be handed to a second child will not open it.
///
/// ── THE CONTRACT, WHICH IS THE ENGINE'S AND NOT INVENTED HERE ──────────────────────────────
///
/// The engine is a Node process that speaks **length-prefixed frames over its own stdin and
/// stdout**. There is no TCP listener, no port and no socket: the only party that can reach it is
/// the process holding the pipe, which is this one. Four consequences shape everything below.
///
///  1. **stdout is the wire.** Diagnostics go to stderr; the engine goes as far as replacing its own
///     `process.stdout.write` so that a stray `console.log` cannot inject bytes into a frame. A
///     length-prefixed stream has no resync point, so a malformed frame is unrecoverable by
///     construction and the only correct response is to tear the process down.
///  2. **Closing its stdin is how you ask it to leave.** The engine answers EOF on stdin by refusing
///     new requests, letting in-flight ones finish, closing IMAP and closing its database — in that
///     order, because closing the database under a live handler is what corrupts the local mirror.
///     So the graceful stop here is a `close()`, not a signal.
///  3. **That same EOF is the orphan defence, and it works even when this process is killed.**
///     Nothing else holds the write end of that pipe. If the shell dies — cleanly, by crash, or by
///     `kill -9` — the kernel closes it, the engine reads EOF and shuts itself down. A stray engine
///     holding an authenticated IMAP connection is therefore not merely handled on the quit path; it
///     is structurally impossible while the pipe stays private to this process. **Never hand that
///     stdin to a second child, and never leak the handle.**
///  4. **Configuration travels in the environment**, and the engine invents nothing: it needs a data
///     directory and a mailbox to open. The mailbox PASSWORD does not travel that way — it is typed
///     once and sealed into the engine's own store under a per-install key, and the environment
///     carries the key instead. See ``requiredEngineVars``.
///
/// ── WHAT "RUNNING" MEANS ───────────────────────────────────────────────────────────────────
///
/// A live pid is not a running engine. The engine announces itself with a single unsolicited `ready`
/// frame once it is serving, and everything that can go wrong at start — a data directory another
/// copy already holds, a credential the keystore did not supply, a schema migration that failed —
/// produces a process that exists and will never serve. So ``EngineStatus/serving(mailboxID:)`` is
/// reached by reading that frame, never by observing that the spawn succeeded.
///
/// ── EXACTLY ONE ENGINE PER MAILBOX ─────────────────────────────────────────────────────────
///
/// Two copies of the app launched at once do not produce two engines, and the defence is not in this
/// file. The engine takes an exclusive lock on its data directory before it dials anything, so the
/// second one fails while starting and exits — before an IMAP socket is opened and before any claim
/// is written to the mailbox. The supervisor's part is only to not make that worse: it retries a
/// bounded number of times and then stays down with a reason, rather than hammering a directory
/// another process legitimately owns.

/// The engine's file name beside the shell's own executable.
public let ENGINE_FILE_STEM = "ohmail-engine"

/// An explicit path to the engine, which overrides looking beside the executable.
public let ENGINE_PATH_VAR = "OHMAIL_ENGINE"

/// An explicit path to the Node runtime the engine is spawned with, overriding the search in
/// ``EngineProcess/resolveNode(environment:fileManager:)``.
public let NODE_PATH_VAR = "OHMAIL_NODE"

/// Where the local mirror lives. Supplied by the shell when the environment does not name one.
public let DATA_DIR_VAR = "OHMAIL_DATA_DIR"

/// The per-install key-encryption key. Composed from ``KeyProvider``, not read for the child.
public let KEK_VAR = "OHMAIL_KEK"

/// What the shell refuses to spawn the engine without. Naming them beats starting a process whose
/// only outcome is a failed start or an install that can never store a credential.
///
/// The first two are the engine's own requirement: it refuses to start without a mailbox to open,
/// and it invents neither. The third is this shell's, and the distinction matters —
///
/// **The key is the shell's, and the password is not.** The engine seals the mailbox password into
/// its local store under a per-install key-encryption key and reads it back on every later launch,
/// so the environment carries the key and the password is typed once, over the bridge. An engine
/// started WITHOUT a key still runs and still serves the mirror; what it cannot do is store a
/// password, so the user types one into a field that answers 503. That is a worse failure than not
/// starting, because it looks like the product working right up until it does not — which is why
/// the key is on this list even though the engine does not demand it.
///
/// `OHMAIL_IMAP_PASS` is deliberately absent: requiring it would mean the password travelled in
/// process state on every launch, which is exactly what sealing it removed. The engine still accepts
/// one if the environment happens to carry it, and this shell never composes it.
public let requiredEngineVars = ["OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER", KEK_VAR]

/// The five durations and the one count the supervisor's behaviour is defined by, in one place so a
/// test can watch a five-second grace period expire without taking five seconds.
///
/// A parameter and not an environment variable: a knob read from the environment is a knob a shipped
/// app has, and the shipped app has exactly one set of timings — ``EngineTimings/default``, which is
/// asserted to be the constants documented on each field.
public struct EngineTimings: Equatable, Sendable {
    /// How long the engine gets to finish leaving after its stdin is closed, before it is killed.
    ///
    /// A judgement, not a measurement. What it has to cover is the engine's documented shutdown
    /// order — finish in-flight requests, close IMAP, close the database — and the one unbounded
    /// term in it is a sync cycle already in progress, which the engine stops re-entering but does
    /// not cancel. Long enough that an ordinary quit is never killed; short enough that quitting the
    /// app is not something a user waits on. The escalation is a hard kill of a process that may be
    /// mid-write, which is the whole reason there is a grace period at all.
    public var stopGrace: TimeInterval
    /// A run that served for at least this long, and actually served, is treated as healthy: the
    /// restart budget resets. Without this an app left open for a week would spend its fourth
    /// restart on the fourth unrelated crash and then refuse to come back.
    public var healthyFor: TimeInterval
    public var backoffBase: TimeInterval
    public var backoffCap: TimeInterval
    /// How often the supervisor looks at the child. Small enough to be invisible, large enough to
    /// cost nothing.
    public var poll: TimeInterval

    public init(stopGrace: TimeInterval, healthyFor: TimeInterval,
                backoffBase: TimeInterval, backoffCap: TimeInterval, poll: TimeInterval) {
        self.stopGrace = stopGrace
        self.healthyFor = healthyFor
        self.backoffBase = backoffBase
        self.backoffCap = backoffCap
        self.poll = poll
    }

    public static let `default` = EngineTimings(
        stopGrace: 5, healthyFor: 60, backoffBase: 1, backoffCap: 8, poll: 0.025)

    /// How many times the engine may be started before the shell gives up: one start and three
    /// restarts.
    ///
    /// A restart loop against an engine that cannot start is worse than staying down. Every failure
    /// mode that is worth restarting for is transient (a crash, a killed process); every one that is
    /// not — a locked data directory, a missing credential, a corrupt mirror — fails identically on
    /// every attempt, and retrying it forever burns CPU, fills the log and hides the cause.
    public static let maxStarts = 4

    /// The delay before attempt `n`. Doubling from ``backoffBase``, capped at ``backoffCap``.
    public func backoff(attempt: Int) -> TimeInterval {
        let shift = min(max(attempt - 2, 0), 16)
        return min(backoffBase * TimeInterval(1 << shift), backoffCap)
    }
}

/// Everything needed to start the engine once.
public struct EngineLaunch: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let program: URL
    public let arguments: [String]
    /// Overlaid on the shell's own environment, which the engine otherwise inherits.
    public let environment: [(name: String, value: String)]

    public init(program: URL, arguments: [String] = [], environment: [(name: String, value: String)] = []) {
        self.program = program
        self.arguments = arguments
        self.environment = environment
    }

    public static func == (a: EngineLaunch, b: EngineLaunch) -> Bool {
        a.program == b.program && a.arguments == b.arguments
            && a.environment.count == b.environment.count
            && zip(a.environment, b.environment).allSatisfy { $0.name == $1.name && $0.value == $1.value }
    }

    /// Names its environment and prints no value.
    ///
    /// One of the two values composed here IS the per-install key. A synthesised description would
    /// put that key in the first crash report that formats a plan, which is the leak this type
    /// exists to make impossible rather than merely unlikely.
    public var description: String {
        "EngineLaunch(program: \(program.path), arguments: \(arguments), "
            + "environment: \(environment.map(\.name)))"
    }

    public var debugDescription: String { description }
}

/// What the shell decided to do about the engine, before doing any of it.
public enum EnginePlan: Equatable, Sendable {
    case spawn(EngineLaunch)
    /// Nothing to run, and a status that says why.
    case inert(EngineStatus)
}

/// WHETHER THIS BUILD CARRIES AN ENGINE — the question that has to be answered before the app asks
/// anybody for a mail password.
///
/// It exists because "there is no engine" and "there is no mailbox yet" look identical from inside a
/// fresh install, and the app used to guess. A build with nothing to spawn opened the setup form,
/// collected an IMAP host, a user and a password, and only at the spawn — after the credential —
/// discovered there was no engine to hand any of it to. A download that asks a stranger for their
/// mail password and cannot use it is the worst shape a broken claim has.
///
/// **Answered by looking, and never by a flag or a build constant.** A packaging change that stops
/// copying the engine is exactly the change that would forget to flip a flag, and the flag would
/// then be a claim about the bundle that the bundle does not support. The filesystem is asked
/// instead, about the same path the spawn will use — see ``EngineProcess/install(environment:executableDirectory:fileManager:)``.
public enum EngineInstall: Equatable, Sendable {
    /// There is something runnable where the engine is looked for.
    case installed
    /// There is not, and this is where it was looked for. The path is the payload because it is the
    /// only actionable thing there is to say about it.
    case missing(lookedFor: String)
}

/// Where frames that are not `ready` go, and how the far end learns a run has ended.
///
/// Held **weakly** by ``EngineProcess``: the shell owns both, and a sink that kept the engine alive
/// would be the retain cycle that outlives the window.
public protocol EngineFrameSink: AnyObject, Sendable {
    func engineDidReceive(_ header: FrameHeader)
    /// Every in-flight request must be failed. A promise that silently never settles is the worst
    /// failure a bridge can have — a spinner forever and no log saying why.
    func engineStreamDidEnd(_ error: Error)
}

/// The engine, its supervisor thread, and the handle that stops both.
public final class EngineProcess: @unchecked Sendable {
    // MARK: - Deciding what to run

    /// A value that is present and is not blank. A variable set to spaces is a variable somebody
    /// meant to unset, and treating it as supplied produces a spawn against an empty path.
    static func present(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : value
    }

    /// Where the engine is looked for.
    enum ProgramLocation: Equatable {
        case at(URL)
        /// Nowhere to look, and the sentence that says why.
        case unresolvable(String)
    }

    /// **ONE RESOLUTION, SHARED BY THE CHECK AND THE SPAWN.**
    ///
    /// A second copy of these four lines would be a build that stats one path and launches another,
    /// and it fails silently in the direction that matters: the check says the engine is installed,
    /// the spawn says `NotFound`, and the trap the check exists to close is back with a layer on top
    /// of it.
    static func locate(environment env: [String: String],
                       executableDirectory exeDir: URL?) -> ProgramLocation {
        if let explicit = present(env[ENGINE_PATH_VAR]) {
            return .at(URL(fileURLWithPath: explicit))
        }
        if let exeDir {
            return .at(exeDir.appendingPathComponent(ENGINE_FILE_STEM))
        }
        return .unresolvable(
            "\(ENGINE_PATH_VAR) is not set and this executable's own directory could not be resolved")
    }

    /// Whether this build carries an engine, asked of the filesystem.
    ///
    /// **THE ONE STAT, AND IT IS DELIBERATE.** ``plan(environment:executableDirectory:dataDirectoryFallback:keys:)``
    /// touches no filesystem on purpose: whether the engine exists is answered there by trying to
    /// start it and reading `NotFound` back, which is one syscall instead of two and cannot go stale
    /// between a check and a spawn. That is still the authority for a launch, and nothing here
    /// replaces it.
    ///
    /// This answers a different question at a different moment — *may this build put a password form
    /// on screen at all* — and it has to be answered before anything is spawned, because the whole
    /// point is not to have collected a credential by the time the spawn fails.
    ///
    /// **Runnable, not merely present.** A directory at that path, or a file without the execute bit,
    /// is not an engine: the spawn would fail with a permission error rather than `NotFound`, which
    /// is a *different sentence* for the same absence and re-opens a narrower version of the same
    /// trap. What is asked is the thing that matters — is there something here this app could run.
    public static func install(environment env: [String: String],
                               executableDirectory exeDir: URL?,
                               fileManager: FileManager = .default) -> EngineInstall {
        switch locate(environment: env, executableDirectory: exeDir) {
        case .unresolvable(let why):
            return .missing(lookedFor: why)
        case .at(let program):
            var isDirectory: ObjCBool = false
            let exists = fileManager.fileExists(atPath: program.path, isDirectory: &isDirectory)
            let runnable = exists && !isDirectory.boolValue
                && fileManager.isExecutableFile(atPath: program.path)
            return runnable ? .installed : .missing(lookedFor: program.path)
        }
    }

    /// The directory the shipped app looks in: the one its own executable is in.
    ///
    /// Here rather than spelled at each call site, because both the install check and the spawn's
    /// plan need it and a second spelling is a second place for them to disagree.
    public static var bundledEngineDirectory: URL? {
        Bundle.main.executableURL?.deletingLastPathComponent()
    }

    /// The Node runtime the engine is spawned with, or `nil` when this build can find none.
    ///
    /// **THE ENGINE IS A NODE SCRIPT AND THIS BETA VENDORS NO RUNTIME**, so one has to be found on
    /// the machine. The trap this closes is that a Finder or launchd launch runs with
    /// `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no nvm — so the engine's own
    /// `#!/usr/bin/env node` shebang finds nothing even when the user HAS Node installed. So the
    /// runtime is resolved explicitly here, and its directory is prepended to the child's `PATH` in
    /// ``supervise(_:)`` so the shebang runs THIS node.
    ///
    /// Order, most specific first: ``NODE_PATH_VAR`` (an operator's exact choice), then the two
    /// default package locations (Homebrew on Apple silicon, then on Intel / the older prefix), then
    /// whatever the inherited `PATH` already carries — the developer case, whose terminal `PATH` has
    /// node on it. **Runnable, not merely present**, the same bar ``install(environment:executableDirectory:fileManager:)``
    /// holds the engine to: a directory or a non-executable at that path is not a runtime.
    static func resolveNode(environment env: [String: String], fileManager fm: FileManager = .default) -> URL? {
        func runnable(_ path: String) -> URL? {
            var isDir: ObjCBool = false
            let ok = fm.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
                && fm.isExecutableFile(atPath: path)
            return ok ? URL(fileURLWithPath: path) : nil
        }
        if let explicit = present(env[NODE_PATH_VAR]), let url = runnable(explicit) { return url }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if let url = runnable(candidate) { return url }
        }
        for dir in (env["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: true) {
            if let url = runnable("\(dir)/node") { return url }
        }
        return nil
    }

    /// Decide whether there is an engine to start, and how — **without touching the filesystem.**
    ///
    /// Nothing here stats a path. Whether the engine exists is answered by trying to start it and
    /// reading `NotFound` back, which is one syscall instead of two and cannot go stale between the
    /// check and the spawn.
    ///
    /// The key comes from `keys` first and the environment second. Once the Keychain slice lands, the
    /// Keychain is the store and an environment variable must not be able to silently displace it;
    /// with ``KeyProviderDefault`` in place the environment is still how a developer runs an engine.
    public static func plan(
        environment env: [String: String],
        executableDirectory exeDir: URL?,
        dataDirectoryFallback fallback: URL?,
        keys: KeyProvider = KeyProviderDefault()
    ) -> EnginePlan {
        let program: URL
        switch locate(environment: env, executableDirectory: exeDir) {
        case .at(let resolved):
            program = resolved
        case .unresolvable(let why):
            return .inert(.absent(lookedFor: why))
        }

        // A keystore that CANNOT BE READ is not a keystore that is empty. Minting a fresh key over a
        // locked keychain would seal the next password under a key that replaced the one every
        // stored credential still needs, so this is a different status and a different sentence.
        let stored: String?
        do {
            stored = try keys.kek()
        } catch {
            return .inert(.failed(
                reason: "the key store could not be read (\(error.localizedDescription)), so the engine was "
                    + "not started. Starting without a key would let a password be typed into a field that "
                    + "cannot store it.",
                last: nil))
        }
        let kek = present(stored) ?? present(env[KEK_VAR])

        var missing: [String] = []
        for name in requiredEngineVars {
            let supplied = name == KEK_VAR ? kek : present(env[name])
            if supplied == nil { missing.append(name) }
        }

        let dataDir = present(env[DATA_DIR_VAR]) ?? fallback?.path
        if dataDir == nil { missing.append(DATA_DIR_VAR) }

        if !missing.isEmpty { return .inert(.notConfigured(missing: missing)) }

        // ONLY THE DATA DIRECTORY AND THE KEY, AND THAT INCLUDES NOT COMPOSING A PASSWORD.
        //
        // Everything else the engine reads is already in the environment this process was given and
        // the child inherits it, so re-listing the variables here would be a second copy of the
        // engine's configuration contract, drifting from the first. These two are the exceptions
        // because they are the values the shell KNOWS rather than reads: the data directory is
        // derived from the app's own identifier, and the key comes from the keystore this shell
        // owns.
        //
        // A first launch looks exactly like every later one. The shell hands over a key, never a
        // password; the password is typed once into the running app and sealed into the engine's
        // store, and the launch after that opens the mailbox from the store. There is no first-run
        // special case to get wrong, and no launch on which a password sits in process state that
        // anything running as this user could read.
        return .spawn(EngineLaunch(
            program: program,
            arguments: [],
            environment: [(DATA_DIR_VAR, dataDir!), (KEK_VAR, kek!)]))
    }

    /// The data directory the shell knows rather than reads: the app's own Application Support
    /// folder, named by the bundle identifier `io.ohmail.desktop`.
    public static var defaultDataDirectory: URL {
        applicationSupportDirectory
    }

    static var applicationSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("io.ohmail.desktop")
    }

    // MARK: - State

    private struct Shared {
        var status: EngineStatus
        /// The write end of the engine's stdin, and the only one that exists. Closing it is the
        /// graceful stop; see the type's header.
        var writer: FrameWriter?
        var pid: Int32?
        var ready: EngineReady?
        /// How the last run ended, as the operating system reported it. An exit status exists only
        /// for a process that has terminated and been reaped, which makes this the one piece of
        /// evidence about a dead engine that does not come from this file's own bookkeeping.
        var lastExit: EngineExit?
        /// Set by the frame reader when the stream stops being readable as frames. Unrecoverable.
        var fault: String?
        var stop = false
        /// When the current child must be killed if it has not left by itself.
        var deadline: Date?
        var finished: Bool
    }

    private let cond = NSCondition()
    private var s: Shared
    private let timings: EngineTimings
    private let launch: EngineLaunch?
    private let onStatusChange: (@Sendable (EngineStatus) -> Void)?
    private weak var sink: (any EngineFrameSink)?
    private var started = false

    private init(status: EngineStatus, launch: EngineLaunch?, timings: EngineTimings,
                 onStatusChange: (@Sendable (EngineStatus) -> Void)?) {
        self.s = Shared(status: status, finished: launch == nil)
        self.launch = launch
        self.timings = timings
        self.onStatusChange = onStatusChange
        if launch == nil { Self.log(status.description) }
    }

    /// An engine that was never going to run: no binary, or nothing to configure it with.
    public static func inert(_ status: EngineStatus,
                             onStatusChange: (@Sendable (EngineStatus) -> Void)? = nil) -> EngineProcess {
        EngineProcess(status: status, launch: nil, timings: .default, onStatusChange: onStatusChange)
    }

    /// An engine that will be started by ``start()``.
    public convenience init(launch: EngineLaunch,
                            timings: EngineTimings = .default,
                            onStatusChange: (@Sendable (EngineStatus) -> Void)? = nil) {
        self.init(status: .starting(attempt: 1), launch: launch, timings: timings, onStatusChange: onStatusChange)
    }

    /// Act on a plan.
    public static func make(_ plan: EnginePlan,
                            timings: EngineTimings = .default,
                            onStatusChange: (@Sendable (EngineStatus) -> Void)? = nil) -> EngineProcess {
        switch plan {
        case .spawn(let launch): return EngineProcess(launch: launch, timings: timings, onStatusChange: onStatusChange)
        case .inert(let status): return .inert(status, onStatusChange: onStatusChange)
        }
    }

    /// Where responses and error frames go. Set before ``start()``; held weakly.
    public func attach(sink: any EngineFrameSink) {
        cond.lock()
        defer { cond.unlock() }
        self.sink = sink
    }

    // MARK: - Reading the state

    public var status: EngineStatus {
        cond.lock(); defer { cond.unlock() }
        return s.status
    }

    public var ready: EngineReady? {
        cond.lock(); defer { cond.unlock() }
        return s.ready
    }

    /// The running engine's process id, while there is one. Test-visible so a test can prove a
    /// process is gone rather than trust that this file reaped it.
    public var pid: Int32? {
        cond.lock(); defer { cond.unlock() }
        return s.pid
    }

    public var lastExit: EngineExit? {
        cond.lock(); defer { cond.unlock() }
        return s.lastExit
    }

    public var isFinished: Bool {
        cond.lock(); defer { cond.unlock() }
        return s.finished
    }

    // MARK: - Running

    /// Start the engine and supervise it until ``stop()`` or the restart budget runs out.
    public func start() {
        cond.lock()
        guard let launch, !started else { cond.unlock(); return }
        started = true
        cond.unlock()
        let thread = Thread { [self] in supervise(launch) }
        thread.name = "ohmail-engine"
        thread.stackSize = 512 * 1024
        thread.start()
    }

    /// Ask the engine to leave, wait for it, and kill it if it will not. Idempotent, and safe to
    /// call from a window-close and again from the app's exit.
    public func stop() {
        cond.lock()
        if !s.stop {
            s.stop = true
            // ORDER: the stop flag is set before the pipe is closed, under the same lock the
            // supervisor takes to read it. The other order races — the child exits cleanly, the
            // supervisor sees an exit with no stop pending, and restarts the engine the user just
            // quit.
            s.deadline = Date().addingTimeInterval(timings.stopGrace)
            let writer = s.writer
            s.writer = nil
            cond.broadcast()
            cond.unlock()
            if let writer, writer.isOpen {
                writer.close()
                Self.log("stopping — closed its input; up to \(Int(timings.stopGrace * 1000))ms to finish")
            }
            cond.lock()
        }
        while !s.finished { cond.wait() }
        cond.unlock()
    }

    /// Write one frame to the engine's stdin. The handle never leaves this object.
    ///
    /// This is the same descriptor whose closure is the graceful stop, which is why there is no
    /// accessor for it: a caller holding the handle could close it, and a caller holding it across
    /// a restart would be writing into the previous run.
    public func send(header: Data, body: Data) throws {
        cond.lock()
        let writer = s.writer
        cond.unlock()
        guard let writer else { throw FrameError("the engine is not running") }
        try writer.write(header: header, body: body)
    }

    // MARK: - The supervisor

    private func supervise(_ launch: EngineLaunch) {
        var attempt = 1
        while true {
            if stopping() {
                setStatus(.stopped)
                break
            }
            setStatus(.starting(attempt: attempt))

            var environment = ProcessInfo.processInfo.environment
            for (name, value) in launch.environment { environment[name] = value }

            // FIND A NODE, OR SAY SO PLAINLY. The engine is a Node script and this beta ships no
            // runtime, so one has to be on the machine — and a Finder/launchd `PATH` finds none even
            // when the user has Node, which is the whole reason ``resolveNode`` exists. Its directory
            // is prepended to the child's `PATH` so the engine's shebang runs THIS node. A build that
            // can find none fails HERE, with the runtime named, rather than at `process.run()` with a
            // `NotFound` that reads as "the engine is missing" — the engine is right there.
            guard let node = Self.resolveNode(environment: environment) else {
                setStatus(.failed(
                    reason: "ohmail's engine runs on Node 20 or newer, and this beta does not yet "
                        + "bundle one. Install Node from nodejs.org and reopen ohmail, or set "
                        + "\(NODE_PATH_VAR) to a node binary. A later build will ship its own runtime.",
                    last: nil))
                break
            }
            environment["PATH"] = node.deletingLastPathComponent().path + ":" + (environment["PATH"] ?? "")

            let process = Process()
            process.executableURL = launch.program
            process.arguments = launch.arguments
            process.environment = environment

            // Piped, all three, and each for its own reason. stdin because the write end must belong
            // to this process and nothing else — that is the graceful stop and the orphan defence at
            // once. stdout because it is the frame stream. stderr because inheriting it on a windowed
            // build hands the child a handle that may not exist, and because a pipe nobody drains
            // blocks the writer once it fills.
            let input = Pipe(), output = Pipe(), diagnostics = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = diagnostics

            do {
                try process.run()
            } catch {
                if Self.isNotFound(error) {
                    setStatus(.absent(lookedFor: launch.program.path))
                } else {
                    setStatus(.failed(
                        reason: "the engine at \(launch.program.path) could not be started: "
                            + error.localizedDescription,
                        last: nil))
                }
                break
            }

            let writer = FrameWriter(input.fileHandleForWriting)
            cond.lock()
            s.writer = writer
            s.pid = process.processIdentifier
            s.ready = nil
            s.fault = nil
            // THE DEADLINE BELONGS TO ONE RUN, AND CARRYING IT INTO THE NEXT KILLS THE NEXT.
            //
            // Found by the crash-loop tests in the Rust original rather than reasoned about
            // (`engine.rs:583-598`): a run torn down for a protocol fault leaves a deadline in the
            // past, so the following child was killed on the supervisor's first pass — before it had
            // executed far enough to do anything. The restart budget then burnt itself out against a
            // healthy engine, and every symptom pointed at the engine instead of at this line.
            //
            // A stop that arrived between the check above and this lock is the one case where the
            // deadline is still live, and it must survive: that child is already being asked to leave
            // and nothing else will ask again.
            if s.stop {
                s.writer = nil
                cond.unlock()
                writer.close()
            } else {
                s.deadline = nil
                cond.unlock()
            }

            let readerDone = DispatchSemaphore(value: 0)
            let drainDone = DispatchSemaphore(value: 0)
            Thread.detachNewThread { [self] in
                readFrames(output.fileHandleForReading)
                readerDone.signal()
            }
            Thread.detachNewThread {
                Self.drainDiagnostics(diagnostics.fileHandleForReading)
                drainDone.signal()
            }

            let began = Date()
            waitForExit(process)
            readerDone.wait()
            drainDone.wait()

            let ran = Date().timeIntervalSince(began)
            cond.lock()
            let openWriter = s.writer
            s.writer = nil
            s.pid = nil
            let served = s.ready != nil
            let fault = s.fault
            s.fault = nil
            cond.unlock()
            openWriter?.close()

            let signalled = process.terminationReason == .uncaughtSignal
            let exit = EngineExit(code: signalled ? nil : process.terminationStatus, served: served, ran: ran)
            cond.lock()
            s.lastExit = exit
            cond.unlock()

            // NOT INDEPENDENTLY OBSERVABLE, AND SAID SO RATHER THAN LEFT LOOKING LOAD-BEARING.
            //
            // Removing this alone leaves every test green: the restart is refused twice more below —
            // by the interruptible delay, and by the check at the top of the loop. What it buys is
            // honesty rather than correctness. Without it a quit walks through `restarting` and logs
            // "restarting in 20ms" about an engine nobody is going to restart, and the status a
            // surface would render during a quit says the opposite of what is happening.
            if stopping() {
                Self.logExit(exit, fault: fault)
                setStatus(.stopped)
                break
            }
            Self.logExit(exit, fault: fault)

            // A run that actually served, for long enough to have been useful, is not evidence of a
            // crash loop. Reset the budget so an app left open for days can still recover.
            if served && ran >= timings.healthyFor { attempt = 0 }
            attempt += 1
            if attempt > EngineTimings.maxStarts {
                setStatus(.failed(
                    reason: "the engine failed \(EngineTimings.maxStarts) starts in a row, so the shell stopped "
                        + "restarting it. Quit ohmail and open it again once the cause is fixed — if another "
                        + "copy of ohmail is already running, that is the cause.",
                    last: exit))
                break
            }

            let delay = timings.backoff(attempt: attempt)
            setStatus(.restarting(attempt: attempt, delay: delay, last: exit))
            if sleepUnlessStopped(delay) {
                setStatus(.stopped)
                break
            }
        }
        finish()
    }

    /// Wait for this run of the engine to end, killing it if it has been asked to leave and has not.
    private func waitForExit(_ process: Process) {
        var killed = false
        while process.isRunning {
            let deadline: Date? = {
                cond.lock()
                defer { cond.unlock() }
                // A malformed frame is unrecoverable: a length-prefixed stream has no resync point,
                // so once the two ends disagree about where a frame starts, every later byte is
                // misread. Ask it to leave the same way a quit does, and hold it to the same
                // deadline.
                if s.fault != nil && s.deadline == nil {
                    let writer = s.writer
                    s.writer = nil
                    s.deadline = Date().addingTimeInterval(timings.stopGrace)
                    writer?.close()
                }
                return s.deadline
            }()

            if let deadline, !killed, Date() >= deadline {
                killed = true
                Self.log("still running \(Int(timings.stopGrace * 1000))ms after being asked to leave; killing it")
                // SIGKILL and not SIGTERM: the grace period has already expired, and the engine
                // handles SIGTERM by starting the same orderly shutdown it has just failed to
                // finish. Asking twice, politely, is how a quit becomes something a user waits on.
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
            Thread.sleep(forTimeInterval: timings.poll)
        }
        process.waitUntilExit()
    }

    /// Read frames until the stream ends, recording the engine's `ready` and handing everything else
    /// to the sink.
    ///
    /// The reader has to run for the whole life of the process, because a pipe nobody drains blocks
    /// the writer once it fills — and an engine blocked on a write it can never finish is a hang
    /// with no symptom near its cause.
    private func readFrames(_ handle: FileHandle) {
        let decoder = FrameDecoder()
        var streamEnd: Error?
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            guard let chunk = Self.readSome(handle, into: &buffer) else {
                // EOF, at a frame boundary or part-way through one. Either way the engine is going
                // away and this is not a protocol fault — a partial frame at EOF is a process that
                // died mid-write, which the exit status describes better than this thread could.
                streamEnd = FrameError("the engine closed its output stream")
                break
            }
            if chunk.isEmpty { continue }   // interrupted; ask again

            let frames: [Frame]
            do {
                frames = try decoder.push(chunk)
            } catch {
                fault(String(describing: error))
                streamEnd = error
                break
            }

            var stop = false
            for frame in frames {
                do {
                    try accept(frame)
                } catch {
                    fault(String(describing: error))
                    streamEnd = error
                    stop = true
                    break
                }
            }
            if stop { break }
        }
        try? handle.close()
        if let streamEnd { sinkNow()?.engineStreamDidEnd(streamEnd) }
    }

    /// Inspect one frame. A throw is a protocol fault and ends the stream.
    private func accept(_ frame: Frame) throws {
        let header = try EngineProtocol.decode(frame)
        guard case .ready(let ready) = header else {
            sinkNow()?.engineDidReceive(header)
            return
        }
        cond.lock()
        if s.ready != nil {
            cond.unlock()
            throw FrameError("the engine announced itself twice; a launch serves once")
        }
        s.ready = ready
        cond.unlock()
        // The mailbox id, and nothing else. Not the token, and not the data directory: a directory
        // under the user's home carries their account name, and the shell that set it already knows.
        setStatus(.serving(mailboxID: ready.mailboxID))
    }

    /// Forward the engine's diagnostics to this process's stderr, verbatim.
    ///
    /// Verbatim, and not prefixed: the engine emits one JSON object per line through a redacting
    /// logger, and a prefix would make every line unparseable by whatever reads them. The thread's
    /// real job is to keep the pipe drained; a pipe nobody reads fills and blocks the writer, and an
    /// engine blocked on a log line is an engine that has stopped serving mail.
    private static func drainDiagnostics(_ handle: FileHandle) {
        var buffer = [UInt8](repeating: 0, count: 8 * 1024)
        while let chunk = readSome(handle, into: &buffer) {
            if !chunk.isEmpty { writeToStandardError(chunk) }
        }
        try? handle.close()
    }

    /// One `read(2)`, returning **whatever has arrived** — `nil` at end of stream, empty when the
    /// call was interrupted.
    ///
    /// **`FileHandle.read(upToCount:)` will not do**, and the difference is the whole slice. It does
    /// not return early: on a pipe it keeps reading until it has the count asked for or the far end
    /// closes, so a 64 KiB request sits on a 149-byte `ready` frame until the engine exits. Every
    /// symptom of that points somewhere else — the engine looks like it never announced itself, a
    /// protocol fault looks like a hang, and both only resolve when the app quits. Measured, not
    /// assumed: with `read(upToCount:)` here, `serving mailbox mbx-1` was logged AFTER
    /// `stopping — closed its input` in every test whose child outlived the assertion.
    private static func readSome(_ handle: FileHandle, into buffer: inout [UInt8]) -> Data? {
        let n = buffer.withUnsafeMutableBytes { raw in
            Foundation.read(handle.fileDescriptor, raw.baseAddress, raw.count)
        }
        if n > 0 { return Data(buffer[0..<n]) }
        if n == 0 { return nil }                       // end of stream
        return errno == EINTR ? Data() : nil
    }

    // MARK: - Bookkeeping

    private func sinkNow() -> (any EngineFrameSink)? {
        cond.lock(); defer { cond.unlock() }
        return sink
    }

    private func stopping() -> Bool {
        cond.lock(); defer { cond.unlock() }
        return s.stop
    }

    /// Sleep, unless and until the engine is asked to stop. Returns true if it was.
    private func sleepUnlessStopped(_ seconds: TimeInterval) -> Bool {
        cond.lock()
        defer { cond.unlock() }
        let until = Date().addingTimeInterval(seconds)
        while !s.stop && Date() < until { cond.wait(until: until) }
        return s.stop
    }

    private func setStatus(_ status: EngineStatus) {
        Self.log(status.description)
        cond.lock()
        s.status = status
        cond.broadcast()
        cond.unlock()
        onStatusChange?(status)
    }

    private func fault(_ message: String) {
        Self.log(message)
        cond.lock()
        if s.fault == nil { s.fault = message }
        cond.unlock()
    }

    private func finish() {
        cond.lock()
        s.finished = true
        let writer = s.writer
        s.writer = nil
        cond.broadcast()
        cond.unlock()
        writer?.close()
    }

    private static func isNotFound(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain, ns.code == NSFileNoSuchFileError { return true }
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOENT) { return true }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            return underlying.domain == NSPOSIXErrorDomain && underlying.code == Int(ENOENT)
        }
        return false
    }

    // MARK: - Saying what happened

    /// One lock so a log line from this shell and a chunk drained from the engine cannot interleave
    /// mid-line. The engine's diagnostics are JSON, one object per line, and half a line is not.
    private static let stderrLock = NSLock()

    static func writeToStandardError(_ bytes: Data) {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        // `try?`, because a windowed build may have no stderr at all. A lost log line must never
        // take the app down.
        try? FileHandle.standardError.write(contentsOf: bytes)
    }

    static func log(_ message: String) {
        writeToStandardError(Data("ohmail engine: \(message)\n".utf8))
    }

    private static func logExit(_ exit: EngineExit, fault: String?) {
        let how: String
        switch exit.code {
        case .some(0): how = "exited cleanly"
        case .some(let code): how = "exited with code \(code)"
        case .none: how = "was killed"
        }
        let served = exit.served ? "after serving" : "without ever serving"
        let ran = String(format: "%.1fs", exit.ran)
        if fault != nil {
            log("\(how) \(served), \(ran) in, after a protocol fault")
        } else {
            log("\(how) \(served), \(ran) in")
        }
    }
}
