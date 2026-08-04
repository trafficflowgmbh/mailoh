//! The engine lifecycle, against a real child process.
//!
//! Nothing here is a mock. Every test that says "the engine" starts an actual operating-system
//! process, over an actual pipe, and the assertions are about processes: whether one is running,
//! whether it is gone, how many times it was started. A supervisor tested against a fake process
//! table would prove nothing about the failure this module exists to prevent — an engine left
//! running after the app has quit, holding an authenticated IMAP connection against a server that
//! caps them.
//!
//! The stand-in engine is Node, which is what the real engine is. It speaks the same frames and
//! honours the same stdin-EOF contract, so a test that passes here is a test about this shell's
//! half of the protocol rather than about a script that was written to agree with it.

use super::*;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

/// The stand-in engine. Modes, in the order the tests use them:
///
///  · `serve`           — announce ready, then leave when stdin ends. What the real one does.
///  · `serve-then-die`  — announce ready, then exit non-zero after a moment.
///  · `serve-deaf`      — announce ready and then ignore stdin entirely. Never leaves.
///  · `die`             — exit 1 without ever announcing. What a locked data directory looks like.
///  · `noise`           — announce ready, then write a line of prose to the frame stream.
///
/// Every mode appends a line to `$FAKE_LOG` on start and on exit, which is how a test counts
/// starts and proves an exit independently of anything this shell reports about itself.
const FAKE_ENGINE_JS: &str = r#"
const fs = require("node:fs");
const mode = process.argv[2];
const log = process.env.FAKE_LOG;
const note = (what) => { if (log) fs.appendFileSync(log, what + " " + process.pid + "\n"); };
note("start");
process.on("exit", () => note("exit"));

function frame(header) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const pre = Buffer.alloc(8);
  pre.writeUInt32BE(h.length, 0);
  pre.writeUInt32BE(0, 4);
  process.stdout.write(Buffer.concat([pre, h]));
}
const ready = () => frame({
  v: 1, t: "ready", baseUrl: "http://sidecar",
  sessionToken: "tok_" + "a".repeat(24),
  accountId: "acc-1", userId: "usr-1", mailboxId: "mbx-1",
});

if (mode === "die") { process.exit(1); }

ready();

// The real engine leaves when its stdin ends; `serve-deaf` is the one that does not.
if (mode !== "serve-deaf") {
  process.stdin.on("end", () => process.exit(0));
}
process.stdin.resume();

if (mode === "serve-then-die") { setTimeout(() => process.exit(9), 60); }
if (mode === "noise") { setTimeout(() => process.stdout.write("a stray console.log\n"), 30); }
setInterval(() => {}, 1000);
"#;

/// Node, which the engine is written in and which every build of this app already needs.
fn node() -> String {
    std::env::var("OHMAIL_TEST_NODE").unwrap_or_else(|_| "node".to_string())
}

static SEQ: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    dir: PathBuf,
    script: PathBuf,
    log: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ohmail-engine-test-{}-{name}-{n}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("fake-engine.cjs");
        fs::write(&script, FAKE_ENGINE_JS).expect("write fake engine");
        let log = dir.join("starts.log");
        Fixture { dir, script, log }
    }

    fn launch(&self, mode: &str) -> Launch {
        Launch {
            program: PathBuf::from(node()),
            args: vec![self.script.clone().into_os_string(), OsString::from(mode)],
            env: vec![(OsString::from("FAKE_LOG"), self.log.clone().into_os_string())],
        }
    }

    fn lines(&self) -> Vec<String> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn starts(&self) -> usize {
        self.lines().iter().filter(|l| l.starts_with("start ")).count()
    }

    fn exits(&self) -> usize {
        self.lines().iter().filter(|l| l.starts_with("exit ")).count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Fast timings. The behaviour under test is the ordering and the bounds, not the numbers —
/// [`default_timings_are_the_shipped_ones`] is what pins the numbers.
fn quick() -> Timings {
    Timings {
        stop_grace: Duration::from_millis(400),
        healthy_for: Duration::from_secs(60),
        backoff_base: Duration::from_millis(20),
        backoff_cap: Duration::from_millis(40),
    }
}

fn wait_for(mut done: impl FnMut() -> bool, within: Duration, what: &str) {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if done() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out after {within:?} waiting for {what}");
}

/// Is this process id one the operating system still knows about?
///
/// `kill -0` is the portable probe — it asks the kernel and changes nothing. Unix only, and it
/// shells out rather than take a dependency on libc for one line in one test.
///
/// It PANICS when the probe itself cannot be run. An earlier version used `ps -p` and returned
/// `false` when the command failed, which made `assert!(!alive(pid))` pass on a machine where the
/// probe did not work — a guard that cannot fail, asserting nothing, in the one test that exists
/// to catch a leaked process. A probe that cannot run must be a red test, not a quiet true.
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    for kill in ["/bin/kill", "/usr/bin/kill"] {
        let status = Command::new(kill)
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(status) => return status.success(),
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => panic!("could not run {kill} to probe pid {pid}: {err}"),
        }
    }
    panic!("no kill(1) to probe pid {pid} with — this test cannot tell a live process from a dead one");
}

// ── The plan: what runs, and whether anything runs at all ───────────────────────────────────

fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

fn full_env() -> HashMap<String, String> {
    env_of(&[
        ("OHMAIL_IMAP_HOST", "imap.example.org"),
        ("OHMAIL_IMAP_USER", "someone@example.org"),
        // A key, not a password. The engine seals the password into its own store under this and
        // reads it back on later launches, so the environment never has to carry one.
        ("OHMAIL_KEK", &"0".repeat(64)),
    ])
}

#[test]
fn an_explicit_engine_path_wins_over_the_one_beside_the_executable() {
    let mut env = full_env();
    env.insert(ENGINE_PATH_VAR.to_string(), "/opt/ohmail/engine".to_string());
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data")));
    match plan {
        Plan::Spawn(launch) => {
            assert_eq!(launch.program, PathBuf::from("/opt/ohmail/engine"));
            assert_eq!(launch.env, vec![(OsString::from(DATA_DIR_VAR), OsString::from("/data"))]);
            assert!(launch.args.is_empty());
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn without_an_explicit_path_the_engine_is_looked_for_beside_the_executable() {
    let env = full_env();
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data")));
    match plan {
        Plan::Spawn(launch) => {
            assert_eq!(launch.program, Path::new("/apps/ohmail").join(engine_file_name()));
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn a_missing_mailbox_is_named_and_nothing_is_started() {
    let mut env = full_env();
    env.remove("OHMAIL_IMAP_HOST");
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data")));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec!["OHMAIL_IMAP_HOST".to_string()] })
    );
}

#[test]
fn without_a_key_nothing_is_started() {
    // The engine WOULD start without one. It would also refuse to store the password the user is
    // about to type, which is a mailbox that works until the app is closed — so the shell treats
    // a missing key as a reason not to start rather than as a reason to start and hope.
    let mut env = full_env();
    env.remove("OHMAIL_KEK");
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data")));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec!["OHMAIL_KEK".to_string()] })
    );
}

#[test]
fn the_mailbox_password_is_never_required_and_never_composed() {
    // It was required, and requiring it is what put a password in process state on every launch.
    // The engine still accepts one; this shell does not hand one over, and a launch without one
    // is the ordinary case rather than a first-run exception.
    assert!(!REQUIRED_ENGINE_VARS.contains(&"OHMAIL_IMAP_PASS"));
    let env = full_env();
    assert!(!env.contains_key("OHMAIL_IMAP_PASS"));
    match plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data"))) {
        Plan::Spawn(launch) => {
            let names: Vec<&OsString> = launch.env.iter().map(|(k, _)| k).collect();
            assert_eq!(names, vec![&OsString::from(DATA_DIR_VAR)]);
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn a_launch_prints_the_names_of_its_environment_and_none_of_the_values() {
    // The keystore slice puts a key in this field. A derived Debug would put that key in the
    // first panic message that formats a plan.
    let launch = Launch {
        program: PathBuf::from("/apps/ohmail/ohmail-engine"),
        args: vec![],
        env: vec![(OsString::from("OHMAIL_KEK"), OsString::from("deadbeef-do-not-print"))],
    };
    let printed = format!("{launch:?}");
    assert!(printed.contains("OHMAIL_KEK"));
    assert!(!printed.contains("deadbeef-do-not-print"), "an environment value was printed: {printed}");
}

#[test]
fn an_empty_credential_counts_as_missing() {
    let mut env = full_env();
    env.insert("OHMAIL_IMAP_USER".to_string(), "   ".to_string());
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data")));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec!["OHMAIL_IMAP_USER".to_string()] })
    );
}

#[test]
fn with_no_data_directory_from_either_source_nothing_is_started() {
    let env = full_env();
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), None);
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec![DATA_DIR_VAR.to_string()] })
    );
}

#[test]
fn an_environment_data_directory_beats_the_shells_own() {
    let mut env = full_env();
    env.insert(DATA_DIR_VAR.to_string(), "/elsewhere".to_string());
    let plan = plan(&|k| env.get(k).cloned(), Some(Path::new("/apps/ohmail")), Some(Path::new("/data")));
    match plan {
        Plan::Spawn(launch) => {
            assert_eq!(launch.env, vec![(OsString::from(DATA_DIR_VAR), OsString::from("/elsewhere"))]);
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn a_build_with_no_engine_beside_it_is_not_an_error() {
    // Nothing at that path, and nothing retries: this is the interface preview, which is what the
    // shell has shipped since it existed.
    let engine = Engine::spawn_with(
        Launch {
            program: PathBuf::from("/nonexistent/ohmail/ohmail-engine"),
            args: vec![],
            env: vec![],
        },
        quick(),
    );
    wait_for(|| matches!(engine.state(), EngineState::Absent { .. }), Duration::from_secs(5), "the absent state");
    engine.stop();
}

// ── Starting, and what "running" means ──────────────────────────────────────────────────────

#[test]
fn the_engine_is_running_when_it_says_it_is_serving() {
    let fixture = Fixture::new("serving");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    assert_eq!(engine.state(), EngineState::Serving { mailbox_id: "mbx-1".to_string() });
    assert_eq!(fixture.starts(), 1);

    let ready = engine.ready().expect("a serving engine has said ready");
    assert_eq!(ready.base_url, "http://sidecar");
    assert_eq!(ready.mailbox_id, "mbx-1");
    assert_eq!(ready.session_token.expose(), format!("tok_{}", "a".repeat(24)));

    #[cfg(unix)]
    assert!(alive(engine.pid().expect("a running engine has a pid")), "the engine process is running");

    // AND IT KEEPS RUNNING, because this process is holding its stdin open.
    //
    // Added after a mutation went the wrong colour: replacing the piped stdin with `Stdio::null()`
    // left every behavioural test green, because a null stdin is EOF and the engine leaving
    // immediately looks like the engine leaving politely. The pipe being OPEN — and privately
    // held — is the invariant, and this is the line that can see it.
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        engine.state(),
        EngineState::Serving { mailbox_id: "mbx-1".to_string() },
        "still serving a moment later"
    );
    assert!(engine.last_exit().is_none(), "nothing has ended: {:?}", engine.last_exit());
    assert_eq!(fixture.exits(), 0, "the engine has not left: {:?}", fixture.lines());

    engine.stop();
}

#[test]
fn a_process_that_never_says_ready_is_never_reported_as_serving() {
    // The whole reason `ready` is the signal: a locked data directory, a missing credential or a
    // failed migration all produce a process that exists and will never serve.
    let fixture = Fixture::new("never-ready");
    let engine = Engine::spawn_with(fixture.launch("die"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Failed { .. }),
        Duration::from_secs(30),
        "the restart budget to run out",
    );
    assert!(engine.ready().is_none(), "nothing ever announced itself");
    match engine.state() {
        EngineState::Failed { last: Some(exit), .. } => {
            assert!(!exit.served, "the run never served");
            assert_eq!(exit.code, Some(1));
        }
        other => panic!("expected a failed state carrying the last exit, got {other:?}"),
    }
    engine.stop();
}

// ── Quitting: the defect this slice exists to prevent ───────────────────────────────────────

#[test]
fn quitting_leaves_no_engine_behind() {
    let fixture = Fixture::new("quit");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    let pid = engine.pid().expect("a running engine has a pid");

    engine.stop();

    assert_eq!(engine.state(), EngineState::Stopped);
    // Three independent proofs, because "the supervisor says it stopped it" is the claim under
    // test rather than evidence for it: the engine ran its own exit handler, the kernel gave us
    // an exit status for it, and the kernel no longer has the process.
    assert_eq!(fixture.exits(), 1, "the engine ran its exit handler: {:?}", fixture.lines());
    assert_eq!(engine.last_exit().expect("the run ended").code, Some(0));
    #[cfg(unix)]
    assert!(!alive(pid), "process {pid} is gone");
    let _ = pid;
}

#[test]
fn quitting_closes_the_engines_input_rather_than_killing_it() {
    // The distinction matters: EOF on stdin is what makes the engine finish its in-flight work,
    // close IMAP and close its database in that order. A kill skips all three.
    let fixture = Fixture::new("graceful");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );

    let began = Instant::now();
    engine.stop();

    // It left of its own accord, well inside the grace period — it was asked, not killed.
    assert!(
        began.elapsed() < quick().stop_grace,
        "left in {:?}, which is inside the {:?} grace period",
        began.elapsed(),
        quick().stop_grace
    );
    assert_eq!(fixture.exits(), 1);
}

#[test]
fn an_engine_that_ignores_the_ask_is_killed_rather_than_left_running() {
    let fixture = Fixture::new("deaf");
    let engine = Engine::spawn_with(fixture.launch("serve-deaf"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    let pid = engine.pid().expect("a running engine has a pid");

    let began = Instant::now();
    engine.stop();

    assert!(began.elapsed() >= quick().stop_grace, "the grace period was waited out before killing");
    assert_eq!(engine.state(), EngineState::Stopped);
    // No exit line: a killed process does not run its own exit handler, which is exactly why this
    // case needs the operating system's account of it rather than the engine's.
    assert_eq!(fixture.exits(), 0);
    #[cfg(unix)]
    assert_eq!(
        engine.last_exit().expect("the run ended").code,
        None,
        "a signal ended it, and the kernel reaped it"
    );
    #[cfg(unix)]
    assert!(!alive(pid), "process {pid} is gone");
    let _ = pid;
}

#[test]
fn stopping_twice_is_the_same_as_stopping_once() {
    // The shell stops the engine when the window is destroyed and again when the app exits, and
    // on Windows and Linux both fire.
    let fixture = Fixture::new("twice");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    engine.stop();
    engine.stop();
    assert_eq!(engine.state(), EngineState::Stopped);
    assert_eq!(fixture.starts(), 1, "nothing was restarted by the second stop");
}

#[test]
fn a_stopped_engine_is_not_restarted() {
    let fixture = Fixture::new("no-resurrect");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    engine.stop();
    thread::sleep(Duration::from_millis(300));
    assert_eq!(fixture.starts(), 1);
    assert_eq!(engine.state(), EngineState::Stopped);
}

// ── Supervision: noticing, restarting, and knowing when to stop ─────────────────────────────

#[test]
fn an_engine_that_dies_is_noticed_and_restarted_a_bounded_number_of_times() {
    let fixture = Fixture::new("crashloop");
    let engine = Engine::spawn_with(fixture.launch("serve-then-die"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Failed { .. }),
        Duration::from_secs(30),
        "the restart budget to run out",
    );
    assert_eq!(fixture.starts(), MAX_STARTS as usize, "one start and three restarts: {:?}", fixture.lines());

    match engine.state() {
        EngineState::Failed { reason, last: Some(exit) } => {
            assert!(exit.served, "each run did serve before dying");
            assert_eq!(exit.code, Some(9));
            assert!(reason.contains("stopped restarting"), "the reason says it gave up: {reason}");
            assert!(reason.contains("another copy"), "the reason names the likely cause: {reason}");
        }
        other => panic!("expected a failed state, got {other:?}"),
    }

    // And it stays down. A supervisor that gave up and then quietly tried again would be the
    // restart loop with extra steps.
    thread::sleep(Duration::from_millis(400));
    assert_eq!(fixture.starts(), MAX_STARTS as usize);
    engine.stop();
}

#[test]
fn a_stray_write_to_the_frame_stream_is_fatal_to_that_run() {
    // The engine goes to some length to keep its stdout pure, because a length-prefixed stream
    // has no resync point. If prose ever reaches it anyway, the only correct response is to end
    // the run — and to say so, because the symptom otherwise appears nowhere near the cause.
    let fixture = Fixture::new("noise");
    let engine = Engine::spawn_with(fixture.launch("noise"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Failed { .. }),
        Duration::from_secs(30),
        "the restart budget to run out",
    );
    assert_eq!(fixture.starts(), MAX_STARTS as usize);
    assert_eq!(fixture.exits(), MAX_STARTS as usize, "every run ended: {:?}", fixture.lines());
    engine.stop();
}

#[test]
fn stopping_during_a_restart_delay_does_not_wait_the_delay_out() {
    let mut timings = quick();
    timings.backoff_base = Duration::from_secs(30);
    timings.backoff_cap = Duration::from_secs(30);
    let fixture = Fixture::new("interrupt-backoff");
    let engine = Engine::spawn_with(fixture.launch("die"), timings);

    wait_for(
        || matches!(engine.state(), EngineState::Restarting { .. }),
        Duration::from_secs(20),
        "the supervisor to enter its restart delay",
    );
    let began = Instant::now();
    engine.stop();
    assert!(began.elapsed() < Duration::from_secs(5), "stop returned in {:?}", began.elapsed());
    assert_eq!(engine.state(), EngineState::Stopped);
}

#[test]
fn the_restart_delay_backs_off_and_is_capped() {
    let t = Timings::default();
    assert_eq!(backoff(2, t), Duration::from_secs(1));
    assert_eq!(backoff(3, t), Duration::from_secs(2));
    assert_eq!(backoff(4, t), Duration::from_secs(4));
    assert_eq!(backoff(9, t), RESTART_BACKOFF_CAP);
}

// ── The contract, and the things that must never be printed ─────────────────────────────────

#[test]
fn the_session_token_is_not_printable() {
    // The `ready` frame carries the credential the UI authenticates with. It travels in-band on a
    // pipe nobody else holds, and it stays private only if nothing formats it.
    let ready = Ready {
        base_url: "http://sidecar".to_string(),
        account_id: "acc-1".to_string(),
        user_id: "usr-1".to_string(),
        mailbox_id: "mbx-1".to_string(),
        session_token: Secret("tok_do_not_print_me".to_string()),
    };
    let printed = format!("{ready:?}");
    assert!(!printed.contains("tok_do_not_print_me"), "the token reached a Debug output: {printed}");
    assert!(printed.contains("<redacted>"));
    assert_eq!(ready.session_token.expose(), "tok_do_not_print_me");
}

#[test]
fn the_serving_state_names_the_mailbox_and_nothing_else() {
    // Deliberately not the data directory: a path under the user's home carries their account
    // name, and the shell that set it already knows what it is.
    let state = EngineState::Serving { mailbox_id: "mbx-1".to_string() };
    let printed = format!("{state:?}");
    assert!(printed.contains("mbx-1"));
    assert!(!printed.to_lowercase().contains("token"));
}

#[test]
fn frame_contract_is_the_engines() {
    // These four numbers belong to the engine's codec, not to this shell. They are asserted here
    // so that changing one is a deliberate act with a red test attached — this file cannot reach
    // the engine's own source, so it cannot do better than that, and saying so is the point.
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(PREAMBLE_BYTES, 8);
    assert_eq!(MAX_HEADER_BYTES, 64 * 1024);
    assert_eq!(MAX_BODY_BYTES, 32 * 1024 * 1024);
}

#[test]
fn default_timings_are_the_shipped_ones() {
    let t = Timings::default();
    assert_eq!(t.stop_grace, STOP_GRACE);
    assert_eq!(t.healthy_for, HEALTHY_FOR);
    assert_eq!(t.backoff_base, RESTART_BACKOFF_BASE);
    assert_eq!(t.backoff_cap, RESTART_BACKOFF_CAP);
    assert_eq!(MAX_STARTS, 4);
}
