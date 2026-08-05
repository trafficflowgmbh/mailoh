import type { SearchFilters } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { search } from "./shared.js";

/**
 * §5.7 — hybrid search. `GET /search?q=…` runs the lexical+fuzzy RRF ranking
 * (SearchService) and returns `{ items, facets, total }`, all accountId-scoped in
 * the service. Facet filters arrive as query params:
 *   folder, sender, unread, hasAttachments, dateFrom, dateTo.
 * An empty/absent `q` yields an empty result (no error). Session-protected (the
 * default pipeline populates `deps.session`; no `public` flag).
 */

/** "true"/"1" → true, "false"/"0" → false, else undefined (filter omitted). */
function boolParam(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

export const searchRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/search",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const q = url.searchParams.get("q") ?? "";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;

      const filters: SearchFilters = {};
      const folder = url.searchParams.get("folder");
      const sender = url.searchParams.get("sender");
      const dateFrom = url.searchParams.get("dateFrom");
      const dateTo = url.searchParams.get("dateTo");
      const unread = boolParam(url.searchParams.get("unread"));
      const hasAttachments = boolParam(url.searchParams.get("hasAttachments"));
      if (folder) filters.folder = folder;
      if (sender) filters.sender = sender;
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo) filters.dateTo = dateTo;
      if (unread !== undefined) filters.unread = unread;
      if (hasAttachments !== undefined) filters.hasAttachments = hasAttachments;

      const result = await search(deps).search(serviceContext(deps, req), { q, filters, limit });
      return jsonResponse(result);
    },
  },
];
