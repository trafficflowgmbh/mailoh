/**
 * Display formatting over engine entities. Fixture rows carry the
 * prototype's display time verbatim (`m.time`); rows minted by
 * mutations fall back to a clock/weekday derived from the ISO date.
 */
import { folderLeaf, VIEW_OF_FOLDER, type EngineMessage, type TagDTO } from "@mailoh/client-engine";
import type { TagHueName } from "@mailoh/ui";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The human name of each client view. Keys are view ids, never folders. */
export const PLACE_LABEL: Record<string, string> = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
  screener: "Screener",
  screened: "Screened",
  spam: "Spam",
};

/**
 * The place badge for a message — the ONE place that turns a folder into
 * something a user reads. Lives here rather than in each view because both
 * copies previously fell back differently: one rendered the raw folder path,
 * the other rendered `undefined`.
 *
 * Neither is acceptable. A server may send a folder this client has no view
 * for (contract §8), and the folder namespace still carries the pre-rebrand
 * company name — so the fallback is the folder's LEAF ("Paper Trail", "Q1"),
 * which is always readable and never leaks a prefix. See `NAMESPACE_EXEMPTION`
 * in `@mailoh/fixtures`.
 */
export function placeLabel(folder: string): string {
  const view = VIEW_OF_FOLDER[folder as keyof typeof VIEW_OF_FOLDER];
  return (view && PLACE_LABEL[view]) || folderLeaf(folder);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function displayTime(m: EngineMessage, now: Date): string {
  if (m.time) return m.time;
  if (!m.date) return "";
  const d = new Date(m.date);
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  if (sameDay) return clockOf(m.date);
  return WEEKDAY_SHORT[d.getUTCDay()] ?? clockOf(m.date);
}

/** "Fri 09:00" from an ISO instant (or the raw string when not ISO). */
export function resurfaceLabel(when: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(when)) return when;
  const d = new Date(when);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The demo's resurface slot: the next Friday 09:00 UTC after `base`. */
export function nextFridayNine(base: Date): string {
  const d = new Date(base);
  let diff = (5 - d.getUTCDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

export function senderName(m: EngineMessage): string {
  return m.from.name || m.from.address;
}

export function firstName(m: EngineMessage): string {
  return senderName(m).split(" ")[0] ?? senderName(m);
}

/** Tag lookup helpers over the mirror's tag entities. */
export function tagsOfMessage(m: EngineMessage, tags: TagDTO[]): TagDTO[] {
  return tags.filter((t) => m.labels.includes(t.id));
}

export function hueOf(tag: TagDTO): TagHueName {
  return (tag.hue as TagHueName) ?? "moss";
}
