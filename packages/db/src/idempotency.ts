import { and, eq, lte } from "drizzle-orm";
/* The mail half directly — see the note in `change-log.ts`. `idempotency_keys` is a mail table. */
import { idempotencyKeys } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * The `idempotency_keys` WRITE primitive, in `packages/db` because six services
 * need it and `packages/services` may not import `packages/api`.
 *
 * ## Why a CLAIM and not an insert
 *
 * The rule is that the dedup record must commit in the SAME transaction as the effect —
 * never "apply the effect, then mark it applied", which reopens the commit-then-crash
 * window. That law is necessary but on its own it was not SUFFICIENT, and the gap was a
 * real double-effect bug:
 *
 *   1. two concurrent invocations carrying the SAME `Idempotency-Key` both run
 *      `lookupIdempotent` (autocommit, before either transaction opens) and both MISS;
 *   2. both open a transaction and both apply the effect;
 *   3. both insert the idempotency row — and with `ON CONFLICT DO NOTHING` the second
 *      insert quietly does nothing while its transaction commits anyway.
 *
 * The result was two runs from one `POST /workflows/:id/run`, two promoted rules from one
 * screener decision, and two different responses for one key. On a serverless host this is
 * not exotic: a client retrying a request whose response was lost, or a double-tap, lands
 * as two simultaneous invocations by construction.
 *
 * So the insert becomes a CLAIM whose result is load-bearing. Postgres does the
 * serialization for us: the second `INSERT … ON CONFLICT` BLOCKS on the conflicting tuple
 * until the first transaction ends, and then reports whether it wrote anything.
 *  • claimed (a row came back) → this transaction owns the key; carry on and commit.
 *  • NOT claimed → another transaction already committed this key. The caller must throw,
 *    which ROLLS BACK its own effect, and the request replays the winner's stored response
 *    (`withIdempotency` in `packages/api`). Exactly one effect, one response, no 409.
 *
 * The rollback is what makes this correct rather than merely tidy, and it is only sound
 * because the effect and this row are already in one transaction: a lost claim means
 * the loser's effect is undone in full.
 *
 * ## Expiry is enforced, not decorative
 *
 * `expires_at` used to be written and never read, which made a nominally 24-hour key
 * permanent and `idempotency_keys` unbounded. The claim therefore takes over an EXPIRED
 * row (`setWhere: expires_at <= now`) instead of colliding with it forever, `lookupIdempotent`
 * filters on it, and {@link pruneIdempotencyKeys} deletes what has aged out.
 */

/** The TTL of a stored idempotent response. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** `expires_at` for a row written now. */
export function idempotencyExpiry(now: Date): Date {
  return new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
}

export interface IdempotencyClaimInput {
  accountId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  /** The verbatim response body to replay. */
  responseJson: unknown;
  /** `change_log` seq to re-emit as `X-Sync-Seq` on replay (null when the mutation emitted none). */
  seq: number | null;
  /** The request clock (`ctx.now()`), used for both `expires_at` and the expired-row takeover. */
  now: Date;
}

/**
 * Claim `(account_id, key)` for THIS transaction and store the response to replay.
 *
 * Returns `true` when this transaction owns the key, `false` when a concurrent
 * transaction already committed it — in which case the caller MUST throw so its own
 * effect rolls back (see the module doc). An expired row is taken over rather than
 * treated as a conflict.
 */
export async function claimIdempotencyKey(tx: Tx, i: IdempotencyClaimInput): Promise<boolean> {
  const row = {
    accountId: i.accountId,
    key: i.key,
    requestHash: i.requestHash,
    responseStatus: i.responseStatus,
    responseJson: i.responseJson,
    seq: i.seq,
    expiresAt: idempotencyExpiry(i.now),
    createdAt: i.now,
  };
  const claimed = await tx
    .insert(idempotencyKeys)
    .values(row)
    .onConflictDoUpdate({
      target: [idempotencyKeys.accountId, idempotencyKeys.key],
      set: {
        requestHash: row.requestHash,
        responseStatus: row.responseStatus,
        responseJson: row.responseJson,
        seq: row.seq,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      },
      // ONLY an already-expired row may be taken over. A live row belongs to whoever
      // committed it and must make this claim fail.
      setWhere: lte(idempotencyKeys.expiresAt, i.now),
    })
    .returning({ key: idempotencyKeys.key });
  return claimed.length > 0;
}

/**
 * Delete every `idempotency_keys` row whose TTL has passed. Run from the worker's
 * maintenance pass — without it the table only grows, since a mutation never revisits
 * its own key.
 */
export async function pruneIdempotencyKeys(tx: Tx, now: Date): Promise<number> {
  const gone = await tx
    .delete(idempotencyKeys)
    .where(lte(idempotencyKeys.expiresAt, now))
    .returning({ key: idempotencyKeys.key });
  return gone.length;
}

/** Read a stored idempotent response for `(accountId, key)` that has NOT expired. */
export async function readIdempotencyKey(
  tx: Tx,
  accountId: string,
  key: string,
  now: Date,
): Promise<{ requestHash: string; responseStatus: number; responseJson: unknown; seq: number | null } | null> {
  const rows = await tx
    .select({
      requestHash: idempotencyKeys.requestHash,
      responseStatus: idempotencyKeys.responseStatus,
      responseJson: idempotencyKeys.responseJson,
      seq: idempotencyKeys.seq,
      expiresAt: idempotencyKeys.expiresAt,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;   // aged out ⇒ as good as absent
  return {
    requestHash: row.requestHash,
    responseStatus: row.responseStatus,
    responseJson: row.responseJson,
    seq: row.seq ?? null,
  };
}
