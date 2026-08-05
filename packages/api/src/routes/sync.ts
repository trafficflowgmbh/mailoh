import type { EntityType } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { sync } from "./shared.js";

/** The EntityType values a `?types=` CSV may name; unknown tokens are dropped. */
const VALID_TYPES = new Set<EntityType>([
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder",
]);

/** Parse `?types=a,b,c` → EntityType[], silently ignoring unknown tokens. */
function parseTypes(raw: string | null): EntityType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter((t): t is EntityType => VALID_TYPES.has(t as EntityType));
  return types.length > 0 ? types : undefined;
}

/** §3 — the delta reader. A 410 (expired/malformed cursor) flows through withErrorEnvelope. */
export const syncRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/sync",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const since = url.searchParams.get("since") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
      const types = parseTypes(url.searchParams.get("types"));

      const result = await sync(deps).getChanges(serviceContext(deps, req), {
        since,
        ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
        ...(types ? { types } : {}),
      });
      return jsonResponse(result);
    },
  },
];
