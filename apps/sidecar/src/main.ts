import { realpathSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createSidecar, type Sidecar, type SidecarConfig } from "./engine.js";
import { serveOverStdio, type StdioHost } from "./host.js";
import { createSidecarLog } from "./log.js";

/**
 * THE RUNNABLE SIDECAR — the process the desktop shell spawns.
 *
 *   node --import tsx src/main.ts        (development)
 *   node dist/main.js                    (packaged)
 *
 * stdin and stdout are the transport. stderr is the only place anything may be said out loud.
 *
 * ── STDOUT PURITY IS A MECHANISM, NOT A CONVENTION ────────────────────────────────────────
 *
 * One stray `console.log` anywhere in the module graph — ours, a dependency's, a debug line
 * somebody forgot — injects bytes into the middle of a frame. Because the framing is
 * length-prefixed there is no resync point: the peer reads the next 8 bytes of a JSON header as a
 * preamble and the connection is finished, with a symptom ("the app stopped talking to the
 * engine") that points nowhere near the cause.
 *
 * So {@link claimStdout} takes the real `write` for the frame writer and then REPLACES
 * `process.stdout.write` with one that forwards to stderr. `console.log`, a library's progress
 * line, and anything else that goes through the stream lands in the log instead of in the wire.
 * It cannot cover a direct write to fd 1 — nothing in this stack does that (imapflow is
 * constructed with `logger: false`), and the redirect itself is pinned by tests that write through
 * `console.log` and assert the bytes land on stderr rather than in the frame stream.
 */

/**
 * Capture the real stdout for the frame stream, then point `process.stdout` at stderr.
 *
 * The sink is a genuine `Writable` that delegates to the captured `write` and, crucially,
 * PROPAGATES BACKPRESSURE: `_write`'s callback is withheld until the underlying stream drains, so
 * this stream's own buffer fills and `write()` starts returning false exactly when the real one
 * does. `FrameWriter` depends on that — a sink that always claimed to have accepted the bytes
 * would buffer a 32 MB response in userland instead of waiting for the UI to read it.
 *
 * Two shapes were tried first and are wrong, recorded so they are not tried again:
 *
 *  · **A prototype clone that only overrides `write`.** `on("drain")` then registers the listener
 *    on the CLONE while the real stream emits on itself, so the writer waits for a drain that can
 *    never arrive and the sidecar hangs on the first response bigger than a pipe buffer.
 *  · **`fs.createWriteStream("", { fd: 1 })`.** `destroy()` closes fd 1 even with
 *    `autoClose: false`, and `fs.write` is the wrong primitive for a non-blocking pipe. Delegating
 *    to `process.stdout` reuses Node's own handling of pipes, TTYs and files.
 */
export function claimStdout(): Writable {
  const real = process.stdout;
  const realWrite = real.write.bind(real);

  const sink = new Writable({
    // Small, so backpressure is felt promptly rather than after a megabyte of slack.
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _enc, cb) {
      const flushed = realWrite(chunk, (err) => {
        if (err) cb(err);
        else if (flushed) cb();
      });
      if (!flushed) real.once("drain", () => cb());
    },
  });
  real.on("error", (err) => sink.destroy(err));

  const toStderr = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : cb;
    process.stderr.write(
      chunk as string | Uint8Array,
      typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
    );
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof real.write;
  real.write = toStderr;

  return sink;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is required. The shell passes the mailbox it owns; the sidecar invents nothing.`);
  }
  return v;
}

/** `OHMAIL_KEK_V<n>`, n >= 1, no leading zeros. `OHMAIL_KEK` is the unversioned spelling of v1. */
const KEK_VAR_RE = /^OHMAIL_KEK_V([1-9][0-9]*)$/;
const KEK_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * THE KEY RING THE HOST HANDS OVER, read from the environment it spawned this process with.
 *
 * `OHMAIL_KEK` is one key and means version 1 — the spelling a shell that has never rotated
 * passes, and the only one it ever needs. `OHMAIL_KEK_V1 … OHMAIL_KEK_Vn` is the same thing said
 * so that a SECOND key can exist beside the first, which is what rotation is: install the new
 * version, keep the old one until no stored credential still references it, then drop it.
 *
 * Three rules, each of them a failure somebody would otherwise debug at length:
 *
 *  · **Versions are contiguous from 1.** A gap means the missing version is exactly the one some
 *    stored row needs, so accepting it converts a startup failure into an unopenable mailbox
 *    later.
 *  · **`OHMAIL_KEK` and `OHMAIL_KEK_V1` may not disagree.** Two spellings of one version with
 *    different bytes is a host that does not know its own key; guessing which one is meant is how
 *    a credential gets sealed under a key nobody has.
 *  · **Empty is absent.** A launcher that materializes every declared variable as `""` must not
 *    look like a broken key.
 *
 * A value is validated and converted; it is never echoed, in an error message or anywhere else.
 */
function keksFromEnv(env: NodeJS.ProcessEnv): Record<number, Buffer> {
  const hex = new Map<number, string>();
  const set = (version: number, value: string, name: string): void => {
    if (!KEK_HEX_RE.test(value)) {
      throw new Error(`${name} must be 64 hex characters (a 32-byte AES-256 key)`);
    }
    const seen = hex.get(version);
    if (seen !== undefined && seen.toLowerCase() !== value.toLowerCase()) {
      throw new Error(
        `OHMAIL_KEK and OHMAIL_KEK_V${version} are both set and differ. Pass one spelling of ` +
          "each key version; two different values for one version is a host that cannot know " +
          "which key its stored credentials were sealed under",
      );
    }
    hex.set(version, value);
  };

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.trim() === "") continue;    // "" counts as absent
    if (name === "OHMAIL_KEK") set(1, value.trim(), name);
    else {
      const m = KEK_VAR_RE.exec(name);
      if (m) set(Number(m[1]), value.trim(), name);
    }
  }
  if (hex.size === 0) return {};

  const versions = [...hex.keys()].sort((a, b) => a - b);
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new Error(
        `key versions must be contiguous from 1: OHMAIL_KEK_V${i + 1} is missing ` +
          `(found ${versions.map((v) => `V${v}`).join(", ")}). The missing version is the one ` +
          "some stored credential needs, so this is refused at startup rather than at the mailbox",
      );
    }
  }
  return Object.fromEntries(versions.map((v) => [v, Buffer.from(hex.get(v)!, "hex")]));
}

/** Build the configuration from the environment the shell sets. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const user = env.OHMAIL_IMAP_USER ?? required("OHMAIL_IMAP_USER");
  const keks = keksFromEnv(env);
  // NOT `required`, and this is the change that makes a restart survivable: after the launch on
  // which the user types it, the password lives encrypted in the local store and the environment
  // carries only the key. A launch with neither is not an error either — the engine serves the
  // mirror and the shell asks for a password.
  const pass = env.OHMAIL_IMAP_PASS;
  return {
    dataDir: env.OHMAIL_DATA_DIR ?? required("OHMAIL_DATA_DIR"),
    imap: {
      host: env.OHMAIL_IMAP_HOST ?? required("OHMAIL_IMAP_HOST"),
      port: Number(env.OHMAIL_IMAP_PORT ?? 993),
      secure: env.OHMAIL_IMAP_SECURE !== "0",
      auth: { user, ...(pass ? { pass } : {}) },
      ...(env.OHMAIL_SMTP_HOST
        ? {
            smtp: {
              host: env.OHMAIL_SMTP_HOST,
              port: Number(env.OHMAIL_SMTP_PORT ?? 587),
              secure: env.OHMAIL_SMTP_SECURE !== "0",
              ...(pass ? { auth: { user, pass } } : {}),
            },
          }
        : {}),
    },
    ...(env.OHMAIL_MAILBOX_ADDRESS ? { address: env.OHMAIL_MAILBOX_ADDRESS } : {}),
    ...(env.OHMAIL_POLL_MS ? { pollIntervalMs: Number(env.OHMAIL_POLL_MS) } : {}),
    ...(Object.keys(keks).length > 0 ? { keks } : {}),
  };
}

export async function runSidecar(): Promise<void> {
  const stdout = claimStdout();
  // The hardened logger from `packages/core`, on stderr. This used to be a hand-rolled
  // `JSON.stringify` whose comment claimed the worker's shape; `log.ts` in this package records
  // what that cost. Every `log(...)` below goes through the allowlist, the value patterns and the
  // `err` reduction.
  const log = createSidecarLog();
  let sidecar: Sidecar | null = null;

  // EPIPE means the parent is gone. Nothing left to serve, and continuing would keep an IMAP
  // connection open on behalf of a UI that no longer exists.
  process.stdout.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") void shutdown("stdout_epipe", 0);
  });

  let host: StdioHost | null = null;
  let shuttingDown: Promise<void> | null = null;
  /**
   * ORDER MATTERS, and getting it wrong corrupts the local mirror.
   *
   * Stop accepting requests → let the in-flight ones finish → only THEN close IMAP and the
   * database. `sidecar.stop()` closes PGlite; a handler still reading it at that moment gets a
   * dead connection at best, and at worst the mirror is closed mid-write. The stdin path already
   * waited (it goes through `host.finished()`); SIGTERM did not, which was the hole.
   */
  const shutdown = (reason: string, code: number): Promise<void> => {
    shuttingDown ??= (async () => {
      log("shutdown", { reason, inFlight: host?.inFlight ?? 0 });
      try {
        if (host) {
          host.stop();
          await host.finished();
        }
        await sidecar?.stop();
      } catch (err) {
        log("shutdown_failed", { err });
        code = 1;
      }
      process.exit(code);
    })();
    return shuttingDown;
  };

  try {
    sidecar = await createSidecar({ ...configFromEnv(), log });
  } catch (err) {
    log("start_failed", { err });
    process.exit(1);
  }

  host = serveOverStdio({
    handle: (req) => sidecar!.handle(req),
    input: process.stdin,
    output: stdout,
    log,
    onFatal: (err) => {
      log("transport_fatal", { err });
      void shutdown("transport_fatal", 1);
    },
  });

  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    // READ BEFORE `start()`, DELIBERATELY. `start()` is what would connect, and it is fired below
    // without being awaited; asking afterwards would race a first sync that takes minutes. What
    // the shell needs to know is what THIS launch was given, which is settled by the time the
    // sidecar was assembled.
    credentialState: await sidecar.credentialState(),
  });
  // `dataDir` used to be on this line and is deliberately gone. A data directory is a filesystem
  // path under the user's home, so it carries the OS account name and, on a portable install, the
  // volume — and the shell that set `OHMAIL_DATA_DIR` already knows it. `mailboxId` is what
  // correlates this line with everything after it.
  log("serving", { mailboxId: sidecar.world.mailboxId });

  // The mailbox comes up AFTER the bridge is serving. A first sync of a real mailbox takes
  // minutes, and a UI that cannot ask anything until it finishes is a UI that looks broken.
  //
  // LOGGING IS THE WHOLE HANDLER, AND THAT IS ONLY DEFENSIBLE BECAUSE `start()` CLEANS UP.
  // A rejection here used to leave an authenticated IMAP login open for the life of the process:
  // `connect()` logs in before any of the work that can fail, and this catch has no handle on the
  // adapter. `start()` now closes it on the way out (see the `catch` in `engine.ts`), so what is
  // left to decide here is genuinely a product question — and the answer is to keep serving the
  // mirror, because offline is a property of this mode rather than a failure of it.
  void sidecar.start().catch((err: unknown) => {
    log("mailbox_start_failed", {
      err,
      reason: "the mailbox did not come up; the IMAP login was released and the bridge keeps " +
        "serving the local mirror",
    });
  });

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

  // The parent closing our stdin is the ordinary way this process is asked to leave.
  await host.finished();
  await shutdown("stdin_closed", 0);
}

/**
 * IS THIS PROCESS RUNNING THE BUNDLE, rather than importing it?
 *
 * `@trafficflow/worker/entry`'s `isCliEntry` compares `import.meta.url` to `process.argv[1]` as
 * literal strings, which is right for the worker but WRONG for the desktop engine, and the failure
 * is silent. The shell spawns this bundle by a path, and when the kernel runs the file's shebang it
 * hands node an `argv[1]` with the `/private` prefix STRIPPED (a temp install under `/var`, an app
 * on a mounted image), while node resolves that same symlink INSIDE `import.meta.url`. The two then
 * differ by exactly `/private`, the check is false, `runSidecar` never runs, and the engine exits
 * having served nothing — which the shell reports as a start failure over and over. Resolving BOTH
 * sides to their real path is what lets the bundle recognise itself wherever the app was installed.
 *
 * On an IMPORT — a test loading this module — `argv[1]` is the test runner, so the two real paths
 * still differ and nothing auto-runs. Measured against a packaged `.app` spawned from a `/var` path,
 * where the literal comparison left the engine dead on arrival.
 */
function isRunAsProgram(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunAsProgram()) {
  void runSidecar();
}
