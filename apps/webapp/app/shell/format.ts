/**
 * Display formatting over engine entities. Fixture rows carry the
 * prototype's display time verbatim (`m.time`); rows minted by
 * mutations fall back to a clock/weekday derived from the ISO date.
 */
import type { EngineMessage, TagDTO } from "@mailoh/client-engine";
import type { TagHueName } from "@mailoh/ui";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
