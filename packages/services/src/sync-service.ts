import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { changeLog, minRetainedSeq, type EntityType } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { materialize, materializeMessages } from "./dto/materialize.js";
import type { ChangeOp, Folder, SyncChange, SyncResponse } from "./dto/types.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export interface GetChangesOptions {
  since?: string;
  limit?: number;
  types?: EntityType[];
}

/**
 * The delta `/sync` reader. Reads `change_log` ascending by seq,
 * re-materializes the CURRENT DTO per row, emits ONE change per row (no
 * compaction), tombstones rows whose live entity is gone, and never advances the
 * cursor past a change it dropped.
 */
export class SyncService {
  /** Opaque base64 of the per-account high-water seq. */
  encodeCursor(seq: bigint): string {
    return Buffer.from(seq.toString(10), "utf8").toString("base64url");
  }

  /** Inverse of {@link encodeCursor}. A cursor we cannot parse is treated as
   *  expired (410) — the client re-bootstraps with `since="0"`, which heals it. */
  decodeCursor(cursor: string): bigint {
    try {
      const dec = Buffer.from(cursor, "base64url").toString("utf8");
      if (!/^\d+$/.test(dec)) throw new Error("non-numeric cursor");
      return BigInt(dec);
    } catch {
      throw new ServiceError("cursor_expired", 410, "sync cursor is malformed or expired; re-bootstrap with since=0");
    }
  }

  async getChanges(ctx: ServiceContext, opts: GetChangesOptions = {}): Promise<SyncResponse> {
    const { db, accountId } = ctx;
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    // since omitted / "0" ⇒ bootstrap (full replay from seq 0).
    const sinceSeq = opts.since && opts.since !== "0" ? this.decodeCursor(opts.since) : 0n;

    // Retention horizon: a non-bootstrap cursor that has fallen
    // below the oldest retained change can never be reconstructed → 410.
    if (sinceSeq > 0n) {
      const minSeq = await minRetainedSeq(db, accountId);
      if (minSeq != null && minSeq > sinceSeq + 1n) {
        throw new ServiceError(
          "cursor_expired", 410,
          "sync cursor is older than the retention horizon; re-bootstrap with since=0",
        );
      }
    }

    const filters = [eq(changeLog.accountId, accountId), gt(changeLog.seq, sinceSeq)];
    if (opts.types && opts.types.length > 0) {
      filters.push(inArray(changeLog.entityType, opts.types));
    }

    const rows = await db
      .select()
      .from(changeLog)
      .where(and(...filters))
      .orderBy(asc(changeLog.seq))
      .limit(limit);

    const creates: SyncChange[] = [];
    const updates: SyncChange[] = [];
    const moves: SyncChange[] = [];
    const deletes: SyncChange[] = [];

    /**
     * PREFETCH THE PAGE'S MESSAGES IN THREE QUERIES, before the loop.
     *
     * The loop below used to call `materialize()` per row, and for a message that is three
     * sequential round-trips. At the 500-row default that is 1 500 of them, enough to run past
     * the function timeout on a large mailbox — so `/sync` returned nothing and every view in the
     * client rendered empty. Bootstrapping such a mailbox would have taken minutes of wall clock
     * spread over dozens of pages.
     *
     * Only `message` is prefetched because it is the only type that appears in volume; the other
     * six stay on the per-row path, which is correct and rare. `materializeMessages` applies the
     * same `accountId` predicate the per-row call did, so this changes cost and nothing else.
     */
    const messageIds = rows.filter((r) => r.entityType === "message" && r.op !== "delete").map((r) => r.entityId);
    const prefetched = await materializeMessages(db, accountId, messageIds);

    for (const row of rows) {
      const type = row.entityType as EntityType;
      const id = row.entityId;
      const seq = Number(row.seq);
      const op = row.op as ChangeOp;

      if (op === "delete") {
        deletes.push({ type, op: "delete", id, seq, updatedAt: row.createdAt.toISOString() });
        continue;
      }

      // Re-materialize the live entity. If it is gone, emit a delete tombstone
      // instead — regardless of the original op. A message absent from the
      // prefetch is absent for the same reason the per-row call returned null.
      const entity = type === "message"
        ? (prefetched.get(id) ?? null)
        : await materialize(db, accountId, type, id);
      if (entity === null) {
        deletes.push({ type, op: "delete", id, seq, updatedAt: row.createdAt.toISOString() });
        continue;
      }

      const updatedAt = (entity as { updatedAt?: string }).updatedAt ?? row.createdAt.toISOString();
      const change: SyncChange = { type, op, id, seq, updatedAt, entity };

      if (op === "move") {
        const meta = (row.meta as { from: Folder | null; to: Folder } | null) ?? null;
        if (meta) change.move = meta;
        moves.push(change);
      } else if (op === "create") {
        creates.push(change);
      } else {
        updates.push(change);
      }
    }

    // cursor = max seq actually returned; unchanged when the page is empty.
    const cursorSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : sinceSeq;

    return {
      changes: { creates, updates, moves, deletes },
      cursor: this.encodeCursor(cursorSeq),
      hasMore: rows.length === limit,
      serverTime: ctx.now().toISOString(),
    };
  }
}

export const syncService = new SyncService();
