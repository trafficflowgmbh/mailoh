import type { EntityReader } from "./store.js";
import {
  FOLDER_OF_VIEW,
  type EngineMessage,
  type Folder,
  type MessageStateDTO,
  type ScreenerSenderDTO,
  type TagDTO,
  type TriageItemDTO,
  type WaterlineMeta,
} from "./types.js";

/**
 * Typed selectors over the mirror — every list, count, and partition the UI
 * renders computes HERE, from local state, with zero network (brief §6).
 * Selectors take an `EntityReader` so they see the engine's optimistic overlay
 * when called through `engine.read()`.
 */

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Server list order (contract §5.2): date desc, id desc. */
function byDateDesc(a: EngineMessage, b: EngineMessage): number {
  const ta = a.date ? Date.parse(a.date) : 0;
  const tb = b.date ? Date.parse(b.date) : 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function messagesIn(reader: EntityReader, folder: Folder): EngineMessage[] {
  return reader
    .list<EngineMessage>("message")
    .filter((m) => m.folder === folder)
    .sort(byDateDesc);
}

// ── Ohbox: the read-state split (new_for_you / previously_seen, brief §4) ──

export interface OhboxView {
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
}

export function ohboxView(reader: EntityReader): OhboxView {
  const all = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  return {
    newForYou: all.filter((m) => m.unread),
    previouslySeen: all.filter((m) => !m.unread),
  };
}

// ── Reads: the waterline partition ─────────────────────────────────────────

export interface ReadsPartition {
  waterline: WaterlineMeta | null;
  /** Arrived since the last visit — everything above (and including) the waterline anchor. */
  fresh: EngineMessage[];
  /** Below the waterline — already seen on a previous visit. */
  seen: EngineMessage[];
}

export function readsPartition(reader: EntityReader): ReadsPartition {
  const all = messagesIn(reader, FOLDER_OF_VIEW.reads);
  const waterline = reader.get<WaterlineMeta>("view_meta", "reads_waterline") ?? null;
  if (!waterline) return { waterline: null, fresh: all, seen: [] };
  const idx = all.findIndex((m) => m.id === waterline.afterId);
  if (idx < 0) return { waterline, fresh: all, seen: [] };
  return { waterline, fresh: all.slice(0, idx + 1), seen: all.slice(idx + 1) };
}

// ── Receipts: grouped by day ───────────────────────────────────────────────

export interface ReceiptsDayGroup {
  label: string;
  items: EngineMessage[];
}

function dayLabel(date: Date, now: Date): string {
  const sameDay =
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate();
  if (sameDay) return "Today";
  const ageDays = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / 86_400_000);
  if (ageDays <= 6) return WEEKDAY_LONG[date.getUTCDay()]!;
  return `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
}

export function receiptsByDay(reader: EntityReader, now: Date): ReceiptsDayGroup[] {
  const groups: ReceiptsDayGroup[] = [];
  for (const m of messagesIn(reader, FOLDER_OF_VIEW.receipts)) {
    const label = dayLabel(m.date ? new Date(m.date) : now, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return groups;
}

// ── Screener segments ──────────────────────────────────────────────────────

export interface ScreenerSegments {
  waiting: ScreenerSenderDTO[];
  screenedOut: ScreenerSenderDTO[];
  spam: ScreenerSenderDTO[];
}

export function screenerSegments(reader: EntityReader): ScreenerSegments {
  const all = reader.list<ScreenerSenderDTO>("screener_sender");
  return {
    waiting: all.filter((s) => s.segment === "waiting"),
    screenedOut: all.filter((s) => s.segment === "screened_out"),
    spam: all.filter((s) => s.segment === "spam"),
  };
}

// ── Triage piles ───────────────────────────────────────────────────────────

export interface TriagePileEntry {
  messageId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}

export interface TriagePiles {
  replyLater: TriagePileEntry[];
  setAside: TriagePileEntry[];
  resurface: TriagePileEntry[];
}

/**
 * The bottom piles: `message_state` entities joined to their messages, merged
 * with fixture-only `triage_item` entries (demo entries with no backing message).
 */
export function triagePiles(reader: EntityReader): TriagePiles {
  const piles: TriagePiles = { replyLater: [], setAside: [], resurface: [] };
  const pileOf = (state: string): TriagePileEntry[] | null =>
    state === "reply_later" ? piles.replyLater
      : state === "set_aside" ? piles.setAside
      : state === "bubbled_up" ? piles.resurface
      : null;

  for (const st of reader.list<MessageStateDTO>("message_state")) {
    const pile = pileOf(st.state);
    if (!pile) continue;
    const msg = reader.get<EngineMessage>("message", st.messageId);
    pile.push({
      messageId: st.messageId,
      title: msg?.from.name || msg?.from.address || st.messageId,
      ...(msg?.subject ? { subtitle: msg.subject } : {}),
      ...(msg?.snippet ? { preview: msg.snippet } : {}),
      ...(st.bubbleUpAt ? { resurfaceAt: st.bubbleUpAt } : {}),
    });
  }
  for (const item of reader.list<TriageItemDTO>("triage_item")) {
    const pile = pileOf(item.pile);
    if (!pile) continue;
    pile.push({
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.preview ? { preview: item.preview } : {}),
      ...(item.resurfaceAt ? { resurfaceAt: item.resurfaceAt } : {}),
    });
  }
  return piles;
}

// ── Tags cross-view ────────────────────────────────────────────────────────

export interface TagGroup {
  tag: TagDTO;
  messages: EngineMessage[];
}

/** Tags cut ACROSS folders: one group per tag, with every labeled message. */
export function tagsCrossView(reader: EntityReader): TagGroup[] {
  const messages = reader.list<EngineMessage>("message");
  return reader.list<TagDTO>("tag").map((tag) => ({
    tag,
    messages: messages.filter((m) => m.labels.includes(tag.id)).sort(byDateDesc),
  }));
}

// ── Counts ─────────────────────────────────────────────────────────────────

export interface EngineCounts {
  ohboxUnread: number;
  ohboxTotal: number;
  /** Unread Reads issues (the rail badge). */
  reads: number;
  /** Unread receipts. */
  receipts: number;
  screenerWaiting: number;
  replyLater: number;
  setAside: number;
  resurface: number;
}

export function unreadCounts(reader: EntityReader): EngineCounts {
  const ohbox = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  const piles = triagePiles(reader);
  return {
    ohboxUnread: ohbox.filter((m) => m.unread).length,
    ohboxTotal: ohbox.length,
    reads: messagesIn(reader, FOLDER_OF_VIEW.reads).filter((m) => m.unread).length,
    receipts: messagesIn(reader, FOLDER_OF_VIEW.receipts).filter((m) => m.unread).length,
    screenerWaiting: screenerSegments(reader).waiting.length,
    replyLater: piles.replyLater.length,
    setAside: piles.setAside.length,
    resurface: piles.resurface.length,
  };
}
