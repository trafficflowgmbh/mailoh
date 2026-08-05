/**
 * Typed application error. Services throw these; route handlers (1f) map them to
 * the `ApiError` envelope (contract §1.4). `code` is the stable machine code the
 * client switches on; `httpStatus` is the response status.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * Thrown by a mutation whose `claimIdempotencyKey` came back FALSE: a concurrent
 * transaction carrying the same `Idempotency-Key` committed first.
 *
 * Throwing is the mechanism, not a diagnostic — it rolls this transaction back, and
 * because the effect and the idempotency row are in ONE transaction, the rollback
 * undoes the duplicate effect in full. `withIdempotency` (`packages/api`) catches it and
 * replays the winner's stored response, so the client sees one effect and one answer
 * rather than two runs or a spurious 409.
 *
 * It is deliberately NOT a {@link ServiceError}: it must never reach `withErrorEnvelope`
 * as an HTTP status. If it ever does surface as a 500, that means the winner's row could
 * not be read back, which is a genuine fault and not something to paper over.
 */
export class IdempotencyRaceLost extends Error {
  constructor(readonly accountId: string, readonly key: string) {
    super("idempotency key was claimed by a concurrent request");
    this.name = "IdempotencyRaceLost";
  }
}
