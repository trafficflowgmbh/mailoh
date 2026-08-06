import Foundation
import OhMailEngine

/// WHAT THE WINDOW SHOWS, AND WHAT — IF ANYTHING — IS BEHIND IT.
///
/// One function, no filesystem, no process, no clock. Everything it needs arrives as an argument,
/// which is what makes every state below reachable from a test rather than only from a machine in
/// the right condition.
///
/// ── THE ONE RULE THIS FILE EXISTS FOR ─────────────────────────────────────────────────────
///
/// **The invented world is reachable from exactly one branch, and that branch is guarded by a
/// command-line flag and nothing else.** Not by a failure, not by an absence, not by a default.
///
/// This is written as a guard rather than as a convention because the convenient version of this
/// code is a fallback — open the mailbox, and if anything at all goes wrong, show the sample world
/// so the window is not empty. That version is worse than a blank window and worse than a crash: it
/// puts nine plausible messages from people who do not exist in front of somebody who believes they
/// are looking at their mail, and it does so most reliably at the exact moment their mail is not
/// reachable. A person could answer one of them.
///
/// So `demo` is asked FIRST, `configured` is asked SECOND, and every remaining branch returns a
/// named state with a sentence in it. There is no third way to reach ``MailSourceKind/fixtures``,
/// and `SourceSelectionTests` walks a configured launch across every engine status to say so.
///
/// ── THE SECOND RULE, WHICH WAS ADDED AFTER IT WAS BROKEN ──────────────────────────────────
///
/// **The setup form is not offered by a build that could not use what it collects.** `configured`
/// answers whether this install has a mailbox; it never answered whether there was an engine to open
/// one with. So a download carrying no engine opened the form, took an IMAP host, a user and a mail
/// password, and found out at the spawn — after the password — that it had nothing to hand them to.
///
/// The guard is ``EngineInstall``, and it is a filesystem check rather than a build flag on purpose:
/// the change that stops packaging the engine is exactly the change that forgets to flip a flag, and
/// a flag would then be a claim about the bundle that the bundle does not support.
///
/// ── WHY THE SENTENCES LIVE HERE AND NOT IN A VIEW ─────────────────────────────────────────
///
/// The words a failed start has to be able to say are the names of environment variables and the
/// supervisor's own reason string. A view that spelled either would be a second place to keep them
/// right, and the one that drifts is always the copy. So the decision carries its own words and
/// ``EngineStateView`` draws whatever it is handed.
public struct SourceSelection: Equatable, Sendable {

    /// What the window draws.
    public enum Surface: Equatable, Sendable {
        /// The sample world, asked for by name on the command line.
        case demo
        /// No mailbox on this install yet. Collect one.
        case setup
        /// The engine is serving; the mail is the mailbox's.
        case mail
        /// Configured, and not showing mail. The text is the reason, in a sentence.
        case engineState(EngineNoticeText)
    }

    public let surface: Surface
    /// What holds the mail, or `nil` when nothing does. A surface with no source cannot render a
    /// message, which is the property that makes "never a fixture message" checkable.
    public let source: MailSourceKind?
    /// Whether the composition root should start the local engine at all.
    ///
    /// False under `--demo`, and that is not a saving — it is the invariant. Exactly one organizer
    /// may be active against a mailbox, and it files real mail into real folders. An engine running
    /// underneath a window that is showing invented mail would be making decisions the person at the
    /// keyboard cannot see and did not make. So the sample world is a window with nothing behind it.
    public let spawnEngine: Bool

    public init(surface: Surface, source: MailSourceKind?, spawnEngine: Bool) {
        self.surface = surface
        self.source = source
        self.spawnEngine = spawnEngine
    }

    /// The decision.
    ///
    /// - Parameters:
    ///   - configured: whether this install has been pointed at a mailbox. **Not** whether it can
    ///     open one — that also needs the key, and the two are different sentences on screen.
    ///   - engine: whether this build carries an engine at all, read off the filesystem. **No
    ///     default value, deliberately.** A defaulted `.installed` is a parameter every future call
    ///     site may forget, and the thing it would silently restore is a form that collects a mail
    ///     password a build cannot use.
    ///   - status: where the engine stands, or `nil` before it has been asked to start.
    ///   - flags: what the process was launched with.
    public static func decide(configured: Bool,
                              engine: EngineInstall,
                              status: EngineStatus?,
                              flags: LaunchFlags) -> SourceSelection {
        // FIRST, AND THE ONLY DOOR TO THE INVENTED WORLD.
        //
        // It is answered before the install is looked at, and it does not start an engine. Both
        // of those are deliberate:
        //
        //  · Asked first, so that what `--demo` means does not depend on whose machine it is run
        //    on. A flag whose behaviour changes once you add a mailbox is a flag nobody can use to
        //    demonstrate anything, and a check built on one reports a different result per machine.
        //  · With no engine, so the sample world can never be a lie about a real mailbox. Nothing
        //    connects, nothing syncs, nothing files — see ``spawnEngine``.
        //
        // What is NOT here is the dangerous version: a `catch`, an `else`, or an `if the engine
        // failed` that lands on the same value. The convenient shape of this whole file is a
        // fallback — open the mailbox, and show the sample world if anything goes wrong — and that
        // shape is the defect. It puts nine plausible messages from people who do not exist in front
        // of somebody who believes they are looking at their mail, most reliably at the moment their
        // mail is unreachable. A person could answer one of them.
        if flags.demo {
            return SourceSelection(surface: .demo, source: .fixtures, spawnEngine: false)
        }
        guard configured else {
            // THE FORM IS NOT OFFERED BY A BUILD THAT COULD NOT USE WHAT IT COLLECTS.
            //
            // Setup asks for an IMAP host, a user and then a mail password. All three are worth
            // nothing without an engine to hand them to, and the password is worth less than
            // nothing: it is a stranger's credential, typed into a window that cannot open the
            // mailbox it names. That is what this app did — the form appeared, the details were
            // saved, and the missing engine was discovered at the spawn, *after* the password.
            //
            // Asked of the bundle rather than of a flag, so it cannot drift from what was actually
            // packaged; the check is one branch up, in `EngineProcess.install`.
            if case .missing(let lookedFor) = engine {
                return SourceSelection(surface: .engineState(noEngine(at: lookedFor)),
                                       source: nil, spawnEngine: false)
            }
            // Nothing to open and nothing to start. The engine refuses to run without a mailbox, so
            // spawning one here would buy a `notConfigured` panel in place of the form that fixes it.
            return SourceSelection(surface: .setup, source: nil, spawnEngine: false)
        }

        // Configured. Every branch from here either shows the mailbox or says why it cannot, and
        // none of them can reach `.fixtures` — there is no `default:` and no fallback below.
        guard let status else {
            return SourceSelection(surface: .engineState(opening), source: nil, spawnEngine: true)
        }

        switch status {
        case .serving:
            return SourceSelection(surface: .mail, source: .engine, spawnEngine: true)

        case .starting(let attempt):
            // The first attempt says exactly what `nil` says, deliberately: "about to start" and
            // "starting, attempt one" are the same event to somebody watching, and a window that
            // distinguished them would be narrating itself.
            guard attempt > 1 else {
                return SourceSelection(surface: .engineState(opening), source: nil, spawnEngine: true)
            }
            return named(
                title: "Opening your mailbox.",
                detail: "Starting the local engine — attempt \(attempt) of \(EngineTimings.maxStarts).")

        case .absent(let lookedFor):
            // THE SAME SENTENCE AS THE UNCONFIGURED BRANCH ABOVE, FROM THE SAME FUNCTION.
            //
            // Two journeys reach one fact — a build with nothing to run — and a second wording of it
            // is a second thing to keep right. The one that drifts is always the copy.
            //
            // This branch is also why the install check above guards only the *unconfigured* case.
            // Once there is a mailbox the spawn is the authority on whether the engine exists: it
            // answers with `NotFound` from the syscall that would have started it, which cannot go
            // stale between a check and a launch. A pre-flight stat here would be a second opinion
            // about the same file, and the app would show whichever of the two was wrong.
            return SourceSelection(surface: .engineState(noEngine(at: lookedFor)),
                                   source: nil, spawnEngine: true)

        case .notConfigured(let missing):
            // Named, never described. These are the variables the engine refuses to start without,
            // and a line that said "configuration is incomplete" would send the reader looking.
            return named(
                title: "ohmail did not start its engine.",
                detail: "Nothing supplied \(missing.joined(separator: ", ")). Remove this mailbox "
                    + "and add it again, or supply them in the environment ohmail is launched with.")

        case .restarting(let attempt, _, let last):
            return named(
                title: "The local engine is restarting.",
                detail: (last.served ? "It stopped after it had started serving. "
                                     : "It stopped before it was ready. ")
                    + "Attempt \(attempt) of \(EngineTimings.maxStarts).")

        case .stopped:
            return named(
                title: "The local engine has stopped.",
                detail: "Quit ohmail and open it again to reopen the mailbox.")

        case .failed(let reason, _):
            // The supervisor's own sentence, verbatim. It is written to be read by a person and it
            // knows things this file does not — which start failed, and how many came before it.
            return named(title: "The local engine stopped.", detail: reason)
        }
    }

    /// Before the engine has been asked anything. Distinct from `.starting`, which means a process
    /// exists: this is the first frame of a configured launch, and saying "starting" then would be
    /// a claim about a process nobody has spawned.
    static let opening = EngineNoticeText(
        title: "Opening your mailbox.",
        detail: "Starting the local engine.")

    /// There is nothing to run, wherever that was worked out.
    ///
    /// The path and not a description of it: "the engine is missing" is not something anybody can
    /// act on, and this is the one line that says where it should be. `lookedFor` is a path in every
    /// ordinary case and a sentence in the one where no path could be worked out at all, which reads
    /// correctly either way.
    ///
    /// "Nothing to run" rather than "no file": a directory at that path and a file without the
    /// execute bit are both this state, and both would make "there is no engine at" a sentence that
    /// contradicts what somebody is looking at in the Finder.
    static func noEngine(at lookedFor: String) -> EngineNoticeText {
        EngineNoticeText(
            title: "ohmail cannot find its mail engine.",
            detail: "There is nothing to run at \(lookedFor). Install ohmail again, or set "
                + "\(ENGINE_PATH_VAR) to the engine's path and reopen ohmail.")
    }

    private static func named(title: String, detail: String) -> SourceSelection {
        SourceSelection(surface: .engineState(EngineNoticeText(title: title, detail: detail)),
                        source: nil, spawnEngine: true)
    }
}

/// What holds the mail.
///
/// Three cases and no fourth, so that "which source did the composition root pick" is a value a test
/// can read rather than a fact it has to infer from what ended up on screen.
public enum MailSourceKind: Equatable, Sendable {
    /// The invented world. Reachable only from the `--demo` branch above.
    case fixtures
    /// The local engine's mirror of the real mailbox — door one.
    case engine
    /// The hosted mailbox, read over HTTPS — door two. A viewer: it never spawns the engine.
    case cloud
}

public extension SourceSelection {

    /// THE DECISION, WITH THE CHOSEN DOOR ON TOP OF IT.
    ///
    /// ``decide(configured:engine:status:flags:)`` is door one and the demo — the local engine's whole
    /// truth table, unchanged. This wraps it with door two, and the ordering is the invariant:
    ///
    ///  1. **`--demo` first, always.** It is asked before the door so the sample world means the same
    ///     thing on every machine, and it reaches neither the engine nor the cloud requester — the one
    ///     door to the invented world stays the flag and nothing else.
    ///  2. **The cloud door never spawns the engine.** Signed in, it is a viewer over `CloudRequester`;
    ///     not signed in, it is the sign-in sequence. `spawnEngine` is `false` in BOTH — this is the
    ///     GOALS #2 one-organizer guarantee made structural, and mutating it to `true` here is what
    ///     `SourceSelectionTests` walks this branch to catch. A cloud install has no `EngineConfig`, no
    ///     IMAP client and no `ohmail/_meta` write path; the worker owns the `cloud` lease.
    ///  3. **The local door is `decide` verbatim**, so door one keeps every property its own tests pin,
    ///     and a local install never names `.cloud` — the composition root reads that and never builds
    ///     a `CloudRequester` for it.
    ///
    /// - Parameters:
    ///   - door: which way this install organizes, or `nil` before the chooser is answered. Sticky per
    ///     install — the choice is persisted and survives relaunch.
    ///   - cloudSignedIn: whether a hosted session has been established this launch. Door two's
    ///     `.mail` is reachable only once it has — before that the sign-in sequence stands, the same
    ///     way door one's password step sits ahead of the mailbox.
    static func resolve(door: OnboardingDoor?, cloudSignedIn: Bool,
                        configured: Bool, engine: EngineInstall,
                        status: EngineStatus?, flags: LaunchFlags) -> SourceSelection {
        // FIRST, AND THE ONLY DOOR TO THE INVENTED WORLD — before the install's door is even read.
        if flags.demo {
            return decide(configured: configured, engine: engine, status: status, flags: flags)
        }
        if door == .cloud {
            // DOOR TWO. A viewer, and structurally unable to organize: no engine, ever.
            if cloudSignedIn {
                return SourceSelection(surface: .mail, source: .cloud, spawnEngine: false)
            }
            // Not signed in yet — the sign-in sequence, drawn by the setup surface. No engine, no
            // fixtures. Never delegated to `decide`, which could spawn: a cloud install must not.
            return SourceSelection(surface: .setup, source: nil, spawnEngine: false)
        }
        // DOOR ONE (or no door chosen yet): the local engine's decision, exactly as before.
        return decide(configured: configured, engine: engine, status: status, flags: flags)
    }
}

/// What the process was launched with.
///
/// A type rather than a `Bool` passed around, because the rule that the render checks imply `--demo`
/// has to live in exactly one place. It used to be able to live in `main.swift`, and then the render
/// checks and the app would disagree about what `--shot` means on a machine that also has a mailbox.
public struct LaunchFlags: Equatable, Sendable {
    /// Show the sample world instead of opening a mailbox.
    public let demo: Bool

    public init(demo: Bool) { self.demo = demo }

    /// The flag that opens the sample world.
    public static let demoFlag = "--demo"
    /// The offscreen render check.
    public static let smokeFlag = "--smoke"
    /// The screenshot pass.
    public static let shotFlag = "--shot"

    /// Read the flags off a command line.
    ///
    /// `--smoke` and `--shot` imply `--demo`. Both walk every route in the app and assert something
    /// about what was drawn, so both need a world that is the same on every machine — and the only
    /// world this app has that does not depend on somebody's account is the sample one. Neither is
    /// an app launch: they render offscreen, exit with a status, and never show a window.
    public static func parse(_ arguments: [String]) -> LaunchFlags {
        let named = Set(arguments)
        return LaunchFlags(demo: named.contains(demoFlag)
                               || named.contains(smokeFlag)
                               || named.contains(shotFlag))
    }

    /// Whether this command line is a render check rather than a launch.
    ///
    /// The render checks do not consult the install at all — see ``SourceSelection`` and the pinned
    /// selection in `Smoke`. A gate whose result depends on whether the person running it happens
    /// to have added a mailbox is not a gate.
    public static func isRenderCheck(_ arguments: [String]) -> Bool {
        let named = Set(arguments)
        return named.contains(smokeFlag) || named.contains(shotFlag)
    }
}
