// The root barrel — see `packages/db/src/ledger-source.ts`. The local engine mounts these routes,
// so an edge from here into the hosted half would ship it.
import { clientIdempotencyKey } from "@trafficflow/db";
import {
  ServiceError, type MarkSeenBody, type MessagePatchBody, type MoveBody,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { message, drafting, drafter, readBody } from "./shared.js";

/**
 * §5.2 — messages. `GET /messages?view=…` is the view-partitioned list (400
 * on a missing/unknown view). `PATCH` (unread/folder) and `POST …/move` are the
 * mutations: each echoes `X-Sync-Seq` from the emitted change (§3.4). `move` is
 * idempotent (Idempotency-Key) — the service writes the idempotency row IN its tx,
 * so `deps.idempotency` is threaded through. Every read/write is
 * account-scoped in the service (404 cross-account). NO IMAP here: a move only
 * writes DESIRED state; the worker performs the physical IMAP move.
 */
export const messageRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/messages",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const view = url.searchParams.get("view") ?? "";
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      const page = await message(deps).list(serviceContext(deps, req), { view, cursor, limit });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await message(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id/body",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await message(deps).getBody(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    // §5.2 — the BATCH read-state route. `{ ids, unread }`, one transaction, one
    // `change_log` row per message, `flag_state.desired_seen` upserted per message so the worker
    // can put `\Seen` on the real server. Capped at 200 ids (413 above it).
    //
    // It sits BEFORE `/messages/:id` in this table only for readability — `matchRoute` compares
    // segment counts first, so `/messages` and `/messages/:id` can never contend.
    //
    // `idempotent: true` for the reason `POST …/move` carries it: this is a multi-row write
    // whose retry after a lost response would re-emit N delta rows for changes the client
    // already has. The service does not claim the key itself (unlike `move`, whose claim
    // lives in its transaction) — `withIdempotency` replays the stored response, and the
    // operation is naturally idempotent anyway, since setting `unread` to the same value twice
    // is the same end state.
    method: "PATCH",
    pattern: "/messages",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<MarkSeenBody>(req);
      const { items, seq } = await message(deps).markSeen(serviceContext(deps, req), body);
      return jsonResponse({ items }, { status: 200, seq });
    },
  },
  {
    method: "PATCH",
    pattern: "/messages/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<MessagePatchBody>(req);
      const { dto, seq } = await message(deps).patch(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto, { status: 200, seq });
    },
  },
  {
    // §5 POST /messages/:id/draft — AI draft-from-history (Phase 3b). Assembles a
    // sensitivity-safe context (KB + this thread, `no_kb`/`no_ai`/sensitive
    // structurally excluded — R-P3-1/7), calls the INJECTED drafter, and STORES a
    // `drafts` row (never sent). A `no_ai`/sensitive target is refused 422 before
    // the drafter is called (R-P3-6). Echoes X-Sync-Seq.
    //
    // IDEMPOTENT-MARKED, and metering is what made it a prerequisite rather than a
    // nicety: `debit_draft`'s attempt key must be the CLIENT's `Idempotency-Key`,
    // and until this flag existed no such key reached the handler at all. On a metered
    // deployment the key is therefore REQUIRED (400 without it) — the same shape
    // `POST /drafts/:id/send` already uses, and for the same reason: a paid, non-repeatable
    // action needs the client to say "this is one intent" before we spend on it.
    method: "POST",
    pattern: "/messages/:id/draft",
    // `paid`: this is the model-inference call, metered against the credit ledger. It carried
    // no cost class at all until this table gained one, which made an unverified account one
    // POST away from token spend.
    cost: "paid",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const ctx = serviceContext(deps, req);
      const credits = deps.services?.aiCredits?.(deps.db, ctx.accountId);
      if (credits && !deps.idempotency) {
        throw new ServiceError(
          "idempotency_key_required", 400,
          "an Idempotency-Key header is required for AI drafting",
        );
      }
      const { draftId, seq } = await drafting(deps).draftFromMessage(ctx, params.id!, {
        drafter: drafter(deps),
        credits,
        attemptKey: deps.idempotency ? clientIdempotencyKey(deps.idempotency.key) : undefined,
        idempotency: deps.idempotency
          ? {
              key: deps.idempotency.key,
              requestHash: deps.idempotency.requestHash,
              responseStatus: 202,
              response: (r) => ({ draftId: r.draftId }),
            }
          : undefined,
      });
      return jsonResponse({ draftId }, { status: 202, seq });
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/move",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<MoveBody>(req);
      const { dto, seq } = await message(deps).move(serviceContext(deps, req), params.id!, body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto, { status: 200, seq });
    },
  },
];
