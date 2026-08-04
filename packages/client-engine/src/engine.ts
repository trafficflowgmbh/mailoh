import type { AttachmentWire, EngineAdapter } from "./adapters/adapter.js";
import { mutationEffects, replySubject, type MutationEffect } from "./mutations.js";
import { SearchIndex, type LocalSearchResult } from "./search.js";
import { sendingMailboxId } from "./selectors.js";
import { MemoryMirrorStore, type EntityReader, type MirrorStore } from "./store.js";
import {
  CursorExpiredError,
  MutationRejectedError,
  type EngineMessage,
  type EngineMutation,
  type MessageBodyRecord,
} from "./types.js";

/**
 * The delta-sync engine (brief §4 — the load-bearing abstraction):
 *
 *   bootstrap (since=0) → drain (hasMore) → apply idempotently → cursor;
 *   410 → discard local state, re-bootstrap;
 *   optimistic mutations: overlay instantly (user-always-wins), fire the wire
 *   request with an Idempotency-Key, reconcile on the X-Sync-Seq echo (or the
 *   next /sync drain), roll back only on a hard rejection;
 *   SSE/push are WAKE SIGNALS only — attachWakeSignal() nudges a syncOnce.
 */

export type MutationStatus = "confirmed" | "queued" | "rolled_back";

export interface MutationResult {
  id: string;
  /** The Idempotency-Key used on the wire — stable across retries. */
  key: string;
  status: MutationStatus;
  seq: number | null;
  error?: MutationRejectedError;
}

interface PendingMutation {
  id: string;
  key: string;
  mutation: EngineMutation;
}

/**
 * WHAT `GET /search` ANSWERS, as much of it as this client reads (gap O14).
 *
 * The route returns `{ items, facets, total }`. `items` are canonical `MessageDTO`s, and an
 * {@link EngineMessage} is exactly a `MessageDTO` plus optional fixture extras, so a DTO IS
 * one — no conversion, no second shape. `facets` is deliberately NOT read: the server's facet
 * keys are raw folder paths (`SearchService.folderExpr` → `desired_folder` / the native
 * locator), while the local index keys its facets by VIEW id or by folder leaf, and rendering
 * the server's keys would put a namespaced IMAP path straight on screen. The surface keeps its
 * local facets; forward-compatible parsing (§8) means the extra field is not an error.
 */
export interface ServerSearchWire {
  items: EngineMessage[];
  /** Matches for the query across the WHOLE corpus, which is more than `items.length`. */
  total: number;
}

/**
 * The transport `searchServer` runs on. Optional everywhere: the demo has no server, the
 * desktop tier has no Cloud, and neither may be given one.
 */
export type ServerSearchFn = (
  query: string,
  opts: { limit?: number },
) => Promise<ServerSearchWire | null>;

/**
 * The adapter capability this reaches for when no `serverSearch` was injected.
 *
 * Declared structurally HERE rather than as a member of `EngineAdapter` because the engine is
 * the only thing that calls it and the two adapters answer it differently in kind — the
 * FixturesAdapter has no server to ask and the HttpAdapter has one endpoint. An adapter
 * without the method is not broken; it is a client with no archive behind it, which
 * {@link OhmailEngine.serverSearchAvailable} reports and the UI states.
 */
interface ServerSearchCapableAdapter {
  searchServer?: ServerSearchFn;
}

/**
 * The outcome of one archive pass. It NEVER rejects — see {@link OhmailEngine.searchServer}.
 *
 * `unavailable` is a first-class answer and not an error: it is what the demo and the desktop
 * get, and the difference between "there is no archive behind this client" and "the archive
 * refused" is the difference between two true sentences the UI has to be able to tell apart.
 */
export type ServerSearchOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; total: number }
  | { state: "failed"; error: string };

// ── attachments (gap O18) ──────────────────────────────────────────────────
//
// ohmail STORES NO ATTACHMENT BYTES, anywhere, ever. Metadata is synced at ingest; the bytes live
// only in the user's own IMAP mailbox and are pulled from it at the moment somebody asks. What the
// types below model is therefore a CACHE WITH NO BACKING STORE: everything here dies with the tab,
// and that is the feature, not a limitation to be engineered away later.

/**
 * One attachment as a surface renders it.
 *
 * `mimeType` (not the wire's `contentType`) and a non-null `filename` — the shape the strip is
 * built against. {@link toAttachmentItem} is the ONE place the wire becomes this, so the fallback
 * name and the rename cannot drift into two answers.
 *
 * `state` is per ITEM because that is how it behaves: a message's strip is a list where one file
 * is open, one is still arriving and one failed, all at once. `objectUrl` is present only in
 * `ready`, and only until {@link OhmailEngine.releaseAttachments} revokes it.
 */
export interface AttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  state: "idle" | "loading" | "ready" | "failed" | "too_large";
  /**
   * A `blob:` URL for the fetched bytes, valid ONLY in the document that minted it.
   *
   * SAFE FOR `<img src>` AND `<a download>`. NOT safe to navigate to top-level: a `blob:` URL
   * inherits the app's origin, so a document type the browser will RENDER (SVG, HTML) executes
   * sender-controlled script as ohmail, with the session cookie in scope. The engine defends this
   * at the point the Blob is built — see {@link RENDERABLE_MIME} — rather than trusting every call
   * site to remember.
   */
  objectUrl?: string;
  /** The server's own sentence when `state` is `failed` or `too_large`. */
  error?: string;
}

/**
 * The outcome of one message's metadata read. Never rejects, for the reason
 * {@link ServerSearchOutcome} does not: the caller is a React effect.
 *
 * `unavailable` is a first-class answer — the demo and the desktop tier have no server to ask —
 * and `ready` with an EMPTY `items` is a different, also-true answer that the surface must render
 * differently. The second one is COMMON, not an edge case: measured against production on
 * 2026-08-04, 755 of 1,766 attachment-flagged messages (43%) carry only `inline` parts, which
 * {@link toAttachmentItem}'s caller filters out. The paperclip is painted from `hasAttachments`,
 * which counts those parts, so a paperclip over an empty strip is a state the UI has to be able to
 * say something honest about. (The absolute numbers drift — the corpus syncs continuously — but the
 * ratio has been stable across two measurements an hour apart.)
 */
export type AttachmentsOutcome =
  | { state: "unavailable" }
  /**
   * `retrying` is set ONLY when a human pressed the list's own retry over a held `failed`
   * (gap AT6). A surface renders the first ask as nothing — the read is one indexed row and a
   * skeleton on every message open would be noise — but it must NOT go silent again the moment
   * somebody presses "Try again": the row they pressed would vanish for the whole round-trip
   * and come back, which reads as "it worked" followed by "no it didn't". The flag is what lets
   * the failure row stay put and say it is asking again.
   */
  | { state: "loading"; retrying?: boolean }
  | { state: "ready"; items: AttachmentItem[] }
  /**
   * `code` and `retryable` are the SERVER'S OWN CLASSIFICATION, carried through rather than
   * re-derived from the sentence (gap AT6 — before it, only `error` survived the catch and the
   * surface had no way to tell "you are offline" from "that message is not yours").
   *
   * WHAT CAN ACTUALLY LAND HERE, because copy written for the wrong failure is a lie:
   * `GET /messages/:id/attachments` is `cost: "read"` and `AttachmentsService.listForMessage`
   * opens no IMAP adapter, so this call NEVER touches the user's mail server. `mailbox_busy`
   * (429, `packages/api/src/attachments-adapter.ts`) therefore cannot reach it — that refusal
   * belongs to the two `cost: "connection"` byte routes. What reaches it is `code: "network"`
   * (the fetch itself rejected — `HttpAdapter.request`), a 5xx from ohmail's own API, or a
   * definite 4xx refusal (401 after a session ends, 404 for a message this account cannot see).
   *
   * `retryable` is TRUE for anything the client could not classify: an unclassified throw means
   * we never established that the server refused, and re-asking costs one indexed row.
   */
  | { state: "failed"; error: string; code: string | null; retryable: boolean };

/**
 * The MIME types whose bytes may keep their real content type on a client-minted Blob.
 *
 * Everything else is minted `application/octet-stream`, which makes a browser DOWNLOAD it rather
 * than render it. This closes the one hole the server's own defences cannot: `GET /attachments/:id`
 * sets `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, but an object URL
 * created here from the response body carries NEITHER — the headers described the response, and the
 * Blob is a new thing with only a type. An `image/svg+xml` attachment opened in a tab would then
 * run its own `<script>` on ohmail's origin.
 *
 * The list is what a strip actually renders inline, and nothing more. SVG is deliberately absent
 * despite being an image: it is a document format that executes script. 18 such attachments exist
 * in the live corpus, so this is a real case and not a hypothetical one.
 */
const RENDERABLE_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
]);

/**
 * Wire → surface, in one place (the mapper the whole strip is rendered from).
 *
 * The filename fallback is `attachment-${id}.bin`, which is the SERVER'S own stem for a nameless
 * part (`attachments-service.ts` `uniqueName`). Matching it deliberately: the name in the strip is
 * then the same name that appears in a download-all zip entry, so a user reading both sees one
 * file, not two.
 */
function toAttachmentItem(wire: AttachmentWire): AttachmentItem {
  return {
    id: wire.id,
    filename: wire.filename?.trim() || `attachment-${wire.id}.bin`,
    mimeType: wire.contentType || "application/octet-stream",
    sizeBytes: wire.sizeBytes,
    state: "idle",
  };
}

export interface EngineOptions {
  adapter: EngineAdapter;
  /**
   * Override the archive transport. The shipped path takes it from the adapter (see
   * {@link ServerSearchCapableAdapter}); this exists so a test can drive the whole seam
   * without an adapter, and so a host that reaches `/search` some other way can supply it.
   */
  serverSearch?: ServerSearchFn;
  /** Defaults to an in-memory mirror (SSR/tests); pass IndexedDbMirrorStore on web. */
  store?: MirrorStore;
  /** Optional `?types=` filter for /sync. */
  types?: string[];
  /** Page size for the drain loop. */
  syncLimit?: number;
  now?: () => Date;
  uuid?: () => string;
}

/** Minimal EventSource-shaped surface (an attach point, not a dependency). */
export interface WakeSignalSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Read-through view: the mirror with the optimistic overlay applied on top. */
class OverlayReader implements EntityReader {
  constructor(
    private readonly store: MirrorStore,
    private readonly overlays: Map<string, MutationEffect[]>,
    private readonly rev: () => number,
  ) {}

  private overlayFor(type: string, id: string): MutationEffect | undefined {
    let hit: MutationEffect | undefined;
    for (const effects of this.overlays.values()) {
      for (const e of effects) if (e.type === type && e.id === id) hit = e; // last wins
    }
    return hit;
  }

  get<T = unknown>(type: string, id: string): T | undefined {
    const o = this.overlayFor(type, id);
    if (o) return o.entity === null ? undefined : (o.entity as T);
    return this.store.get<T>(type, id);
  }

  entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
    if (this.overlays.size === 0) return this.store.entries<T>(type);
    const byId = new Map<string, T>();
    for (const e of this.store.entries<T>(type)) byId.set(e.id, e.entity);
    for (const effects of this.overlays.values()) {
      for (const e of effects) {
        if (e.type !== type) continue;
        if (e.entity === null) byId.delete(e.id);
        else byId.set(e.id, e.entity as T);
      }
    }
    return [...byId.entries()].map(([id, entity]) => ({ id, entity }));
  }

  list<T = unknown>(type: string): T[] {
    if (this.overlays.size === 0) return this.store.list<T>(type);
    return this.entries<T>(type).map((e) => e.entity);
  }

  version(): number {
    return this.store.version() * 1_000_003 + this.rev();
  }
}

export class OhmailEngine {
  readonly store: MirrorStore;
  private readonly adapter: EngineAdapter;
  private readonly types: string[] | undefined;
  private readonly syncLimit: number | undefined;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  private readonly overlays = new Map<string, MutationEffect[]>();
  private overlayRev = 0;
  private readonly queue: PendingMutation[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly readerView: OverlayReader;
  private searchCache: { version: number; index: SearchIndex } | null = null;
  private syncing: Promise<void> | null = null;
  /** In-flight body fetches by message id — see {@link OhmailEngine.hydrateBody}. */
  private readonly bodyRequests = new Map<string, Promise<void>>();
  /** The archive transport, or `null` when this client has no server behind it. */
  private readonly serverSearchFn: ServerSearchFn | null;
  /** In-flight archive passes by query key — see {@link OhmailEngine.searchServer}. */
  private readonly serverSearches = new Map<string, Promise<ServerSearchOutcome>>();

  /**
   * Attachment metadata + byte state by message id (gap O18).
   *
   * IN MEMORY, NEVER `store.putLocal`, and that is a correctness requirement rather than a
   * preference. ohmail stores no attachment bytes anywhere — not server-side, not here — and an
   * `objectUrl` is only valid for the lifetime of the document that minted it. A record persisted
   * to IndexedDB would come back after a reload still holding a `blob:` string pointing at nothing,
   * and the surface would render a `ready` attachment whose image is permanently broken. Scoping
   * this to the tab is what makes "fetched on demand, held for the session" true.
   */
  private readonly attachmentLists = new Map<string, AttachmentsOutcome>();
  /** In-flight metadata reads by message id — single-flight, see {@link OhmailEngine.loadAttachments}. */
  private readonly attachmentListRequests = new Map<string, Promise<AttachmentsOutcome>>();
  /** In-flight byte fetches by attachment id — see {@link OhmailEngine.openAttachment}. */
  private readonly attachmentRequests = new Map<string, Promise<void>>();

  constructor(opts: EngineOptions) {
    this.adapter = opts.adapter;
    // The adapter's own capability is the shipped path; the option is the override. Resolved
    // ONCE, here, so `serverSearchAvailable()` cannot answer differently from what
    // `searchServer` will do a moment later.
    this.serverSearchFn =
      opts.serverSearch ??
      (opts.adapter as ServerSearchCapableAdapter).searchServer?.bind(opts.adapter) ??
      null;
    this.store = opts.store ?? new MemoryMirrorStore();
    this.types = opts.types;
    this.syncLimit = opts.syncLimit;
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.readerView = new OverlayReader(this.store, this.overlays, () => this.overlayRev);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Hydrate the mirror, then bootstrap/catch up. */
  async start(): Promise<void> {
    await this.store.load();
    await this.syncOnce();
  }

  /**
   * One full drain: pull pages from the cursor of record until hasMore:false,
   * applying each page idempotently. A 410 discards local state and re-enters
   * as a bootstrap (once — a second 410 within one drain is surfaced).
   */
  async syncOnce(): Promise<void> {
    // Serialize concurrent callers onto one drain.
    if (this.syncing) return this.syncing;
    this.syncing = this.drain().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async drain(): Promise<void> {
    let rebootstrapped = false;
    for (;;) {
      let resp;
      try {
        resp = await this.adapter.sync({
          since: this.store.getCursor(),
          ...(this.syncLimit !== undefined ? { limit: this.syncLimit } : {}),
          ...(this.types ? { types: this.types } : {}),
        });
      } catch (err) {
        if (err instanceof CursorExpiredError && !rebootstrapped) {
          rebootstrapped = true;
          await this.store.resetForBootstrap(); // cursor → "0"
          this.notify();
          continue;
        }
        throw err;
      }
      await this.store.applyResponse(resp);
      this.notify();
      if (!resp.hasMore) return;
    }
  }

  /**
   * A drain that is guaranteed to have STARTED AFTER the caller's write committed (gap O3-ENGINE).
   *
   * ## THE DEFECT THIS EXISTS FOR
   *
   * `syncOnce()` coalesces: a second caller gets the drain already running. For a poll or a wake
   * that is exactly right — they only ever want "catch up", and one drain does. For a mutation
   * reconciling its own write it is WRONG, and wrong in the way that is hardest to see: a drain
   * issued BEFORE the POST committed read the change log at a seq below the mutation's row, so it
   * cannot carry it however long it takes to come back. `dispatch` awaited it anyway, concluded
   * the write had landed, deleted the optimistic overlay — and the mail snapped back to the
   * Screener until the next 8 s poll.
   *
   * Reported twice by the owner as "when I select one as ohbox, it does not seem to work", and
   * then it does. It depends on whether a poll happens to be in flight when the click lands, which
   * is why it looked intermittent: unpredictable by construction, not by luck.
   *
   * ## WHY "STARTED AFTER THE POST RETURNED" IS SUFFICIENT — AND WHAT WOULD BREAK IT
   *
   * `allocateSeq` (`packages/db/src/change-log.ts:77-85`) allocates through an `UPDATE … RETURNING`
   * on the account's `account_sync_state` row, inside the mutation's own transaction, and
   * `recordChange` appends the `change_log` row in that same transaction. So the row lock makes
   * seq order equal COMMIT order per account: seq N is durable before N+1 is ever handed out. A
   * drain issued after our POST returned therefore reads a log in which our row is already
   * visible, and no concurrent drain can move the cursor PAST our seq while our row is still
   * invisible. That is the whole argument, and it rests entirely on that lock — a future
   * `bigserial` seq (allocated outside the transaction, committed out of order) would leave every
   * test here green while making this silently unsound.
   *
   * This is deliberately NOT a wait for `cursor >= outcome.seq`. That is unsound in a way this is
   * not: `SyncService` sets the cursor to the max seq actually RETURNED, computed after the
   * `types` filter, so with `EngineOptions.types` set a seq belonging to a filtered-out entity
   * type is never reached and the wait never terminates. It also needs a fallback anyway —
   * `rule_delete`'s 404 and any absent or non-finite `X-Sync-Seq` give `seq: null` — and a wait
   * loop is unbounded requests (invariant #10) where this is exactly one drain.
   *
   * ## WHAT IT COSTS, WHICH IS NOTHING IN THE COMMON CASE
   *
   * No drain in flight ⇒ `syncOnce()` starts one NOW, which is already "after". That is the same
   * single drain the mutation paid for before this existed: no extra round trip, no doubled
   * request rate.
   *
   * A drain in flight ⇒ ONE follow-up, chained behind it and shared by every mutation that lands
   * in the same window. Three clicks during one poll are three overlays and one extra drain, not
   * three.
   *
   * That bound comes from `syncOnce()` itself and needs no bookkeeping here, which is worth
   * stating because the obvious "remember the queued drain" field is redundant and was removed
   * after being written: every mutation waiting on the same in-flight drain has its callback on
   * that ONE promise's reaction list, so the callbacks run as consecutive microtasks; the first
   * calls `syncOnce()`, which assigns `this.syncing` SYNCHRONOUSLY before returning; every
   * sibling therefore finds it set and coalesces. No macrotask can interleave between adjacent
   * microtasks, and a drain cannot finish inside that window because its own first step is an
   * `await`. Proven by experiment rather than argued: with the sharing field disabled the whole
   * suite — including the three-clicks-in-one-window bound — stayed green.
   *
   * Drains therefore never overlap. NOT because of `getCursor()`, which is a plain synchronous
   * field read that serializes nothing, but because the follow-up is created by calling
   * `syncOnce()` from inside a `.then` on the drain it is waiting for, so the single-flight is
   * never bypassed. Concurrency stays 1, which is the property
   * `apps/webapp/app/shell/sync-scheduler.ts` states and `sync-liveness.test.ts` asserts.
   *
   * Two costs are accepted rather than engineered away. A mutation that lands during the ~37-page
   * cold bootstrap now waits for the bootstrap AND a follow-up before it confirms — the overlay
   * keeps the screen correct throughout, and the mutation was already hostage to that bootstrap
   * through `syncOnce`'s coalescing. And a POST that returned before the current drain STARTED
   * chains one drain it did not need: the client cannot tell that case from the broken one,
   * because the only happens-before it owns is "the POST returned". The over-approximation is
   * sound and bounded at one drain; distinguishing it would need a wall clock, and the only clock
   * here is the injectable `now` seam that fixtures freeze.
   */
  private syncFresh(): Promise<void> {
    const inFlight = this.syncing;
    // Nothing running ⇒ this starts a drain now, which is already after the commit.
    if (!inFlight) return this.syncOnce();
    return inFlight
      // The IN-FLIGHT drain's failure is not this mutation's failure — it is a poll that has
      // nothing to do with the write, and this mutation still needs its own drain afterwards.
      // Its rejection still reaches its own caller (the scheduler counts it and arms backoff):
      // `.catch` derives a NEW promise and steals no handler.
      .catch(() => { /* see above */ })
      .then(() => this.syncOnce());
  }

  /** Hook an SSE/EventSource (or push relay) as a wake signal: `sync` events nudge a drain. */
  attachWakeSignal(source: WakeSignalSource, event = "sync"): () => void {
    const onWake = (): void => {
      void this.syncOnce().catch(() => {
        /* a wake nudge must never throw into the event loop; the next tick retries */
      });
    };
    source.addEventListener(event, onWake);
    return () => source.removeEventListener(event, onWake);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** The overlay-merged reader — what selectors and the UI consume. */
  read(): EntityReader {
    return this.readerView;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // ── message bodies (slice U5-BODY) ───────────────────────────────────────

  /**
   * FETCH ONE MESSAGE'S BODY, ON EXPLICIT INTENT (slice U5-BODY).
   *
   * The one capability behind every reading surface. Before it, the wire `MessageDTO`
   * carried `snippet` and never `body`, so on a live account `m.body ?? m.snippet` rendered
   * a single line in the Ohbox, in Reads, in Receipts and in the Screener; every
   * `StreamCard` measured "short"; and `.scast.short .sc-x{display:none}` hid the Expand
   * pill. There was no pill because there was nothing to expand.
   *
   * ── THE RESULT DOES NOT GO ON THE MESSAGE ROW ──────────────────────────────────────────
   *
   * It goes into a client-local `message_body` record — see {@link MessageBodyRecord} for
   * the mechanism and for the live-only bug that shape makes unreachable. Nothing here
   * touches `message`.
   *
   * ── IDEMPOTENT, SINGLE-FLIGHT ──────────────────────────────────────────────────────────
   *
   * Two surfaces can want the same body at once — the Ohbox read column and the reader sheet
   * render the same message simultaneously — so concurrent callers join one request. A body
   * already `ready` is never re-fetched.
   *
   * A `loading` record with no promise behind it — a tab that died mid-request; the record
   * persists, the promise does not — IS re-fetched. That cannot loop, because a `loading`
   * record written by THIS engine always has an entry in the in-flight map above it. The map
   * is the dedup that matters; deciding from the record's state alone would make a zombie
   * `loading` a permanent spinner with no way out.
   *
   * ── `retry` — WHY A FAILURE IS NOT RETRIED BY DEFAULT ───────────────────────────────────
   *
   * Most callers are React effects: "the card became current", "this sender was selected".
   * They re-run whenever their inputs change, and a failed fetch writes a record, which bumps
   * the mirror version, which re-renders — so a `failed` state that re-fetched on the default
   * path would be a request loop against a server that is already refusing, billed per
   * attempt, for as long as the view stays open (invariant #10). Found by exactly that: a
   * 500-ing adapter under a view whose callback identity changed per render spun until the
   * test timed out.
   *
   * So the rule is about WHO is asking, not about the state. An automatic trigger asks once
   * and reports the failure; a HUMAN act — re-expanding a card, pressing Retry — passes
   * `retry` and asks again. That also makes the failed state's exit a thing the user chose,
   * which is what a control on screen is for.
   *
   * ── WHY IT NEVER REJECTS ───────────────────────────────────────────────────────────────
   *
   * Every caller is a React effect or a click handler; a rejection there is an unhandled
   * promise and, at worst, an error boundary over somebody's mailbox. The outcome is the
   * RECORD — `ready` or `failed` — which is a thing the UI can render. The failure is
   * reported on screen, not thrown at the DOM.
   */
  async hydrateBody(messageId: string, opts: { retry?: boolean } = {}): Promise<void> {
    const inFlight = this.bodyRequests.get(messageId);
    if (inFlight) return inFlight;

    const msg = this.read().get<EngineMessage>("message", messageId);
    // Not in the mirror at all — a fixture `screener_sender`'s held id, or a row that has
    // since been drained away. Nothing to ask about.
    if (!msg) return;
    /**
     * ALREADY WHOLE. The demo's message rows carry `body` (`fixtures-adapter.ts` →
     * `toMessage`), and `bodyOf` answers `full` from exactly this field — so the two agree
     * by construction rather than by both being remembered. This is also what keeps the
     * demo at zero requests without the demo being a special case here.
     */
    if (msg.body !== undefined) return;
    /**
     * A PROTECTED MESSAGE HAS NO BODY TO ASK FOR.
     *
     * Its surface renders `ProtectedBlock` and no text whatever the mirror holds
     * (invariant #1, and `MessagePane` is where that decision lives), so a request here
     * could only ever produce a record nothing reads. Not a safety check — the endpoint's
     * text is already redacted server-side and asking would be harmless — it is simply the
     * one case where the answer cannot change the screen. Skipping it also keeps the demo's
     * one body-less fixture from churning a loading record and a tombstone every time it is
     * selected.
     */
    if (msg.protected != null) return;
    const held = this.read().get<MessageBodyRecord>("message_body", messageId);
    if (held?.state === "ready") return;
    // See `retry` above: an automatic trigger must not re-ask a server that already refused.
    if (held?.state === "failed" && !opts.retry) return;

    const request = this.fetchBodyInto(messageId).finally(() => {
      this.bodyRequests.delete(messageId);
    });
    this.bodyRequests.set(messageId, request);
    return request;
  }

  private async fetchBodyInto(messageId: string): Promise<void> {
    await this.putBody(messageId, {
      messageId, state: "loading", text: "", html: null, loadedRemoteContent: false,
    });
    try {
      const wire = await this.adapter.fetchBody(messageId);
      // `null` ⇒ this adapter serves no bodies (the fixtures world). Tombstone the loading
      // marker rather than leaving a surface saying "loading…" forever; `bodyOf` then falls
      // back to the snippet, which is the honest answer for an adapter with no endpoint.
      //
      // O11b — `html` rides along, UNTOUCHED. This is the one hop between the wire and the
      // renderer and it must stay a carry: sanitizing here would put attacker markup through
      // a transform in the engine, where no surface can see what it did and where the result
      // would be written into the mirror. What is stored is what the sender wrote.
      await this.putBody(
        messageId,
        wire === null
          ? null
          : {
              messageId,
              state: "ready",
              text: wire.text,
              html: wire.html,
              loadedRemoteContent: wire.loadedRemoteContent,
            },
      );
    } catch (err) {
      await this.putBody(messageId, {
        messageId,
        state: "failed",
        text: "",
        html: null,
        loadedRemoteContent: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async putBody(messageId: string, record: MessageBodyRecord | null): Promise<void> {
    await this.store.putLocal("message_body", messageId, record);
    this.notify();
  }

  // ── optimistic mutations ─────────────────────────────────────────────────

  /** Fill in wire-derivable fields so adapter + overlay agree on the payload. */
  private enrich(m: EngineMutation): EngineMutation {
    if (m.kind === "tag_assign" && m.labels === undefined) {
      const msg = this.read().get<EngineMessage>("message", m.messageId);
      if (msg) {
        const labels = m.assigned
          ? [...new Set([...msg.labels, m.tagId])]
          : msg.labels.filter((l) => l !== m.tagId);
        return { ...m, labels };
      }
    }
    if (m.kind === "feed_mark_seen" && m.messageIds === undefined) {
      const ids = this.read()
        .list<EngineMessage>("message")
        .filter((msg) => msg.folder === "ohmail/Reads" && msg.unread)
        .map((msg) => msg.id);
      return { ...m, messageIds: ids };
    }
    if (m.kind === "mail_send") {
      // FREEZE THE ENVELOPE HERE, and nowhere else. The overlay effect and the wire body are
      // both computed from this one object, so they cannot disagree — and because the
      // enriched mutation is what goes on the queue, a retry after a network failure sends
      // the SAME envelope rather than re-deriving it from a mirror that has since drained.
      if (m.inReplyTo === null) {
        // A COMPOSE. The recipient and the subject are the USER's and are not derived from
        // anything; the only unknown is which of the account's mailboxes it goes out from,
        // and `threadId` is pinned to null so nothing downstream can wander into a thread.
        return {
          ...m,
          mailboxId: m.mailboxId ?? sendingMailboxId(this.read()) ?? undefined,
          threadId: null,
        };
      }
      const parent = this.read().get<EngineMessage>("message", m.inReplyTo);
      if (!parent) return m; // unknown parent ⇒ no effects ⇒ mutate() rejects it below
      return {
        ...m,
        mailboxId: m.mailboxId ?? parent.mailboxId,
        threadId: m.threadId ?? parent.threadId,
        subject: m.subject ?? replySubject(parent.subject),
        // The reply goes to the sender of the message being answered. `Reply-To` is not in
        // the mirror (the DTO has no field for it), so a sender who set one is answered at
        // their From — filed as owed rather than silently approximated.
        to: m.to ?? [parent.from],
      };
    }
    return m;
  }

  /**
   * Apply locally NOW, fire the request, reconcile on the echo. Hard rejection
   * ⇒ overlay rolled back; retryable failure ⇒ mutation stays queued (and
   * visible — user-always-wins) for flushPending() with the SAME key.
   */
  async mutate(m: EngineMutation): Promise<MutationResult> {
    const enriched = this.enrich(m);
    const id = this.uuid();
    const key = this.uuid();

    const effects = mutationEffects(this.read(), enriched, { now: this.now, uuid: this.uuid });
    if (effects.length === 0) {
      const error = new MutationRejectedError(`mutation target not found (${m.kind})`, {
        status: 404, code: "not_found",
      });
      return { id, key, status: "rolled_back", seq: null, error };
    }
    this.overlays.set(id, effects);
    this.overlayRev++;
    this.notify();

    return this.dispatch({ id, key, mutation: enriched });
  }

  private async dispatch(p: PendingMutation): Promise<MutationResult> {
    try {
      const outcome = await this.adapter.mutate(p.mutation, { idempotencyKey: p.key });
      if (outcome.changes.length > 0) {
        // Read-your-writes echo (§3.4): idempotent apply — converges with the
        // delta that will arrive at the same seq.
        await this.store.applyChanges(outcome.changes);
      } else {
        /**
         * NO ECHO BODY — pull the authoritative delta from a drain that STARTED after this POST
         * returned. See {@link OhmailEngine.syncFresh} for why merely "a drain" is not enough.
         *
         * This is not the screener's branch, or triage's. EVERY mutation kind can reach it:
         * `triage_set`, `screener_decide`, `mark_seen`, `tag_assign`, `rule_delete` and
         * `mail_send` answer `changes: []` unconditionally, and `move`, `rule_update` and
         * `feed_mark_seen` degrade to it whenever `X-Sync-Seq` is absent or non-finite
         * (`http-adapter.ts` `noteSeq`) — a proxy that strips the header puts the whole product
         * on this path. Only `draft_accept` cannot, because the HTTP adapter refuses it outright.
         *
         * ── ITS FAILURE IS NOT THE MUTATION'S FAILURE ────────────────────────────────────────
         *
         * `adapter.mutate` RESOLVED: the server answered 2xx and committed its `change_log` row.
         * A reconciliation drain that then fails — a hidden tab (the webapp's `SyncGate` aborts
         * the next page), a blip, a second 410 — used to fall into the `catch` below, be wrapped
         * NON-retryable, and report `rolled_back` for a write that had already succeeded.
         *
         * For `mail_send` that is a delivered email reported as failed, and it does not stop at a
         * wrong label: `useMailSend.absorb` (`apps/webapp/app/shell/mail-send.ts`) releases the
         * send lock on every status except `queued` and runs `settle` on `confirmed` ONLY, so the
         * draft survives and the next press mints a NEW Idempotency-Key — a SECOND delivery of
         * the same mail (invariant #2). "Press Send, then switch apps" is enough to reach it.
         *
         * So the drain's failure is swallowed, and that is strictly more truthful rather than
         * less: the overlay is dropped either way, so the screen is identical, and `confirmed` is
         * the true statement about a write the server took. What is NOT swallowed is a rejection
         * from `adapter.mutate` itself — the server refusing is the only thing that means the
         * mutation failed, and it still rolls back or queues in the `catch` below.
         *
         * The residual: on a failed drain the mirror has not caught up, so the row reverts on
         * screen until the next poll. That is the O3 symptom in the one case where the network
         * genuinely broke, rather than in the ordinary case of a poll being in flight.
         */
        try {
          await this.syncFresh();
        } catch { /* see above — the write landed; the mirror catches up on the next poll */ }
      }
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      return { id: p.id, key: p.key, status: "confirmed", seq: outcome.seq };
    } catch (err) {
      const rejection = err instanceof MutationRejectedError
        ? err
        : new MutationRejectedError(String(err), { retryable: false });
      if (rejection.retryable) {
        // Keep the overlay (the user's intent stands) + queue for a retry with
        // the SAME Idempotency-Key — the server dedupes a half-landed attempt.
        this.queue.push(p);
        return { id: p.id, key: p.key, status: "queued", seq: null, error: rejection };
      }
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection };
    }
  }

  pendingMutations(): ReadonlyArray<{ id: string; key: string; mutation: EngineMutation }> {
    return [...this.queue];
  }

  /** Retry every queued mutation (reconnect path), preserving keys and order. */
  async flushPending(): Promise<MutationResult[]> {
    const batch = this.queue.splice(0, this.queue.length);
    const results: MutationResult[] = [];
    for (const p of batch) results.push(await this.dispatch(p));
    return results;
  }

  // ── local search ─────────────────────────────────────────────────────────

  /**
   * THE FAST PATH, and it stays the fast path.
   *
   * Synchronous, no round trip, answers from the mirror on every keystroke. It reads
   * subject, sender, the ≤200-character snippet and whatever body text this device holds —
   * `LocalSearchResult.coverage` says how much of the corpus that was, and the surface is
   * required to say so rather than let the count of hits imply completeness (gap O14).
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const version = this.readerView.version();
    if (!this.searchCache || this.searchCache.version !== version) {
      this.searchCache = { version, index: SearchIndex.build(this.readerView) };
    }
    return this.searchCache.index.search(query, opts);
  }

  // ── the archive pass (gap O14) ───────────────────────────────────────────

  /**
   * Is there a server archive behind this client at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network, invariants #6/#8) and for
   * the desktop tier, whose master is the IMAP mailbox and which has no Cloud API. Both are
   * states the UI must be able to STATE, not states it should hide: "there is no archive
   * here" and "the archive has not answered yet" are different sentences.
   */
  serverSearchAvailable(): boolean {
    return this.serverSearchFn !== null;
  }

  /**
   * SEARCH THE WHOLE CORPUS — `GET /search`, the RRF-ranked hybrid that had zero callers.
   *
   * This is the SECOND answer, never the first. {@link OhmailEngine.search} has already
   * painted; this arrives after and extends it. A surface that awaited this before rendering
   * would have traded an instant local result for a round trip, which is the one thing the
   * local index exists to prevent.
   *
   * ── THE RESULT DOES NOT GO IN THE MIRROR ────────────────────────────────────────────────
   *
   * Same rule as U5-BODY's, for a sharper reason. `/sync` owns the mirror: rows arrive at a
   * seq, deletes arrive at a seq, and `applyToRecords` reconciles by seq. A search hit has no
   * seq. Writing one in would create a row no delta can ever update or remove — a message
   * that outlives its own deletion, in a store whose whole contract is that it converges. So
   * the items are RETURNED, the caller renders them, and they are gone when the query changes.
   *
   * In practice a Cloud mirror already holds the message ROW for nearly every hit (the
   * bootstrap drains all of them); what it lacked was the body TEXT to match on. The caller
   * should therefore prefer its own mirror entity by id — that one carries the optimistic
   * overlay — and fall back to the wire item only for a row the mirror does not have.
   *
   * ── SINGLE-FLIGHT, AND WHY IT NEVER REJECTS ─────────────────────────────────────────────
   *
   * Concurrent callers for the same query join one request. And the caller is a React effect
   * behind a debounce: a rejection there is an unhandled promise over somebody's mailbox, so
   * the outcome is a VALUE — `unavailable`, `ready`, or `failed` with the server's own
   * sentence — which is a thing the UI can render. A 402 from the spend gate arrives as its
   * message, not as an error boundary.
   *
   * `GET /search` is `cost: "read"` (`packages/api/src/routes/search.ts`), so wiring this
   * caller changes no cost class and no line of the route-cost census. It reads rows already
   * stored for the caller's own account, writes nothing, opens no socket and calls no metered
   * third party. It is not, however, free of judgement: it is one request per settled query,
   * fired from a debounce and never per keystroke, for the same reason `hydrateBody` fires on
   * explicit intent only (invariant #10).
   */
  async searchServer(query: string, opts: { limit?: number } = {}): Promise<ServerSearchOutcome> {
    const fn = this.serverSearchFn;
    if (fn === null) return { state: "unavailable" };
    const q = query.trim();
    if (q === "") return { state: "ready", items: [], total: 0 };

    const key = `${opts.limit ?? ""}\u0000${q}`;
    const inFlight = this.serverSearches.get(key);
    if (inFlight) return inFlight;

    const request = fn(q, opts)
      .then((wire): ServerSearchOutcome => {
        // `null` ⇒ this transport serves no archive. Same shape as `fetchBody`'s `null`, and
        // it must not become an empty `ready`: "we searched everything and found nothing" is
        // a claim, and this is the case where we searched nothing at all.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
        };
      })
      .catch((err: unknown): ServerSearchOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => {
        this.serverSearches.delete(key);
      });

    this.serverSearches.set(key, request);
    return request;
  }

  // ── attachments (gap O18) ────────────────────────────────────────────────

  /**
   * Can this client open attachments at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network, invariants #6/#8), where the
   * paperclip must not offer a control that cannot work. Resolved from the adapter's own optional
   * capability, so it cannot disagree with what the methods below will do.
   */
  attachmentsAvailable(): boolean {
    return typeof this.adapter.listAttachments === "function"
      && typeof this.adapter.fetchAttachment === "function";
  }

  /**
   * What the surface renders RIGHT NOW for one message. Synchronous, no side effects.
   *
   * Separate from {@link OhmailEngine.loadAttachments} on purpose: React renders far more often
   * than it should fetch, so the render path reads state and the effect path asks for it. A method
   * that fetched on read would issue a request per render (invariant #10).
   */
  attachmentsOf(messageId: string): AttachmentsOutcome {
    if (!this.attachmentsAvailable()) return { state: "unavailable" };
    return this.attachmentLists.get(messageId) ?? { state: "loading" };
  }

  /**
   * Read one message's attachment METADATA — filenames, types, sizes. No bytes, no IMAP.
   *
   * `cost: "read"` on the route: this is an indexed row read against the caller's own account and
   * nothing here reaches the mail server, which is what makes it acceptable to call when a message
   * is opened. The bytes are a separate, deliberate act.
   *
   * ## INLINE PARTS ARE FILTERED OUT, AND THE PAPERCLIP DOES NOT KNOW
   *
   * `inline` parts are `cid:` images the HTML body already references — a newsletter's logo, a
   * signature graphic. They are not files a person means when they say "attachment", and the server
   * agrees: both `GET /files` and per-message `download-all` exclude them. Filtering here keeps the
   * strip consistent with the zip.
   *
   * It also exposes a real inconsistency rather than hiding one. `hasAttachments` is derived from
   * ALL parts (`mime.ts` — `attachments.length > 0`), so 755 of 1,766 flagged messages in production
   * (43%, measured 2026-08-04) are flagged for inline parts ONLY and will render a paperclip over an
   * EMPTY strip. That is honest about the data and wrong about the mail. The fix belongs where the
   * flag is computed, and is deliberately NOT done here: filtering this list to match the flag would
   * mean listing tracking pixels and signature logos as files, and widening the flag's definition is
   * an ingest change plus a backfill of every affected row. Filed as its own gap.
   *
   * Never rejects: single-flight per message, and the failure is a value the UI can render.
   */
  async loadAttachments(messageId: string, opts: { retry?: boolean } = {}): Promise<AttachmentsOutcome> {
    const list = this.adapter.listAttachments;
    if (!list || !this.attachmentsAvailable()) return { state: "unavailable" };

    const inFlight = this.attachmentListRequests.get(messageId);
    if (inFlight) return inFlight;

    const held = this.attachmentLists.get(messageId);
    // Already answered. Re-reading would discard the per-item byte state (`ready` object URLs and
    // all) for a list that cannot have changed — attachments are immutable parts of a stored message.
    if (held && held.state === "ready") return held;
    // See `hydrateBody`'s `retry` note: an automatic trigger must not re-ask a server that refused,
    // or a React effect whose identity changes per render loops against it for as long as the view
    // is open. A human pressing Retry passes `retry`.
    if (held && held.state === "failed" && !opts.retry) return held;

    // `retrying` marks a HUMAN re-ask over a failure, and nothing else: the first ask of a
    // message must stay `{ state: "loading" }` with the field absent, because that is the state
    // the surface renders as silence.
    const retrying = opts.retry === true && held?.state === "failed";
    this.attachmentLists.set(messageId, retrying ? { state: "loading", retrying: true } : { state: "loading" });
    this.notify();

    const request = list.call(this.adapter, messageId)
      .then((wire): AttachmentsOutcome => {
        const items = wire.filter((a) => !a.inline).map(toAttachmentItem);
        return { state: "ready", items };
      })
      // The adapter's own classification, kept. `MutationRejectedError` is the one thing
      // `HttpAdapter` throws — for a non-2xx (`rejectionOf`: the server's code, and `retryable`
      // defaulted from the status) and for a fetch that rejected outright (`code: "network"`).
      // Anything else reaching here is unclassified, and unclassified means we never established
      // that the server refused, so asking again is honest. See {@link AttachmentsOutcome}.
      .catch((err: unknown): AttachmentsOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
        retryable: err instanceof MutationRejectedError ? err.retryable : true,
      }))
      .then((outcome) => {
        this.attachmentLists.set(messageId, outcome);
        this.notify();
        return outcome;
      })
      .finally(() => {
        this.attachmentListRequests.delete(messageId);
      });

    this.attachmentListRequests.set(messageId, request);
    return request;
  }

  /**
   * FETCH ONE ATTACHMENT'S BYTES from the user's IMAP mailbox and mint a Blob URL for it.
   *
   * `cost: "connection"` — this opens a real IMAP connection to somebody's mail server, which is
   * the most expensive read in the product. So it fires on an explicit human act only: a click on
   * that file. Never on render, never on selection, never speculatively for a strip.
   *
   * Never rejects (the caller is a click handler). The outcome is the item's `state`:
   *
   *   · `too_large` — the server refused at its size ceiling (`payload_too_large`). A distinct
   *     state, not a failure, because the answer is permanent and a Retry button would be a lie.
   *   · `failed`    — anything else, carrying the server's own sentence.
   *
   * Single-flight per attachment id: a double-click is one fetch, not two IMAP connections.
   */
  async openAttachment(messageId: string, attachmentId: string, opts: { retry?: boolean } = {}): Promise<void> {
    const fetchOne = this.adapter.fetchAttachment;
    if (!fetchOne) return;

    const inFlight = this.attachmentRequests.get(attachmentId);
    if (inFlight) return inFlight;

    const current = this.itemOf(messageId, attachmentId);
    if (!current) return;
    // Already fetched, and the URL is still live — the bytes are in the tab, nothing to ask for.
    if (current.state === "ready" && current.objectUrl) return;
    // A refusal at the ceiling cannot become a success by asking again.
    if (current.state === "too_large") return;
    if (current.state === "failed" && !opts.retry) return;

    this.patchAttachment(messageId, attachmentId, { state: "loading", error: undefined });

    const request = fetchOne.call(this.adapter, attachmentId)
      .then((blob) => {
        // REVOKE BEFORE RE-MINTING. A retry over a `failed` item that had somehow minted a URL,
        // or any second pass, would otherwise leak the old one for the life of the document.
        this.revokeItem(messageId, attachmentId);
        const objectUrl = this.mintObjectUrl(blob, current.mimeType);
        this.patchAttachment(messageId, attachmentId, {
          state: "ready",
          ...(objectUrl ? { objectUrl } : {}),
        });
      })
      .catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        this.patchAttachment(messageId, attachmentId, {
          state: code === "payload_too_large" ? "too_large" : "failed",
          error: message,
        });
      })
      .finally(() => {
        this.attachmentRequests.delete(attachmentId);
      });

    this.attachmentRequests.set(attachmentId, request);
    return request;
  }

  /**
   * FETCH EVERY non-inline attachment on a message as ONE zip, assembled server-side.
   *
   * One request and one IMAP connection for the whole set, which is why this is not a loop over
   * {@link OhmailEngine.openAttachment} — N files would otherwise mean N logins to the user's mail
   * server, and providers throttle exactly that pattern.
   *
   * Returns the Blob for the caller to save (`<a download>`), or `null` when this client has no
   * server or the archive could not be built.
   *
   * ## THE FAILURE IS THE CALLER'S TO REPORT, AND THE LIST IS LEFT ALONE
   *
   * An earlier shape wrote `{state: "failed"}` over the message's list here. That was wrong twice:
   * the metadata is still perfectly good — only the archive request failed — so replacing the list
   * would blank a strip the user is looking at, discarding every `ready` object URL in it; and at
   * the time the strip had no per-list error surface at all, so the state was overwritten and
   * restored in the same tick and no render could ever observe it. A state nothing can render is
   * not error handling.
   *
   * THE SECOND HALF OF THAT IS NO LONGER TRUE — gap AT6 gave the strip a list state, and `failed`
   * now reaches it. The FIRST half is why this still must not use it: a failed zip says nothing
   * about the metadata, and a list-level failure row here would claim the files are unknown when
   * they are on screen.
   *
   * So the signal is the return value and the caller says so — a toast, next to the button that
   * was pressed.
   *
   * The zip may legitimately be missing files: the server skips a part it cannot fetch and names it
   * in `_errors.txt` inside the archive. A non-null answer is therefore NOT a promise that every
   * file is present.
   */
  async downloadAllAttachments(messageId: string): Promise<Blob | null> {
    const fetchAll = this.adapter.fetchAllAttachments;
    if (!fetchAll) return null;
    try {
      return await fetchAll.call(this.adapter, messageId);
    } catch {
      return null;
    }
  }

  /**
   * Revoke every object URL held for a message and forget its byte state.
   *
   * MUST be called when the surface stops rendering the message (a pane unmount, a different
   * message selected). A `blob:` URL pins its bytes in memory until it is revoked or the document
   * dies, so a session spent opening PDFs in a long-lived tab would otherwise accumulate every one
   * of them — the exact cost the "nothing is stored" design exists to avoid, reintroduced in the
   * browser instead of the database.
   */
  releaseAttachments(messageId: string): void {
    const held = this.attachmentLists.get(messageId);
    if (held?.state === "ready") {
      for (const item of held.items) this.revokeUrl(item.objectUrl);
    }
    this.attachmentLists.delete(messageId);
    this.notify();
  }

  /** Revoke everything, for a teardown that is losing the whole engine. */
  releaseAllAttachments(): void {
    for (const messageId of [...this.attachmentLists.keys()]) this.releaseAttachments(messageId);
  }

  private itemOf(messageId: string, attachmentId: string): AttachmentItem | undefined {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return undefined;
    return held.items.find((i) => i.id === attachmentId);
  }

  /** Replace one item in a message's list and re-render. */
  private patchAttachment(messageId: string, attachmentId: string, patch: Partial<AttachmentItem>): void {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;
    this.attachmentLists.set(messageId, {
      state: "ready",
      items: held.items.map((i) => (i.id === attachmentId ? { ...i, ...patch } : i)),
    });
    this.notify();
  }

  private revokeItem(messageId: string, attachmentId: string): void {
    this.revokeUrl(this.itemOf(messageId, attachmentId)?.objectUrl);
  }

  private revokeUrl(url: string | undefined): void {
    if (!url) return;
    const U = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
    U?.revokeObjectURL?.(url);
  }

  /**
   * Mint a Blob URL, DOWNGRADING the content type of anything a browser would render as a document.
   *
   * See {@link RENDERABLE_MIME}. The re-typing happens at construction because that is the only
   * point that governs every consumer: a call site can forget to check a type, and the two the
   * server sets (`Content-Disposition`, `nosniff`) describe the RESPONSE and do not survive into a
   * Blob made from its body.
   *
   * Returns `undefined` where there is no `URL.createObjectURL` — SSR and the node test
   * environment — so a `ready` item there simply carries no URL rather than throwing inside a
   * render.
   */
  private mintObjectUrl(blob: Blob, declaredMime: string): string | undefined {
    const U = (globalThis as {
      URL?: { createObjectURL?: (b: Blob) => string };
    }).URL;
    if (typeof U?.createObjectURL !== "function") return undefined;
    const safeType = RENDERABLE_MIME.has(declaredMime.toLowerCase()) ? declaredMime : "application/octet-stream";
    const typed = blob.type === safeType ? blob : new Blob([blob], { type: safeType });
    return U.createObjectURL(typed);
  }
}
