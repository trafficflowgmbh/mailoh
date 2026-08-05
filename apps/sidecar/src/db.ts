import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mailSchema } from "@trafficflow/db/mail";
import { MAIL_JOURNAL, adoptBaseline } from "@trafficflow/db/journal";

/**
 * THE LOCAL MIRROR: PGlite ON DISK, migrated by the SAME sequence production runs — over the
 * MAIL HALF, and only the mail half.
 *
 * PGlite is the sidecar's store precisely because it takes the same Drizzle journal, so it gets
 * the same schema. That is what makes the "one pipeline implementation" argument true — here
 * **narrowed to the half a mailbox is made of.**
 * The same MAIL journal, the same MAIL schema; the Cloud half never runs here and never ships.
 *
 * ── WHY THE CLOUD PASS WAS REMOVED, AND WHY NOTHING CAUGHT IT ─────────────────────────────
 *
 * This loop used to walk `JOURNALS` — mail then cloud — because that is what production does.
 * Two consequences, both invisible to every test in the repository:
 *
 *  1. **Every desktop install minted the Cloud schema locally.** The hosted credential store, the
 *     billing ledger, the subscription table, the staff directory and fifteen more, created in a
 *     database belonging to somebody who has no account with us, cannot log in, is not billed and
 *     has no operator. A table nobody writes is not harmless when its NAME is the disclosure.
 *  2. **It put the Cloud journal's SQL inside the shipped application.** The migrator reads
 *     `.sql` files off disk at runtime, so `drizzle-cloud/`'s eight files — the identity ceremony,
 *     Stripe, the credit ledger, the admin console's staff tables — would have had to be packaged
 *     beside the engine to make this line work at all. Readable text, the private half, in a
 *     public download.
 *
 * **A bundler cannot see either one.** Both journals are read through `node:path` at runtime, so
 * they are not esbuild inputs: a bundle-input census of the engine reports the private half at
 * zero while the artifact still has to carry it. That is why this is stated here, in the loop,
 * rather than trusted to a measurement.
 *
 * The mail journal is closed under itself by construction — a test over the journal asserts that
 * no mail statement names an object belonging to the Cloud half — so mail-alone, first, against an
 * empty database is exactly the case it was designed for.
 *
 * `adoptBaseline` is a no-op for a brand-new local database (it hits the `fresh` cell of its truth
 * table) and it is still called rather than skipped, for the same reason `testing.ts` calls it: a
 * code path only production takes is a code path nothing checks.
 *
 * Re-running this against a directory that already has the schema applies nothing. That is the
 * upgrade path for an installed desktop app — a new release ships new migrations and the first
 * launch replays only what is missing.
 *
 * ── CAVEAT WORTH WRITING DOWN NOW ──────────────────────────────────────────────────────────
 *
 * The on-disk format belongs to PGlite, not to us. A future PGlite major that changes it turns
 * every installed local mirror into a migration problem that no SQL journal can express. The
 * dependency is therefore pinned in `package.json`, and the honest answer if it ever moves is to
 * rebuild the mirror by re-syncing. Everything in the local database is reconstructible from IMAP
 * EXCEPT the decisions that have no representation on the server — rules, triage state and
 * Resurface timers, Screener verdicts, contacts and notes, snippets, workflows. Those are the only
 * rows a rebuild would actually lose, and preserving them across such a move is not handled here.
 */

export type LocalDb = PgliteDatabase<typeof mailSchema>;

export interface OpenLocalDb {
  db: LocalDb;
  /** The ohmail directory the caller named. */
  dataDir: string;
  /** The PGDATA inside it — `<dataDir>/pgdata`. See {@link PGDATA_SUBDIR}. */
  pgDataDir: string;
  /** Flush and release. Idempotent — shutdown paths call it from more than one place. */
  close(): Promise<void>;
}

/**
 * PGlite gets a SUBDIRECTORY, not the directory the caller named.
 *
 * `initdb` refuses a data directory that already contains anything at all — a single sibling file
 * makes it `exit(1)` with no JavaScript error to catch, only a WASM abort. So the lock file (and
 * anything else that later needs to sit beside the database) lives in `<dataDir>/`, and PGlite owns
 * `<dataDir>/pgdata` exclusively.
 */
export const PGDATA_SUBDIR = "pgdata";

/** Raised when another process already holds this data directory. */
export class DataDirLockedError extends Error {
  constructor(readonly dataDir: string, readonly holder: string) {
    super(
      `the ohmail local database at ${dataDir} is already open by ${holder}. PGlite has no ` +
        "cross-process locking of its own, so two engines on one directory corrupt it. Close the " +
        "other instance, or delete the .lock file if that process is definitely gone.",
    );
    this.name = "DataDirLockedError";
  }
}

export const LOCK_FILE = "sidecar.lock";

/** Is `pid` a live process this user can see? `kill(pid, 0)` is the portable probe. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take an exclusive lock on the data directory, or refuse.
 *
 * `wx` is `O_CREAT|O_EXCL`, which is atomic: two processes racing here cannot both win. A lock
 * left behind by a crash names a pid, and a pid that is gone releases it — the alternative, a
 * lock that outlives the crash, means a user whose laptop lost power cannot open their mail.
 */
function lockDataDir(dataDir: string): () => void {
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const raw = (() => {
        try {
          return readFileSync(path, "utf8").trim();
        } catch {
          return "";
        }
      })();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new DataDirLockedError(dataDir, `pid ${pid}`);
      // Stale (or unreadable): clear it and try exactly once more, so two processes both finding
      // it stale still resolve to one winner via the O_EXCL race above.
      rmSync(path, { force: true });
    }
  }
  throw new DataDirLockedError(dataDir, "another process that keeps re-taking the lock");
}

/**
 * Open (creating if needed) the local database at `dataDir` and bring its schema up to date.
 *
 * The returned handle is the PROCESS SINGLETON: the API deps and the sync loop share it. Two
 * PGlite instances on one directory corrupt it even inside one process, and two on one directory
 * across processes is what {@link lockDataDir} refuses.
 */
export async function openLocalDb(dataDir: string): Promise<OpenLocalDb> {
  mkdirSync(dataDir, { recursive: true });
  const unlock = lockDataDir(dataDir);
  const pgDataDir = join(dataDir, PGDATA_SUBDIR);
  let client: PGlite;
  try {
    client = new PGlite(pgDataDir);
    const db = drizzle(client, { schema: mailSchema });
    // ONE JOURNAL, and the loop is gone with the second one: a `for` over a one-element list is
    // an invitation to put the other element back. `adoptBaseline` still runs — it is a no-op on
    // a brand-new local database (the `fresh` cell of its truth table), and a code path only
    // production takes is a code path nothing checks.
    await adoptBaseline(db, MAIL_JOURNAL);
    await migrate(db, {
      migrationsFolder: MAIL_JOURNAL.dir,
      migrationsSchema: MAIL_JOURNAL.migrationsSchema,
    });
    let closed = false;
    return {
      db,
      dataDir,
      pgDataDir,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await client.close();
        } finally {
          unlock();
        }
      },
    };
  } catch (err) {
    unlock();
    throw err;
  }
}
