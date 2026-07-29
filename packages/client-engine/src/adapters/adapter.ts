import type { EngineMutation, SyncChange, SyncResponse } from "../types.js";

/**
 * ONE interface, two implementations (FixturesAdapter for ?demo/UI tests,
 * HttpAdapter for the real wire). The Engine is adapter-agnostic — swapping
 * Stage-2 live sync in is a construction-time config change, not a rewrite.
 */

export interface SyncParams {
  /** The cursor of record ("0" ⇒ bootstrap). */
  since: string;
  limit?: number;
  /** Optional `?types=` filter (contract §3.1). */
  types?: string[];
}

export interface MutationOutcome {
  /**
   * Authoritative changes to apply to the mirror right away (the §3.4
   * read-your-writes echo). Empty ⇒ the endpoint returned no seq'd DTO —
   * the engine reconciles via the next /sync drain instead.
   */
  changes: SyncChange[];
  /** The X-Sync-Seq of the mutation (null when the endpoint does not echo one). */
  seq: number | null;
}

export interface EngineAdapter {
  /** Fetch one /sync page. Throws CursorExpiredError on a 410 (§3.2). */
  sync(params: SyncParams): Promise<SyncResponse>;
  /**
   * Execute a mutation. `idempotencyKey` is stable across retries of the SAME
   * logical intent (contract §1.6) — a replay must not double-apply.
   * Throws MutationRejectedError (retryable or not) on failure.
   */
  mutate(m: EngineMutation, opts: { idempotencyKey: string }): Promise<MutationOutcome>;
}
