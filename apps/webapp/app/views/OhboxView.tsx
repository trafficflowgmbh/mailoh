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
import { avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useEngineVersion, useReader, useSyncStatus } from "../shell/engine";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useMessageChrome } from "../shell/message-chrome";
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
  doorbellHues,
  doorbellCount,
  onDoorbell,
  onAction,
  onAddTag,
  onAttachment,
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
  /** Per-sender tint hues for the doorbell stack, index-aligned with `doorbellInitials`. */
  doorbellHues?: number[];
  doorbellCount: number;
  onDoorbell: () => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  onAttachment: () => void;
}) {
  const t = useTranslations("ohbox");
  /** Only for Escape precedence — see the binding. Inert outside the shell. */
  const chrome = useMessageChrome();

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

  /** Mark everything picked read, in ONE mutation — one request, one transaction, one intent. */
  const markPicked = useCallback(() => {
    const ids = all.filter((m) => picked.has(m.id)).map((m) => m.id);
    onMarkSeen(ids, false);
    clearPicked();
  }, [all, picked, onMarkSeen, clearPicked]);

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
   * THE MESSAGE `u` JUST PUT BACK TO UNREAD, and why the dwell must not undo it.
   *
   * Pressing `u` on the row under the cursor marks it unread — and in the split pane the
   * cursor is still on it, so the 2 s dwell below arms and marks it read again two seconds
   * later. The mutation fires, the server agrees, and the user's explicit act is reverted
   * by a heuristic while they watch. That is not a subtle bug; it makes `u` useless in the
   * one view whose keyboard map advertises it, and the U2 overlay would be documenting a
   * key that does not do what it says.
   *
   * An explicit "unread" therefore pins the message until the cursor MOVES. A ref rather
   * than state: it must be readable by the dwell effect in the same commit, and it should
   * not cause a render of its own.
   */
  const pinnedUnread = useRef<string | null>(null);
  useEffect(() => {
    if (pinnedUnread.current && pinnedUnread.current !== selected?.id) pinnedUnread.current = null;
  }, [selected?.id]);

  const toggleUnread = useCallback((m: EngineMessage) => {
    pinnedUnread.current = m.unread ? null : m.id;
    onMarkSeen([m.id], !m.unread);
  }, [onMarkSeen]);

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
    if (pinnedUnread.current === selected.id) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(max-width: 900px)").matches) return;
    const timer = window.setTimeout(() => onMarkSeen([selected.id], false), DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [selected, onMarkSeen]);

  /**
   * The Ohbox's keys, DECLARED (slice U2).
   *
   * These were a sixth `document` listener with the shell's and four other views'; they are
   * now a view layer in the registry, which means two things: they win over the global map
   * while this view is mounted (and disappear with it), and the `?` sheet lists them
   * because they exist, not because someone remembered to write them down.
   */
  const order = all.map((m) => m.id);
  const at = selected ? order.indexOf(selected.id) : -1;
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: at >= order.length - 1,
      run: () => at < order.length - 1 && onSelect(order[at + 1]!),
    },
    {
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: at <= 0,
      run: () => at > 0 && onSelect(order[at - 1]!),
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      // ↵ on a focused button presses the button; that is the browser's and it stays so.
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      run: () => (selected ? open(selected) : onEnterReader()),
    },
    {
      chord: "t",
      group: "message",
      label: t("keyTag"),
      disabled: selected == null,
      run: () =>
        selected &&
        onAddTag(
          selected.id,
          document.querySelector<HTMLElement>(
            `.view-ohbox .row[data-id="${CSS.escape(selected.id)}"]`,
          ),
        ),
    },
    {
      chord: "x",
      group: "message",
      label: t("keyPick"),
      disabled: selected == null,
      run: () => selected && togglePick(selected.id),
    },
    {
      chord: "u",
      group: "message",
      label: t("keyUnread"),
      disabled: selected == null,
      run: () => selected && toggleUnread(selected),
    },
    {
      /**
       * THE BULK ACTION, ON THE KEYBOARD (slice U1d).
       *
       * The owner's complaint was "I can't select multiple emails and mark them seen", and
       * the half that shipped could only be finished with a mouse: the bar's buttons are
       * reachable by Tab, but there was no way to say "mark what I picked" from the keys
       * that made the pick, and nothing in the `?` sheet mentioned that marking a selection
       * was possible at all. Declaring it here documents it — the sheet is generated from
       * this registry and cannot list a key that does nothing.
       *
       * `⇧U` and not a fresh letter: `u` is already "mark read / unread" at the cursor, so
       * the shifted twin is the same verb over the selection. `chordMatches` keeps plain
       * `u` from swallowing it.
       */
      chord: "shift+u",
      group: "message",
      label: t("keyMarkPicked"),
      disabled: picked.size === 0,
      run: () => markPicked(),
    },
    {
      /**
       * Innermost Escape in the product: a picked set is closer than the reader is.
       *
       * NOT closer than the reply editor, though, and that cost a live journey to find.
       * `U4-REPLY` went red the moment a selection survived into it — "r opened an inline
       * editor but Esc did not close it" — because this VIEW binding outranks the shell's
       * cascade unconditionally and cleared the selection instead. The typing guard hides
       * this most of the time (this binding is not `inInput`, so it is dormant while the
       * caret is in the textarea) and that is exactly why it is worth stating: the editor
       * does not always hold focus, and a guard that only works when the caret is in the
       * right place is not the guarantee U4 makes.
       *
       * SAME CLASS, NOT FIXED HERE: the `?` sheet, the ⌘K palette and the screening
       * popover are also inner to a picked set and also lose to it. They are the shell's
       * overlays, this view cannot see them, and the fix is precedence in the cascade
       * rather than a growing condition here — filed, not silently patched.
       */
      chord: "Escape",
      group: "message",
      label: t("keyClear"),
      disabled: picked.size === 0 || chrome.replyTo != null,
      run: clearPicked,
    },
  ];
  useKeyBindings(keys);

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

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={rowAddress(m)}
      {...avatarOf(m)}
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
      /* `picked` carries BOTH the styling and the ARIA now (slice U1d) — it used to be a
         class name only, so `aria-selected` was set on zero rows and the selection existed
         for sighted mouse users and nobody else. See `MessageRow`. */
      picked={picked.has(m.id)}
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
          <>
            <Doorbell
              initials={doorbellInitials}
              hues={doorbellHues}
              gone={doorbellCount === 0}
              message={
                <DoorbellMessage count={doorbellCount} />
              }
              actionLabel={t("doorbellAction")}
              ariaLabel={t("doorbellAria", { count: doorbellCount })}
              onPress={onDoorbell}
            />
            {/* THE SELECTION AFFORDANCE, ABOVE THE SCROLLER (slice U1d).
                It used to be the scroller's first child, so the count and the bulk action
                scrolled off the moment you picked something forty rows down — the state was
                unknowable exactly when it mattered most. `ListPane`'s `header` slot is
                documented for a bulk bar; this is the bulk bar.

                Still a plain bar in this view rather than a `@ohmail/ui` primitive: nothing
                else in the product has a multi-select, and a component invented for one
                caller is a guess about the second one.

                `role="status"` so the count is ANNOUNCED as it changes, not merely present. */}
            {picked.size > 0 ? (
              <div className="pick-bar" role="status">
                <span>{t("picked", { count: picked.size })}</span>
                <button type="button" onClick={markPicked}>
                  {t("pickedMarkSeen")} <Kbd>⇧U</Kbd>
                </button>
                <button type="button" className="quiet" onClick={clearPicked}>
                  {t("pickedClear")} <Kbd>esc</Kbd>
                </button>
              </div>
            ) : null}
          </>
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
              <Kbd>?</Kbd> {t("hintAllKeys")}
            </span>
          </>
        }
      >
        {/* TWO listboxes, not one: "New" and "Earlier" are separated by a group label, and
            an option's listbox has to be its actual container. Each is labelled, because an
            unnamed pair of listboxes is worse than none. */}
        <ListGroupLabel>{t("newForYou")}</ListGroupLabel>
        <ListRows multiSelectable ariaLabel={t("newForYou")}>{newForYou.map(row)}</ListRows>
        <ListGroupLabel>{t("previouslySeen")}</ListGroupLabel>
        <ListRows multiSelectable ariaLabel={t("previouslySeen")}>{previouslySeen.map(row)}</ListRows>
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
