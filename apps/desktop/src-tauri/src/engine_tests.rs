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
///  · `echo`            — answer every request with a response describing what it received.
///  · `mute`            — accept requests and answer none. A wedged engine, which is what the
///                        run-end drain exists for.
///
/// The three request modes decode frames the same way the real engine does — an 8-byte preamble
/// then a JSON header then a body — so a test that passes is a test about this shell's half of the
/// protocol rather than about a script written to agree with it.
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

// One line on stderr, in the shape the real engine's logger emits: a JSON object per line, already
// redacted by the time it leaves that process. It is here so a test can prove the shell forwards
// the engine's own diagnostics to the log file rather than only its own account of them.
process.stderr.write(JSON.stringify({ level: "info", msg: "fake engine up", mode }) + "\n");

function frame(header, body) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const b = body ?? Buffer.alloc(0);
  const pre = Buffer.alloc(8);
  pre.writeUInt32BE(h.length, 0);
  pre.writeUInt32BE(b.length, 4);
  process.stdout.write(Buffer.concat([pre, h, b]));
}
const ready = () => frame({
  v: 1, t: "ready", baseUrl: "http://sidecar",
  sessionToken: "tok_" + "a".repeat(24),
  accountId: "acc-1", userId: "usr-1", mailboxId: "mbx-1",
  credentialState: "ready",
});

if (mode === "die") { process.exit(1); }

ready();

// The real engine leaves when its stdin ends; `serve-deaf` is the one that does not.
if (mode !== "serve-deaf") {
  process.stdin.on("end", () => process.exit(0));
}

if (mode === "echo" || mode === "mute") {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 8) return;
      const hl = buf.readUInt32BE(0);
      const bl = buf.readUInt32BE(4);
      if (buf.length < 8 + hl + bl) return;
      const header = JSON.parse(buf.subarray(8, 8 + hl).toString("utf8"));
      const body = buf.subarray(8 + hl, 8 + hl + bl);
      buf = buf.subarray(8 + hl + bl);
      if (mode === "mute") continue;
      // The answer describes the request, so a test can prove what actually crossed the pipe —
      // the method, the URL, every header the shell composed, and the body's bytes.
      const said = Buffer.from(JSON.stringify({
        method: header.method, url: header.url, h: header.h, body: body.toString("utf8"),
      }), "utf8");
      frame({
        v: 1, t: "res", id: header.id, status: 200, statusText: "OK",
        h: [["content-type", "application/json"]], sc: [],
      }, said);
    }
  });
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
        credential_state: CredentialState::Ready,
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

// ── The bridge: a request down the pipe, an answer back ─────────────────────────────────────
//
// The transport is what makes `engine.rs` load-bearing rather than a lifecycle nobody consults.
// Everything below runs against a real child over a real pipe, for the reason stated at the top of
// this file: a correlation map tested against a fake stream would prove nothing about the failure
// that matters, which is a UI waiting for ever on an engine that is not going to answer.

/// Wait until the engine reports `Serving`, or fail saying what it reported instead.
fn serving(engine: &Engine) {
    wait_for(|| matches!(engine.state(), EngineState::Serving { .. }), Duration::from_secs(10), "Serving");
}

fn get(path: &str) -> EngineRequest {
    EngineRequest {
        method: "GET".to_string(),
        url: format!("http://sidecar{path}"),
        headers: vec![("accept".to_string(), "application/json".to_string())],
        body: Vec::new(),
    }
}

#[test]
fn a_request_crosses_the_pipe_and_the_answer_comes_back() {
    let f = Fixture::new("echo");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let answer = engine.request(get("/mailboxes")).expect("the engine answered");
    assert_eq!(answer.status, 200);
    assert_eq!(answer.status_text, "OK");
    assert!(answer.headers.iter().any(|(k, v)| k == "content-type" && v == "application/json"));

    // The body is the engine's own account of what it received, so this asserts what crossed the
    // pipe rather than what this process believes it sent.
    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    assert_eq!(said["method"], "GET");
    assert_eq!(said["url"], "http://sidecar/mailboxes");

    engine.stop();
}

#[test]
fn the_shell_adds_the_authorization_and_the_caller_cannot() {
    // THE POINT OF THE WHOLE ARRANGEMENT. The per-launch session token is the engine's credential;
    // it reaches the child and never the caller. A caller that could set the header could also read
    // back what it set, which is the one way a token gets out of this process.
    let f = Fixture::new("auth");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let mut req = get("/health");
    req.headers.push(("Authorization".to_string(), "Bearer i-chose-this".to_string()));
    let answer = engine.request(req).expect("the engine answered");

    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    let headers = said["h"].as_array().expect("headers");
    let auth: Vec<&str> = headers
        .iter()
        .filter(|pair| pair[0].as_str().is_some_and(|k| k.eq_ignore_ascii_case("authorization")))
        .map(|pair| pair[1].as_str().unwrap_or(""))
        .collect();
    assert_eq!(auth.len(), 1, "exactly one authorization reached the engine: {auth:?}");
    assert_eq!(auth[0], format!("Bearer tok_{}", "a".repeat(24)));
    assert!(!auth[0].contains("i-chose-this"), "the caller's authorization was forwarded");

    engine.stop();
}

#[test]
fn a_request_body_reaches_the_engine_intact() {
    let f = Fixture::new("body");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let answer = engine
        .request(EngineRequest {
            method: "POST".to_string(),
            url: "http://sidecar/rules".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: br#"{"from":"petra@nordlys.example"}"#.to_vec(),
        })
        .expect("the engine answered");
    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    assert_eq!(said["method"], "POST");
    assert_eq!(said["body"], r#"{"from":"petra@nordlys.example"}"#);

    engine.stop();
}

#[test]
fn an_engine_that_dies_mid_request_fails_the_caller_instead_of_hanging() {
    // THE ACCEPTANCE FOR THE WHOLE CORRELATION MAP, and the reason there is no timer in this file.
    //
    // `mute` accepts the request and answers nothing. Killing it must fail the caller — a promise
    // that never settles is a spinner for ever with no log line near the cause. Mutate
    // `drain_waiting` out of the run-end path and this test hangs until the harness kills it,
    // which is exactly what a user would experience.
    let f = Fixture::new("mute");
    let engine = Arc::new(Engine::spawn_with(f.launch("mute"), quick()));
    serving(&engine);

    let asking = Arc::clone(&engine);
    let caller = thread::spawn(move || asking.request(get("/sync")));

    // Give the request time to be written and registered before the engine is taken away.
    thread::sleep(Duration::from_millis(150));
    let pid = engine.pid().expect("a running engine");
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(killed.success(), "could not kill the engine");

    let answer = caller.join().expect("the calling thread did not panic");
    let err = answer.expect_err("a killed engine answered a request");
    assert!(!err.is_empty(), "the failure said nothing");

    engine.stop();
}

#[test]
fn a_request_before_serving_is_refused_by_name() {
    // Every state that is not `Serving` gets its own sentence, because "the request failed" is the
    // one answer that helps nobody decide what to render.
    let engine = Engine::inert(EngineState::Absent { looked_for: "/nowhere/ohmail-engine".to_string() });
    let err = engine.request(get("/sync")).expect_err("an absent engine answered");
    assert!(err.contains("no local engine"), "{err}");

    let engine = Engine::inert(EngineState::NoKey { reason: "the keystore is locked".to_string() });
    let err = engine.request(get("/sync")).expect_err("a keyless engine answered");
    assert_eq!(err, "the keystore is locked");
}

#[test]
fn the_credential_state_rides_on_the_ready_frame() {
    let f = Fixture::new("cred");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);
    assert_eq!(engine.ready().expect("ready").credential_state, CredentialState::Ready);
    engine.stop();
}

#[test]
fn an_engine_that_says_nothing_about_credentials_is_unknown_and_not_absent() {
    // An older engine sends no `credentialState`. Reading that as "no password" would put a
    // password prompt in front of somebody whose mailbox is working.
    assert_eq!(CredentialState::parse(None), CredentialState::Unknown);
    assert_eq!(CredentialState::parse(Some("nonsense")), CredentialState::Unknown);
    assert_eq!(CredentialState::parse(Some("absent")), CredentialState::Absent);
    assert_eq!(CredentialState::parse(Some("unreadable")), CredentialState::Unreadable);
    assert_eq!(CredentialState::parse(Some("ready")), CredentialState::Ready);
}

#[test]
fn the_status_the_window_can_read_carries_no_token() {
    // `engine_status` is the one thing a page may read about the engine, and the token is the one
    // thing it must never contain. Asserted on the serialization rather than on the struct, because
    // the serialization is what crosses.
    let f = Fixture::new("status");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let printed = status_json(&engine).to_string();
    assert!(printed.contains("\"state\":\"serving\""), "{printed}");
    assert!(printed.contains("mbx-1"));
    assert!(printed.contains("\"credentialState\":\"ready\""), "{printed}");
    assert!(!printed.contains("tok_"), "the session token reached the window: {printed}");
    assert!(!printed.to_lowercase().contains("sessiontoken"), "{printed}");

    engine.stop();
}

#[test]
fn a_key_is_sixty_four_hex_characters_and_nothing_else() {
    assert!(is_key(&"a".repeat(64)));
    assert!(is_key(&"0123456789abcdef".repeat(4)));
    assert!(!is_key(&"a".repeat(63)));
    assert!(!is_key(&"a".repeat(65)));
    assert!(!is_key(&"g".repeat(64)));
    assert!(!is_key(""));
}

// ── Adopting the key an earlier version of this app stored ──────────────────────────────────
//
// The order is the correctness, and it is driven here rather than against a keychain: the real
// keystore on the machine running these tests holds that person's real key, so a test that used it
// would either be asserting things about their install or writing over it. `resolve_install_key`
// exists as a separate function for exactly this reason — everything it can do, it does through the
// four closures below, and there is no fifth closure that could delete anything.

/// What a run of [`resolve_install_key`] did, in order.
#[derive(Default)]
struct Keystore {
    calls: Mutex<Vec<String>>,
}

impl Keystore {
    fn note(&self, what: &str) {
        self.calls.lock().expect("calls").push(what.to_string());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }
}

fn a_key(seed: char) -> String {
    seed.to_string().repeat(64)
}

#[test]
fn this_apps_own_key_wins_and_nothing_else_is_consulted() {
    let store = Keystore::default();
    let key = a_key('a');
    let got = resolve_install_key(
        &|| {
            store.note("own");
            Stored::Key(key.clone())
        },
        &|| {
            store.note("older");
            Stored::Key(a_key('b'))
        },
        &|_| {
            store.note("adopt");
            Ok(())
        },
        &|| {
            store.note("mint");
            Ok(a_key('c'))
        },
    );
    assert_eq!(got, Ok(key));
    // Not merely "the right key": the older item is not even READ on the ordinary launch, which is
    // what keeps a migration from costing a keychain round trip on every start for ever.
    assert_eq!(store.calls(), vec!["own"]);
}

#[test]
fn the_key_an_earlier_version_stored_is_adopted_rather_than_replaced() {
    // THE DEFECT THIS EXISTS TO PREVENT. Without the older lookup, an install whose key was minted
    // by the previous version of this app finds nothing, mints a fresh key, and the engine reports
    // the mailbox password stored months ago as unreadable — with nothing on screen able to say
    // why.
    let store = Keystore::default();
    let existing = a_key('7');
    let got = resolve_install_key(
        &|| {
            store.note("own");
            Stored::Empty
        },
        &|| {
            store.note("older");
            Stored::Key(existing.clone())
        },
        &|key| {
            store.note(&format!("adopt {key}"));
            Ok(())
        },
        &|| {
            store.note("mint");
            Ok(a_key('c'))
        },
    );
    assert_eq!(got, Ok(existing.clone()), "the launch uses the key that opens the stored password");
    assert_eq!(
        store.calls(),
        vec!["own".to_string(), "older".to_string(), format!("adopt {existing}")],
        "the older key was read, copied, and nothing was minted"
    );
}

#[test]
fn a_copy_that_fails_does_not_cost_the_launch() {
    // The key is in hand and it opens what it opened before. Refusing to start over a bookkeeping
    // failure would trade a working mailbox for a syscall saved on the next launch.
    let existing = a_key('9');
    let got = resolve_install_key(
        &|| Stored::Empty,
        &|| Stored::Key(existing.clone()),
        &|_| Err("the keystore is read-only".to_string()),
        &|| panic!("nothing may be minted once an existing key has been read"),
    );
    assert_eq!(got, Ok(existing));
}

#[test]
fn nothing_older_and_nothing_of_ours_mints_exactly_one_key() {
    let store = Keystore::default();
    let minted = a_key('f');
    let got = resolve_install_key(
        &|| {
            store.note("own");
            Stored::Empty
        },
        &|| {
            store.note("older");
            Stored::Empty
        },
        &|_| {
            store.note("adopt");
            Ok(())
        },
        &|| {
            store.note("mint");
            Ok(minted.clone())
        },
    );
    assert_eq!(got, Ok(minted));
    assert_eq!(store.calls(), vec!["own", "older", "mint"]);
}

#[test]
fn an_item_of_ours_that_is_not_a_key_refuses_without_looking_further() {
    // Something wrote it. Minting over it, or quietly using a different key instead, would seal the
    // next password under a key that does not open the last one.
    let store = Keystore::default();
    let got = resolve_install_key(
        &|| {
            store.note("own");
            Stored::Foreign
        },
        &|| {
            store.note("older");
            Stored::Key(a_key('b'))
        },
        &|_| {
            store.note("adopt");
            Ok(())
        },
        &|| {
            store.note("mint");
            Ok(a_key('c'))
        },
    );
    let err = got.expect_err("a foreign item was accepted");
    assert!(err.contains(KEYSTORE_ENTRY), "the refusal names the item to remove: {err}");
    assert_eq!(store.calls(), vec!["own"]);
}

#[test]
fn an_older_item_that_will_not_be_read_stops_the_launch_rather_than_minting_over_it() {
    // The one branch where minting is actively harmful. The first lookup already proved the
    // keystore answers, so an error on the second means there IS an item here that this binary was
    // not allowed to read — and a fresh key would silently orphan whatever it seals.
    let got = resolve_install_key(
        &|| Stored::Empty,
        &|| Stored::Refused("access denied".to_string()),
        &|_| Ok(()),
        &|| panic!("a key was minted over an item that could not be read"),
    );
    let err = got.expect_err("a refused older item was ignored");
    assert!(err.contains("unreadable"), "the refusal says what minting would cost: {err}");
}

#[test]
fn an_older_item_of_the_wrong_shape_is_not_adopted() {
    let store = Keystore::default();
    let minted = a_key('e');
    let got = resolve_install_key(
        &|| Stored::Empty,
        &|| Stored::Foreign,
        &|_| {
            store.note("adopt");
            Ok(())
        },
        &|| {
            store.note("mint");
            Ok(minted.clone())
        },
    );
    assert_eq!(got, Ok(minted));
    assert_eq!(store.calls(), vec!["mint"], "nothing that is not a key is copied anywhere");
}

#[cfg(target_os = "macos")]
#[test]
fn the_older_coordinates_are_the_ones_the_earlier_version_wrote() {
    // These two strings are the previous version's, not this file's, and a disagreement is a
    // migration that finds nothing. Asserted so that changing one is a deliberate act with a red
    // test attached.
    assert_eq!(LEGACY_KEYSTORE_SERVICE, "io.ohmail.desktop");
    assert_eq!(LEGACY_KEYSTORE_ENTRY, "kek.v1");
    // And they are not this app's own, or the "look one place further" would be looking at itself.
    assert_ne!(LEGACY_KEYSTORE_SERVICE, KEYSTORE_SERVICE);
}

// ── The log file ────────────────────────────────────────────────────────────────────────────

#[test]
fn the_log_rolls_over_at_the_cap_and_keeps_one_generation() {
    let f = Fixture::new("rotate");
    let path = f.dir.join("engine.log");
    let mut log = LogFile::open(path.clone()).expect("open");

    // Just under the cap, then one more line, so the rotation is caused by the cap rather than by
    // an arbitrary call.
    let chunk = vec![b'x'; 64 * 1024];
    let mut written = 0u64;
    while written + chunk.len() as u64 <= LOG_MAX_BYTES {
        log.write(&chunk);
        written += chunk.len() as u64;
    }
    assert!(!f.dir.join("engine.log.old").exists(), "nothing rotated below the cap");

    log.write(b"the line that crosses it\n");
    let old = f.dir.join("engine.log.old");
    assert!(old.exists(), "the previous generation was kept");
    assert_eq!(fs::metadata(&old).expect("old").len(), written, "the whole of it was kept");
    let current = fs::read_to_string(&path).expect("current");
    assert_eq!(current, "the line that crosses it\n", "the new file starts with the line that rolled it");

    // A SECOND rotation replaces the one generation rather than accumulating them, so the space
    // this can take is bounded at two files however long the app runs.
    log.rotate().expect("the second rotation");
    assert!(!f.dir.join("engine.log.old.old").exists(), "generations do not accumulate");
    assert_eq!(
        fs::read_to_string(&old).expect("old"),
        "the line that crosses it\n",
        "the kept generation is the one that was current"
    );
    assert_eq!(fs::read_to_string(&path).expect("current"), "", "the new current file starts empty");
}

#[test]
fn reopening_a_log_appends_and_rotates_from_the_size_it_found() {
    let f = Fixture::new("reopen");
    let path = f.dir.join("engine.log");
    {
        let mut log = LogFile::open(path.clone()).expect("open");
        log.write(b"first run\n");
    }
    {
        let mut log = LogFile::open(path.clone()).expect("reopen");
        log.write(b"second run\n");
    }
    let text = fs::read_to_string(&path).expect("read");
    assert_eq!(text, "first run\nsecond run\n", "a relaunch adds to the account of the last one");
}

#[test]
fn the_shells_lines_and_the_engines_own_diagnostics_both_reach_the_file() {
    // The two halves of what a person needs and a packaged app throws away: this shell's account of
    // starting and stopping, and the engine's own JSON lines. And the one thing that must never be
    // in either — the per-launch session token, which the `ready` frame carries in-band.
    let f = Fixture::new("logfile");
    let path = f.dir.join("engine.log");
    install_log_file(path.clone()).expect("install the log file");

    let engine = Engine::spawn_with(f.launch("serve"), quick());
    serving(&engine);
    engine.stop();

    // Uninstalled before the assertions so nothing else in this binary can add to the file while it
    // is being read.
    *LOG.lock().expect("log") = None;
    let text = fs::read_to_string(&path).expect("the log file exists");

    assert!(text.contains("serving mailbox mbx-1"), "this shell's own account is missing: {text}");
    assert!(text.contains("stopped"), "the stop was not recorded: {text}");
    assert!(text.contains("fake engine up"), "the engine's own stderr never reached the file: {text}");
    assert!(
        !text.contains("tok_"),
        "the session token reached the log file, which is the one thing it may never do: {text}"
    );
}
