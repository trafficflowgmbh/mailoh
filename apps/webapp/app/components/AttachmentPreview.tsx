"use client";

/**
 * ═══ QUICK LOOK: A PRESS BECOMES A LOOK, NOT A DOWNLOAD ═══════════════════════════════════
 *
 * The macOS gesture, brought to the web client: press an attachment and it opens INSTANTLY
 * over the current view — no download required to look — dismissed with Space or Esc, moved
 * through with ←/→, a PDF paged with ↑/↓. The bytes are the same on-demand IMAP fetch the
 * strip already makes; the overlay opens at once and fills in when they land.
 *
 * ── THE ONE SECURITY RULE, STATED ONCE: ATTACHMENT BYTES NEVER BECOME A DOCUMENT ─────────
 *
 * An attachment is untrusted content from a stranger. Every other client bug in this space is
 * the same shape — hostile bytes handed to something that will EXECUTE them — so this surface
 * hands them to nothing that can. There is no `<iframe src=blob:>`, no `<embed>`, no
 * `<object>`, no navigation to a `blob:` URL (which would inherit this origin and run an SVG's
 * or a PDF's script as ohmail, with the host-only session cookie in scope). Only three inert
 * shapes ever render a byte:
 *
 *   · image  — an `<img>`. The browser decodes pixels; an `<img>` never runs SVG script, and
 *              the engine already refuses to type an SVG blob as an image anyway
 *              (`RENDERABLE_MIME`), so an SVG press is a DOWNLOAD, never a render.
 *   · pdf    — pdf.js (Apache-2.0). The CORE api used here (`getDocument` → `page.render`)
 *              never executes a PDF's embedded JavaScript: Acrobat scripting lives only in the
 *              separate viewer/`pdf.sandbox` layer, which is not loaded. It rasterises one page
 *              to a `<canvas>`; the PDF never becomes a live document, the canvas is pixels. The
 *              app CSP carries no `'unsafe-eval'`, so pdf.js's internal font-eval path cannot run
 *              either — it detects the block and falls back to the non-eval renderer.
 *   · text   — a React text node inside `<pre>`, escaped by construction, capped.
 *
 * Everything else — a docx, a zip, an SVG — shows a "download to open" card and never a
 * rendered byte. The app's own CSP is the belt under these braces: `object-src 'none'` and a
 * `frame-src 'self'` that does not match `blob:` mean the document-shaped branches above are
 * refused at the platform level even if this file ever grew one by mistake.
 *
 * ── NO NETWORK REACHES A SENDER ──────────────────────────────────────────────────────────
 *
 * The bytes come from the engine's retained Blob (`attachments.blobOf`), never a re-`fetch` of
 * the object URL — `connect-src 'self'` refuses a `blob:` fetch on the live host, and there is
 * nothing to fetch off-origin regardless. pdf.js is told to fetch nothing (`disableAutoFetch`,
 * `disableStream`, no cMap/font CDN); its worker is a same-origin static asset,
 * admitted by `worker-src 'self'`. Opening a preview makes ZERO requests to any host the
 * sender could name.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentItem } from "./AttachmentStrip";
import { useKeyBindings } from "../shell/keymap";
import "./attachment-preview.css";

/* ── what can be looked at, and what merely downloads ─────────────────────────────────── */

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type PreviewKind = "image" | "pdf" | "text" | "other";

/** The essence of a declared type, ignoring parameters (`text/plain; charset=utf-8`). */
export function previewKind(mimeType: string): PreviewKind {
  const m = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (IMAGE_MIME.has(m)) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/")) return "text";
  return "other";
}

/**
 * Can this app render the file inline, or is a press only ever a download?
 *
 * The set is exactly the engine's `RENDERABLE_MIME` (the four raster images plus PDF) widened
 * by `text/*`. SVG is deliberately NOT here — it is a document that executes script, and the
 * engine downgrades its blob to `application/octet-stream` for the same reason. `MessagePane`
 * reads this to decide whether a tile press opens this overlay or saves a file.
 */
export function isPreviewable(mimeType: string): boolean {
  return previewKind(mimeType) !== "other";
}

/* ── copy (shim with one exit, the pattern `AttachmentStrip` and `MessageBody` use) ────── */

const COPY = {
  ariaLabel: "Attachment preview",
  fetching: "Fetching from your mailbox…",
  rendering: "Preparing preview…",
  download: "Download",
  close: "Close",
  retry: "Try again",
  noPreviewTitle: "No preview",
  noPreviewDetail: "This kind of file can't be shown here — download it to open.",
  tooLargeTitle: "Too large to preview",
  tooLargeDetail: "This file is over the fetch limit for on-demand open.",
  failedTitle: "Couldn't fetch this file",
  pdfErrorTitle: "Couldn't render this PDF",
  pdfErrorDetail: "The file may be damaged. Download it to open in another app.",
  textTruncated: "— preview truncated. Download to read the rest.",
  count: (i: number, n: number) => `${i} of ${n}`,
  page: (p: number, n: number) => `${p} / ${n}`,
  prevAttachment: "Previous attachment",
  nextAttachment: "Next attachment",
  prevPage: "Previous page",
  nextPage: "Next page",
  hintClose: "Space or Esc to close",
  hintMove: "← → to move",
  hintPage: "↑ ↓ to page",
  kClose: "close preview",
  kPrev: "previous attachment",
  kNext: "next attachment",
  kPrevPage: "previous page",
  kNextPage: "next page",
} as const;

/** 1000-based, matching `AttachmentStrip.formatSize` so both surfaces name one size. */
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
  return `${bytes} B`;
}

/* ── pdf.js, loaded on demand and configured once ─────────────────────────────────────── */

type PdfjsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * The worker, served from `public/` at a SAME-ORIGIN path — admitted by `worker-src 'self'`.
 *
 * Not `new URL("…/pdf.worker.min.mjs", import.meta.url)`: that makes webpack pull the worker into
 * the module graph, where SWC parses the `.mjs` (which uses `import.meta`) as a non-module and the
 * build dies. And never a CDN — `worker-src`/`connect-src 'self'` refuse one, as they should. So
 * the worker is a static asset, vendored beside the app and kept in lockstep with `pdfjs-dist` by
 * `pdf-worker-version.test.ts`.
 */
const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

/**
 * Import pdf.js (≈1 MB) only when a PDF is actually looked at, and point its worker at the
 * same-origin asset.
 *
 * The worker is NOT optional. If pdf.js cannot load it, it silently falls back to a "fake
 * worker" that parses the hostile bytes on the app-origin MAIN thread — the one place they
 * should never run. So `workerSrc` is set here and verified non-empty before any `getDocument`;
 * a missing worker is treated as a render failure, not a quiet fallback.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import("pdfjs-dist");
      mod.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      return mod;
    })();
  }
  return pdfjsPromise;
}

/** The longest canvas edge, in CSS px, before a crafted `/MediaBox` demands a gigapixel raster. */
const MAX_CANVAS_EDGE = 4096;
/** The width a PDF page renders to before CSS scales it down to the panel. */
const PDF_TARGET_WIDTH = 900;
/** The text preview is capped for the same reason the mail renderer is (`MAX_HTML_CHARS`). */
const MAX_TEXT_CHARS = 512 * 1024;

/* ── the overlay ──────────────────────────────────────────────────────────────────────── */

export interface AttachmentPreviewProps {
  /** The message's non-inline attachments (the strip's ready list). Navigation walks these. */
  items: AttachmentItem[];
  /** Which attachment is on screen. */
  activeId: string;
  onActiveIdChange: (attachmentId: string) => void;
  /** Fetch bytes for one item without saving — brings `idle` to `ready`. */
  ensure: (attachmentId: string, opts?: { retry?: boolean }) => void;
  /** The engine's retained typed Blob for a ready item, or `undefined`. */
  blobOf: (attachmentId: string) => Blob | undefined;
  /** Save one item (fetch if needed) — the overlay's Download and the fallback card. */
  onDownload: (attachmentId: string) => void;
  onClose: () => void;
}

export function AttachmentPreview({
  items,
  activeId,
  onActiveIdChange,
  ensure,
  blobOf,
  onDownload,
  onClose,
}: AttachmentPreviewProps) {
  const index = Math.max(0, items.findIndex((i) => i.id === activeId));
  const active: AttachmentItem | undefined = items.find((i) => i.id === activeId) ?? items[0];
  const kind = active ? previewKind(active.mimeType) : "other";
  const canPreview = active ? isPreviewable(active.mimeType) : false;
  const hasMultiple = items.length > 1;

  /* ── attachment navigation (wraps, like Quick Look) ── */
  const goRel = useCallback(
    (delta: number) => {
      if (items.length < 2) return;
      const next = items[(index + delta + items.length) % items.length];
      if (next) onActiveIdChange(next.id);
    },
    [items, index, onActiveIdChange],
  );

  /* ── the fetch: previewable items only, never speculative ──
     Non-previewable items are not fetched here — their card downloads on demand — so a press
     onto a docx does not spend a `cost:"connection"` fetch for bytes nothing will render. */
  useEffect(() => {
    if (!active || !canPreview) return;
    if (active.state === "idle") ensure(active.id);
  }, [active, canPreview, ensure]);

  /* ── PDF document + page state, owned here so ↑/↓ and the page counter can see it ── */
  const [pdf, setPdf] = useState<{ id: string; doc: PdfDoc; numPages: number } | null>(null);
  const [page, setPage] = useState(1);
  const [pdfError, setPdfError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  // Load the document when a ready PDF becomes active. The ArrayBuffer is read FRESH here —
  // pdf.js transfers it to its worker and detaches it, so a cached buffer fails the second open.
  useEffect(() => {
    if (!active || kind !== "pdf" || active.state !== "ready") return;
    const blob = blobOf(active.id);
    if (!blob) return;
    const id = active.id;
    let cancelled = false;
    setPdfError(false);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (!pdfjs.GlobalWorkerOptions.workerSrc) throw new Error("pdf worker unavailable");
        const buf = await blob.arrayBuffer();
        // Core api only — no scripting layer, so no PDF JavaScript runs. `disableAutoFetch` +
        // `disableStream` keep it from issuing range requests; there is nothing to fetch here
        // anyway (the source is a Blob, and no cMap/font CDN is configured), so opening the
        // document reaches no network.
        const doc = (await pdfjs.getDocument({
          data: buf,
          disableAutoFetch: true,
          disableStream: true,
        }).promise) as unknown as PdfDoc;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdf({ id, doc, numPages: doc.numPages });
        setPage(1);
      } catch {
        if (!cancelled) setPdfError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `active.state` is what turns idle→ready; `active.id` is the navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.state, kind]);

  // Destroy a document when it is replaced or the overlay unmounts — the worker holds it open.
  useEffect(() => {
    return () => {
      if (pdf) void pdf.doc.destroy();
    };
  }, [pdf]);

  // Render the current page. A superseded render is cancelled first — pdf.js refuses two
  // renders on one canvas, and a fast ↑/↓ would otherwise throw.
  useEffect(() => {
    if (!pdf || pdf.id !== activeId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await pdf.doc.getPage(page);
        if (cancelled) return;
        const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
        const base = p.getViewport({ scale: 1 });
        let scale = Math.min(PDF_TARGET_WIDTH / base.width, 3);
        const longEdge = Math.max(base.width, base.height) * scale;
        if (longEdge > MAX_CANVAS_EDGE) scale *= MAX_CANVAS_EDGE / longEdge;
        const vp = p.getViewport({ scale });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        renderTaskRef.current?.cancel();
        const task = p.render({
          canvasContext: ctx,
          viewport: vp,
          ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}),
        }) as unknown as { promise: Promise<void>; cancel: () => void };
        renderTaskRef.current = task;
        await task.promise;
      } catch {
        /* a cancelled render rejects; nothing to do. A real parse failure surfaced at load. */
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, activeId, page]);

  const numPages = pdf && pdf.id === activeId ? pdf.numPages : 0;
  const isPdfMultiPage = numPages > 1;
  const goPage = useCallback(
    (delta: number) => setPage((p) => Math.min(numPages || 1, Math.max(1, p + delta))),
    [numPages],
  );

  /* ── text state ── */
  const [text, setText] = useState<{ id: string; body: string; truncated: boolean } | null>(null);
  useEffect(() => {
    if (!active || kind !== "text" || active.state !== "ready") return;
    const blob = blobOf(active.id);
    if (!blob) return;
    const id = active.id;
    let cancelled = false;
    (async () => {
      const full = await blob.text();
      if (cancelled) return;
      setText({ id, body: full.slice(0, MAX_TEXT_CHARS), truncated: full.length > MAX_TEXT_CHARS });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.state, kind]);

  /* ── keyboard, through the registry's `overlay` scope so it out-ranks the view beneath and
        cannot re-break Escape ownership (a raw window listener is what did, historically). ── */
  useKeyBindings(
    [
      { chord: "Escape", group: "app", label: COPY.kClose, inInput: true, run: () => onClose() },
      { chord: "ArrowLeft", group: "navigate", label: COPY.kPrev, disabled: !hasMultiple, run: () => goRel(-1) },
      { chord: "ArrowRight", group: "navigate", label: COPY.kNext, disabled: !hasMultiple, run: () => goRel(1) },
      { chord: "ArrowUp", group: "navigate", label: COPY.kPrevPage, disabled: !isPdfMultiPage, run: () => goPage(-1) },
      { chord: "ArrowDown", group: "navigate", label: COPY.kNextPage, disabled: !isPdfMultiPage, run: () => goPage(1) },
    ],
    "overlay",
  );

  /* ── focus trap: hold focus in the panel, restore it on close ── */
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    document.body.classList.add("ap-lock");
    return () => {
      document.body.classList.remove("ap-lock");
      previously?.focus?.();
    };
  }, []);

  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Space closes — but the registry uses space as its sequence separator, so the spacebar has
    // no chord spelling and is handled here instead, scoped to the panel (never window). Only
    // when the panel itself holds focus: on a button, Space belongs to the button.
    if ((e.key === " " || e.key === "Spacebar") && e.target === e.currentTarget) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const activeEl = document.activeElement;
    if (e.shiftKey && (activeEl === first || activeEl === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const stem = active?.filename ?? "";
  const typeLabel = useMemo(
    () => (active ? active.mimeType.split(";")[0]?.trim() ?? "" : ""),
    [active],
  );
  const canDownload = active != null && active.state !== "too_large";

  return (
    <div
      className="ap-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ap-panel"
        role="dialog"
        aria-modal="true"
        aria-label={COPY.ariaLabel}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onPanelKeyDown}
      >
        <header className="ap-head">
          <div className="ap-id">
            <span className="ap-name" title={stem}>{stem}</span>
            <span className="ap-meta num">
              {typeLabel}
              {active ? ` · ${formatSize(active.sizeBytes)}` : ""}
              {kind === "pdf" && numPages > 0 ? ` · ${COPY.page(page, numPages)}` : ""}
              {hasMultiple ? ` · ${COPY.count(index + 1, items.length)}` : ""}
            </span>
          </div>
          <div className="ap-tools">
            {kind === "pdf" && isPdfMultiPage ? (
              <span className="ap-pager" role="group" aria-label="Pages">
                <button type="button" className="ap-iconbtn" aria-label={COPY.prevPage}
                  aria-disabled={page <= 1 || undefined} onClick={() => goPage(-1)}>{ARROW_UP}</button>
                <button type="button" className="ap-iconbtn" aria-label={COPY.nextPage}
                  aria-disabled={page >= numPages || undefined} onClick={() => goPage(1)}>{ARROW_DOWN}</button>
              </span>
            ) : null}
            {canDownload ? (
              <button type="button" className="ap-btn" onClick={() => active && onDownload(active.id)}>
                {DOWNLOAD_GLYPH}
                {COPY.download}
              </button>
            ) : null}
            <button type="button" className="ap-iconbtn ap-close" aria-label={COPY.close} onClick={onClose}>
              {CLOSE_GLYPH}
            </button>
          </div>
        </header>

        <div className="ap-stage">
          {hasMultiple ? (
            <button type="button" className="ap-nav ap-prev" aria-label={COPY.prevAttachment}
              onClick={() => goRel(-1)}>{CHEVRON_LEFT}</button>
          ) : null}

          <div className="ap-content">
            {renderContent({ active, kind, canPreview, pdf, pdfError, activeId, canvasRef, text, ensure, onDownload })}
          </div>

          {hasMultiple ? (
            <button type="button" className="ap-nav ap-next" aria-label={COPY.nextAttachment}
              onClick={() => goRel(1)}>{CHEVRON_RIGHT}</button>
          ) : null}
        </div>

        <footer className="ap-foot">
          <span>{COPY.hintClose}</span>
          {hasMultiple ? <span>{COPY.hintMove}</span> : null}
          {isPdfMultiPage ? <span>{COPY.hintPage}</span> : null}
        </footer>
      </div>
    </div>
  );
}

/* ── the content area, one function so every state is exhausted in one place ───────────── */

function renderContent({
  active,
  kind,
  canPreview,
  pdf,
  pdfError,
  activeId,
  canvasRef,
  text,
  ensure,
  onDownload,
}: {
  active: AttachmentItem | undefined;
  kind: PreviewKind;
  canPreview: boolean;
  pdf: { id: string; numPages: number } | null;
  pdfError: boolean;
  activeId: string;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  text: { id: string; body: string; truncated: boolean } | null;
  ensure: (attachmentId: string, opts?: { retry?: boolean }) => void;
  onDownload: (attachmentId: string) => void;
}) {
  if (!active) return null;

  if (!canPreview) {
    return (
      <Card title={COPY.noPreviewTitle} detail={COPY.noPreviewDetail}
        action={{ label: COPY.download, onClick: () => onDownload(active.id) }} />
    );
  }
  if (active.state === "too_large") {
    return <Card title={COPY.tooLargeTitle} detail={COPY.tooLargeDetail} />;
  }
  if (active.state === "failed") {
    return (
      <Card title={COPY.failedTitle} detail={active.error}
        action={{ label: COPY.retry, onClick: () => ensure(active.id, { retry: true }) }} />
    );
  }
  if (active.state === "idle" || active.state === "loading") {
    return <Busy label={COPY.fetching} />;
  }

  // ready
  if (kind === "image") {
    return active.objectUrl
      ? <img className="ap-img" src={active.objectUrl} alt={active.filename} />
      : <Busy label={COPY.rendering} />;
  }
  if (kind === "pdf") {
    if (pdfError) {
      return (
        <Card title={COPY.pdfErrorTitle} detail={COPY.pdfErrorDetail}
          action={{ label: COPY.download, onClick: () => onDownload(active.id) }} />
      );
    }
    if (!pdf || pdf.id !== activeId) return <Busy label={COPY.rendering} />;
    return (
      <div className="ap-pdf">
        <canvas className="ap-canvas" ref={canvasRef} />
      </div>
    );
  }
  if (kind === "text") {
    if (!text || text.id !== activeId) return <Busy label={COPY.rendering} />;
    return (
      <pre className="ap-text">
        {text.body}
        {text.truncated ? `\n\n${COPY.textTruncated}` : ""}
      </pre>
    );
  }
  return null;
}

/* ── small building blocks ────────────────────────────────────────────────────────────── */

function Busy({ label }: { label: string }) {
  return (
    <div className="ap-busy" role="status">
      <span className="ap-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function Card({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="ap-card" role="status">
      <span className="ap-card-glyph" aria-hidden="true">{FILE_GLYPH}</span>
      <b>{title}</b>
      {detail ? <span className="ap-card-detail">{detail}</span> : null}
      {action ? (
        <button type="button" className="ap-btn ap-card-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/* ── glyphs, in the icon set's stroke grammar (16-grid, ~1.4 stroke) ──────────────────── */

const CLOSE_GLYPH = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic"><path d="m4 4 8 8M12 4l-8 8" /></svg>
);
const DOWNLOAD_GLYPH = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic"><path d="M8 2.6v7M5.4 7 8 9.6 10.6 7M3.4 12.8h9.2" /></svg>
);
const CHEVRON_LEFT = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic"><path d="m10 3.5-4.5 4.5 4.5 4.5" /></svg>
);
const CHEVRON_RIGHT = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic"><path d="m6 3.5 4.5 4.5-4.5 4.5" /></svg>
);
const ARROW_UP = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" /></svg>
);
const ARROW_DOWN = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic"><path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" /></svg>
);
const FILE_GLYPH = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="ap-ic ap-ic-lg">
    <path d="M4.3 2.2h4.5l3 3v8.6H4.3z" /><path d="M8.8 2.2v3h3" />
  </svg>
);

/* ── the minimal slice of pdf.js this file touches, typed so the rest can stay `unknown` ── */

interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
    transform?: number[];
  }): { promise: Promise<void>; cancel: () => void };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
