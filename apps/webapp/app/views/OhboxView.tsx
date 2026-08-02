"use client";

/**
 * Ohbox — the two-pane accepted-mail view: grouped list (New / Earlier)
 * against the engine's ohboxView selector, the Screener
 * doorbell, and the reading column. j/k moves, ↵ opens the reader,
 * t opens the tag picker, x picks, u toggles unread.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import {
  Doorbell,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
} from "@ohmail/ui";
import { displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useEngineVersion, useReader, useSyncStatus } from "../shell/engine";
import { MessagePane, type MessageAction } from "../shell/MessagePane";

/**
 * How long a split-pane selection must survive before it counts as read.
 *
 * Two seconds is long enough that no j/k sweep reaches it (a sweep is tens of milliseconds per
 * row) and short enough that someone who stopped to read the pane has, by any reasonable
 * account, read it. It is a constant and not a setting: a knob here would be a knob about
 * whether the product tells the truth.
 */
const DWELL_MS = 2000;

export function OhboxView({
  demo,
  newForYou,
  previouslySeen,
  tags,
  now,
  selectedId,
  onSelect,
  onEnterReader,
  onMarkSeen,
  doorbellInitials,
  doorbellCount,
  onDoorbell,
  onAction,
  onAddTag,
  onAttachment,
  typingGuard,
}: {
  /** Fixture world or a real mailbox — decides the "older mail" tail. See its use below. */
  demo: boolean;
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  tags: TagDTO[];
  now: Date;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEnterReader: () => void;
  /** The shell's `mark_seen` mutation — the one read-state writer (slice U1). */
  onMarkSeen: (ids: string[], unread: boolean) => void;
  doorbellInitials: string[];
  doorbellCount: number;
  onDoorbell: () => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  onAttachment: () => void;
  typingGuard: (e: KeyboardEvent) => boolean;
}) {
  const t = useTranslations("ohbox");

  const all = useMemo(
    () => [...newForYou, ...previouslySeen],
    [newForYou, previouslySeen],
  );
  const selected = all.find((m) => m.id === selectedId) ?? all[0] ?? null;

  /* ── multi-select: VIEW-LOCAL, deliberately ──────────────────────────────
     It is a selection, not a document: it means nothing after you leave the
     Ohbox, and persisting it would resurrect a stale set on the next visit.
     `anchor` is the range origin for shift-click, kept in a ref so changing it
     never costs a render. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const clearPicked = useCallback(() => {
    if (picked.size > 0) setPicked(new Set());
    anchor.current = null;
  }, [picked.size]);

  const togglePick = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  }, []);

  /** Shift-click: add the inclusive range from the anchor to `id`, in list order. */
  const pickRangeTo = useCallback((id: string) => {
    const order = all.map((m) => m.id);
    const from = anchor.current ? order.indexOf(anchor.current) : -1;
    const to = order.indexOf(id);
    if (from < 0 || to < 0) {
      togglePick(id);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setPicked((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(order[i]!);
      return next;
    });
  }, [all, togglePick]);

  // Ids that vanished from the list (moved, filed, deleted) leave with it — a count that
  // outlives its rows is a count that acts on nothing.
  useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(all.map((m) => m.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [all]);

  /* ── read-state ────────────────────────────────────────────────────────── */

  /** Opening a message IS reading it — Enter, click-into-reader, mobile tap. */
  const open = useCallback((m: EngineMessage) => {
    if (m.unread) onMarkSeen([m.id], false);
    onEnterReader();
  }, [onMarkSeen, onEnterReader]);

  /**
   * THE 2 s DWELL, and why j/k alone must commit nothing.
   *
   * In the split pane the reading column already shows whatever the cursor is on, so a strict
   * "only an explicit open counts" rule would leave a message the user has plainly read sitting
   * bold. But `jjjjj` down a list is navigation, not reading, and marking every row it passes
   * would empty the Ohbox by accident — the one destructive-feeling thing a keyboard sweep can
   * do. A dwell separates the two: the timer is armed on selection and CANCELLED by the cleanup
   * on every change, so a sweep of ten rows arms and cancels ten times and commits nothing,
   * while stopping on one for two seconds commits that one.
   *
   * Split pane only. On mobile there is no reading column beside the list, so a selection shows
   * nothing and dwelling on it means nothing; there, only `open` counts.
   */
  useEffect(() => {
    if (!selected || !selected.unread) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(max-width: 900px)").matches) return;
    const timer = window.setTimeout(() => onMarkSeen([selected.id], false), DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [selected, onMarkSeen]);

  // j/k selection + ↵ reader + t tag picker + x pick + u unread (this view only —
  // it unmounts with the route, so the binding scopes itself). ONE listener: a second
  // global in AppShell would fire in every view and fight this one for the same keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const order = all.map((m) => m.id);
      const i = selected ? order.indexOf(selected.id) : -1;
      if (e.key === "j" && i < order.length - 1) onSelect(order[i + 1]!);
      else if (e.key === "k" && i > 0) onSelect(order[i - 1]!);
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
        if (selected) open(selected);
        else onEnterReader();
      } else if (e.key === "t" && selected) {
        e.preventDefault();
        const row = document.querySelector<HTMLElement>(
          `.view-ohbox .row[data-id="${CSS.escape(selected.id)}"]`,
        );
        onAddTag(selected.id, row);
      } else if (e.key === "x" && selected) {
        e.preventDefault();
        togglePick(selected.id);
      } else if (e.key === "u" && selected) {
        e.preventDefault();
        onMarkSeen([selected.id], !selected.unread);
      } else if (e.key === "Escape" && picked.size > 0) {
        // Escape clears the selection BEFORE the shell's own Escape handling closes anything —
        // a picked set is the innermost thing on screen.
        e.preventDefault();
        clearPicked();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [all, selected, onSelect, onEnterReader, onAddTag, onMarkSeen, open, togglePick, clearPicked, picked.size, typingGuard]);

  /**
   * SHIFT-CLICK RANGES, intercepted in the CAPTURE phase.
   *
   * `MessageRow` lives in `@ohmail/ui` and its `onClick` takes no event, so the modifier is
   * unreachable from the row itself — and widening a shared design-system primitive for one
   * view's selection model is the wrong trade. Capture runs before the row's own handler, so
   * `stopPropagation` here means a shift-click extends the range INSTEAD of moving the cursor,
   * rather than doing both.
   */
  const onRangeClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!e.shiftKey) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>(".row[data-id]")?.dataset.id;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    pickRangeTo(id);
  }, [pickRangeTo]);

  const markPicked = useCallback(() => {
    const ids = all.filter((m) => picked.has(m.id)).map((m) => m.id);
    onMarkSeen(ids, false);
    clearPicked();
  }, [all, picked, onMarkSeen, clearPicked]);

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={m.from.address}
      time={displayTime(m, now)}
      subject={m.subject}
      preview={m.protected ? t("protectedPreview") : m.snippet}
      unread={m.unread}
      seen={!m.unread}
      selected={selected?.id === m.id}
      threadCount={m.threadCount}
      hasAttachment={m.hasAttachments}
      protected={m.protected != null}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      className={picked.has(m.id) ? "picked" : undefined}
      onClick={() => {
        if (window.matchMedia("(max-width: 900px)").matches) {
          // Mobile: a tap IS the open — there is no reading column to preview into.
          onSelect(m.id);
          open(m);
        } else if (selected?.id === m.id) {
          // Second click on the already-selected row: into the reader, so it is read.
          open(m);
        } else {
          onSelect(m.id);
        }
      }}
    />
  );

  return (
    <section className="view split view-ohbox" onClickCapture={onRangeClickCapture}>
      <ListPane
        title={t("title")}
        meta={t("meta", {
          unread: newForYou.length,
          total: all.length,
        })}
        header={
          <Doorbell
            initials={doorbellInitials}
            gone={doorbellCount === 0}
            message={
              <DoorbellMessage count={doorbellCount} />
            }
            actionLabel={t("doorbellAction")}
            ariaLabel={t("doorbellAria", { count: doorbellCount })}
            onPress={onDoorbell}
          />
        }
        hints={
          <>
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintMove")}
            </span>
            <span>
              <Kbd>↵</Kbd> {t("hintRead")}
            </span>
            <span>
              <Kbd>t</Kbd> {t("hintTag")}
            </span>
            <span>
              <Kbd>x</Kbd> {t("hintPick")}
            </span>
            <span>
              <Kbd>u</Kbd> {t("hintUnread")}
            </span>
            <span>
              <Kbd>esc</Kbd> {t("hintBack")}
            </span>
          </>
        }
      >
        {/* The selection affordance. A plain bar in this view, not a `@ohmail/ui` primitive:
            nothing else in the product has a multi-select yet, and a component invented for one
            caller is a guess about the second one. */}
        {picked.size > 0 ? (
          <div className="pick-bar" role="status">
            <span>{t("picked", { count: picked.size })}</span>
            <button type="button" onClick={markPicked}>{t("pickedMarkSeen")}</button>
            <button type="button" className="quiet" onClick={clearPicked}>{t("pickedClear")}</button>
          </div>
        ) : null}
        <ListGroupLabel>{t("newForYou")}</ListGroupLabel>
        <ListRows>{newForYou.map(row)}</ListRows>
        <ListGroupLabel>{t("previouslySeen")}</ListGroupLabel>
        <ListRows>{previouslySeen.map(row)}</ListRows>
        {all.length === 0 ? <SyncState /> : null}
        {/* DEMO ONLY, and it was not. "Older mail stays on your server — find it in Search."
            is true of Mila's fixture world, which holds a hand-made slice of a mailbox. It is
            FALSE of a live account: the worker syncs every folder from cursor zero, so what is
            on the server is what is in the mirror, and telling a paying customer their old
            mail is somewhere else is the kind of claim CLAUDE.md forbids shipping. The
            no-collapse rule (invariant #6) is satisfied either way — every message is a real
            row above. */}
        {demo ? <div className="tail-row">{t("tail")}</div> : null}
      </ListPane>
      <ReadColumn>
        {selected ? (
          <MessagePane
            message={selected}
            tags={tags}
            now={now}
            onEnterReader={onEnterReader}
            onAction={(a) => onAction(a, selected)}
            onAddTag={onAddTag}
            onAttachment={onAttachment}
          />
        ) : null}
      </ReadColumn>
    </section>
  );
}

/**
 * WHY AN EMPTY OHBOX IS EMPTY — a count, and never a percentage.
 *
 * P16. A first drain is thirty-odd pages and twelve to fifteen seconds on a real mailbox, and
 * for all of it this pane said "0 unread of 0" with no rows and no explanation, which is what
 * a broken account looks like. The engine already calls `notify()` once per page, so the
 * mirror's size is live here with no extra plumbing.
 *
 * A progress bar is impossible and would have to be invented: `/sync` answers `hasMore` as a
 * boolean, so the total is unknowable until the drain ends. A count is the largest true thing
 * available, and it moves, which is the part that distinguishes working from hung. It counts
 * every message in the MIRROR — Screener, Reads and Receipts included — not the ohbox rows
 * above, so the wording says "messages", not "in your Ohbox".
 *
 * Three consecutive failures replaces it with the failure, because by then the count has
 * stopped moving and a frozen counter is the same lie in a new font. It says the loop is still
 * retrying because it is: the scheduler backs off to a minute and never gives up while the tab
 * is visible.
 *
 * The demo and the desktop never reach either branch — `useSyncStatus()` is permanently
 * settled for a fixtures engine.
 */
function SyncState() {
  const t = useTranslations("ohbox");
  const { bootstrapping, failures } = useSyncStatus();
  const reader = useReader();
  const version = useEngineVersion();
  const mirrored = useMemo(() => reader.list("message").length, [reader, version]);

  if (failures >= 3) {
    return (
      <div className="empty" role="status">
        <span className="glyph" aria-hidden="true">⚠</span>
        <b>{t("syncFailed")}</b>
      </div>
    );
  }
  if (!bootstrapping) return null;
  return (
    <div className="empty" role="status">
      <span className="glyph" aria-hidden="true">✉</span>
      <b>{t("syncingTitle")}</b>
      {t("syncingCount", { count: mirrored })}
    </div>
  );
}

function DoorbellMessage({ count }: { count: number }) {
  const t = useTranslations("ohbox");
  return (
    <>
      {t.rich("doorbell", {
        count,
        b: (chunks) => <b>{chunks}</b>,
      })}
    </>
  );
}
