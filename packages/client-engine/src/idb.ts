import type { MirrorRecord } from "./apply.js";
import { BaseMirrorStore } from "./store.js";
import type { Cursor } from "./types.js";

const ENTITIES = "entities";
const META = "meta";
const CURSOR_KEY = "cursor";

/**
 * Where the mirror records WHOSE mail it is holding. Read before anything is hydrated.
 *
 * The `__` prefix keeps it out of the application's own meta namespace, and `load()`
 * strips it the same way it strips the cursor, so `getMeta` can never hand the owner back
 * to a selector as though it were product state.
 */
const OWNER_KEY = "__owner";

/** The prefix every account-scoped mirror database name starts with. */
export const MIRROR_DB_PREFIX = "ohmail-mirror";

/**
 * THE DATABASE NAME THAT MUST NEVER BE USED AGAIN.
 *
 * Every build before this repair opened exactly this name, for every account, on every
 * browser. {@link purgeLegacyMirror} deletes it; it is never opened.
 */
export const LEGACY_MIRROR_DB = "ohmail-mirror";

/**
 * The database that holds `owner`'s mirror and no one else's.
 *
 * The account id is a server-issued opaque identifier and is not a secret from the origin
 * that is already holding the account's mail — it is in memory in this tab either way. It
 * is used verbatim rather than hashed so that a human looking at the browser's storage
 * inspector during a support call can tell whose mirror is whose.
 */
export function mirrorDbName(owner: string): string {
  return `${MIRROR_DB_PREFIX}:${owner}`;
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export interface IndexedDbMirrorStoreOptions {
  /**
   * THE ACCOUNT THIS MIRROR BELONGS TO — a server-verified account id, never a client
   * guess. Required unless {@link IndexedDbMirrorStoreOptions.dbName} is given.
   *
   * It does two separate jobs and both are load-bearing:
   *
   *  1. it NAMES the database ({@link mirrorDbName}), so two accounts on one browser open
   *     two different databases and can never see each other's cursor or records;
   *  2. it is STAMPED inside the database and checked on every open, so a database whose
   *     name says one account and whose contents were written by another is wiped rather
   *     than read.
   *
   * (2) is not redundant with (1). A name is a convention; the stamp is what makes the
   * guarantee survive a future change to the naming scheme, a restored profile, or a
   * database somebody opened by hand.
   */
  owner?: string;
  /**
   * Database name, overriding {@link IndexedDbMirrorStoreOptions.owner}'s derivation.
   *
   * FOR TESTS AND TOOLS. Passing this without an `owner` opts out of the ownership stamp
   * entirely, which is correct for a fixture database in `fake-indexeddb` and wrong for
   * anything a real account's mail lands in — `apps/webapp` never passes it.
   */
  dbName?: string;
  /** Injectable factory — `fake-indexeddb`'s IDBFactory in tests, else global. */
  factory?: IDBFactory;
}

/**
 * Delete a mirror database. Resolves even when the delete is BLOCKED by another tab that
 * still holds the database open — the caller is doing hygiene, not enforcing an invariant,
 * and a hung promise would be worse than an un-deleted database.
 */
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Delete the pre-repair, un-owned mirror.
 *
 * Every account that signed in on a given browser before this change wrote into ONE
 * database called {@link LEGACY_MIRROR_DB}. Renaming forward is not enough on its own:
 * whatever the last account left there is still on disk, still readable by anything on
 * this origin, and still exactly the cross-account material the rename exists to prevent.
 * So it is deleted, once, the first time an owned mirror is constructed.
 */
export function purgeLegacyMirror(factory?: IDBFactory): Promise<void> {
  const f = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!f) return Promise.resolve();
  return deleteDatabase(f, LEGACY_MIRROR_DB);
}

/**
 * Delete EVERY mirror on this origin — the sign-out / "this is not my computer" path.
 *
 * `IDBFactory.databases()` is the only way to enumerate, and it does not exist on every
 * engine (Firefox shipped it late; some privacy modes stub it). Where it is missing this
 * still deletes the legacy name and the caller's own mirror, which is the case that
 * matters: a sign-out knows who is signing out.
 */
export async function clearAllMirrors(owner?: string, factory?: IDBFactory): Promise<void> {
  const f = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!f) return;
  const names = new Set<string>([LEGACY_MIRROR_DB]);
  if (owner) names.add(mirrorDbName(owner));
  if (typeof f.databases === "function") {
    try {
      for (const info of await f.databases()) {
        if (info.name && info.name.startsWith(MIRROR_DB_PREFIX)) names.add(info.name);
      }
    } catch {
      /* enumeration refused — the two names above are still deleted */
    }
  }
  await Promise.all([...names].map((n) => deleteDatabase(f, n)));
}

/**
 * The IndexedDB-backed mirror (brief §2: "apply them into a local store —
 * IndexedDB for web"). Layout:
 *
 *   - object store `entities`: key "type:id" → MirrorRecord (tombstones INCLUDED —
 *     they carry the seq guard that makes replays converge);
 *   - object store `meta`: key string → value; the /sync cursor lives at "cursor".
 *
 * Every page is flushed in ONE readwrite transaction across both stores, so the
 * cursor never persists ahead of its page (contract §3.3 step 3).
 */
export class IndexedDbMirrorStore extends BaseMirrorStore {
  private readonly dbName: string;
  private readonly owner: string | null;
  private readonly factory: IDBFactory;
  private db: IDBDatabase | null = null;

  constructor(opts: IndexedDbMirrorStoreOptions = {}) {
    super();
    const owner = opts.owner?.trim();
    if (owner) {
      this.owner = owner;
      this.dbName = opts.dbName ?? mirrorDbName(owner);
    } else if (opts.dbName) {
      // The explicit-name escape hatch: fixtures and tooling, never an account's mail.
      this.owner = null;
      this.dbName = opts.dbName;
    } else {
      // THE DEFAULT THAT WAS THE BUG. `dbName ?? "ohmail-mirror"` meant every account on a
      // browser opened the same database and inherited the previous one's cursor and
      // records — /sync is account-filtered but it only MERGES, so nothing ever removed
      // the other account's mail from the mirror and it rendered. There is no safe default
      // for "whose mail is this", so there is no default.
      throw new Error(
        "IndexedDbMirrorStore requires `owner` (a server-verified account id) — an unowned mirror is shared between accounts on the same browser",
      );
    }
    const factory = opts.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (!factory) {
      throw new Error("IndexedDB is unavailable in this environment — use MemoryMirrorStore instead");
    }
    this.factory = factory;
  }

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const req = this.factory.open(this.dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTITIES)) db.createObjectStore(ENTITIES);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    const db = await requestDone(req as IDBRequest<IDBDatabase>);
    // BEFORE the handle is published, and therefore before `load()` can read a record out
    // of it. An ownership check that ran after hydration would be a check on data already
    // in memory and already renderable.
    await this.bindOwner(db);
    /**
     * YIELD TO A DELETE. Measured, not theorised.
     *
     * `deleteDatabase` fires `versionchange` on every OPEN connection and is BLOCKED until
     * they all close. `deleteDatabase` here resolves on `onblocked` deliberately — hygiene
     * must not hang — so a connection that ignores `versionchange` turns "the local copy is
     * wiped" into a silent no-op. And the connection that blocks it is normally OUR OWN: the
     * sign-out and account-erasure paths both run in the page whose engine holds the mirror.
     *
     * Found by deleting a live account through the product's own screen and then asking the
     * browser what databases it still had: `ohmail-mirror:<account>` was still there, and a
     * subsequent `open()` hung behind the pending delete. Every existing test in
     * `idb-owner.test.ts` called `close()` first, so none of them could see it.
     */
    db.onversionchange = () => {
      db.close();
      if (this.db === db) this.db = null;
    };
    this.db = db;
    return db;
  }

  /**
   * Claim this database for {@link owner}, or empty it first.
   *
   * Three cases, and the middle one is the whole point:
   *
   *  - **unstamped** — a database this build has never opened. Claim it. (A mirror written
   *    by a pre-repair build cannot appear here: that one is called
   *    {@link LEGACY_MIRROR_DB} and {@link purgeLegacyMirror} deletes it.)
   *  - **stamped with somebody else** — should be unreachable, because the name contains
   *    the owner. Unreachable states are exactly the ones worth handling: WIPE, then claim.
   *    Refusing to open instead would leave a user staring at a broken client with no way
   *    out; wiping costs a re-bootstrap from `/sync` and is invisible.
   *  - **stamped with us** — the ordinary path, one extra indexed read per session.
   */
  private async bindOwner(db: IDBDatabase): Promise<void> {
    if (this.owner === null) return;
    const read = db.transaction([META], "readonly");
    const stamped = await requestDone(read.objectStore(META).get(OWNER_KEY));
    await txDone(read);
    if (stamped === this.owner) return;

    const tx = db.transaction([ENTITIES, META], "readwrite");
    if (stamped !== undefined) {
      tx.objectStore(ENTITIES).clear();
      tx.objectStore(META).clear();
    }
    tx.objectStore(META).put(this.owner, OWNER_KEY);
    await txDone(tx);
  }

  async load(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ENTITIES, META], "readonly");

    const entityKeys = await requestDone(tx.objectStore(ENTITIES).getAllKeys());
    const entityVals = await requestDone(tx.objectStore(ENTITIES).getAll());
    const metaKeys = await requestDone(tx.objectStore(META).getAllKeys());
    const metaVals = await requestDone(tx.objectStore(META).getAll());
    await txDone(tx);

    this.records.clear();
    this.meta.clear();
    this.highSeq = 0;
    for (let i = 0; i < entityKeys.length; i++) {
      const rec = entityVals[i] as MirrorRecord;
      this.records.set(String(entityKeys[i]), rec);
      if (rec.seq > this.highSeq) this.highSeq = rec.seq;
    }
    for (let i = 0; i < metaKeys.length; i++) {
      this.meta.set(String(metaKeys[i]), metaVals[i]);
    }
    this.cursor = (this.meta.get(CURSOR_KEY) as Cursor | undefined) ?? "0";
    this.meta.delete(CURSOR_KEY);
    // The ownership stamp is this store's bookkeeping, not the application's meta — it
    // must not reach `getMeta` and from there a selector.
    this.meta.delete(OWNER_KEY);
    this.ver++;
  }

  protected async persist(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void> {
    if (dirty.length === 0 && cursor === null && metaEntries.length === 0) return;
    const db = await this.open();
    const tx = db.transaction([ENTITIES, META], "readwrite");
    const entities = tx.objectStore(ENTITIES);
    const meta = tx.objectStore(META);
    for (const rec of dirty) {
      entities.put(rec, `${rec.type}:${rec.id}`);
    }
    if (cursor !== null) meta.put(cursor, CURSOR_KEY);
    for (const [k, v] of metaEntries) meta.put(v, k);
    await txDone(tx);
  }

  protected async wipe(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ENTITIES, META], "readwrite");
    tx.objectStore(ENTITIES).clear();
    tx.objectStore(META).clear();
    // Clearing META drops the stamp too. Re-write it in the SAME transaction: a database
    // that is empty and unowned would be silently claimable by the next account to open
    // it, which is the state this whole mechanism exists to make impossible.
    if (this.owner !== null) tx.objectStore(META).put(this.owner, OWNER_KEY);
    await txDone(tx);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
