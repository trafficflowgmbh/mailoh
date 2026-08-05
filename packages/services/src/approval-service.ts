import { and, asc, eq, gt } from "drizzle-orm";
import {
  approvals, routingDecisions, messages, folderState, claimIdempotencyKey, recordChange, type Tx,
} from "@trafficflow/db";
import type { AdapterPort, Destination, NativeLocator } from "@trafficflow/core/mail";
import { applyReconcileAction } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { LearningService } from "./learning-service.js";
import { patternKeyFor } from "./learning-service.js";
import { materializeApproval } from "./dto/materialize.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { ApprovalDTO, Page } from "./dto/types.js";

export interface ApprovalDeps {
  /**
   * The IMAP write-path adapter for the inline approved move (OUTSIDE the tx).
   * OPTIONAL: the serverless API constructs the service WITHOUT one — the DB
   * tx still sets folder_state `pending` + emits the move change, and the always-on
   * worker performs the physical IMAP move on its next reconcile cycle.
   */
  adapter?: AdapterPort;
  learning?: LearningService;
}

export interface ApprovalDecisionBody {
  decision: "approve" | "reject";
}

/** Idempotency handle threaded in by the route; the row is written IN the decide tx. */
export interface ApprovalIdempotency {
  key: string;
  requestHash: string;
}

export interface ListApprovalsOptions {
  status?: "pending" | "approved" | "rejected" | "expired";
  cursor?: string;
  limit?: number;
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
/** Materialize inside the ambient tx (reads its uncommitted writes) — same query surface as Db. */
const asDb = (tx: Tx): Db => tx as unknown as Db;

/**
 * ApprovalService. Lists pending approvals and resolves them. On
 * **approve** the stored routing payload is executed via the reconciler write-path
 * — the physical move runs OUTSIDE the DB transaction — the approval +
 * routing decision flip to `approved`, a `move` change is emitted, and the action
 * feeds the learning loop as a POSITIVE signal (advancing graduation counters via
 * SQL). On **reject** the approval flips to `rejected`, an override is
 * recorded, and the learning loop is fed a NEGATIVE signal (demotion). Deciding an
 * already-resolved/expired approval is a 422.
 */
export class ApprovalService {
  private readonly learning: LearningService;
  constructor(private readonly deps: ApprovalDeps) {
    this.learning = deps.learning ?? new LearningService();
  }

  async list(ctx: ServiceContext, opts: ListApprovalsOptions = {}): Promise<Page<ApprovalDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(approvals.accountId, ctx.accountId)];
    if (opts.status) filters.push(eq(approvals.status, opts.status));
    if (opts.cursor) filters.push(gt(approvals.id, decodeListCursor(opts.cursor)));

    const rows = await ctx.db.select({ id: approvals.id }).from(approvals)
      .where(and(...filters)).orderBy(asc(approvals.id)).limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const items: ApprovalDTO[] = [];
    for (const r of pageRows) {
      const dto = await materializeApproval(ctx.db, ctx.accountId, r.id);
      if (dto) items.push(dto);
    }
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items, nextCursor };
  }

  async decide(
    ctx: ServiceContext, id: string, b: ApprovalDecisionBody,
    opts: { idempotency?: ApprovalIdempotency | null } = {},
  ): Promise<ApprovalDTO> {
    const [appr] = await ctx.db.select().from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.accountId, ctx.accountId))).limit(1);
    if (!appr) throw new ServiceError("not_found", 404, "approval not found");
    if (appr.status !== "pending") {
      throw new ServiceError("unprocessable", 422, `approval already ${appr.status}`);
    }
    const expired = appr.expiresAt != null && appr.expiresAt.getTime() <= ctx.now().getTime();
    if (expired) throw new ServiceError("unprocessable", 422, "approval has expired");

    // Resolve the target folder + the message's current native location (reads before the tx, step 1).
    const target = extractFolder(appr.payload);
    let msg: { id: string; fromAddress: string; locator: NativeLocator; observedFolder: string } | null = null;
    if (appr.messageId) {
      const [m] = await ctx.db.select({
        id: messages.id, fromAddress: messages.fromAddress, nativeLocator: messages.nativeLocator,
        observedFolder: folderState.observedFolder,
      }).from(messages).leftJoin(folderState, eq(folderState.messageId, messages.id))
        .where(and(eq(messages.id, appr.messageId), eq(messages.accountId, ctx.accountId))).limit(1);
      if (m) {
        const loc = (m.nativeLocator as NativeLocator | null) ?? { folder: m.observedFolder ?? "INBOX", ref: "0:0" };
        msg = { id: m.id, fromAddress: m.fromAddress, locator: loc, observedFolder: m.observedFolder ?? loc.folder };
      }
    }

    const approve = b.decision === "approve";
    const label = approve ? "positive" : "negative";

    // ── DB tx: flip status, (approve) re-route folder-state, emit change_log, feed learning (step 2) ──
    const dto = await asTx(ctx).transaction(async (tx) => {
      await tx.update(approvals)
        .set({ status: approve ? "approved" : "rejected", updatedAt: ctx.now() })
        .where(eq(approvals.id, id));
      if (appr.routingDecisionId) {
        await tx.update(routingDecisions)
          .set({ status: approve ? "approved" : "rejected", updatedAt: ctx.now() })
          .where(eq(routingDecisions.id, appr.routingDecisionId));
      }
      let lastSeq = await recordChange(tx, { accountId: ctx.accountId, entityType: "approval", entityId: id, op: "update", meta: null });

      if (approve && msg && target) {
        await tx.insert(folderState).values({
          messageId: msg.id, desiredFolder: target, observedFolder: msg.observedFolder,
          lastSetBy: "us", reconcileStatus: "pending", conflict: false,
        }).onConflictDoUpdate({
          target: folderState.messageId,
          set: { desiredFolder: target, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: ctx.now() },
        });
        lastSeq = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: msg.id, op: "move",
          meta: { from: msg.observedFolder, to: target },
        });
      }

      if (msg && target) {
        await this.learning.recordOn(tx, ctx.accountId, {
          triggeringActionId: `approval:${id}`,
          kind: "approval",
          senderAddress: msg.fromAddress,
          destination: target,
          label,
        });
      }

      // Materialize the resolved ApprovalDTO INSIDE the tx (reads the uncommitted
      // status flip). The demotion pass + physical move below never touch the
      // `approvals` row, so this is the exact DTO the method returns.
      const materialized = await materializeApproval(asDb(tx), ctx.accountId, id);
      if (!materialized) throw new ServiceError("internal", 500, "approval vanished after decision");

      // Store the verbatim response IN this tx so a commit-then-crash retry
      // replays the SAME 200 — never re-flipping the approval (which, already
      // resolved, would otherwise 422). Inserted directly (services can't import packages/api).
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: materialized,
          seq: Number(lastSeq),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return materialized;
    });

    // Demotion pass on reject (accumulated overrides disable a promoted pattern).
    if (!approve && msg && target) {
      const pk = patternKeyFor({ senderAddress: msg.fromAddress, destination: target });
      if (pk) await this.learning.promoteOrDemote(ctx, pk);
    }

    // ── Physical IMAP move via the reconciler write-path, OUTSIDE the tx (step 3, idempotent) ──
    // Only when an adapter is injected. The serverless API path has none — the
    // folder_state row is left `pending` and the always-on worker drains it later.
    if (approve && msg && target && this.deps.adapter) {
      const repo = makeDrizzleRepo(ctx.db as unknown as Tx);
      await applyReconcileAction(
        { repo, adapter: this.deps.adapter, accountId: ctx.accountId, mailboxId: "" },
        { messageId: msg.id, locator: msg.locator, state: { desiredFolder: target, observedFolder: msg.observedFolder, lastSetBy: "us" } },
        { type: "move", to: target },
      );
    }

    return dto;
  }
}

function extractFolder(payload: unknown): Destination | null {
  if (payload && typeof payload === "object" && "folder" in payload) {
    const f = (payload as { folder?: unknown }).folder;
    if (typeof f === "string") return f as Destination;
  }
  return null;
}

export function makeApprovalService(deps: ApprovalDeps): ApprovalService {
  return new ApprovalService(deps);
}
