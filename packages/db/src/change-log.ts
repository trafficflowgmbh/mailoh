import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
/* THE MAIL HALF DIRECTLY, never `./schema.js`. `schema.ts` re-exports both halves, so naming it
 * here would put every Cloud table into the root barrel's closure — and the root barrel is what
 * the desktop engine's bundle follows. Both tables below are mail-domain. */
import { accountSyncState, changeLog } from "./schema-mail.js";

/**
 * A Drizzle query runner: either a top-level db handle (postgres-js in prod,
 * PGlite in tests) or an ambient transaction handle. Both expose the same
 * query-builder surface, so change-log writers are driver-agnostic and
 * always operate on the AMBIENT `tx`, never a captured `this.db`.
 *
 * **This type does NOT mean "a transaction".** It is the right type for a READ, and for a
 * write whose correctness does not depend on other statements committing with it. Anything
 * that takes a row lock, or that must commit two writes together, wants {@link LedgerTx} —
 * a lock taken on a top-level handle is released at the end of its own statement and
 * serializes nothing.
 */
export type Tx = PgDatabase<any, any, any>;

/**
 * A REAL transaction handle — the value `db.transaction((tx) => …)` hands its callback.
 *
 * Distinct from {@link Tx} on purpose: a top-level `PgDatabase` is not assignable here, so
 * `debitCredits(db, …)` does not compile. Use it for every primitive whose guarantees rest on
 * a row lock outliving the statement that took it, or on several writes becoming durable
 * together. (`liveSubscriptionOf(…, { forUpdate: true })` has the same requirement; it keeps
 * `Tx` because the same function serves the ordinary read path.)
 */
export type LedgerTx = PgTransaction<any, any, any>;

// The client-visible entity kinds that flow through `/sync`.
//
// GROWING THIS UNION IS NOT FREE, AND HERE IS WHY. The rule is not "never add a type" — it is
// that a type here without a matching case in `materialize` is worse than no type at all: the
// materializer falls through to `null`, and `SyncService` reads a null entity as a TOMBSTONE, so
// every row of the new kind would drain to the client as a `delete`. `"tag"` is added together
// with `materializeTag` (`packages/services/src/dto/materialize.ts`) in the same change, which is
// the condition this rule actually imposes.
//
// TAG ASSIGNMENTS ARE NOT A TYPE HERE. They ride the existing `"message"` entity: an assign or
// unassign emits one `message` change and the client re-reads that message's `labels`. A
// separate `message_tag` entity would have meant two changes per toggle at two seqs, with a
// window in which the client had the assignment but not the tag it names.
export type EntityType =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder"
  // Tag identity (name + hue). The assignment rides `message`; see above.
  | "tag";

export type ChangeOp = "create" | "update" | "move" | "delete";

export interface ChangeInput {
  accountId: string;
  entityType: EntityType;
  entityId: string;
  op: ChangeOp;
  meta?: { from: string | null; to: string } | null;
}

/**
 * Allocate the next per-account, gap-free, strictly-monotonic sequence number.
 *
 *   UPDATE account_sync_state
 *   SET next_seq = greatest(next_seq, coalesce((SELECT max(seq) FROM change_log
 *                                               WHERE account_id = $1), 0)) + 1
 *   WHERE account_id = $1 RETURNING next_seq;
 *
 * The implicit ROW LOCK taken by the UPDATE is the serialization mechanism — a
 * concurrent allocator blocks on the same row until this transaction commits, so
 * seq N is durable before N+1 is ever handed out. This is NOT a pg advisory lock
 * and NOT a bare bigserial (both of which leak gaps under concurrency).
 *
 * A guard INSERT ensures the counter row exists on first use for an account; it
 * is a no-op once the row is present (the common, hot path), leaving the UPDATE
 * as the sole serializing step.
 *
 * ── WHY THE COUNTER IS RECONCILED AGAINST THE LOG ON EVERY ALLOCATION ─────────────────────
 *
 * `change_log`'s primary key is `(account_id, seq)`, so a counter that sits BELOW the log's
 * own maximum does not degrade — it hard-fails, permanently. Every allocation hands back a
 * seq that is already taken, the insert raises `23505`, and because the change-log write is
 * inside the caller's transaction the whole mutation rolls back. An account in that state
 * cannot ingest a message, write a rule or record a screening decision: every write path in
 * the product returns 500 and nothing self-corrects, because the counter is only ever moved
 * by the statement that is failing.
 *
 * The way it happens is not exotic. Any copy of the database that reads these two tables at
 * different instants while the account is in use — a restore, a move between providers — lands
 * a counter that is behind the log it was copied beside, and from then on every mutation on
 * that account fails. The breakage is silent in the sense that matters: nothing about it is
 * visible until somebody presses a button.
 *
 * `greatest(next_seq, max(seq))` closes it by construction, for any cause, at the cost of one
 * index probe: `max(seq) WHERE account_id = $1` is a single descending walk of the primary
 * key. Monotonicity is unaffected — the first arm alone already guarantees it, so the
 * reconciliation can only ever move the counter FORWARD, never re-issue, and never leave a
 * gap that was not already in the log.
 *
 * MUST be called with the ambient transaction handle.
 */
export async function allocateSeq(tx: Tx, accountId: string): Promise<bigint> {
  const [first] = await allocateSeqRange(tx, accountId, 1);
  return first!;
}

/**
 * Allocate `count` CONSECUTIVE sequence numbers in one statement, oldest first.
 *
 * One round trip instead of `count` of them, and — more importantly — one row-lock
 * acquisition instead of `count`. A caller writing hundreds of change-log rows in a single
 * transaction (the sent-mail seed confirms one rule per correspondent, and real mailboxes
 * carry thousands) otherwise pays three statements per row, which on a serverless host is
 * the difference between a request that answers and one the platform kills at its deadline.
 *
 * The block is contiguous and reserved by the same UPDATE that {@link allocateSeq} uses, so
 * the guarantees are identical: strictly monotonic, gap-free, serialized against every
 * concurrent allocator on the account by the row lock this statement takes.
 *
 * `count` must be positive; a caller with nothing to record must not take the lock at all.
 */
export async function allocateSeqRange(tx: Tx, accountId: string, count: number): Promise<bigint[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`allocateSeqRange: count must be a positive integer, got ${String(count)}`);
  }
  await tx.insert(accountSyncState).values({ accountId }).onConflictDoNothing();
  const rows = await tx
    .update(accountSyncState)
    .set({
      nextSeq: sql`greatest(${accountSyncState.nextSeq}, coalesce((select max(${changeLog.seq}) from ${changeLog} where ${changeLog.accountId} = ${accountId}), 0)) + ${count}`,
    })
    .where(eq(accountSyncState.accountId, accountId))
    .returning({ nextSeq: accountSyncState.nextSeq });
  // `next_seq` now names the LAST seq of the block; the block is the `count` values ending there.
  const last = rows[0]!.nextSeq;
  const out: bigint[] = [];
  for (let i = BigInt(count) - 1n; i >= 0n; i--) out.push(last - i);
  return out;
}

/**
 * Allocate a seq and append the corresponding `change_log` row in the SAME
 * transaction (allocateSeq + change_log insert + entity write commit as one).
 * Returns the assigned seq (→ the `X-Sync-Seq` response header).
 *
 * MUST be called with the ambient transaction handle.
 */
export async function recordChange(tx: Tx, c: ChangeInput): Promise<bigint> {
  const [seq] = await recordChanges(tx, [c]);
  return seq!;
}

/**
 * Append MANY change-log rows in one allocation and one insert, in the order given.
 *
 * The same contract as {@link recordChange} — every row's seq is allocated from the account's
 * counter inside the ambient transaction — with the per-row round trips collapsed. A bulk
 * mutation that called `recordChange` in a loop spent three statements per entity, and the
 * cost is not merely latency: the account's counter row stays locked from the first
 * allocation to commit, so a long loop blocks every other writer on the account for its whole
 * duration. One allocation shortens that window to a single statement.
 *
 * Returns the assigned seqs, positionally. An empty list writes nothing and takes no lock.
 */
export async function recordChanges(tx: Tx, changes: readonly ChangeInput[]): Promise<bigint[]> {
  if (changes.length === 0) return [];
  const accountId = changes[0]!.accountId;
  // One account per call: the seqs come from ONE counter, so a mixed list would silently
  // stamp another account's rows with this account's sequence.
  for (const c of changes) {
    if (c.accountId !== accountId) throw new Error("recordChanges: every change must name the same account");
  }
  const seqs = await allocateSeqRange(tx, accountId, changes.length);
  await tx.insert(changeLog).values(changes.map((c, i) => ({
    accountId,
    seq: seqs[i]!,
    entityType: c.entityType,
    entityId: c.entityId,
    op: c.op,
    meta: c.meta ?? null,
  })));
  return seqs;
}

/**
 * The lowest `seq` still retained in the change log for an account, or `null`
 * when the log is empty. SyncService uses this to detect a cursor that has
 * fallen behind the retention horizon (→ 410 cursor_expired).
 */
export async function minRetainedSeq(tx: Tx, accountId: string): Promise<bigint | null> {
  const rows = await tx
    .select({ min: sql<string | null>`min(${changeLog.seq})` })
    .from(changeLog)
    .where(eq(changeLog.accountId, accountId));
  const m = rows[0]?.min;
  return m == null ? null : BigInt(m);
}
