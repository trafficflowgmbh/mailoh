import { and, eq, sql } from "drizzle-orm";
import { graduations, learningSignals, rules as rulesTbl, type Tx } from "@trafficflow/db";
import type { Destination } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/** Net (positives − negatives) a (pattern, action) must reach before it graduates. */
export const GRADUATION_THRESHOLD = 3;
/** Net-negative margin at which an accumulated set of overrides demotes/unpromotes a pattern. */
export const DEMOTION_THRESHOLD = 2;

export type LearningKind = "screener" | "approval" | "override" | "external_move";
export type LearningLabel = "positive" | "negative";

export interface LearningSignalInput {
  triggeringActionId: string;
  kind: LearningKind;
  senderAddress?: string | null;
  senderDomain?: string | null;
  destination?: Destination | string | null;
  label: LearningLabel;
}

/** Deterministic pattern key the pipeline's `RoutingPort.isGraduated` also reads. */
export function patternKeyFor(
  s: { senderAddress?: string | null; senderDomain?: string | null; destination?: string | null },
): string | null {
  if (!s.destination) return null;
  if (s.senderAddress) return `sender:${s.senderAddress.toLowerCase()}→${s.destination}`;
  if (s.senderDomain) return `domain:${s.senderDomain.toLowerCase()}→${s.destination}`;
  return null;
}

/**
 * LearningService. Captures every learning-relevant action as a
 * `learning_signals` row **deduped by `triggeringActionId`**, and advances the
 * `graduations` counters with **SQL expressions** — never an
 * app-side read-modify-write, which would lose updates under the worker-read /
 * API-write race. The `graduated` flip is likewise computed and guarded in SQL.
 *
 * The `graduations` table is the seam the 1c pipeline reads via
 * `RoutingPort.isGraduated`: once a (sender→destination, route) pattern graduates
 * here, the pipeline auto-applies confident classifications for it.
 */
export class LearningService {
  /** Public entry: runs on the request's ambient db (which may already be a tx). */
  async record(ctx: ServiceContext, s: LearningSignalInput): Promise<void> {
    await this.recordOn(asTx(ctx), ctx.accountId, s);
  }

  /**
   * Executor-level record so callers already inside a transaction (ApprovalService,
   * ScreenerService) can enroll the signal + counter bump atomically with their
   * own writes. Idempotent on `(accountId, triggeringActionId)`: a replayed action
   * inserts nothing and — crucially — bumps no counter.
   */
  async recordOn(tx: Tx, accountId: string, s: LearningSignalInput): Promise<void> {
    const inserted = await tx
      .insert(learningSignals)
      .values({
        accountId,
        triggeringActionId: s.triggeringActionId,
        kind: s.kind,
        senderAddress: s.senderAddress ?? null,
        senderDomain: s.senderDomain ?? null,
        destination: (s.destination as string | undefined) ?? null,
        label: s.label,
      })
      .onConflictDoNothing({ target: [learningSignals.accountId, learningSignals.triggeringActionId] })
      .returning({ id: learningSignals.id });

    // Duplicate triggering action → signal already recorded → do NOT double-count.
    if (inserted.length === 0) return;

    const patternKey = patternKeyFor(s);
    if (!patternKey) return;
    await this.bumpCounter(tx, accountId, patternKey, s.label);
  }

  /**
   * Advance the (pattern, action='route') counters entirely in SQL:
   *   positives = positives + 1   (or negatives = negatives + 1)
   * and flip `graduated` in the same statement, guarded so it is sticky once set
   * and only trips when net (positives − negatives) reaches the threshold. Because
   * the increment and the flip are one `ON CONFLICT DO UPDATE`, two concurrent
   * writers serialize on the row lock and neither loses an increment.
   */
  private async bumpCounter(tx: Tx, accountId: string, patternKey: string, label: LearningLabel): Promise<void> {
    const pos = label === "positive" ? 1 : 0;
    const neg = label === "negative" ? 1 : 0;
    const net = sql`(${graduations.positives} + ${pos}) - (${graduations.negatives} + ${neg})`;
    await tx
      .insert(graduations)
      .values({ accountId, patternKey, action: "route", positives: pos, negatives: neg, graduated: false })
      .onConflictDoUpdate({
        target: [graduations.accountId, graduations.patternKey, graduations.action],
        set: {
          positives: sql`${graduations.positives} + ${pos}`,
          negatives: sql`${graduations.negatives} + ${neg}`,
          graduated: sql`(${graduations.graduated} OR ${net} >= ${GRADUATION_THRESHOLD})`,
          graduatedAt: sql`CASE WHEN ${graduations.graduatedAt} IS NULL AND ${net} >= ${GRADUATION_THRESHOLD} THEN now() ELSE ${graduations.graduatedAt} END`,
          updatedAt: sql`now()`,
        },
      });
  }

  /** True when the (pattern, action) has graduated — the same read the 1c pipeline performs. */
  async isGraduated(ctx: ServiceContext, patternKey: string, action: "route" = "route"): Promise<boolean> {
    const rows = await asTx(ctx)
      .select({ graduated: graduations.graduated })
      .from(graduations)
      .where(and(
        eq(graduations.accountId, ctx.accountId),
        eq(graduations.patternKey, patternKey),
        eq(graduations.action, action),
        eq(graduations.graduated, true),
      ))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Promotion / demotion pass for a pattern. When a `sender:<addr>→<dest>`
   * pattern has graduated and no equivalent enabled promoted rule exists yet, create
   * one. When accumulated overrides push net negative past the demotion threshold,
   * disable the promoted rule (`demotions++`) and clear `graduated` — all in SQL.
   */
  async promoteOrDemote(ctx: ServiceContext, patternKey: string): Promise<void> {
    const tx = asTx(ctx);
    const [g] = await tx
      .select()
      .from(graduations)
      .where(and(
        eq(graduations.accountId, ctx.accountId),
        eq(graduations.patternKey, patternKey),
        eq(graduations.action, "route"),
      ))
      .limit(1);
    if (!g) return;

    const parsed = parsePatternKey(patternKey);
    if (!parsed) return;

    const net = g.positives - g.negatives;
    if (g.graduated && net >= GRADUATION_THRESHOLD) {
      await this.ensurePromotedRule(tx, ctx.accountId, parsed);
    } else if (net <= -DEMOTION_THRESHOLD) {
      await this.demotePromotedRule(tx, ctx.accountId, parsed);
      await tx
        .update(graduations)
        .set({ graduated: false, updatedAt: sql`now()` })
        .where(eq(graduations.id, g.id));
    }
  }

  private async ensurePromotedRule(tx: Tx, accountId: string, p: ParsedPattern): Promise<void> {
    const existing = await tx
      .select({ id: rulesTbl.id })
      .from(rulesTbl)
      .where(and(
        eq(rulesTbl.accountId, accountId),
        eq(rulesTbl.kind, p.kind),
        eq(rulesTbl.match, p.match),
        eq(rulesTbl.destination, p.destination),
      ))
      .limit(1);
    if (existing.length > 0) {
      await tx.update(rulesTbl).set({ enabled: true, updatedAt: sql`now()` }).where(eq(rulesTbl.id, existing[0]!.id));
      return;
    }
    await tx.insert(rulesTbl).values({
      accountId, kind: p.kind, match: p.match, destination: p.destination,
      provenance: "promoted", enabled: true,
    });
  }

  private async demotePromotedRule(tx: Tx, accountId: string, p: ParsedPattern): Promise<void> {
    await tx
      .update(rulesTbl)
      .set({ enabled: false, demotions: sql`${rulesTbl.demotions} + 1`, updatedAt: sql`now()` })
      .where(and(
        eq(rulesTbl.accountId, accountId),
        eq(rulesTbl.kind, p.kind),
        eq(rulesTbl.match, p.match),
        eq(rulesTbl.destination, p.destination),
        eq(rulesTbl.provenance, "promoted"),
      ));
  }
}

interface ParsedPattern { kind: "sender" | "domain"; match: string; destination: string; }

function parsePatternKey(patternKey: string): ParsedPattern | null {
  const arrow = patternKey.indexOf("→");
  if (arrow < 0) return null;
  const lhs = patternKey.slice(0, arrow);
  const destination = patternKey.slice(arrow + 1);
  const colon = lhs.indexOf(":");
  if (colon < 0) return null;
  const kind = lhs.slice(0, colon);
  const match = lhs.slice(colon + 1);
  if (kind !== "sender" && kind !== "domain") return null;
  return { kind, match, destination };
}

export const learningService = new LearningService();
