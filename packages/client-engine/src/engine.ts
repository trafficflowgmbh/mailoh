import type { EngineAdapter } from "./adapters/adapter.js";
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
    await this.putBody(messageId, { messageId, state: "loading", text: "" });
    try {
      const wire = await this.adapter.fetchBody(messageId);
      // `null` ⇒ this adapter serves no bodies (the fixtures world). Tombstone the loading
      // marker rather than leaving a surface saying "loading…" forever; `bodyOf` then falls
      // back to the snippet, which is the honest answer for an adapter with no endpoint.
      await this.putBody(messageId, wire === null ? null : { messageId, state: "ready", text: wire.text });
    } catch (err) {
      await this.putBody(messageId, {
        messageId,
        state: "failed",
        text: "",
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
        // No echo body (triage/screener) — pull the authoritative delta now.
        await this.syncOnce();
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

    const key = `${opts.limit ?? ""} ${q}`;
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
}
