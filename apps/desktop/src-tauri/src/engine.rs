//! THE LOCAL ENGINE'S LIFECYCLE — start it with the app, watch it while it runs, and make
//! certain it is gone when the app is.
//!
//! Compiled only under the `local-engine` feature, which is OFF by default. The shell that ships
//! today is an interface preview with no engine in the bundle, and a dormant spawn path inside it
//! would be a capability the preview carries without using. The feature is the artifact boundary:
//! with it off this file is not in the binary at all, so the preview's "it talks to nobody" is a
//! property of the build rather than of a runtime branch that happened not to be taken.
//!
//! ── THE CONTRACT, WHICH IS THE ENGINE'S AND NOT INVENTED HERE ──────────────────────────────
//!
//! The engine is a Node process that speaks **length-prefixed frames over its own stdin and
//! stdout**. There is no TCP listener, no port and no socket: the only party that can reach it is
//! the process holding the pipe, which is this one. Four consequences shape everything below.
//!
//!  1. **stdout is the wire.** Diagnostics go to stderr; the engine goes as far as replacing its
//!     own `process.stdout.write` so that a stray `console.log` cannot inject bytes into a frame.
//!     A length-prefixed stream has no resync point, so a malformed frame is unrecoverable by
//!     construction and the only correct response is to tear the process down.
//!  2. **Closing its stdin is how you ask it to leave.** The engine answers EOF on stdin by
//!     refusing new requests, letting in-flight ones finish, closing IMAP and closing its
//!     database — in that order, because closing the database under a live handler is what
//!     corrupts the local mirror. So the graceful stop here is a `drop`, not a signal.
//!  3. **That same EOF is the orphan defence, and it works even when this process is killed.**
//!     Nothing else holds the write end of that pipe. If the shell dies — cleanly, by panic, or
//!     by `kill -9` — the kernel closes it, the engine reads EOF and shuts itself down. A stray
//!     engine holding an authenticated IMAP connection is therefore not merely handled on the
//!     quit path; it is structurally impossible while the pipe stays private to this process.
//!     **Never hand that stdin to a second child, and never leak the handle.**
//!  4. **Configuration travels in the environment**, and the engine invents nothing: it needs a
//!     data directory and a mailbox to open. The mailbox PASSWORD does not travel that way — it is
//!     typed once and sealed into the engine's own store under a per-install key, and the
//!     environment carries the key instead. See {@link REQUIRED_ENGINE_VARS}.
//!
//! ── WHAT THIS SHELL DOES NOT DO ────────────────────────────────────────────────────────────
//!
//! It does not own a keystore. The design puts one per-install key in the operating system's
//! keychain, minted on first run and handed over at spawn; nothing here mints or stores anything,
//! so the key is read from the environment like the rest. That is a named gap and not an
//! oversight — but it means a packaged app with an empty environment reports what is missing and
//! starts nothing, which is the honest behaviour until the keystore exists.
//!
//! ── WHAT "RUNNING" MEANS ───────────────────────────────────────────────────────────────────
//!
//! A live pid is not a running engine. The engine announces itself with a single unsolicited
//! `ready` frame once it is serving, and everything that can go wrong at start — a data directory
//! another copy already holds, a credential the keystore did not supply, a schema migration that
//! failed — produces a process that exists and will never serve. So {@link EngineState::Serving}
//! is reached by reading that frame, never by observing that the spawn succeeded.
//!
//! ── EXACTLY ONE ENGINE PER MAILBOX ─────────────────────────────────────────────────────────
//!
//! Two copies of the app launched at once do not produce two engines, and the defence is not in
//! this file. The engine takes an exclusive `O_CREAT|O_EXCL` lock on its data directory before it
//! dials anything, so the second one fails while starting and exits — before an IMAP socket is
//! opened and before any claim is written to the mailbox. The supervisor's part is only to not
//! make that worse: it retries a bounded number of times and then stays down with a reason,
//! rather than hammering a directory another process legitimately owns.

use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

// ── The frame codec's constants. Mirrored from the engine's own codec ─────────────────────────
//
// These four numbers are the engine's, and a disagreement is a stream that cannot be read. They
// are duplicated here because the shell is Rust and the engine is TypeScript; there is no shared
// artifact to import. `frame_contract_is_the_engines` in the test module records the source, and
// the honest limitation is that it can only assert what this file says, not what the engine says
// — the engine is not published to this repository, so nothing here can compare the two.
const PROTOCOL_VERSION: u64 = 1;
const PREAMBLE_BYTES: usize = 8;
const MAX_HEADER_BYTES: u32 = 64 * 1024;
const MAX_BODY_BYTES: u32 = 32 * 1024 * 1024;

/// The engine's file name beside the shell's own executable.
pub const ENGINE_FILE_STEM: &str = "ohmail-engine";

/// An explicit path to the engine, which overrides looking beside the executable.
pub const ENGINE_PATH_VAR: &str = "OHMAIL_ENGINE";

/// Where the local mirror lives. Supplied by the shell when the environment does not name one.
pub const DATA_DIR_VAR: &str = "OHMAIL_DATA_DIR";

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
/// `OHMAIL_IMAP_PASS` was on this list and is deliberately gone: requiring it would mean the
/// password travelled in process state on every launch, which is exactly what sealing it removed.
/// The engine still accepts one if the environment happens to carry it, and this shell never
/// composes it.
pub const REQUIRED_ENGINE_VARS: [&str; 3] = ["OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER", "OHMAIL_KEK"];

/// How many times the engine may be started before the shell gives up: one start and three
/// restarts.
///
/// A restart loop against an engine that cannot start is worse than staying down. Every failure
/// mode that is worth restarting for is transient (a crash, a killed process); every one that is
/// not — a locked data directory, a missing credential, a corrupt mirror — fails identically on
/// every attempt, and retrying it forever burns CPU, fills the log and hides the cause.
pub const MAX_STARTS: u32 = 4;

/// A run that served for at least this long, and actually served, is treated as healthy: the
/// restart budget resets. Without this an app left open for a week would spend its fourth restart
/// on the fourth unrelated crash and then refuse to come back.
pub const HEALTHY_FOR: Duration = Duration::from_secs(60);

const RESTART_BACKOFF_BASE: Duration = Duration::from_secs(1);
const RESTART_BACKOFF_CAP: Duration = Duration::from_secs(8);

/// The four durations the supervisor's behaviour is defined by, in one place so a test can watch
/// a five-second grace period expire without taking five seconds.
///
/// A parameter and not an environment variable: a knob read from the environment is a knob a
/// shipped app has, and the shipped app has exactly one set of timings — [`Timings::default`],
/// which is the constants above and is asserted to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timings {
    pub stop_grace: Duration,
    pub healthy_for: Duration,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            stop_grace: STOP_GRACE,
            healthy_for: HEALTHY_FOR,
            backoff_base: RESTART_BACKOFF_BASE,
            backoff_cap: RESTART_BACKOFF_CAP,
        }
    }
}

/// How long the engine gets to finish leaving after its stdin is closed, before it is killed.
///
/// A judgement, not a measurement. What it has to cover is the engine's documented shutdown
/// order — finish in-flight requests, close IMAP, close the database — and the one unbounded term
/// in it is a sync cycle already in progress, which the engine stops re-entering but does not
/// cancel. Long enough that an ordinary quit is never killed; short enough that quitting the app
/// is not something a user waits on. The escalation is a hard kill of a process that may be
/// mid-write, which is the whole reason there is a grace period at all.
pub const STOP_GRACE: Duration = Duration::from_secs(5);

/// How often the supervisor looks at the child. Small enough to be invisible, large enough to
/// cost nothing.
const POLL: Duration = Duration::from_millis(25);

/// A string that must never reach a log, a panic message or a `Debug` derive.
///
/// The engine's `ready` frame carries the per-launch session token — the credential the UI will
/// authenticate with. It travels in-band on a pipe nobody else holds, and it stays that way only
/// if nothing prints it. A newtype makes that a property of the type rather than of every author
/// who ever formats an `EngineState`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// The only way to read it. Deliberately noisy at the call site.
    ///
    /// Unused outside the tests today, and allowed rather than deleted: the UI wiring slice is
    /// what calls it, and a redaction type that only exists once there is something to redact is
    /// a redaction type that gets added after the first leak.
    #[allow(dead_code)]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// What the engine said when it started serving.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub base_url: String,
    pub account_id: String,
    pub user_id: String,
    pub mailbox_id: String,
    /// The per-launch bearer token. Never persisted by the engine, never logged by this shell.
    pub session_token: Secret,
}

/// How a run of the engine ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exit {
    /// `None` on Unix when a signal ended it — which includes this shell's own kill.
    pub code: Option<i32>,
    /// Whether it ever reached `ready`. A process that exits without serving is a start failure,
    /// not a crash, and the two want different words in the log.
    pub served: bool,
    pub ran: Duration,
}

/// Why the shell is not restarting the engine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineState {
    /// There is no engine to run. The window is the interface preview, which is what the shell
    /// has always been; this is not an error and nothing retries.
    Absent { looked_for: String },
    /// There is an engine, and nothing to point it at — or no key to seal a credential under.
    /// Naming the variables beats starting a process that fails, or one that runs and then
    /// refuses to remember the password somebody just typed.
    NotConfigured { missing: Vec<String> },
    Starting { attempt: u32 },
    /// Serving: the `ready` frame arrived.
    Serving { mailbox_id: String },
    Restarting { attempt: u32, delay: Duration, last: Exit },
    /// Asked to leave, and gone.
    Stopped,
    /// Down and staying down. `reason` is a sentence, because it is the only thing anyone will
    /// have to work from.
    Failed { reason: String, last: Option<Exit> },
}

/// Everything needed to start the engine once.
#[derive(Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Overlaid on the shell's own environment, which the engine otherwise inherits.
    pub env: Vec<(OsString, OsString)>,
}

impl fmt::Debug for Launch {
    /// Names its environment and prints no value.
    ///
    /// Nothing composed here is secret TODAY — it is one data directory — and this is written
    /// before it is needed rather than after: the keystore slice's whole job is to put a key in
    /// this field, and a derived `Debug` would put that key in the first panic message that
    /// formats a `Plan`. The seam is known, so the redaction goes in with the seam.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Launch")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &self.env.iter().map(|(k, _)| k).collect::<Vec<_>>())
            .finish()
    }
}

/// What the shell decided to do about the engine, before doing any of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Spawn(Launch),
    /// Nothing to run, and a state that says why.
    Inert(EngineState),
}

/// Decide whether there is an engine to start, and how — without touching the filesystem.
///
/// Nothing here stats a path. Whether the engine exists is answered by trying to start it and
/// reading `NotFound` back, which is one syscall instead of two and cannot go stale between the
/// check and the spawn. It also keeps this shell's claim to open no files true of the source and
/// not merely of the common case.
pub fn plan(
    get: &dyn Fn(&str) -> Option<String>,
    exe_dir: Option<&Path>,
    data_dir_fallback: Option<&Path>,
) -> Plan {
    let program = match get(ENGINE_PATH_VAR).filter(|v| !v.trim().is_empty()) {
        Some(explicit) => PathBuf::from(explicit),
        None => match exe_dir {
            Some(dir) => dir.join(engine_file_name()),
            None => {
                return Plan::Inert(EngineState::Absent {
                    looked_for: format!(
                        "{ENGINE_PATH_VAR} is not set and this executable's own directory could not be resolved"
                    ),
                })
            }
        },
    };

    let mut missing: Vec<String> = REQUIRED_ENGINE_VARS
        .iter()
        .filter(|name| get(name).filter(|v| !v.trim().is_empty()).is_none())
        .map(|name| (*name).to_string())
        .collect();

    let data_dir = match get(DATA_DIR_VAR).filter(|v| !v.trim().is_empty()) {
        Some(explicit) => Some(OsString::from(explicit)),
        None => data_dir_fallback.map(|p| p.as_os_str().to_os_string()),
    };
    if data_dir.is_none() {
        missing.push(DATA_DIR_VAR.to_string());
    }

    if !missing.is_empty() {
        return Plan::Inert(EngineState::NotConfigured { missing });
    }

    Plan::Spawn(Launch {
        program,
        args: Vec::new(),
        // ONLY THE DATA DIRECTORY, AND THAT INCLUDES NOT COMPOSING A PASSWORD.
        //
        // Everything else the engine reads is already in the environment this process was given
        // and the child inherits it, so re-listing the variables here would be a second copy of
        // the engine's configuration contract, drifting from the first. The data directory is the
        // exception because it is the one value the shell KNOWS rather than reads: it is derived
        // from the app's own identifier.
        //
        // A first launch looks exactly like every later one. The shell hands over a key, never a
        // password; the password is typed once into the running app and sealed into the engine's
        // store, and the launch after that opens the mailbox from the store. There is no
        // first-run special case to get wrong, and no launch on which a password sits in process
        // state that anything running as this user could read.
        env: vec![(OsString::from(DATA_DIR_VAR), data_dir.expect("checked above"))],
    })
}

fn engine_file_name() -> String {
    if cfg!(windows) {
        format!("{ENGINE_FILE_STEM}.exe")
    } else {
        ENGINE_FILE_STEM.to_string()
    }
}

// ── The supervisor ───────────────────────────────────────────────────────────────────────────

struct Shared {
    state: EngineState,
    /// The write end of the engine's stdin, and the only one that exists. Dropping it is the
    /// graceful stop; see the module header.
    stdin: Option<std::process::ChildStdin>,
    /// The current child, while there is one. Test-visible so a test can prove a process is gone
    /// rather than trust that this file reaped it.
    pid: Option<u32>,
    ready: Option<Ready>,
    /// How the last run ended, as the operating system reported it. An exit status exists only
    /// for a process that has terminated and been reaped, which makes this the one piece of
    /// evidence about a dead engine that does not come from this file's own bookkeeping.
    last_exit: Option<Exit>,
    /// Set by the frame reader when the stream stops being readable as frames. Unrecoverable.
    fault: Option<String>,
    stop: bool,
    /// When the current child must be killed if it has not left by itself.
    deadline: Option<Instant>,
    finished: bool,
}

struct Inner {
    shared: Mutex<Shared>,
    cv: Condvar,
    timings: Timings,
}

fn new_shared(state: EngineState, finished: bool) -> Shared {
    Shared {
        state,
        stdin: None,
        pid: None,
        ready: None,
        last_exit: None,
        fault: None,
        stop: false,
        deadline: None,
        finished,
    }
}

/// The engine, its supervisor thread, and the handle that stops both.
pub struct Engine {
    inner: Arc<Inner>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Engine {
    /// An engine that was never going to run: no binary, or nothing to configure it with.
    pub fn inert(state: EngineState) -> Engine {
        log_state(&state);
        Engine {
            inner: Arc::new(Inner {
                shared: Mutex::new(new_shared(state, true)),
                cv: Condvar::new(),
                timings: Timings::default(),
            }),
            thread: Mutex::new(None),
        }
    }

    /// Start the engine and supervise it until [`Engine::stop`] or the restart budget runs out.
    pub fn spawn(launch: Launch) -> Engine {
        Engine::spawn_with(launch, Timings::default())
    }

    pub fn spawn_with(launch: Launch, timings: Timings) -> Engine {
        let inner = Arc::new(Inner {
            shared: Mutex::new(new_shared(EngineState::Starting { attempt: 1 }, false)),
            cv: Condvar::new(),
            timings,
        });
        let worker = Arc::clone(&inner);
        let thread = thread::Builder::new()
            .name("ohmail-engine".into())
            .spawn(move || supervise(worker, launch))
            .expect("ohmail: failed to start the engine supervisor thread");
        Engine { inner, thread: Mutex::new(Some(thread)) }
    }

    /// From the Tauri app: work out the plan and act on it.
    pub fn start(app: &tauri::App) -> Engine {
        use tauri::Manager;

        let exe = std::env::current_exe().ok();
        let exe_dir = exe.as_deref().and_then(Path::parent);
        let data_dir = app.path().app_data_dir().ok();
        match plan(&|name| std::env::var(name).ok(), exe_dir, data_dir.as_deref()) {
            Plan::Spawn(launch) => Engine::spawn(launch),
            Plan::Inert(state) => Engine::inert(state),
        }
    }

    /// ── THE THREE READERS, AND WHY THEY HAVE NO CALLER IN THE APP YET ────────────────────
    ///
    /// What the shell knows about the engine, and the seam the UI wiring slice takes:
    /// `base_url` and `session_token` are what a client over the bridge needs, and `state` is
    /// what a strip that says "the engine stopped" would render. That slice is where the webview
    /// gains a way to hear about any of it — which is a Tauri permission, and permissions are
    /// added by the slice that has a use for them, never in advance.
    ///
    /// Allowed rather than deleted because the tests are the caller: an accessor removed now
    /// comes back with the first surface, and the supervisor would ship untested in between.
    #[allow(dead_code)]
    pub fn state(&self) -> EngineState {
        self.inner.shared.lock().expect("engine state").state.clone()
    }

    #[allow(dead_code)]
    pub fn ready(&self) -> Option<Ready> {
        self.inner.shared.lock().expect("engine state").ready.clone()
    }

    /// The running engine's process id, while there is one.
    #[allow(dead_code)]
    pub fn pid(&self) -> Option<u32> {
        self.inner.shared.lock().expect("engine state").pid
    }

    /// How the last run ended, straight from the operating system's exit status.
    #[allow(dead_code)]
    pub fn last_exit(&self) -> Option<Exit> {
        self.inner.shared.lock().expect("engine state").last_exit
    }

    /// Ask the engine to leave, wait for it, and kill it if it will not. Idempotent, and safe to
    /// call from a window-close and again from the app's exit.
    pub fn stop(&self) {
        {
            let mut s = self.inner.shared.lock().expect("engine state");
            if !s.stop {
                s.stop = true;
                s.deadline = Some(Instant::now() + self.inner.timings.stop_grace);
                // ORDER: the stop flag is set before the pipe is closed, under the same lock the
                // supervisor takes to read it. The other order races — the child exits cleanly,
                // the supervisor sees an exit with no stop pending, and restarts the engine the
                // user just quit.
                if s.stdin.take().is_some() {
                    log_line(format_args!(
                        "stopping — closed its input; up to {}ms to finish",
                        self.inner.timings.stop_grace.as_millis()
                    ));
                }
            }
        }
        self.inner.cv.notify_all();
        if let Some(handle) = self.thread.lock().expect("engine thread").take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Engine {
    /// Belt and braces. Tauri's run loop can end the process without unwinding, which is why the
    /// shell also calls [`Engine::stop`] explicitly — but an `Engine` dropped for any other
    /// reason must not leave a child behind either.
    fn drop(&mut self) {
        self.stop();
    }
}

impl Inner {
    fn set_state(&self, state: EngineState) {
        log_state(&state);
        self.shared.lock().expect("engine state").state = state;
    }

    fn stopping(&self) -> bool {
        self.shared.lock().expect("engine state").stop
    }

    /// Sleep, unless and until the engine is asked to stop. Returns true if it was.
    fn sleep_unless_stopped(&self, d: Duration) -> bool {
        let guard = self.shared.lock().expect("engine state");
        let (guard, _) = self
            .cv
            .wait_timeout_while(guard, d, |s| !s.stop)
            .expect("engine state");
        guard.stop
    }

    fn finish(&self) {
        let mut s = self.shared.lock().expect("engine state");
        s.finished = true;
        s.stdin = None;
    }
}

fn supervise(inner: Arc<Inner>, launch: Launch) {
    let mut attempt: u32 = 1;
    loop {
        if inner.stopping() {
            inner.set_state(EngineState::Stopped);
            break;
        }
        inner.set_state(EngineState::Starting { attempt });

        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            // Piped, all three, and each for its own reason. stdin because the write end must
            // belong to this process and nothing else — that is the graceful stop and the orphan
            // defence at once. stdout because it is the frame stream. stderr because inheriting
            // it on a windowed build hands the child a handle that may not exist, and because a
            // pipe nobody drains blocks the writer once it fills.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &launch.env {
            command.env(key, value);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                inner.set_state(EngineState::Absent {
                    looked_for: launch.program.display().to_string(),
                });
                break;
            }
            Err(err) => {
                inner.set_state(EngineState::Failed {
                    reason: format!("the engine at {} could not be started: {err}", launch.program.display()),
                    last: None,
                });
                break;
            }
        };

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        {
            let mut s = inner.shared.lock().expect("engine state");
            s.stdin = child.stdin.take();
            s.pid = Some(child.id());
            s.ready = None;
            s.fault = None;
            // THE DEADLINE BELONGS TO ONE RUN, AND CARRYING IT INTO THE NEXT KILLS THE NEXT.
            //
            // Found by the crash-loop tests rather than reasoned about: a run torn down for a
            // protocol fault leaves a deadline in the past, so the following child was killed on
            // the supervisor's first pass — before it had executed far enough to do anything.
            // The restart budget then burnt itself out against a healthy engine, and every
            // symptom pointed at the engine instead of at this line.
            //
            // A stop that arrived between the check above and this lock is the one case where the
            // deadline is still live, and it must survive: that child is already being asked to
            // leave and nothing else will ask again.
            if s.stop {
                s.stdin = None;
            } else {
                s.deadline = None;
            }
        }

        let reader_inner = Arc::clone(&inner);
        let reader = thread::spawn(move || read_frames(stdout, &reader_inner));
        let forwarder = thread::spawn(move || forward_diagnostics(stderr));

        let started = Instant::now();
        let status = wait_for_exit(&inner, &mut child);
        let _ = reader.join();
        let _ = forwarder.join();

        let ran = started.elapsed();
        let (served, fault) = {
            let mut s = inner.shared.lock().expect("engine state");
            s.stdin = None;
            s.pid = None;
            (s.ready.is_some(), s.fault.take())
        };
        let exit = Exit { code: status.code(), served, ran };
        inner.shared.lock().expect("engine state").last_exit = Some(exit);

        // NOT INDEPENDENTLY OBSERVABLE, AND SAID SO RATHER THAN LEFT LOOKING LOAD-BEARING.
        //
        // Removing this alone leaves every test green: the restart is refused twice more below —
        // by the interruptible delay, and by the check at the top of the loop. What it buys is
        // honesty rather than correctness. Without it a quit walks through `Restarting` and logs
        // "restarting in 20ms" about an engine nobody is going to restart, and the state a
        // surface would render during a quit says the opposite of what is happening.
        if inner.stopping() {
            log_exit(&exit, fault.as_deref());
            inner.set_state(EngineState::Stopped);
            break;
        }
        log_exit(&exit, fault.as_deref());

        // A run that actually served, for long enough to have been useful, is not evidence of a
        // crash loop. Reset the budget so an app left open for days can still recover.
        if served && ran >= inner.timings.healthy_for {
            attempt = 0;
        }
        attempt += 1;
        if attempt > MAX_STARTS {
            inner.set_state(EngineState::Failed {
                reason: format!(
                    "the engine failed {MAX_STARTS} starts in a row, so the shell stopped restarting it. \
                     Quit ohmail and open it again once the cause is fixed — if another copy of ohmail \
                     is already running, that is the cause."
                ),
                last: Some(exit),
            });
            break;
        }

        let delay = backoff(attempt, inner.timings);
        inner.set_state(EngineState::Restarting { attempt, delay, last: exit });
        if inner.sleep_unless_stopped(delay) {
            inner.set_state(EngineState::Stopped);
            break;
        }
    }
    inner.finish();
}

/// Wait for this run of the engine to end, killing it if it has been asked to leave and has not.
fn wait_for_exit(inner: &Arc<Inner>, child: &mut Child) -> ExitStatus {
    let mut killed = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status,
            Ok(None) => {}
            Err(err) => {
                // The child cannot be observed. Killing it is the only thing left that keeps the
                // guarantee this file exists for.
                let _ = writeln!(io::stderr(), "ohmail engine: cannot observe the engine ({err}); killing it");
                let _ = child.kill();
                return child.wait().unwrap_or_else(|_| exit_status_unavailable());
            }
        }

        let deadline = {
            let mut s = inner.shared.lock().expect("engine state");
            // A malformed frame is unrecoverable: a length-prefixed stream has no resync point, so
            // once the two ends disagree about where a frame starts, every later byte is misread.
            // Ask it to leave the same way a quit does, and hold it to the same deadline.
            if s.fault.is_some() && s.deadline.is_none() {
                s.stdin = None;
                s.deadline = Some(Instant::now() + inner.timings.stop_grace);
            }
            s.deadline
        };

        if let Some(deadline) = deadline {
            if !killed && Instant::now() >= deadline {
                killed = true;
                let _ = writeln!(
                    io::stderr(),
                    "ohmail engine: still running {}ms after being asked to leave; killing it",
                    inner.timings.stop_grace.as_millis()
                );
                let _ = child.kill();
            }
        }
        thread::sleep(POLL);
    }
}

fn backoff(attempt: u32, timings: Timings) -> Duration {
    let shift = attempt.saturating_sub(2).min(16);
    let delay = timings.backoff_base.saturating_mul(1u32 << shift);
    delay.min(timings.backoff_cap)
}

// ── Reading the wire ─────────────────────────────────────────────────────────────────────────

/// Read frames until the stream ends, recording the engine's `ready` and discarding the rest.
///
/// Discarding is the honest state of this slice: nothing sends requests yet, so nothing is
/// waiting for a response. The reader still has to run, and has to run for the whole life of the
/// process, because a pipe nobody drains blocks the writer once it fills — and the engine
/// blocked on a write it can never finish is a hang with no symptom near its cause.
///
/// Bodies are SKIPPED rather than read into memory: a frame body may be 32 MB, and buffering one
/// only to drop it would be the largest allocation in this shell.
fn read_frames(mut stdout: ChildStdout, inner: &Arc<Inner>) {
    let mut preamble = [0u8; PREAMBLE_BYTES];
    loop {
        match read_exact_or_eof(&mut stdout, &mut preamble) {
            Ok(true) => {}
            // EOF, at a frame boundary or part-way through one. Either way the engine is going
            // away and this is not a protocol fault — a partial frame at EOF is a process that
            // died mid-write, which the exit status describes better than this thread could.
            Ok(false) | Err(_) => return,
        }

        let header_len = u32::from_be_bytes([preamble[0], preamble[1], preamble[2], preamble[3]]);
        let body_len = u32::from_be_bytes([preamble[4], preamble[5], preamble[6], preamble[7]]);
        // Both caps are checked before a single byte of either is allocated, and a breach is
        // fatal rather than skipped: a length that is wrong means the stream has already lost
        // frame alignment, and there is nothing to resynchronise to.
        if header_len == 0 || header_len > MAX_HEADER_BYTES {
            fault(inner, format!(
                "a frame declared a {header_len}-byte header, outside 1..{MAX_HEADER_BYTES} — the engine is \
                 not speaking this protocol, or something wrote to its stdout"
            ));
            return;
        }
        if body_len > MAX_BODY_BYTES {
            fault(inner, format!("a frame declared a {body_len}-byte body, over the {MAX_BODY_BYTES}-byte cap"));
            return;
        }

        let mut header = vec![0u8; header_len as usize];
        match read_exact_or_eof(&mut stdout, &mut header) {
            Ok(true) => {}
            Ok(false) | Err(_) => return,
        }

        if let Err(message) = accept_header(&header, inner) {
            fault(inner, message);
            return;
        }

        if !skip(&mut stdout, body_len as u64) {
            return;
        }
    }
}

/// Inspect one frame header. `Err` is a protocol fault and ends the stream.
fn accept_header(header: &[u8], inner: &Arc<Inner>) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_slice(header)
        .map_err(|err| format!("a frame header was not JSON: {err}"))?;

    match parsed.get("v").and_then(serde_json::Value::as_u64) {
        Some(PROTOCOL_VERSION) => {}
        other => {
            return Err(format!(
                "a frame declared protocol version {}, and this shell speaks {PROTOCOL_VERSION}",
                other.map_or_else(|| "nothing".to_string(), |v| v.to_string())
            ))
        }
    }

    if parsed.get("t").and_then(serde_json::Value::as_str) != Some("ready") {
        return Ok(());
    }

    let field = |name: &str| -> Result<String, String> {
        parsed
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("the engine's ready frame carried no {name}"))
    };
    let ready = Ready {
        base_url: field("baseUrl")?,
        account_id: field("accountId")?,
        user_id: field("userId")?,
        mailbox_id: field("mailboxId")?,
        session_token: Secret(field("sessionToken")?),
    };

    let mailbox_id = ready.mailbox_id.clone();
    {
        let mut s = inner.shared.lock().expect("engine state");
        if s.ready.is_some() {
            return Err("the engine announced itself twice; a launch serves once".to_string());
        }
        s.ready = Some(ready);
    }
    // The mailbox id, and nothing else. Not the token, and not the data directory: a directory
    // under the user's home carries their account name, and the shell that set it already knows.
    inner.set_state(EngineState::Serving { mailbox_id });
    Ok(())
}

fn fault(inner: &Arc<Inner>, message: String) {
    let _ = writeln!(io::stderr(), "ohmail engine: {message}");
    let mut s = inner.shared.lock().expect("engine state");
    if s.fault.is_none() {
        s.fault = Some(message);
    }
}

/// Fill `buf`. `Ok(false)` means the stream ended before any of it arrived or part-way through.
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => return Ok(false),
            Ok(n) => filled += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(true)
}

fn skip<R: Read>(reader: &mut R, mut remaining: u64) -> bool {
    let mut scratch = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(scratch.len() as u64) as usize;
        match reader.read(&mut scratch[..want]) {
            Ok(0) => return false,
            Ok(n) => remaining -= n as u64,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    true
}

/// Forward the engine's diagnostics to this process's stderr, verbatim.
///
/// Verbatim, and not prefixed: the engine emits one JSON object per line through a redacting
/// logger, and a prefix would make every line unparseable by whatever reads them. The thread's
/// real job is to keep the pipe drained; a pipe nobody reads fills and blocks the writer, and an
/// engine blocked on a log line is an engine that has stopped serving mail.
fn forward_diagnostics(mut stderr: ChildStderr) {
    let mut buf = [0u8; 8 * 1024];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                let _ = io::stderr().write_all(&buf[..n]);
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

// ── Saying what happened ─────────────────────────────────────────────────────────────────────

fn log_line(args: fmt::Arguments<'_>) {
    // `writeln!` and not `eprintln!`: a windowed build may have no stderr at all, and `eprintln!`
    // panics when the write fails. A lost log line must never take the app down.
    let _ = writeln!(io::stderr(), "ohmail engine: {args}");
}

fn log_state(state: &EngineState) {
    match state {
        EngineState::Absent { looked_for } => {
            log_line(format_args!("no engine in this build ({looked_for}); the window is the interface preview"));
        }
        EngineState::NotConfigured { missing } => {
            log_line(format_args!("not started — nothing set {}", missing.join(", ")));
        }
        EngineState::Starting { attempt } => {
            log_line(format_args!("starting (attempt {attempt} of {MAX_STARTS})"));
        }
        EngineState::Serving { mailbox_id } => {
            log_line(format_args!("serving mailbox {mailbox_id}"));
        }
        EngineState::Restarting { attempt, delay, .. } => {
            log_line(format_args!(
                "restarting in {}ms (attempt {attempt} of {MAX_STARTS})",
                delay.as_millis()
            ));
        }
        EngineState::Stopped => log_line(format_args!("stopped")),
        EngineState::Failed { reason, .. } => log_line(format_args!("{reason}")),
    }
}

fn log_exit(exit: &Exit, fault: Option<&str>) {
    let how = match exit.code {
        Some(0) => "exited cleanly".to_string(),
        Some(code) => format!("exited with code {code}"),
        None => "was killed".to_string(),
    };
    let served = if exit.served { "after serving" } else { "without ever serving" };
    match fault {
        Some(_) => log_line(format_args!("{how} {served}, {:.1}s in, after a protocol fault", exit.ran.as_secs_f32())),
        None => log_line(format_args!("{how} {served}, {:.1}s in", exit.ran.as_secs_f32())),
    }
}

#[cfg(unix)]
fn exit_status_unavailable() -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(-1)
}

#[cfg(windows)]
fn exit_status_unavailable() -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(1)
}
