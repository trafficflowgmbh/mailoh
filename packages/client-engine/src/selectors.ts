import type { EntityReader } from "./store.js";
import {
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type Folder,
  type MessageBody,
  type MessageBodyRecord,
  type MessageStateDTO,
  type OhmailView,
  type RuleDTO,
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

/** UTC midnights apart. Positive = in the past; negative = dated in the future. */
function daysAgo(d: Date, now: Date): number {
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  return Math.round((day(now) - day(d)) / 86_400_000);
}

/**
 * The prototype's row stamp for a message: "09:12" today, "Mon" this week, "2 Aug" beyond it.
 *
 * Fixture rows carry the prototype's own string in `time`; server-fed rows carry only
 * `date`, so every surface that shows a stamp has to derive one. It lives here — beside
 * the selectors that build display DTOs — rather than in the web app, because
 * `screenerSegments()` mints `ScreenerSenderDTO.time` and `ScreenerHeldMail.time` for
 * senders that have no fixture row at all.
 *
 * ── A WEEKDAY NAME ONLY MEANS SOMETHING FOR SIX DAYS ────────────────────────────────────
 *
 * This used to answer `WEEKDAY_SHORT[d.getUTCDay()]` for EVERY message that was not from
 * today, so a message from March rendered as "Tue" — indistinguishable from one sent
 * yesterday, in a list sorted by date, which is the one place the reader is relying on the
 * stamp to tell things apart. Owner-reported.
 *
 * Seven bands would be over-thinking it; the rule is just that a label may not be reused
 * before it has stopped being unambiguous. "Tue" is unique within a six-day window and
 * repeats on the seventh, so that is exactly where it stops. Past that, the day-and-month
 * carries the year implicitly for the current year and explicitly outside it — a bare
 * "2 Aug" on a message from 2025 would be the same lie in a slower form.
 *
 * A FUTURE date (a resurfaced or scheduled row) takes the dated branch too: `daysAgo` goes
 * negative, and "Fri" for something that has not happened yet reads as the past.
 */
export function messageDisplayTime(m: Pick<EngineMessage, "time" | "date">, now: Date): string {
  if (m.time) return m.time;
  if (!m.date) return "";
  const d = new Date(m.date);
  if (Number.isNaN(d.getTime())) return "";

  const ago = daysAgo(d, now);
  if (ago === 0) return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  if (ago >= 1 && ago <= 6) return WEEKDAY_SHORT[d.getUTCDay()]!;

  const stamp = `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? stamp : `${stamp} ${d.getUTCFullYear()}`;
}

/** Server list order (contract §5.2): date desc, id desc. */
function byDateDesc(a: EngineMessage, b: EngineMessage): number {
  const ta = a.date ? Date.parse(a.date) : 0;
  const tb = b.date ? Date.parse(b.date) : 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Reading order for a conversation — the exact reverse of `byDateDesc`, undated rows first. */
function byDateAsc(a: EngineMessage, b: EngineMessage): number {
  return -byDateDesc(a, b);
}

// ── Bodies (slice U5-BODY) ─────────────────────────────────────────────────

/**
 * THE TEXT A SURFACE RENDERS, AND WHAT THAT TEXT ACTUALLY IS.
 *
 * Every reading surface used to write `m.body ?? m.snippet`, and on a live account that
 * expression has exactly one branch: `body` is a fixture-only extra, so a Cloud message
 * always fell through to the snippet and every pile rendered one line of every message as
 * though it were the whole thing. This is the one place that question is answered, and it
 * answers it with a {@link BodyState} so no caller has to guess.
 *
 * ── READ-TIME MERGE, NOT A WRITE ───────────────────────────────────────────────────────
 *
 * The hydrated text lives in a separate `message_body` record precisely so that a `/sync`
 * delta for the message cannot replace it (see {@link MessageBodyRecord}). The cost of that
 * is one join, here, and it is the reason a body survives the `mark_seen` echo that opening
 * the message emits.
 *
 * ── PRECEDENCE, AND WHY `m.body` IS FIRST ──────────────────────────────────────────────
 *
 * The fixture world's rows carry their full text already. Checking the message first means
 * the demo never consults a record, never has one, and `hydrateBody` short-circuits on the
 * same field — so "the demo performs zero requests" is one fact in two places that read the
 * same source, rather than two rules that have to be kept in agreement.
 *
 * ── PROTECTED MAIL IS NOT SPECIAL-CASED HERE, DELIBERATELY ─────────────────────────────
 *
 * A sensitive message's stored body is redacted server-side (invariant #1), so the text
 * this returns for one is already safe — and `message.protected` is routed through
 * `ProtectedBlock` by the SURFACE, unchanged, which is where that decision has always
 * lived. Moving it in here would mean two places deciding what a protected message shows,
 * and the surface would still need its branch for the fixture case.
 *
 * ── `ready` WITH EMPTY TEXT IS STILL `full` ────────────────────────────────────────────
 *
 * `getBody` answers `text: ""` for a message whose body row was never ingested. That is
 * reported as `full` rather than falling back to the snippet, because the snippet is
 * DERIVED from the body at ingest — the two arrive together — so "an empty body next to a
 * populated snippet" is not a state the pipeline produces, and inventing a fallback for it
 * would mean rendering a preview while claiming it is the whole message. The empty case
 * renders empty, which is what the server has.
 */
export function bodyOf(
  reader: EntityReader,
  m: Pick<EngineMessage, "id" | "snippet"> & { body?: string },
): MessageBody {
  // O11b — `html` IS NULL ON EVERY BRANCH BUT ONE, and that is the contract rather than an
  // omission ({@link MessageBody}). The demo's rows carry text and no html; a snippet is not
  // html; and `loading`/`failed` have no body to describe. Only `ready` has a document, so
  // only `ready` may report one — otherwise a surface could render a stale frame underneath
  // a "still loading" line.
  if (m.body !== undefined) {
    return { text: m.body, state: "full", html: null, loadedRemoteContent: false };
  }
  const rec = reader.get<MessageBodyRecord>("message_body", m.id);
  if (!rec) return { text: m.snippet, state: "snippet", html: null, loadedRemoteContent: false };
  if (rec.state === "ready") {
    return {
      text: rec.text,
      state: "full",
      html: rec.html ?? null,
      loadedRemoteContent: rec.loadedRemoteContent === true,
    };
  }
  // Loading and failed both keep the snippet on screen — it is the only text there is — and
  // differ in what the surface says about it. Neither may read as "this is the whole mail".
  return {
    text: m.snippet,
    state: rec.state === "loading" ? "loading" : "failed",
    html: null,
    loadedRemoteContent: false,
  };
}

// ── Conversations ──────────────────────────────────────────────────────────

/**
 * THE CONVERSATION a message belongs to, oldest first (slice P6b).
 *
 * `threadId` is populated by C3 — 2 319 threads on the owner's mailbox, largest 18 — and
 * nothing rendered it. This is the one place the grouping is computed.
 *
 * ── THE EMPTY ARRAY IS A CONTRACT, NOT A DEGENERATE CASE ────────────────────────────────
 *
 * A message with no `threadId`, and a message that is the SOLE member of its thread, both
 * answer `[]`. They are the same fact to a reader — there is no conversation here — and
 * collapsing them means a caller cannot accidentally render "1 message" chrome around a
 * message that has no conversation. Every consumer's condition is `length > 0`; none of
 * them has to know that a thread of one exists in the mirror.
 *
 * NO FOLDER FILTER. A conversation legitimately spans folders: a stranger's first mail sits
 * in `ohmail/Screener` while their accepted follow-ups land in the Ohbox, and hiding the
 * held one would be the reader lying about what it has. The `Sent` folder is the other
 * side of that coin and is NOT watched (gap U4c) — the user's own replies are not in
 * `messages` at all, so this can only ever return the counterpart's half. Callers say so;
 * see `Conversation.tsx`.
 *
 * O(n) over the mirror, like every selector here. Do NOT call it per row to build list
 * badges — that is O(n²) at 8 800 messages and wants a one-pass count selector instead.
 */
export function threadOf(reader: EntityReader, messageId: string): EngineMessage[] {
  const self = reader.get<EngineMessage>("message", messageId);
  if (!self?.threadId) return [];
  const members = reader
    .list<EngineMessage>("message")
    .filter((m) => m.threadId === self.threadId)
    .sort(byDateAsc);
  return members.length > 1 ? members : [];
}

export function messagesIn(reader: EntityReader, folder: Folder): EngineMessage[] {
  return reader
    .list<EngineMessage>("message")
    .filter((m) => m.folder === folder)
    .sort(byDateDesc);
}

/**
 * WHICH MAILBOX A FRESH COMPOSE SENDS FROM (slice U4f).
 *
 * A reply inherits its mailbox from the message it answers. A compose has no parent, and the
 * server will not guess: `POST /drafts` requires a `mailboxId` that belongs to the account
 * (`drafts-service.ts` → `validMailbox`), and `SendService` uses that mailbox's own address as
 * the `From`. So the client has to name one.
 *
 * ── WHY IT IS DERIVED FROM MAIL AND NOT FROM A MAILBOX LIST ─────────────────────────────
 *
 * There is no mailbox list to read on a Cloud account. `"mailbox"` is not an entity type in
 * the change log, so `/sync` never emits one and the mirror
 * holds `mailbox` rows ONLY where the FixturesAdapter seeded them — the demo and Desktop.
 * `GET /mailboxes` exists but lives behind the Cloud client's API layer, which the shared shell
 * may not import (it is not part of the Desktop bundle). What every account DOES have is mail, and
 * every message carries the `mailboxId` it arrived in.
 *
 * So: a seeded `mailbox` entity when there is one, else the mailbox holding the account's
 * NEWEST message. Newest rather than "the first one `list()` happens to return", because the
 * order of a mirror scan is not a fact about the user and this answer decides whose address a
 * stranger sees in their From line.
 *
 * ── THE LIMIT THAT USED TO BE STATED HERE IS NOW CLOSED (gap O20) ──────────────────────
 *
 * This paragraph said "with two mailboxes connected this picks one of them and offers no way to
 * choose", filed as owed. It was worse than owed: nothing on the compose surface said WHICH one,
 * so the From flipped with whichever address last received mail and no screen mentioned it.
 *
 * The picker exists. `apps/webapp/app/shell/compose-from.ts` owns the rule — a fresh compose
 * defaults to the OLDEST CONNECTED mailbox, a reply keeps the one the message arrived in, and
 * the value is a mailbox id — over the account's real mailboxes, which the Cloud shell reads
 * from `GET /mailboxes` and hands to the shared shell through `MailStateProvider` (the prop
 * threaded from the Cloud shell this note called for; no new `/sync` entity type was needed).
 *
 * SO THIS FUNCTION IS NOW THE LAST RESORT AND NOT THE ANSWER. It is reached only where nothing
 * can name the account's mailboxes at all — the Desktop, and a Cloud tab in the moment before
 * its first mailbox poll lands — and in exactly those cases there is no From line on screen for
 * it to contradict. `Engine.enrich` still falls back to it for a `mail_send` that carries no
 * `mailboxId`, which is what keeps a send possible there rather than refused.
 *
 * `null` ⇒ this account has nothing to send from yet (a mailbox that has not finished its
 * first sync). The compose surface refuses rather than posting a draft the server will 400.
 */
export function sendingMailboxId(reader: EntityReader): string | null {
  const seeded = reader.list<{ id?: string }>("mailbox")[0]?.id;
  if (typeof seeded === "string" && seeded.length > 0) return seeded;
  const newest = reader.list<EngineMessage>("message").sort(byDateDesc)[0];
  return newest?.mailboxId ?? null;
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

/**
 * One held message, with its body RESOLVED rather than degraded (slice U5-BODY).
 *
 * This used to be `body: m.body ?? m.snippet` with a comment calling the snippet a stated
 * degradation. It was stated, and it was also the thing that made `ScreenerSenderDTO.held`'s
 * own promise — "every held message, in full" — false on every live account: the preview a
 * consent decision is taken on showed one line. `bodyOf` returns the hydrated text once
 * `hydrateBody` has run for this id, and `bodyState` tells the preview which of the four
 * situations it is in so it can never present a truncation as the mail.
 */
function heldOf(reader: EntityReader, m: EngineMessage, now: Date): ScreenerHeldMail {
  const body = bodyOf(reader, m);
  return {
    id: m.id,
    subject: m.subject,
    time: messageDisplayTime(m, now),
    body: body.text,
    bodyState: body.state,
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
          held: [...newestFirst].reverse().map((m) => heldOf(reader, m, now)),
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

// ── Rules: the consent gate's memory (gap O16) ─────────────────────────────

/**
 * EVERY ROUTING RULE THIS ACCOUNT HAS, NEWEST FIRST.
 *
 * The Screener writes a `rules` row on every decision — `POST /screener/:id` creates one
 * per yes/no (`screener-service.ts:364`), and the DecisionBar, "apply to all", "mark all
 * spam" and the sender menu all reach that endpoint — so a product whose thesis is a
 * consent gate accumulates these faster than any other entity the user did not ask for.
 * Until this selector existed nothing in any client read them: `rule` has been an entity type
 * in the change log since the first release and a
 * `SyncEntityType` here, the mirror has been storing them all along, and `/rules` had zero
 * references across the whole web app.
 *
 * ── WHY THE MIRROR AND NOT `GET /rules` ────────────────────────────────────────────────
 *
 * The same argument `sendingMailboxId` makes about mailboxes, with the opposite outcome,
 * and the difference is worth stating because it is the reason this one is a selector at
 * all. A mailbox is NOT an entity type in the change log, so `/sync` can never send one and
 * a Cloud surface has to reach the Cloud client's API layer — which the shared shell may not
 * import, because that layer is not part of the Desktop bundle. A rule IS one. The server
 * replays it from `change_log` like any other entity, the webapp passes no
 * `types` filter so the drain carries every type, and nothing prunes `change_log` —
 * `minRetainedSeq` only READS the minimum — so a bootstrap re-materializes rules created
 * long before this client existed. Reading the mirror therefore costs no request, works
 * offline, and shows the optimistic overlay: a rule the user has just revoked is gone from
 * this list before the wire has answered.
 *
 * ── NEWEST FIRST, AND WHY THAT IS THE ORDER ────────────────────────────────────────────
 *
 * `RulesService.list` orders by `id` — a random uuid, i.e. no order at all to a reader.
 * The rule a user wants to inspect or undo is overwhelmingly the one they just caused, and
 * on this surface every row was caused by an act they may not have realised was a rule. So
 * recency, with the id as a deterministic tie-break for rules minted inside the same
 * `createdAt` resolution (a bulk "apply to all" mints several at once).
 *
 * ── WHAT IS DELIBERATELY NOT COMPUTED HERE ─────────────────────────────────────────────
 *
 * "How many messages has this rule filed?" `RuleDTO.stats` carries `hits`, `lastHitAt` and
 * `demotions`, and NOTHING ANYWHERE EVER WRITES THEM — the columns exist, the server
 * faithfully reports them, and every one of them is still the `default(0)` / `null` it was
 * inserted with. Surfacing that as a count would put "0 messages" beside a rule that has
 * silently filed three thousand. The surface says the count is not recorded instead; see
 * `RulesView`.
 *
 * A count of mirror messages CURRENTLY sitting in the rule's destination would be
 * computable and is also refused, for a second reason: it reads as "these will move back",
 * which is exactly the false promise revocation must not make.
 */
export function rulesList(reader: EntityReader): RuleDTO[] {
  return reader.list<RuleDTO>("rule").sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
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
