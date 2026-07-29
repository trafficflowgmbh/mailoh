/**
 * @mailoh/client-engine — wire vocabulary.
 *
 * These shapes MIRROR the backend contract (docs/superpowers/api-contract.md §1–§5
 * and packages/services/src/dto/types.ts) without importing any backend package:
 * the engine consumes the wire contract only, exactly as the native SwiftData
 * mirror will. Clients must tolerate unknown fields and unknown entity types
 * (contract §8 forward-compatible parsing) — hence the open unions below.
 */

export type ISODateTime = string;
export type Cursor = string;

export interface EmailAddress {
  name: string | null;
  address: string;
}

/** Real IMAP folders — identical to core `Destination` (contract §1.2). */
export type Folder =
  | "INBOX"
  | "TrafficFlow/Screener"
  | "TrafficFlow/Feed"
  | "TrafficFlow/Paper Trail"
  | "TrafficFlow/Screened"
  | "TrafficFlow/Quarantine";

export type ChangeOp = "create" | "update" | "move" | "delete";

/** The EntityType values the server's `/sync` feed carries today (contract §3.1 P1). */
export type SyncEntityType =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder";

/**
 * Everything the LOCAL mirror stores. Beyond the synced types, the engine keeps
 * client-local entities for the demo/fixture world (`tag`, `screener_sender`,
 * `triage_item`, `mailbox`) and view metadata (`view_meta`, e.g. the Reads
 * waterline). Unknown strings are tolerated by design.
 */
export type MirrorEntityType =
  | SyncEntityType
  | "tag" | "screener_sender" | "triage_item" | "mailbox" | "view_meta"
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

export interface TagDTO {
  id: string;
  name: string;
  hue: string;
  className: string;
}

export type ScreenerSegment = "waiting" | "screened_out" | "spam";

export interface ScreenerHeldMail {
  subject: string;
  time: string;
  body: string;
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
  ai: { dest: MailohView | "screened" | "spam"; confidence: number; rationale: string } | null;
  held: ScreenerHeldMail[];
  /** screened_out only */
  screenedOn?: string;
  heldCount?: number;
  lastSubject?: string;
  lastBody?: string;
  /** spam only */
  detection?: { source: string; confidence: number; reason: string; label: string };
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
export type MailohView = "ohbox" | "reads" | "receipts" | "screener" | "screened" | "spam";

export const FOLDER_OF_VIEW: Record<MailohView, Folder> = {
  ohbox: "INBOX",
  reads: "TrafficFlow/Feed",
  receipts: "TrafficFlow/Paper Trail",
  screener: "TrafficFlow/Screener",
  screened: "TrafficFlow/Screened",
  spam: "TrafficFlow/Quarantine",
};

export const VIEW_OF_FOLDER: Record<Folder, MailohView> = {
  "INBOX": "ohbox",
  "TrafficFlow/Feed": "reads",
  "TrafficFlow/Paper Trail": "receipts",
  "TrafficFlow/Screener": "screener",
  "TrafficFlow/Screened": "screened",
  "TrafficFlow/Quarantine": "spam",
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
      dest?: MailohView;
      /** "&read" seen-semantics: a Yes files the held mail already-seen (unread=false). */
      read?: boolean;
      scope?: "sender" | "domain";
    }
  | {
      kind: "tag_assign";
      messageId: string;
      tagId: string;
      assigned: boolean;
      /** Filled by the engine at mutate() time: the full next labels array (wire PATCH body). */
      labels?: string[];
    }
  | {
      kind: "feed_mark_seen";
      /** Waterline anchor; defaults to the newest Reads message. */
      upToId?: string;
      /** Filled by the engine at mutate() time: the unread Reads ids to flip. */
      messageIds?: string[];
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
