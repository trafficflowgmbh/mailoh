"use client";

/**
 * ═══ THE LAST TEN CENTIMETRES: A PRESS BECOMES A FILE ═════════════════════════════════════
 *
 * The engine holds every attachment's state and mints the Blob URL; `AttachmentStrip` draws
 * it. Neither of them puts a file on somebody's disk, and neither of them can: saving is a
 * DOM act, and the strip is a pure component that takes `onOpen` and asks no questions. This
 * module is that seam, and it exists as its own file for two reasons — `AppShell` is 1 900
 * lines and does not need four more callbacks in it, and every decision below is testable in
 * jsdom without mounting a shell.
 *
 * ── WHY `<a download>` AND NEVER `window.open` ────────────────────────────────────────────
 *
 * A `blob:` URL INHERITS THE APP'S ORIGIN. Navigating to one at top level therefore runs
 * whatever the document contains as `ohmail.app`, with the host-only session cookie in
 * scope — and an `image/svg+xml` attachment is a document that executes script. The route's
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` describe the
 * RESPONSE and do not survive into a Blob built from its body, so they do not help here.
 *
 * The engine already closes this at the point the Blob is minted (`RENDERABLE_MIME` — an SVG
 * comes back typed `application/octet-stream`). This is the second ring, and it is a
 * different mechanism rather than the same one twice: `download` makes the browser SAVE
 * whatever it is handed instead of rendering it, so the file never becomes a document in a
 * tab whatever its type says. Both rings are cheap; the attack this forecloses is a stranger
 * mailing you a file.
 *
 * ── WHY A SEPARATE SUBSCRIPTION AND NOT `useEngineVersion` ────────────────────────────────
 *
 * `useEngineVersion` reads `engine.read().version()`, which is `store.version()` composed
 * with the overlay revision. Attachment state is IN-MEMORY ONLY — the whole design is that
 * ohmail stores no attachment bytes, so nothing is written to the mirror and neither of those
 * two numbers moves. `notify()` fires, `useSyncExternalStore` compares the snapshot, finds it
 * identical and BAILS OUT: the strip would sit on `idle` for ever while the bytes arrived
 * behind it, and every test that drives the engine directly would still pass. That is this
 * slice's own failure mode, one layer up, so the subscription counts notifications rather
 * than reading a version that cannot change.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { AttachmentItem, AttachmentsView } from "../components/AttachmentStrip";

/**
 * What `MessagePane` needs to render one message's strip.
 *
 * Functions of `messageId` rather than resolved values, for the reason every other member of
 * {@link import("./message-chrome").MessageChrome} is: the pane is mounted TWICE while the
 * reader is open and the two mounts may hold different messages.
 */
export interface AttachmentsChrome {
  /**
   * THE LIST AND WHAT IS KNOWN ABOUT IT — the engine's outcome, not a flattened array.
   *
   * ## THE DEFECT, AND THE ONE LINE IT WAS
   *
   * This used to read `held.state === "ready" ? held.items : []`. `unavailable`, `loading` and
   * `failed` all became the same empty array, so a metadata read that FAILED drew exactly what
   * an inline-only message draws — nothing, under a paperclip painted from `hasAttachments`.
   * Two different sentences, one silence, and the failing one invisible.
   *
   * The engine had recorded the failure the whole time (`AttachmentsOutcome`, with the server's
   * `code` and `retryable`), and it already refuses to re-ask automatically so that a
   * React effect cannot loop against a server that refused. What was missing was here: the seam
   * threw the answer away. It no longer does, and {@link AttachmentsView} is the strip's own
   * type, so the wire `MessagePane` already passes carries the state without that file changing.
   */
  itemsOf(messageId: string): AttachmentsView;
  /** Fetch (if needed) and SAVE one attachment. The press is the whole intent. */
  open(messageId: string, attachmentId: string): void;
  /** Fetch the whole set as one server-assembled zip and save it. */
  downloadAll(messageId: string): void;
  downloadingAll(messageId: string): boolean;
}

/**
 * Hand a URL the app already holds to the browser as a download.
 *
 * `rel="noopener"` and an anchor that never enters the layout: this is a synthetic click, not
 * a link somebody can focus, and it is removed in the same tick.
 */
export function saveObjectUrl(url: string, filename: string, doc: Document): void {
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save a Blob the caller owns, minting and releasing its URL around the click.
 *
 * The revoke is DEFERRED rather than immediate. Chrome starts the download asynchronously
 * from the synthetic click, and revoking in the same task cancels a large one — the failure
 * is silent and size-dependent, which is the worst way to find it. A zip of somebody's
 * attachments is exactly the large case.
 */
export function saveBlob(blob: Blob, filename: string, doc: Document): void {
  const U = (globalThis as { URL?: typeof URL }).URL;
  if (typeof U?.createObjectURL !== "function") return;
  const url = U.createObjectURL(blob);
  saveObjectUrl(url, filename, doc);
  setTimeout(() => U.revokeObjectURL?.(url), 30_000);
}

/** One item out of the engine's per-message list, or `undefined`. */
function itemOf(engine: OhmailEngine, messageId: string, attachmentId: string): AttachmentItem | undefined {
  const held = engine.attachmentsOf(messageId);
  if (held.state !== "ready") return undefined;
  return held.items.find((i) => i.id === attachmentId);
}

/**
 * Re-render this component on every engine notification, version bump or not.
 *
 * See the header: attachment state moves without the mirror moving, so
 * `useEngineVersion` cannot see it. The counter is a ref because `getSnapshot` must return
 * the same value until something actually changes, and a `useState` setter inside a
 * subscription is one render behind.
 */
function useEngineNotice(engine: OhmailEngine): number {
  const ticks = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) =>
      engine.subscribe(() => {
        ticks.current += 1;
        onChange();
      }),
    [engine],
  );
  return useSyncExternalStore(subscribe, () => ticks.current, () => 0);
}

/**
 * Wire one selected message's attachments to the shell.
 *
 * Returns `undefined` when this client cannot open attachments at all — the demo (`?demo=1`
 * is fixtures and zero network) and any host whose adapter lacks the capability. `undefined`
 * is a REAL answer and the pane reads it as one: no strip, rather than a "Download all"
 * button over an archive nothing can build.
 *
 * ── THE CLEANUP IS NOT OPTIONAL ───────────────────────────────────────────────────────────
 *
 * `releaseAttachments` revokes every object URL held for the message. A `blob:` URL pins its
 * bytes until it is revoked or the document dies, so without this a session spent opening
 * PDFs in a long-lived tab accumulates every one of them — the exact cost "ohmail stores no
 * attachment bytes" exists to avoid, reintroduced in the browser instead of the database.
 */
export function useMessageAttachments(
  engine: OhmailEngine,
  messageId: string | null,
  opts: { onDownloadAllFailed: () => void },
): AttachmentsChrome | undefined {
  const available = engine.attachmentsAvailable();
  useEngineNotice(engine);
  const [downloadingAll, setDownloadingAll] = useState<string | null>(null);

  /**
   * The failure callback through a ref: `AppShell` supplies it inline (it closes over
   * `toast` and `t`), so a dependency on it would rebuild every callback below on every
   * render — and `open`/`downloadAll` are handed to a memoized context.
   */
  const onFailed = useRef(opts.onDownloadAllFailed);
  onFailed.current = opts.onDownloadAllFailed;

  useEffect(() => {
    if (!available || !messageId) return;
    // Metadata only: `cost: "read"`, one indexed row read, nothing reaches IMAP. The bytes
    // are a separate, deliberate act — never speculative, never per row (invariant #10).
    void engine.loadAttachments(messageId);
    return () => engine.releaseAttachments(messageId);
  }, [engine, messageId, available]);

  /**
   * The engine's outcome, carried across unchanged but for one addition: the failed variant
   * gets the callback that acts on it.
   *
   * `retry: true` is not optional decoration. `loadAttachments` returns the HELD failure for an
   * ordinary call — deliberately, so a React effect whose identity changes per render cannot
   * hammer a server that already refused — so a "Try again" that omitted the flag would redraw
   * the same failure without asking anybody, which is the same lie the failed TILE's own copy
   * was written to avoid.
   */
  const itemsOf = useCallback(
    (id: string): AttachmentsView => {
      const held = engine.attachmentsOf(id);
      switch (held.state) {
        case "unavailable":
          return { state: "unavailable" };
        case "loading":
          return held.retrying ? { state: "loading", retrying: true } : { state: "loading" };
        case "ready":
          return { state: "ready", items: held.items };
        case "failed":
          return {
            state: "failed",
            error: held.error,
            code: held.code,
            retryable: held.retryable,
            onRetry: () => void engine.loadAttachments(id, { retry: true }),
          };
        default: {
          /* Exhaustive: a state the engine grows must be given an answer here, never dropped
             into a catch-all — dropping states into one answer is the whole of AT6. */
          const unhandled: never = held;
          return unhandled;
        }
      }
    },
    [engine],
  );

  const open = useCallback(
    (id: string, attachmentId: string): void => {
      void (async () => {
        const before = itemOf(engine, id, attachmentId);
        // `too_large` is permanent — the strip renders it as a div rather than a button for
        // exactly this reason, and a programmatic call must agree with the pixels.
        if (!before || before.state === "too_large") return;

        if (before.state !== "ready" || !before.objectUrl) {
          // `retry` ONLY on a press over a failed tile. The engine deliberately refuses an
          // automatic re-ask (a React effect whose identity changes per render would loop
          // against a server that already refused, at `cost: "connection"` a time) — and the
          // failed tile's own words are "Couldn't fetch — try again", so a press that did
          // not re-ask would make that sentence a lie.
          await engine.openAttachment(id, attachmentId, before.state === "failed" ? { retry: true } : {});
        }

        const after = itemOf(engine, id, attachmentId);
        // Nothing to save on `failed` or `too_large`: the tile carries the server's own
        // sentence and a silent no-op here is what lets it be read.
        if (after?.state === "ready" && after.objectUrl) {
          saveObjectUrl(after.objectUrl, after.filename, document);
        }
      })();
    },
    [engine],
  );

  const downloadAll = useCallback(
    (id: string): void => {
      void (async () => {
        setDownloadingAll(id);
        try {
          const zip = await engine.downloadAllAttachments(id);
          if (!zip) {
            // The engine returns `null` rather than writing over the message's list — the
            // metadata is still good and blanking the strip would drop every object URL in
            // it. So the report belongs here, beside the button that was pressed.
            onFailed.current();
            return;
          }
          // The SERVER'S own name for this archive (`attachments-service.ts`
          // `downloadAll`), so the file on disk is the one the API says it sent. The zip may
          // legitimately be missing parts — the server skips what it cannot fetch and names
          // them in `_errors.txt` inside the archive — so a saved file is not a promise that
          // everything is in it.
          saveBlob(zip, `attachments-${id}.zip`, document);
        } finally {
          // Guarded: a second message's download may have started while this one was in
          // flight, and clearing unconditionally would take its spinner away.
          setDownloadingAll((cur) => (cur === id ? null : cur));
        }
      })();
    },
    [engine],
  );

  const downloadingAllOf = useCallback((id: string): boolean => downloadingAll === id, [downloadingAll]);

  /**
   * ONE OBJECT, not a fresh literal per render.
   *
   * `AppShell` puts this straight into the `chrome` memo, and a value that changed identity on
   * every render would defeat that memo entirely — every consumer of `MessageChromeContext`
   * re-rendering on every keystroke in the reply editor. It changes exactly when something a
   * consumer can see changes: the engine, or whether a zip is in flight.
   */
  const chrome = useMemo(
    (): AttachmentsChrome => ({ itemsOf, open, downloadAll, downloadingAll: downloadingAllOf }),
    [itemsOf, open, downloadAll, downloadingAllOf],
  );

  return available ? chrome : undefined;
}
