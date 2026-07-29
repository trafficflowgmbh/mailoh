"use client";

/**
 * Hash routing, verbatim from the prototype's contract:
 *   #/ohbox … #/settings   the eight views
 *   #/screener/screened    screener segment deep-links
 *   #/tag/steiner          one tag across everything
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

export interface Route {
  view: ViewId;
  tagId: string | null;
  screenerSegment: ScreenerSegmentId;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (raw.startsWith("tag/") && raw.slice(4)) {
    return { view: "tag", tagId: raw.slice(4), screenerSegment: "waiting" };
  }
  if (raw === "screener" || raw.startsWith("screener/")) {
    const sub = raw.split("/")[1];
    return {
      view: "screener",
      tagId: null,
      screenerSegment: sub === "screened" || sub === "spam" ? sub : "waiting",
    };
  }
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : "ohbox";
  return { view, tagId: null, screenerSegment: "waiting" };
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
