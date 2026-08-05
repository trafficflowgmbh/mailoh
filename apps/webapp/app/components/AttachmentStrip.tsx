"use client";

/**
 * ═══ THE ATTACHMENT STRIP ══════════════════════════════════════════════════════════════
 *
 * What a mail client owes a message that carries files: show them, and when there is more
 * than one, offer to take them all at once — the neat rounded rectangle Apple Mail puts them
 * in.
 *
 * That rectangle is taken as INTENT — a tangible object you can act on — and translated into
 * Blanc's own physics, where presence is encoded by light falloff:
 *
 *   · idle       — a flat impression in the surface (`--tint`, no shadow). The bytes are
 *                  NOT here; they are in the user's mailbox, and the tile says so in
 *                  words. A thing that has not been fetched must not stand like one that
 *                  has.
 *   · loading    — the impression breathes between the two neutral tints (the exact
 *                  `send-working` vocabulary) under a sentence that names the wait:
 *                  "Fetching from your mailbox…". On-demand IMAP fetch is the product
 *                  telling the truth about where mail lives, so the wait is shown, named,
 *                  and never dressed as an anonymous spinner.
 *   · ready      — the object RISES onto the panel (`--panel` + `--lift-0`, the small
 *                  `rise` entrance): fetched means standing on the surface, and hover
 *                  lifts it further like every other Blanc object. Images show their own
 *                  pixels in the leaf — the bytes come from the user's mailbox, which is
 *                  the one source consent-first allows.
 *   · failed     — the accent-soft ground with a hairline, exactly the `send-status.warn`
 *                  register: a condition inviting one action (the tile is the retry).
 *   · too_large  — honest and inert: not a button, no hover, the size and the fact.
 *                  Dressing it as openable would be a lie the first press exposes.
 *
 * NOTHING HERE TOUCHES THE NETWORK. `objectUrl` is accepted only when it is `blob:` or
 * `data:` — bytes the app already holds from the user's own mailbox. A remote URL in that
 * field renders the type glyph instead, so a tracker can never ride in through this prop
 * (the same posture `no-third-party.test.ts` holds the rest of the app to).
 *
 * COPY LIVES HERE RATHER THAN IN THE TRANSLATION CATALOGUE — for now, and with one exit.
 * These sentences have no keys in `messages/en.json` yet, so they are declared in `COPY`
 * below under the `attachments` namespace they will take there; adding the keys and swapping
 * for `useTranslations("attachments")` is then a one-line change with exactly one place to
 * make it. Same shim-with-one-exit pattern as `ActionBar`'s `copy()`.
 */
import type { ReactNode } from "react";
import "./attachment-strip.css";

export interface AttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  state: "idle" | "loading" | "ready" | "failed" | "too_large";
  /** Present only when state === "ready". Must be `blob:`/`data:` to be shown. */
  objectUrl?: string;
  /** Present only when state === "failed". */
  error?: string;
}

/**
 * ═══ THE LIST HAS A STATE OF ITS OWN, AND SILENCE IS ONLY ONE OF ITS ANSWERS ══════════════
 *
 * Before this the strip took `AttachmentItem[]` and the shell flattened everything that was
 * not `ready` to `[]`. So a metadata read that FAILED drew exactly what an inline-only message
 * draws: nothing, under a paperclip. Two different sentences rendered as one silence — and the
 * silent-but-fine case is the COMMON one, not the edge: the paperclip is set from the presence
 * of any non-inline part, so a large share of the messages that carry one hold nothing a reader
 * could download.
 *
 * ── WHY THIS IS THE `items` PROP AND NOT A NEW ONE ────────────────────────────────────────
 *
 * `MessagePane` is the only consumer and it passes `items={attachments.itemsOf(message.id)}`.
 * A NEW prop would have to be added there to ever render — and this repo has shipped
 * "built, tested, unreachable" seven times, most recently a strip whose update signal could not
 * see its own state. Widening the type of the wire that ALREADY runs makes the fix reachable
 * without editing that file, and makes the reverse unbuildable: flatten `itemsOf` back to an
 * array and `next build` fails in `MessagePane.tsx`, a file the reverting change never touched.
 *
 * ── WHAT EACH STATE DRAWS, AND WHY ────────────────────────────────────────────────────────
 *
 *   · unavailable    — nothing. No server to ask (demo/desktop); the shell normally withholds
 *                      the whole chrome, and this arm is the render-time race with that check.
 *   · loading        — nothing. The read is ONE INDEXED ROW and never touches IMAP; a skeleton
 *                      on every message open would be noise on a wait nobody sees.
 *   · loading+retry  — the failure row, still standing, saying it is asking again. Going silent
 *                      the instant somebody presses "Try again" would read as success.
 *   · ready, empty   — nothing. "No files on this message" is TRUE and ORDINARY, and a message
 *                      whose only parts are a signature logo must not grow a notice about it.
 *   · ready, items   — the strip.
 *   · failed         — one sentence, and a retry ONLY when retrying could work.
 */
export type AttachmentsView =
  | { state: "unavailable" }
  | { state: "loading"; retrying?: boolean }
  | { state: "ready"; items: AttachmentItem[] }
  | {
      state: "failed";
      /** The server's own sentence. Shown as the row's `title`, never as the row's copy. */
      error: string;
      /** The server's own code, or `null` when nothing classified it. */
      code: string | null;
      retryable: boolean;
      onRetry: () => void;
    };

export interface AttachmentStripProps {
  /**
   * The LIST, not a list of items — see {@link AttachmentsView}. Named `items` because
   * `MessagePane` already passes it under that name and that file is the reachability
   * argument; a rename there and here is owed to whoever next owns the pane.
   */
  items: AttachmentsView;
  onOpen(id: string): void;
  onDownloadAll(): void;
  downloadingAll: boolean;
}

/** Reported for `messages/en.json` under the `attachments` namespace — see the header. */
const COPY = {
  /** en.json: "{count, plural, one {# attachment} other {# attachments}}" */
  count: (n: number) => `${n} ${n === 1 ? "attachment" : "attachments"}`,
  groupAria: "Attachments",
  downloadAll: "Download all",
  downloadingAll: "Fetching…",
  /** en.json: "{size} · in your mailbox" — the true thing: not fetched yet. */
  idle: (size: string) => `${size} · in your mailbox`,
  loading: "Fetching from your mailbox…",
  failed: "Couldn't fetch — try again",
  /** en.json: "{size} · too large to fetch" */
  tooLarge: (size: string) => `${size} · too large to fetch`,

  /* ── the LIST's own sentences ─────────────────────────────────────────────────────────
   *
   * NONE OF THESE MAY SAY "MAILBOX", and that is a fact about the route rather than a
   * preference. `GET /messages/:id/attachments` is `cost: "read"` and
   * `AttachmentsService.listForMessage` opens no IMAP adapter — the list comes from ohmail's
   * own indexed rows, synced at ingest. The per-ITEM copy above says "your mailbox" because
   * the BYTES really are fetched from IMAP on demand; borrowing that phrasing here would
   * blame the user's mail server for ohmail failing to answer. For the same reason there is
   * no "the mailbox is busy" line: `mailbox_busy` is thrown inside `makeOpenAdapter` and only
   * the two `cost: "connection"` byte routes go through it.
   */
  /** en.json: the general case — a 5xx from ohmail, or a throw nothing classified. */
  listFailed: "Couldn't load this message's files.",
  /** en.json: `code: "network"` — the fetch itself never got an answer. */
  listOffline: "Couldn't reach ohmail — check your connection.",
  /**
   * en.json: `code: "timeout"` — the request went out, was accepted, and nothing came back
   * inside `ATTACHMENT_LIST_TIMEOUT_MS`. A THIRD sentence rather than a reuse of either
   * neighbour, because it is a third situation and the user's next move differs: `listOffline`
   * tells somebody to check a connection that in this case is demonstrably working, and
   * `listFailed` implies ohmail gave an answer. Neither is true here, and the client aborted the
   * request as it said this, so the sentence is not describing something still running.
   */
  listTimeout: "ohmail didn't answer in time.",
  listRetry: "Try again",
  listRetrying: "Looking again…",
} as const;

/** 1000-based, like the Finder the file is about to land in. One decimal below 100,
    never a trailing ".0" — "2.3 MB", "18.2 MB", "748 KB". */
function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes / 1000;
  for (const unit of ["KB", "MB", "GB"]) {
    if (value < 1000 || unit === "GB") {
      const text = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
      return `${text} ${unit}`;
    }
    value /= 1000;
  }
  /* unreachable — the GB arm above always returns */
  return `${bytes} B`;
}

/**
 * The stem may ellipsize; the extension may not. A truncated "Q3-financial-repor…" with
 * no ".pdf" hides the one part of a long filename that says what the object IS.
 */
function splitName(filename: string): [stem: string, ext: string] {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || filename.length - dot > 6) return [filename, ""];
  return [filename.slice(0, dot), filename.slice(dot)];
}

type Kind = "image" | "doc" | "other";

function kindOf(mimeType: string): Kind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "doc";
  return "other";
}

/** Consent gate on the preview: only bytes the app already holds, never a remote URL. */
function isLocalUrl(url: string): boolean {
  return url.startsWith("blob:") || url.startsWith("data:");
}

/* ── glyphs — local, in the icon set's own stroke grammar (16-grid, 1.3 stroke) ─────── */

const GLYPH_STYLE = { width: 17, height: 17 } as const;

const GLYPH: Record<Kind, ReactNode> = {
  image: (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={GLYPH_STYLE}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <circle cx="5.9" cy="6.7" r="1" />
      <path d="m3.6 11.4 2.7-2.9 2.1 2.2 1.5-1.6 2.5 2.6" />
    </svg>
  ),
  doc: (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={GLYPH_STYLE}>
      <path d="M4.3 2.2h4.5l3 3v8.6H4.3z" />
      <path d="M8.8 2.2v3h3" />
      <path d="M6.2 9h3.6M6.2 11h3.6" />
    </svg>
  ),
  other: (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={GLYPH_STYLE}>
      <path d="M4.3 2.2h4.5l3 3v8.6H4.3z" />
      <path d="M8.8 2.2v3h3" />
    </svg>
  ),
};

const GLYPH_TRAY = (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={{ width: 13, height: 13 }}>
    <path d="M8 2.8v7M5.4 7.2 8 9.8l2.6-2.6M3.4 12.8h9.2" />
  </svg>
);

/* ── the leaf: what kind of object this is, at a glance ─────────────────────────────── */

function Leaf({ item }: { item: AttachmentItem }) {
  const kind = kindOf(item.mimeType);
  const showThumb =
    item.state === "ready" && kind === "image" && item.objectUrl != null && isLocalUrl(item.objectUrl);
  if (showThumb) {
    /* alt="" — the filename beside it is the name; the thumbnail is chrome. */
    return (
      <span className="att-leaf" aria-hidden="true">
        <img className="att-thumb" src={item.objectUrl} alt="" />
      </span>
    );
  }
  /* An unknown binary shows its extension rather than a dressed-up icon — honest about
     being "a file", specific about which kind, in the keycap's own monospace. */
  const [, ext] = splitName(item.filename);
  const badge = kind === "other" && ext.length > 1 ? ext.slice(1).toUpperCase() : null;
  return (
    <span className="att-leaf" aria-hidden="true">
      {badge ? <span className="att-badge">{badge}</span> : GLYPH[kind]}
    </span>
  );
}

/* ── one attachment ─────────────────────────────────────────────────────────────────── */

function Tile({ item, onOpen }: { item: AttachmentItem; onOpen: (id: string) => void }) {
  const size = formatSize(item.sizeBytes);
  const [stem, ext] = splitName(item.filename);

  const stateLine: ReactNode =
    item.state === "loading" ? (
      <>
        <span className="att-spin" aria-hidden="true" />
        {COPY.loading}
      </>
    ) : item.state === "failed" ? (
      COPY.failed
    ) : item.state === "too_large" ? (
      COPY.tooLarge(size)
    ) : item.state === "ready" ? (
      size
    ) : (
      COPY.idle(size)
    );

  const body = (
    <>
      <Leaf item={item} />
      <span className="att-text">
        <span className="att-name">
          <span className="att-stem">{stem}</span>
          {ext ? <span className="att-ext">{ext}</span> : null}
        </span>
        {/* `role="status"` — the transition loading → ready/failed is spoken, the same
            way `ReadingPane`'s bodyNote is. Sizes are tabular so a strip of tiles keeps
            one vertical rhythm. */}
        <span className="att-state num" role="status">
          {stateLine}
        </span>
      </span>
    </>
  );

  if (item.state === "too_large") {
    /* Not a button, deliberately: there is nothing pressing it could truthfully do. */
    return (
      <div className="att-tile" data-state="too_large">
        {body}
      </div>
    );
  }

  /* One element across idle → loading → ready/failed, so focus survives the fetch it
     started. While loading the press is inert (guarded, not `disabled` — `disabled`
     would drop that focus mid-wait). */
  const loading = item.state === "loading";
  return (
    <button
      type="button"
      className="att-tile"
      data-state={item.state}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      title={item.state === "failed" ? item.error : undefined}
      onClick={loading ? undefined : () => onOpen(item.id)}
    >
      {body}
    </button>
  );
}

/* ── the list's own state: one sentence, and at most one action ──────────────────────── */

/**
 * The row that stands in for a strip nobody could build.
 *
 * ONE ACTION AT MOST, and only an honest one. A "Try again" over a 404 or a dead session is a
 * button whose first press proves it was a lie — the same argument that makes the `too_large`
 * TILE a `div` rather than a button. `onRetry` absent therefore means the sentence stands alone.
 *
 * Not a spinner: while the re-ask is in flight the row says what it is doing, in the strip's own
 * grammar (the tile's wait names its source too). The sweep beside it is `.mbx-wait`'s move —
 * it says "running" without asking to be watched, and the SENTENCE carries the meaning, which
 * is what keeps it legible with `prefers-reduced-motion` killing the animation.
 */
function ListState({ sentence, title, working, onRetry }: {
  sentence: string;
  title?: string;
  working: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="att-strip" role="group" aria-label={COPY.groupAria}>
      <div className="att-list" data-state={working ? "retrying" : "failed"} title={title}>
        {/* Spoken like the tile's own state line — the transition failed → retrying → strip is
            a change a screen reader user is entitled to hear without going looking. */}
        <span className="att-list-say" role="status">
          {working ? <span className="att-spin" aria-hidden="true" /> : null}
          {sentence}
        </span>
        {working || onRetry ? (
          /* Guarded rather than `disabled` while working: `disabled` drops focus mid-wait, and
             this is the element the user just pressed. */
          <button
            type="button"
            className="att-list-retry"
            aria-disabled={working || undefined}
            onClick={working ? undefined : onRetry}
          >
            {COPY.listRetry}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ── the strip ──────────────────────────────────────────────────────────────────────── */

export function AttachmentStrip({ items, onOpen, onDownloadAll, downloadingAll }: AttachmentStripProps) {
  switch (items.state) {
    case "unavailable":
      return null;
    case "loading":
      /* Silent on the first ask; still standing on a re-ask. See {@link AttachmentsView}. */
      return items.retrying ? <ListState sentence={COPY.listRetrying} working /> : null;
    case "failed":
      return (
        <ListState
          /* Most specific first. `timeout` and `network` are both "no answer", and only the ORDER
             keeps them apart: a timeout that fell through to `listOffline` would tell somebody to
             check a connection that just carried the request out successfully. */
          sentence={
            items.code === "timeout"
              ? COPY.listTimeout
              : items.code === "network"
                ? COPY.listOffline
                : COPY.listFailed
          }
          title={items.error || undefined}
          working={false}
          onRetry={items.retryable ? items.onRetry : undefined}
        />
      );
    case "ready":
      return items.items.length === 0
        ? null
        : <ReadyStrip items={items.items} onOpen={onOpen} onDownloadAll={onDownloadAll} downloadingAll={downloadingAll} />;
    default: {
      /* EXHAUSTIVE BY CONSTRUCTION. A `default` returning null would be the flattening defect
         rebuilt one branch over: a new list state would render as silence and nobody would
         find out. Assigning to `never` makes an unhandled state a compile error instead. */
      const unhandled: never = items;
      return unhandled;
    }
  }
}

function ReadyStrip({ items, onOpen, onDownloadAll, downloadingAll }: {
  items: AttachmentItem[];
  onOpen: (id: string) => void;
  onDownloadAll: () => void;
  downloadingAll: boolean;
}) {
  const total = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  return (
    <div className="att-strip" role="group" aria-label={COPY.groupAria}>
      {items.length > 1 ? (
        /* Plural is a different situation, not the same control with a bigger number:
           the group gains a summary line and one group verb. A single attachment gets
           neither — one object needs no inventory. */
        <div className="att-head">
          <span className="att-sum num">
            {COPY.count(items.length)} · {formatSize(total)}
          </span>
          <button
            type="button"
            className="att-all"
            data-working={downloadingAll || undefined}
            aria-disabled={downloadingAll || undefined}
            onClick={downloadingAll ? undefined : onDownloadAll}
          >
            {downloadingAll ? (
              <>
                <span className="att-spin" aria-hidden="true" />
                {COPY.downloadingAll}
              </>
            ) : (
              <>
                {GLYPH_TRAY}
                {COPY.downloadAll}
              </>
            )}
          </button>
        </div>
      ) : null}
      <div className="att-grid">
        {items.map((item) => (
          <Tile key={item.id} item={item} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
