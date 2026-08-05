import { and, eq, sql } from "drizzle-orm";
import {
  accountSettings, contacts, folderState, learningSignals, messages, recordChange,
  routingDecisions, rules, type Tx,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RESET SCREENING STATE — put an account back to "never screened anybody", keeping the mail.

   This is a supported operation and not only a development convenience: re-running the seed
   after a change of life is the same button. So it is careful about two things.

   ── IT NEVER MOVES MAIL ───────────────────────────────────────────────────────────────────

   Screening decisions taken in the past caused real IMAP moves, and those moves are visible in
   every other mail client the person uses. Un-making them would be thousands more moves, made
   on the strength of an assumption about what the mailbox "should" look like — and the moves
   this would be undoing are indistinguishable, at the database level, from moves the user made
   by hand. So the reset REPORTS what it is leaving behind, per pile, and stops. What to do
   about it is a decision for a person.

   The consequence to hold onto: after a reset, mail physically filed in the Screener folder
   still belongs to a sender with no decision. The presentation layer already handles exactly
   that — it partitions by consent rather than by folder — so the account presents correctly
   without a single message moving.

   ── IT TELLS THE CLIENTS ──────────────────────────────────────────────────────────────────

   `rule` is a synced entity. A bulk DELETE that skipped the change log would leave every
   mirror — browser, desktop — showing the deleted rules for ever, with no event that could
   ever remove them. Each deletion gets its own change-log row inside the same transaction.

   `contacts` and `learning_signals` are NOT synced, so they are deleted plainly.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Mail that a past decision physically moved, and that this reset is deliberately leaving. */
export interface UnmovedPile {
  /** The folder as it exists on the mail server. */
  folder: string;
  messages: number;
  /** Messages the server has already been told about — i.e. really sitting there. */
  observed: number;
}

export interface ResetResult {
  rulesDeleted: number;
  contactsDeleted: number;
  screenerSuggestionsDeleted: number;
  learningSignalsDeleted: number;
  /**
   * What could not be cleanly un-moved, per pile. Never acted on — reported so that a person
   * can decide, because the alternative is a silent mass move through somebody's mailbox.
   */
  unmoved: UnmovedPile[];
  lastSeq: number | null;
}

/** The folders a screening decision can have moved mail INTO. INBOX is where mail already was. */
const DECISION_PILES = ["ohmail/Screener", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

/**
 * Count what past decisions physically moved. Read-only, and safe to call before deciding to reset.
 */
export async function unmovedReport(ctx: ServiceContext): Promise<UnmovedPile[]> {
  const rows = await ctx.db
    .select({
      folder: folderState.desiredFolder,
      total: sql<number>`count(*)::int`,
      observed: sql<number>`count(*) filter (where ${folderState.observedFolder} = ${folderState.desiredFolder})::int`,
    })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(
      eq(messages.accountId, ctx.accountId),
      sql`${folderState.desiredFolder} in ${sql`(${sql.join(DECISION_PILES.map((f) => sql`${f}`), sql`, `)})`}`,
    ))
    .groupBy(folderState.desiredFolder);

  return rows
    .map((r) => ({ folder: r.folder, messages: Number(r.total), observed: Number(r.observed) }))
    .sort((a, b) => b.messages - a.messages);
}

/**
 * Wipe rules, contacts, screener suggestions and screener learning. Keep every message.
 *
 * Idempotent: running it twice deletes nothing the second time and reports zeroes.
 */
export async function resetScreeningState(ctx: ServiceContext): Promise<ResetResult> {
  // Read the pile report BEFORE the transaction. It describes physical state the reset does
  // not change, so it is the same answer either way — and taking it outside keeps the
  // transaction, which holds the account's sequence row, as short as it can be.
  const unmoved = await unmovedReport(ctx);

  return asTx(ctx).transaction(async (tx) => {
    const doomed = await tx.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ctx.accountId));

    let lastSeq: bigint | null = null;
    for (const r of doomed) {
      // The change-log row is written BEFORE the delete so a crash between them leaves a
      // client believing a rule is gone that still exists — recoverable by the next sync —
      // rather than a rule gone from the database that no client will ever stop showing.
      lastSeq = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "rule", entityId: r.id, op: "delete", meta: null,
      });
    }
    if (doomed.length > 0) await tx.delete(rules).where(eq(rules.accountId, ctx.accountId));

    const contactRows = await tx.delete(contacts)
      .where(eq(contacts.accountId, ctx.accountId)).returning({ id: contacts.id });

    // Screener SUGGESTIONS only. The rest of `routing_decisions` is the record of why each
    // message is where it is — and since the reset moves nothing, that record is still true.
    const suggestionRows = await tx.delete(routingDecisions)
      .where(and(eq(routingDecisions.accountId, ctx.accountId), eq(routingDecisions.status, "suggestion")))
      .returning({ id: routingDecisions.id });

    const learningRows = await tx.delete(learningSignals)
      .where(and(eq(learningSignals.accountId, ctx.accountId), eq(learningSignals.kind, "screener")))
      .returning({ id: learningSignals.id });

    await tx.insert(accountSettings).values({
      accountId: ctx.accountId,
      seedConfirmedAt: null,
      seedConfirmedCount: 0,
      seedDeclinedCount: 0,
      screeningResetAt: ctx.now(),
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: {
        seedConfirmedAt: null,
        seedConfirmedCount: 0,
        seedDeclinedCount: 0,
        screeningResetAt: ctx.now(),
        updatedAt: ctx.now(),
      },
    });

    return {
      rulesDeleted: doomed.length,
      contactsDeleted: contactRows.length,
      screenerSuggestionsDeleted: suggestionRows.length,
      learningSignalsDeleted: learningRows.length,
      unmoved,
      lastSeq: lastSeq === null ? null : Number(lastSeq),
    };
  });
}
