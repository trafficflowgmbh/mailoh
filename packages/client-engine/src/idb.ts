import type { MirrorRecord } from "./apply.js";
import { BaseMirrorStore } from "./store.js";
import type { Cursor } from "./types.js";

const ENTITIES = "entities";
const META = "meta";
const CURSOR_KEY = "cursor";

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
  /** Database name; one mirror per account should use a distinct name. */
  dbName?: string;
  /** Injectable factory — `fake-indexeddb`'s IDBFactory in tests, else global. */
  factory?: IDBFactory;
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
  private readonly factory: IDBFactory;
  private db: IDBDatabase | null = null;

  constructor(opts: IndexedDbMirrorStoreOptions = {}) {
    super();
    this.dbName = opts.dbName ?? "mailoh-mirror";
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
    this.db = await requestDone(req as IDBRequest<IDBDatabase>);
    return this.db;
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
    await txDone(tx);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
