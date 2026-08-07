/**
 * Display formatting over engine entities. Fixture rows carry the
 * prototype's display time verbatim (`m.time`); rows minted by
 * mutations fall back to a clock/weekday derived from the ISO date.
 */
import {
  folderLeaf,
  messageDisplayTime,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type TagDTO,
} from "@ohmail/client-engine";
import type { TagHueName } from "@ohmail/ui";

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
 * for (contract §8), so the fallback is the folder's LEAF ("Receipts", "Q1"),
 * which is always readable and never puts a namespaced path on screen.
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

/**
 * The row stamp. The rule moved into `@ohmail/client-engine` when the Screener started
 * deriving its own rows, and had to mint the same stamp for senders with no
 * fixture behind them; this stays as the app-side name every view already imports, and
 * delegates so the two can never drift apart.
 */
export function displayTime(m: EngineMessage, now: Date): string {
  return messageDisplayTime(m, now);
}

/**
 * A META LINE, JOINED — and the separator is never printed without a value on both sides.
 *
 * ── "Ohbox ·" ───────────────────────────────────────────────────────────────────────────
 *
 * A message with **no `Date:` header** — which spam and scripts routinely omit, and which nothing in the pipeline
 * substitutes for — carries `date: null` all the way to the client, so
 * {@link displayTime} answers `""` (`packages/client-engine/src/selectors.ts:66-77`, and
 * correctly: there is no instant to format). Every surface then interpolated that empty
 * string into a template that had already committed to the separator:
 *
 *   · `SearchView`  — `` `${placeLabel(m.folder)} · ${displayTime(m, now)}` `` ⇒ **"Ohbox · "**
 *   · `MessagePane` — `messages.threadMeta` was the literal `"thread ({count}) · "` ⇒
 *                     **"thread (3) · "**, a separator introducing nothing
 *   · `Conversation` — an unconditional `<span className="t num">{displayTime(…)}</span>`,
 *                      i.e. an empty stamp element in a row that has a slot for one
 *
 * A dangling "·" is not a cosmetic defect. It is the interface asserting that a second fact
 * follows, and there is no second fact — the same class of untrue statement as the copy this
 * slice's five siblings fix, said in punctuation instead of words.
 *
 * ── WHY THE JOINER IS HERE AND NOT A GUARD AT EACH CALL SITE ────────────────────────────
 *
 * `placeLabel` two functions up is here for the reason its own docstring records: the two
 * copies of that fallback drifted, and one of them shipped `undefined` on screen. Three
 * hand-written `x ? \` · ${x}\` : ""` ternaries would be that shape again, and the fourth
 * surface — the one nobody has written yet — would get the ternary wrong once and reproduce
 * this exact report.
 *
 * ── AND WHY THE FALLBACK IS NOT ON THE WIRE, WHICH WAS THE FIRST THING TRIED ────────────
 *
 * The audit asks for IMAP INTERNALDATE, and that is the right value — but it is not reachable
 * from anywhere a display fix can stand:
 *
 *  1. **Nothing persists it.** The MIME parser writes `parsed.date ?? null`, and INTERNALDATE is
 *     read only for ORDERING, into an in-memory `arrivalKey` cache. The `messages` table has no
 *     column for it, so materialization has nothing to coalesce to but `createdAt` — when the
 *     sync worker wrote the row. The IMAP adapter already records why that is the wrong answer:
 *     an imported mailbox "leaves every message stamped with the import time".
 *  2. **A non-null `MessageDTO.date` would desynchronise two orderings.** The server sorts by
 *     `messages.date`, which is still NULL; the client sorts by the DTO's `date`, and
 *     `byDateDesc` reads a missing one as 0 — oldest. Synthesizing a value client-side of the
 *     sort would place an undated message NEWEST here and OLDEST there, and the sync contract
 *     makes the server's order the order.
 *
 * So the true repair belongs at ingest, where INTERNALDATE is in hand and one write fixes every
 * surface at once; it is owed rather than done. This function is what stops the product lying in
 * the meantime, and it stays correct after that fix lands: a date that is always present simply
 * means no part is ever dropped.
 */
export function metaLine(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

/** "Fri 09:00" from an ISO instant (or the raw string when not ISO). */
export function resurfaceLabel(when: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(when)) return when;
  const d = new Date(when);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The resurface fallback: the next Friday 09:00 UTC after `base` (the keyboard/palette default). */
export function nextFridayNine(base: Date): string {
  const d = new Date(base);
  let diff = (5 - d.getUTCDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

/**
 * ═══ THE RESURFACE HORIZONS ═════════════════════════════════════════════════════════════
 *
 * The action carries a chosen instant now, so the presets are computed here rather than baked
 * at the one call site `nextFridayNine` used to serve. All land at 09:00 UTC — the same clock
 * `nextFridayNine` picked and the hour every stored `bubbleUpAt` uses, so `resurfaceLabel`
 * reads them back the same way whichever preset produced them.
 */

/** Tomorrow, 09:00 UTC. */
export function tomorrowNine(base: Date): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

/** The coming Monday, 09:00 UTC — and never "later today": a Monday resolves to the next one. */
export function nextWeekNine(base: Date): string {
  const d = new Date(base);
  let diff = (1 - d.getUTCDay() + 7) % 7; // 1 = Monday
  if (diff === 0) diff = 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

/** A picked calendar day ("YYYY-MM-DD" from an `<input type="date">`) at 09:00 UTC. */
export function dayNine(day: string): string {
  const d = new Date(day);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

/** The "YYYY-MM-DD" a date input wants, from an ISO instant — used to floor the picker at tomorrow. */
export function dayValue(iso: string): string {
  return iso.slice(0, 10);
}

export function senderName(m: EngineMessage): string {
  return m.from.name || m.from.address;
}

/**
 * THE SENDER CIRCLE — the same letter and the same colour for one person, in
 * every list, on every device, forever.
 *
 * The requirement: the small circle carrying the sender's or receiver's letter belongs on the
 * mail list too, not only in the Screener. The component already existed — it is what the Screener's
 * rows and the doorbell stack — so the only new thing is the derivation, and the only
 * requirement on the derivation is that it be a pure function of the ADDRESS. Not of the
 * display name, which the same person changes between messages, and not of a random seed,
 * which would repaint the list on every reload.
 *
 * The hues are eight fixed angles, not `hash % 360`: the free wheel produces the candy
 * greens and electric blues the Blanc system rules out, while these sit in the same
 * warm-adjacent band as the tag hues (rosewood 25 · terracotta 42 · ochre 78 · olive 112 ·
 * moss 150 · slate 196 · indigo 250 · mauve 318). Lightness and chroma are pinned in
 * `avatar.css` per theme, so legibility is not a property of this table.
 */
const AVATAR_HUES = [25, 42, 78, 112, 150, 196, 250, 318];

export function avatarHue(address: string): number {
  // FNV-1a over the case-folded address. Small, stable, and dependency-free; the value is
  // never persisted, so it may be recomputed anywhere without a migration.
  let h = 0x811c9dc5;
  const key = address.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

/** The letter in the circle: the display name's first, else the address's. */
export function initialsOf(nameOrAddress: string): string {
  return (nameOrAddress.trim()[0] ?? "?").toUpperCase();
}

/**
 * The address, ONLY when it says something the name did not.
 *
 * `senderName` falls back to the address when a sender has no display name — which is most
 * automated mail — so passing both unconditionally printed it twice in the same line:
 * "verify@atlas-identity.invalid  verify@atlas-identity.invalid", in every row and again in
 * the open message. Caught in the 390px screenshots of the shipped build; the Screener had
 * been guarding against it by hand since it was written.
 */
export function rowAddress(m: EngineMessage): string | undefined {
  return m.from.name ? m.from.address : undefined;
}

/** The circle for a message row, in one call. */
export function avatarOf(m: EngineMessage): { avatarInitial: string; avatarHue: number } {
  return {
    avatarInitial: initialsOf(senderName(m)),
    avatarHue: avatarHue(m.from.address),
  };
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
