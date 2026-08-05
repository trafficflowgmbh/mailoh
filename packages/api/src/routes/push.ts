import type { PushSubscribeBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { push, readBody, noContent } from "./shared.js";

/**
 * §4.2 — push subscriptions. `POST` is idempotent (Idempotency-Key): the service
 * writes the idempotency row IN its mutation tx, so `deps.idempotency` is
 * threaded through. The stored/returned response is a bare `{ id }` (verbatim on
 * replay). `DELETE` is scoped to the account (404 cross-account).
 */
export const pushRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/push/subscriptions",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<PushSubscribeBody>(req);
      const { id } = await push(deps).subscribe(serviceContext(deps, req), body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse({ id }, { status: 201 });
    },
  },
  {
    method: "DELETE",
    pattern: "/push/subscriptions/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      await push(deps).unsubscribe(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
