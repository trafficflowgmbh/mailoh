"use client";

/**
 * Hash routing, verbatim from the prototype's contract:
 *   #/ohbox … #/settings   the eight views
 *   #/screener/screened    screener segment deep-links
 *   #/tag/pottery          one tag across everything
 * The query string (?demo=1) is untouched by navigation.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

export const VIEWS = [
  "ohbox",
  "reads",
  "receipts",
  "screener",
  "triage",
  "search",
  "compose",
  "settings",
] as const;
export type ViewId = (typeof VIEWS)[number] | "tag";
export type ScreenerSegmentId = "waiting" | "screened" | "spam";
/**
 * WHICH TRIAGE PILE IS OPEN — the thing the route could not say.
 *
 * Reported as: the triage horizons cannot be selected individually, only Answer Later opens,
 * on all three. That was exact. The rail lists three rows — Answer Later, Park, Resurface —
 * and `AppShell` collapsed every id beginning `triage` into `go("triage")`, which is a route
 * with no pile in it at all; `TriageView` then rendered all three stacks as equal peers and
 * `activeRailId` mapped the view back to the literal id `"triage"`, which is the Answer Later
 * row. So all three rows navigated to the identical URL, showed the identical screen, and lit
 * the first row whichever had been clicked. Selecting Park was not merely unbound — it was
 * unrepresentable.
 *
 * The ids are the pile's own names and not the rail's (`triage-aside`), because this is what
 * the URL carries: `#/triage/aside` reads as a place, `#/triage/triage-aside` reads as a bug.
 */
export const TRIAGE_PILES = ["reply", "aside", "resurface"] as const;
export type TriagePileId = (typeof TRIAGE_PILES)[number];

export interface Route {
  view: ViewId;
  tagId: string | null;
  screenerSegment: ScreenerSegmentId;
  triagePile: TriagePileId;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (raw.startsWith("tag/") && raw.slice(4)) {
    return { view: "tag", tagId: raw.slice(4), screenerSegment: "waiting", triagePile: "reply" };
  }
  if (raw === "screener" || raw.startsWith("screener/")) {
    const sub = raw.split("/")[1];
    return {
      view: "screener",
      tagId: null,
      screenerSegment: sub === "screened" || sub === "spam" ? sub : "waiting",
      triagePile: "reply",
    };
  }
  // `#/triage`, `#/triage/aside`, `#/triage/resurface`. An unknown sub-path falls to the first
  // pile rather than 404ing, exactly as an unknown screener segment falls to `waiting`.
  if (raw === "triage" || raw.startsWith("triage/")) {
    const sub = raw.split("/")[1];
    return {
      view: "triage",
      tagId: null,
      screenerSegment: "waiting",
      triagePile: (TRIAGE_PILES as readonly string[]).includes(sub ?? "")
        ? (sub as TriagePileId)
        : "reply",
    };
  }
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : "ohbox";
  return { view, tagId: null, screenerSegment: "waiting", triagePile: "reply" };
}

export function useHashRoute(): Route {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, []);
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return useMemo(() => parseHash(hash), [hash]);
}

export function go(view: Exclude<ViewId, "tag">): void {
  window.location.hash = `#/${view}`;
}

export function goTag(tagId: string): void {
  window.location.hash = `#/tag/${tagId}`;
}

export function goScreener(segment: ScreenerSegmentId): void {
  window.location.hash = segment === "waiting" ? "#/screener" : `#/screener/${segment}`;
}

/** The first pile keeps the bare `#/triage`, so every link that already exists still lands. */
export function goTriage(pile: TriagePileId): void {
  window.location.hash = pile === "reply" ? "#/triage" : `#/triage/${pile}`;
}
