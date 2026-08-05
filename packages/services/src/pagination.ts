/**
 * Opaque list cursors (contract §1.5) — independent from the `/sync` seq cursor.
 * A list cursor encodes the last entity id returned; the next page selects rows
 * with a greater id under a stable ascending-id ordering.
 */
export function encodeListCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeListCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
}
