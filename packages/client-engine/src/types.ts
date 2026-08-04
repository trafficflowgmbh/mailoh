/**
 * @ohmail/client-engine — wire vocabulary.
 *
 * These shapes MIRROR the ohmail Cloud API contract without importing any
 * backend package: the engine consumes the wire contract only, exactly as the
 * native SwiftData mirror will. Clients must tolerate unknown fields and
 * unknown entity types (forward-compatible parsing) — hence the open unions
 * below.
 *
 * ABOUT THE `§` REFERENCES in this package. They cite the Cloud API contract
 * document, which is **not public** — ohmail Desktop is the free, GPL-3.0 half
 * of the product and the Cloud service is the other half. The citations are
 * left in rather than stripped because they are load-bearing where the file is
 * authored, and because pretending the other half does not exist would be its
 * own kind of dishonesty. Nothing here depends on being able to read that
 * document: this file IS the public statement of the wire vocabulary, and in
 * the Desktop build the client that would speak it is aliased out of the bundle
 * entirely (`adapters/http-adapter.ts` is a stub whose constructor throws).
 */

export type ISODateTime = string;
export type Cursor = string;

export interface EmailAddress {
  name: string | null;
  address: string;
}

/**
 * Real IMAP folders — identical to core `Destination` (contract §1.2).
 *
 * These five strings are the most durable copy the product writes: they are
 * created inside the customer's own mailbox and render in Apple Mail, Outlook
 * and every other client, forever — including after the customer leaves. The
 * namespace was renamed from the pre-rebrand company name to `ohmail/…` on
 * 2026-07-31, while zero real mailboxes were connected, precisely so that no
 * folder-rename migration would ever be needed. Changing them again is an
 * IMAP data migration, not an edit.
 *
 * The narrow UI rule stands regardless: NEVER render a raw folder string. Map
 * it through `VIEW_OF_FOLDER`; when a server sends a folder this client does
 * not know (contract §8 forward-compatible parsing), fall back to
 * `folderLeaf()`, which yields the last path segment.
 */
export type Folder =
  | "INBOX"
  | "ohmail/Screener"
  | "ohmail/Reads"
  | "ohmail/Receipts"
  | "ohmail/Screened"
  | "ohmail/Quarantine";

export type ChangeOp = "create" | "update" | "move" | "delete";

/**
 * The EntityType values the server's `/sync` feed carries today (contract §3.1 P1).
 *
 * `"tag"` JOINED THIS LIST IN W6 and the move is the whole point of that slice. It used to sit
 * only in {@link MirrorEntityType}, among the demo-world types, and the consequence was not a
 * missing feature but an invisible one: `TagView`, `TagPicker` and the `t` shortcut were all
 * built and all worked against fixtures, while a real Cloud account drained a `/sync` feed with
 * no vocabulary for a tag and therefore rendered an empty picker forever. Mirrors
 * `EntityType` in `packages/db/src/change-log.ts`, which grew the same member in the same slice.
 *
 * Tag ASSIGNMENTS are deliberately not a type here. They ride the `message` entity —
 * `MessageDTO.labels` — so a client can never hold an assignment that names a tag it has not
 * received yet.
 */
export type SyncEntityType =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder" | "tag";

/**
 * Everything the LOCAL mirror stores. Beyond the synced types, the engine keeps
 * client-local entities for the demo/fixture world (`screener_sender`,
 * `triage_item`, `mailbox`), view metadata (`view_meta`, e.g. the Reads
 * waterline) and hydrated message bodies (`message_body`, slice U5-BODY).
 * Unknown strings are tolerated by design.
 */
export type MirrorEntityType =
  | SyncEntityType
  | "screener_sender" | "triage_item" | "mailbox" | "view_meta" | "message_body"
  | (string & {});

// ── /sync wire shapes (contract §3.1) ──────────────────────────────────────

export interface SyncChange<T = unknown> {
  type: MirrorEntityType;
  op: ChangeOp;
  id: string;
  /** Global monotonic per-account sequence — the order of record (§3.3). */
  seq: number;
  updatedAt: ISODateTime;
  /** The full resource DTO; OMITTED for op:"delete". */
  entity?: T;
  /** Present only for op:"move" on messages. */
  move?: { from: Folder | null; to: Folder };
}

export interface SyncResponse {
  changes: {
    creates: SyncChange[];
    updates: SyncChange[];
    moves: SyncChange[];
    deletes: SyncChange[];
  };
  cursor: Cursor;
  hasMore: boolean;
  serverTime: ISODateTime;
}

// ── entity DTO mirrors ─────────────────────────────────────────────────────

export interface SensitivityFlags {
  sensitive: boolean;
  category: "otp" | "verification" | "password_reset" | "security_alert" | null;
  no_ai: boolean;
  no_forward: boolean;
  no_kb: boolean;
  priority: boolean;
}

export type TriageState = "none" | "reply_later" | "set_aside" | "bubbled_up" | "muted";

export interface MessageStateDTO {
  messageId: string;
  state: TriageState;
  bubbleUpAt: ISODateTime | null;
  setAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Fixture-only display extras a message row may carry in the demo world. */
export interface EngineMessageExtras {
  /** Full body text (mirrored locally so search covers it). */
  body?: string;
  /** Display time exactly as the prototype renders it ("09:12", "Mon"). */
  time?: string;
  threadCount?: number;
  attachment?: { filename: string; size: string };
  protected?: { kind: string; label: string; redactedNote: string; policy: string };
  rationale?: string;
  trackerNote?: string;
  amount?: string;
  art?: { ariaLabel: string; caption: string };
}

/**
 * The engine's message row — the wire `MessageDTO` (contract §5.2) plus optional
 * client-local extras. Server-fed rows simply leave the extras absent.
 */
export interface EngineMessage extends EngineMessageExtras {
  id: string;
  accountId: string;
  mailboxId: string;
  threadId: string | null;
  messageIdHeader: string | null;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  date: ISODateTime | null;
  folder: Folder;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  sensitivity: SensitivityFlags;
  triage: MessageStateDTO | null;
  labels: string[];
  remoteContent: "blocked" | "loaded" | "none";
  updatedAt: ISODateTime;
}

// ── message bodies (slice U5-BODY) ─────────────────────────────────────────

/**
 * `GET /messages/:id/body`, as much of it as this client reads.
 *
 * The endpoint answers `{messageId, text, html, headers, loadedRemoteContent}`. Only `text`
 * is declared, because only `text` is rendered — contract §8's forward-compatible parsing
 * means an unread field is not an error. Two of the omissions are deliberate rather than
 * pending:
 *
 *  · `html` is NOT read. Rendering sender-authored HTML would need a sanitiser, and it is
 *    also where a tracking pixel re-enters a product whose spy-pixel blocker is a feature.
 *    Filed as owed; `text` is what every surface clamps today anyway.
 *  · `text` is ALREADY sensitivity-redacted server-side (invariant #1, `message-service.ts`
 *    `getBody`: "returned as-is, never re-derived"). This client stores exactly what it was
 *    given and never attempts a redaction of its own — a second implementation of that rule
 *    is a second place for it to be wrong.
 */
export interface MessageBodyWire {
  text: string;
}

/**
 * THE HYDRATED BODY, AS A CLIENT-LOCAL RECORD — and why it is not on the message.
 *
 * `message_body` is in {@link MirrorEntityType} and deliberately NOT in
 * {@link SyncEntityType}: `/sync`'s vocabulary has no such type, so no delta can ever
 * carry one and no delta can ever overwrite one. That absence is the whole mechanism.
 *
 * Writing the fetched text onto the `message` row instead would look simpler and would be
 * broken in a way no fixture test can see. `applyToRecords` REPLACES the entity on
 * `create|update` (`apply.ts:56-58`), and opening a message emits `mark_seen`, whose echo
 * is an update carrying a server DTO — which has `snippet` and no `body`. So the body the
 * user is reading would be wiped by the read-receipt of the act of reading it, live only,
 * timing-dependent, and invisible in the demo because the FixturesAdapter's message rows
 * carry `body` already. Keeping the two in separate records makes the failure unreachable
 * rather than unlikely.
 *
 * `state` is on the record rather than derived, because "we asked and the server refused"
 * has to be distinguishable from "we never asked" — see {@link BodyState}.
 */
export interface MessageBodyRecord {
  messageId: string;
  state: "loading" | "ready" | "failed";
  /** The endpoint's already-redacted text. Empty while loading and after a failure. */
  text: string;
  /** Why the fetch failed, for the console — never rendered to the user. */
  error?: string;
}

/**
 * What a surface knows about the text it is about to render.
 *
 * The four values exist because ONE of them — `snippet` — is how U5a shipped: `body ??
 * snippet` renders a one-line truncation as though it were the whole message, with no
 * signal anywhere that there is more. A surface that cannot tell these apart cannot show
 * the difference, so the distinction is in the type rather than in each caller's guesswork.
 *
 *  · `full`    — this IS the whole message. Clamp it, offer the pill, say nothing.
 *  · `snippet` — a preview; the body has not been asked for. The pill must still be
 *                offered, or there is no way to ask.
 *  · `loading` — asked, in flight. Say so.
 *  · `failed`  — asked, refused. Say so, and differently.
 */
export type BodyState = "full" | "snippet" | "loading" | "failed";

/** The text to render plus what it actually is. See {@link BodyState}. */
export interface MessageBody {
  text: string;
  state: BodyState;
}

export interface RuleDTO {
  id: string;
  kind: "sender" | "domain" | "header";
  match: string;
  destination: Folder;
  priority: number;
  provenance: "manual" | "migrated" | "promoted";
  enabled: boolean;
  stats: { hits: number; lastHitAt: ISODateTime | null; demotions: number };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface EngineDraft {
  id: string;
  mailboxId: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  subject: string;
  body: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  rationale: string | null;
  status: "draft" | "sending" | "sent" | "unverified";
  /** Client-local: the user took the AI draft into the editor. */
  accepted?: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── client-local entities (fixtures / demo world) ──────────────────────────

/**
 * A tag. NO LONGER FIXTURE-ONLY as of W6 — it is a real `/sync` entity backed by the `tags`
 * table, and this interface is now the client mirror of the server's `TagDTO`.
 *
 * A tag is OURS: a row in our database keyed by message, and never an IMAP folder. That is why
 * it can be created and destroyed by the product at all, and it is also why the UI tells the
 * truth about its lifetime — a disconnect keeps tags (a mailbox `delete` is a reversible soft
 * delete), but erasing the account takes them, and a tag never outlives its message. The user's
 * FOLDERS survive leaving because they are real IMAP folders; their tags do not.
 *
 * `className` is OPTIONAL because the server does not send it: a CSS class is presentation, not
 * account data. The fixture adapter still supplies one, and `hueOf` derives the rendering from
 * `hue` for both worlds.
 */
export interface TagDTO {
  id: string;
  name: string;
  hue: string;
  className?: string;
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
}

export type ScreenerSegment = "waiting" | "screened_out" | "spam";

export interface ScreenerHeldMail {
  /** Own identity, so a held message is never just a slot in a count. */
  id: string;
  subject: string;
  time: string;
  body: string;
  /**
   * WHAT `body` ACTUALLY IS (slice U5-BODY). Absent ⇒ `full`, which is the fixture world:
   * a `screener_sender` entity carries its held bodies verbatim and there is nothing to
   * hydrate. A DERIVED row — every row on a Cloud account — starts at `snippet` and moves
   * through `loading` to `full` or `failed`, and the preview has to say which, because a
   * consent decision taken on a truncation is the risk the Screener exists to remove.
   */
  bodyState?: BodyState;
  trackerNote?: string;
}

export interface ScreenerSenderDTO {
  id: string;
  segment: ScreenerSegment;
  from: EmailAddress;
  initial: string;
  time: string;
  scope: "sender" | "domain";
  dull?: boolean;
  ai: { dest: OhmailView | "screened" | "spam"; confidence: number; rationale: string } | null;
  /**
   * NO-COLLAPSE (invariant #6): every held message, in full, oldest first —
   * non-empty in every segment. There is deliberately no `heldCount` /
   * `lastSubject` / `lastBody` beside it: a count that is not `held.length`
   * can drift, and a "last body" is how held mail becomes hidden mail.
   */
  held: ScreenerHeldMail[];
  /** screened_out only */
  screenedOn?: string;
  /** spam only */
  detection?: { source: string; confidence: number; reason: string; label: string };
  /**
   * TRUE when `screenerSegments()` computed this row from the MESSAGE MIRROR rather
   * than reading a `screener_sender` entity (slice C1) — i.e. every row on a Cloud
   * account, and none in the demo world.
   *
   * It is not cosmetic. `id` is then the representative MESSAGE id, which is what
   * `POST /screener/:id` resolves, and the surrounding affordances differ: the server
   * has no un-screen and no delete endpoint, so releasing a derived screened-out or
   * quarantined sender is per-message `move`, and Delete is not offered at all. The
   * UI must not guess which kind of row it has.
   */
  derived?: true;
  updatedAt: ISODateTime;
}

/** A triage pile entry with no backing message in the demo world. */
export interface TriageItemDTO {
  id: string;
  pile: Exclude<TriageState, "none" | "muted">;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}

/** `view_meta` id "reads_waterline" — the Reads seen-up-to-here marker. */
export interface WaterlineMeta {
  afterId: string;
  label: string;
  meta: string;
}

// ── views ──────────────────────────────────────────────────────────────────

/** Views are CLIENT groupings over folders, not folders (brief §4). */
export type OhmailView = "ohbox" | "reads" | "receipts" | "screener" | "screened" | "spam";

export const FOLDER_OF_VIEW: Record<OhmailView, Folder> = {
  ohbox: "INBOX",
  reads: "ohmail/Reads",
  receipts: "ohmail/Receipts",
  screener: "ohmail/Screener",
  screened: "ohmail/Screened",
  spam: "ohmail/Quarantine",
};

/**
 * The last path segment of a folder name — the only safe way to show a folder
 * this client has no view for.
 *
 * It exists rather than views falling back to the raw string because unknown
 * folders are expected: the server may add folders a shipped client has never
 * heard of (contract §8), and customers nest their own. The leaf of
 * `ohmail/Receipts` is `Receipts`; the leaf of a customer's own
 * `Archive/2026/Q1` is `Q1`. Both read correctly; neither shows a path.
 */
export function folderLeaf(folder: string): string {
  const leaf = folder.split("/").filter(Boolean).pop() ?? folder;
  return leaf.trim() || folder;
}

export const VIEW_OF_FOLDER: Record<Folder, OhmailView> = {
  "INBOX": "ohbox",
  "ohmail/Reads": "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screener": "screener",
  "ohmail/Screened": "screened",
  "ohmail/Quarantine": "spam",
};

// ── mutations ──────────────────────────────────────────────────────────────

/**
 * The optimistic mutation vocabulary. Each mutation is applied locally at once
 * (user-always-wins) and mapped by the adapter to its wire endpoint (HTTP) or
 * served in-place (fixtures).
 */
export type EngineMutation =
  | { kind: "move"; messageId: string; folder: Folder }
  | { kind: "triage_set"; messageId: string; state: TriageState; bubbleUpAt?: ISODateTime | null }
  | {
      kind: "screener_decide";
      senderId: string;
      decision: "yes" | "no";
      /** Where a Yes files the held mail; defaults to the AI suggestion, then ohbox. */
      dest?: OhmailView;
      /** "&read" seen-semantics: a Yes files the held mail already-seen (unread=false). */
      read?: boolean;
      scope?: "sender" | "domain";
    }
  | {
      kind: "tag_assign";
      messageId: string;
      tagId: string;
      assigned: boolean;
      /**
       * Filled by the engine at mutate() time: the full next labels array.
       *
       * FOR THE OPTIMISTIC EFFECT ONLY — it is deliberately NOT the wire body, though it was
       * described as one before the backend existed. Sending an array would be a
       * read-modify-write, and two concurrent toggles of different tags on one message would
       * lose one of them. The adapter sends `{ tagId, assigned }`; see `http-adapter.ts`.
       */
      labels?: string[];
      /**
       * TAG-OR-CREATE (W6). Present when the user typed a name that does not exist yet, which
       * is the only way to mint a tag from this shell: the shared shell may not import
       * `app/api-client` (`scripts/publish-desktop.mjs` DENYs it), so the engine is its only
       * wire, and a separate `tag_create` mutation would have to be handled in
       * `mutations.ts`'s exhaustive switch.
       *
       * `tagId` is then a CLIENT-MINTED uuid and the server uses it as the new row's id — so
       * the optimistic paint names the same tag the database ends up holding. If the name
       * turns out to already exist (a race, or a case-insensitive collision), the EXISTING
       * tag wins and the client's id is simply never seen; `tagsOfMessage` filters ids the
       * mirror does not know, so the chip appears one drain later under the correct id rather
       * than rendering something false in the meantime.
       */
      createName?: string;
    }
  | {
      kind: "feed_mark_seen";
      /** Waterline anchor; defaults to the newest Reads message. */
      upToId?: string;
      /** Filled by the engine at mutate() time: the unread Reads ids to flip. */
      messageIds?: string[];
    }
  /**
   * FOLDER-AGNOSTIC read-state (slice U1) — the mutation `feed_mark_seen` could not be.
   *
   * `feed_mark_seen` is the Reads WATERLINE, and its optimistic effect drops every id outside
   * `ohmail/Reads` by construction while its wire side would PATCH anything. Outside Reads the
   * two halves therefore disagree — the server flips a message the local overlay did not — so
   * reusing it for the Ohbox or Receipts would have produced a row that stays bold until the
   * next drain and then silently changes under the cursor. This one flips exactly the ids it is
   * given, wherever they live, and its wire side sends exactly the same list.
   *
   * `unread` and not a `seen` verb: it is the field the mutation sets, on the wire and in the
   * mirror, so `u` (toggle unread) and "mark selection read" are one mutation with two values
   * rather than two mutations that must be kept in agreement.
   */
  | { kind: "mark_seen"; messageIds: string[]; unread: boolean }
  /**
   * SEND MAIL (slices U4b, U4f) — the one mutation whose effect leaves the building.
   *
   * ── ONE VERB, TWO ENTRY POINTS ─────────────────────────────────────────────────────────
   *
   * It shipped as `reply_send` and was generalized in U4f rather than copied: Compose needed
   * the same idempotency key, the same four-outcome failure surface, the same "a 200 is
   * inspected, not trusted" reading of the wire and the same double-send lock. A second
   * implementation of "send an email" is two places for invariant #2 to be true in, which is
   * one place too many. `inReplyTo` is the ONLY difference between the two callers.
   *
   * ── `inReplyTo: null` IS LOAD-BEARING, NOT A DEFAULT ───────────────────────────────────
   *
   * A fresh compose starts a NEW conversation and must carry no `In-Reply-To` and no
   * `References`. Those headers are minted server-side from `drafts.inReplyToMessageId`
   * (`send-service.ts`: the whole threading block is inside `if (d.inReplyToMessageId)`), so
   * a null here is what keeps a stranger's Message-ID out of a message that is not answering
   * them. `null` rather than "absent" so a caller cannot forget the field and inherit
   * whatever a previous send left in scope.
   *
   * ── WHY IT HAS NO REVERSIBLE OPTIMISTIC EFFECT ─────────────────────────────────────────
   *
   * Every other verb here is a local edit the server later agrees with, and a rejection
   * rolls the overlay back with nothing lost. A send is not that: a message that reached
   * SMTP cannot be un-sent, so the overlay must never assert that it arrived. The effect is
   * therefore ONE `draft` row at `status: "sending"` — the same state the server writes on
   * its reservation — and deliberately NOT a Sent-folder message row. The real copy lands
   * when the worker's Sent-folder watch ingests it (slice U4c), minutes later; fabricating
   * one here would be a claim the mirror contradicts on the next drain.
   *
   * The three non-delivered outcomes are distinguishable at the call site and MUST stay
   * that way — `send_unverified` (SMTP threw and the Sent probe found nothing: genuinely
   * ambiguous), `send_failed` (a terminal prior attempt under this key), and a retryable
   * `in_flight`/network rejection that keeps the intent queued. A queued send that looks
   * like a delivered one is the failure this vocabulary exists to prevent.
   *
   * ── WHAT `Engine.enrich()` FILLS, AND WHAT IT MUST NOT ─────────────────────────────────
   *
   * For a REPLY the optional fields are derived from the parent (recipient, subject, mailbox,
   * thread), exactly as `tag_assign.labels` is, so the overlay and the wire body are computed
   * once from the same state and cannot disagree. For a COMPOSE the recipient and the subject
   * are the USER's and are never derived; only `mailboxId` is filled, from the mirror
   * (`sendingMailboxId`), because the account's own address is not something a compose form
   * can know.
   *
   * There is no `cc`. `OutboundMessage` (packages/core) has no cc field, so `SendService`
   * stores `drafts.cc` and never delivers it — a Cc box would drop the copy silently. Filed
   * as owed rather than offered.
   */
  | {
      kind: "mail_send";
      /**
       * The message being answered, or `null` for a fresh compose — see above. A reply's
       * recipient, subject, mailbox and thread are all derived from it.
       */
      inReplyTo: string | null;
      /** Exactly what the user typed. No quoted original: see the http adapter. */
      body: string;
      mailboxId?: string;
      threadId?: string | null;
      subject?: string;
      to?: EmailAddress[];
    }
  | { kind: "draft_accept"; draftId: string };

// ── errors ─────────────────────────────────────────────────────────────────

/** `410 cursor_expired` — discard local state and re-bootstrap with since=0 (§3.2). */
export class CursorExpiredError extends Error {
  constructor(message = "sync cursor expired; re-bootstrap with since=0") {
    super(message);
    this.name = "CursorExpiredError";
  }
}

/** A mutation the server (or adapter) refused. `retryable` gates the offline queue. */
export class MutationRejectedError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number | null; code?: string | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "MutationRejectedError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

/** A mutation kind this adapter has no wire mapping for (e.g. tags pre-Stage-2). */
export class UnsupportedMutationError extends MutationRejectedError {
  constructor(kind: string) {
    super(`mutation kind "${kind}" is not supported by this adapter`, { retryable: false, code: "unsupported_mutation" });
    this.name = "UnsupportedMutationError";
  }
}

// ── base64url helpers (browser + node) ─────────────────────────────────────

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encodeAscii(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    out += B64_CHARS[a >> 2]!;
    out += B64_CHARS[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]!;
    out += Number.isNaN(b) ? "=" : B64_CHARS[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]!;
    out += Number.isNaN(c) ? "=" : B64_CHARS[c & 63]!;
  }
  return out;
}

function b64decodeAscii(s: string): string {
  if (typeof atob === "function") return atob(s);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) throw new Error("invalid base64");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** Encode a numeric seq as an opaque base64url cursor (server-shape parity). */
export function encodeSeqCursor(seq: number): Cursor {
  return b64encodeAscii(String(seq)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url seq cursor; returns null when malformed ("0" ⇒ 0). */
export function decodeSeqCursor(cursor: Cursor): number | null {
  if (cursor === "0" || cursor === "") return 0;
  try {
    const raw = b64decodeAscii(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}
