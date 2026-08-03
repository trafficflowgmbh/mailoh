import type { EngineMutation, MessageBodyWire, SyncChange, SyncResponse } from "../types.js";

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
  /**
   * Fetch one message's body text (slice U5-BODY), or `null` when this adapter serves no
   * bodies at all.
   *
   * `null` is the FixturesAdapter's answer and it is not a stub: the demo world's message
   * rows carry `body` in the mirror already, so there is nothing to fetch and nothing that
   * may touch the network (invariant #6). The engine writes no record for a `null`, which
   * keeps `?demo=1` at exactly zero requests — `demo-zero-network.test.ts` asserts it.
   *
   * It is on the ADAPTER rather than beside the surfaces because there are four surfaces
   * and one protocol. `GET /messages/:id/body` existed, spend-gated and contract-tested,
   * with zero callers for the whole of Stage 2; the reason every pile rendered a one-line
   * snippet was that nothing in the client had ever asked.
   *
   * A rejection MUST throw rather than resolve empty — the engine turns a throw into a
   * `failed` record and the surface says so. Resolving `{text: ""}` on a 500 would render
   * an empty message as though that were the mail.
   */
  fetchBody(messageId: string): Promise<MessageBodyWire | null>;
}
