import type { EntityReader } from "./store.js";
import {
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type Folder,
  type MessageStateDTO,
  type OhmailView,
  type ScreenerHeldMail,
  type ScreenerSegment,
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
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The prototype's row stamp for a message: "09:12" today, "Mon" this week.
 *
 * Fixture rows carry the prototype's own string in `time`; server-fed rows carry only
 * `date`, so every surface that shows a stamp has to derive one. It lives here — beside
 * the selectors that build display DTOs — rather than in the web app, because
 * `screenerSegments()` mints `ScreenerSenderDTO.time` and `ScreenerHeldMail.time` for
 * senders that have no fixture row at all.
 */
export function messageDisplayTime(m: Pick<EngineMessage, "time" | "date">, now: Date): string {
  if (m.time) return m.time;
  if (!m.date) return "";
  const d = new Date(m.date);
  const clock = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  if (sameDay) return clock;
  return WEEKDAY_SHORT[d.getUTCDay()] ?? clock;
}

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

/**
 * The three Screener segments, as VIEWS over folders (brief §4) — never as folders.
 * `VIEW_OF_FOLDER` turns a message's folder into a view; this turns the three
 * Screener-ish views into the segment the UI renders them in.
 */
const SEGMENT_OF_VIEW: Partial<Record<OhmailView, ScreenerSegment>> = {
  screener: "waiting",
  screened: "screened_out",
  spam: "spam",
};

/**
 * The grouping key for a Screener sender — the address, case-folded.
 *
 * Shared with `mutationEffects`' `screener_decide` branch so the set of messages a
 * decision moves is exactly the set the row said it was holding, and with the server,
 * which lower-cases the same way (`screener-service.ts:118`, `:147`).
 */
export function senderKey(address: string): string {
  return address.trim().toLowerCase();
}

function heldOf(m: EngineMessage, now: Date): ScreenerHeldMail {
  return {
    id: m.id,
    subject: m.subject,
    time: messageDisplayTime(m, now),
    // DEGRADATION, stated rather than hidden: server-fed rows never carried bodies
    // into the mirror (`MessageDTO` has `snippet`, not `body`), so a derived held
    // message shows the snippet. Fixture rows keep their full `body`.
    body: m.body ?? m.snippet,
    ...(m.trackerNote ? { trackerNote: m.trackerNote } : {}),
  };
}

/**
 * THE SCREENER, DERIVED FROM THE MESSAGE MIRROR (slice C1).
 *
 * `screener_sender` is a client-local entity: `/sync`'s vocabulary never carried it
 * (`change-log.ts`), so before this the Screener was structurally empty on every Cloud
 * account while its mail sat in `ohmail/Screener`. It is not promoted onto the wire,
 * because the server's own queue is ALREADY a derivation — "DERIVED (no separate
 * table)", `screener-service.ts:88-92`: one entry per distinct sender, the latest
 * message representing it. Grouping the mirror the same way reproduces that queue with
 * no new wire entity to keep in lockstep with every folder move.
 *
 * The row `id` is therefore the REPRESENTATIVE MESSAGE id, which is precisely what
 * `POST /screener/:id` resolves (`screener-service.ts:144` — `rows.find(r =>
 * r.messageId === id)`). A derived row speaks the existing protocol unchanged.
 *
 * FIXTURE PRECEDENCE: `screener_sender` rows win per sender key. A Cloud account has
 * none, so it sees pure derivation; the demo world keeps its richer DTOs (AI
 * suggestions, full bodies, spam detection metadata) exactly as before.
 *
 * NO-COLLAPSE (invariant #6): `held` enumerates EVERY message the sender has in that
 * folder — there is no count standing in for mail nobody can open.
 */
export function screenerSegments(reader: EntityReader, now: Date = new Date()): ScreenerSegments {
  const grouped: Record<ScreenerSegment, Map<string, EngineMessage[]>> = {
    waiting: new Map(),
    screened_out: new Map(),
    spam: new Map(),
  };

  for (const m of reader.list<EngineMessage>("message")) {
    const view = VIEW_OF_FOLDER[m.folder] as OhmailView | undefined;
    const segment = view ? SEGMENT_OF_VIEW[view] : undefined;
    if (!segment) continue;
    const key = senderKey(m.from.address);
    const bucket = grouped[segment].get(key);
    if (bucket) bucket.push(m);
    else grouped[segment].set(key, [m]);
  }

  const out: Record<ScreenerSegment, Map<string, ScreenerSenderDTO>> = {
    waiting: new Map(),
    screened_out: new Map(),
    spam: new Map(),
  };

  for (const segment of ["waiting", "screened_out", "spam"] as const) {
    const rows: Array<{ key: string; rep: EngineMessage; dto: ScreenerSenderDTO }> = [];
    for (const [key, bucket] of grouped[segment]) {
      const newestFirst = [...bucket].sort(byDateDesc);
      const rep = newestFirst[0]!;
      const name = rep.from.name || rep.from.address;
      const repDate = rep.date ? new Date(rep.date) : null;
      rows.push({
        key,
        rep,
        dto: {
          id: rep.id,
          segment,
          from: rep.from,
          initial: (name.trim()[0] ?? "?").toUpperCase(),
          time: messageDisplayTime(rep, now),
          scope: "sender",
          // DEGRADATION: no classifier runs client-side and `/sync` carries no
          // suggestion, so a derived row has none. `GET /screener` still returns
          // `aiSuggestion` for desktop/native and for enrichment later.
          ai: null,
          // Oldest first — the order every preview renders, and ALL of them.
          held: [...newestFirst].reverse().map((m) => heldOf(m, now)),
          ...(segment === "screened_out" && repDate
            ? { screenedOn: `${repDate.getUTCDate()} ${MONTH_SHORT[repDate.getUTCMonth()]}` }
            : {}),
          derived: true,
          updatedAt: rep.updatedAt,
        },
      });
    }
    // Newest sender first — the same order `messagesIn` gives every other list.
    rows.sort((a, b) => byDateDesc(a.rep, b.rep));
    for (const r of rows) out[segment].set(r.key, r.dto);
  }

  // Fixtures win per sender key. `Map.set` on an existing key keeps its position, so a
  // demo row substitutes in place rather than jumping to the end of the segment.
  for (const s of reader.list<ScreenerSenderDTO>("screener_sender")) {
    const bucket = out[s.segment];
    if (!bucket) continue;
    bucket.set(senderKey(s.from.address), s);
  }

  return {
    waiting: [...out.waiting.values()],
    screenedOut: [...out.screened_out.values()],
    spam: [...out.spam.values()],
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

export function unreadCounts(reader: EntityReader, now: Date = new Date()): EngineCounts {
  const ohbox = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  const piles = triagePiles(reader);
  return {
    ohboxUnread: ohbox.filter((m) => m.unread).length,
    ohboxTotal: ohbox.length,
    reads: messagesIn(reader, FOLDER_OF_VIEW.reads).filter((m) => m.unread).length,
    receipts: messagesIn(reader, FOLDER_OF_VIEW.receipts).filter((m) => m.unread).length,
    screenerWaiting: screenerSegments(reader, now).waiting.length,
    replyLater: piles.replyLater.length,
    setAside: piles.setAside.length,
    resurface: piles.resurface.length,
  };
}
