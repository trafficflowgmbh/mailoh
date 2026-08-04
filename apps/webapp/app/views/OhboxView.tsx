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
  Icon,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
} from "@ohmail/ui";
import { PLACE_LABEL, avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useLoadingGrace } from "../shell/loading-grace";
import { useMailState } from "../shell/MailStateProvider";
import { MessagePane, MOVE_TARGETS, type BulkAction, type MessageAction, type MoveTarget } from "../shell/MessagePane";
import type { ScreeningDest } from "../shell/sender-screening";
import "../shell/action-bar.css";

/**
 * What a selection can be asked to do.
 *
 * Four callbacks and not one, because they are not one kind of thing. `run` and `tag` are
 * ordinary, reversible mail operations; `screen` is a consent decision about SENDERS, and
 * `screenPreview` exists so the surface can state what will persist BEFORE committing it.
 * Sharing a bar is right; sharing commit semantics would be the design error.
 */
export interface BulkVerbs {
  run: (action: BulkAction, ids: string[]) => void;
  tag: (ids: string[], anchor: HTMLElement | null) => void;
  screenPreview: (
    ids: string[],
    dest: ScreeningDest,
  ) => { senders: number; messages: number; rules: number };
  screen: (ids: string[], dest: ScreeningDest) => void;
}

/** Which sub-row the bulk bar is showing; `null` is the resting bar. Mirrors `BarPanel`. */
type PickPanel =
  | { kind: "move" | "more" | "screen" }
  | { kind: "confirm"; dest: MoveTarget };

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
  settled,
  onDoorbell,
  onAction,
  onAddTag,
  bulk,
}: {
  /** Fixture world or a real mailbox — decides the "older mail" tail. See its use below. */
  demo: boolean;
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  tags: TagDTO[];
  now: Date;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * Open the reader ON A MESSAGE.
   *
   * It took no argument while the shell's reader was a boolean over `selectedOhbox`. It
   * takes one now because `open` below calls `onSelect` and this in the same tick, so the
   * shell's own selection has not re-rendered yet — a reader that read it would show the
   * previously selected message.
   */
  onEnterReader: (messageId: string) => void;
  /** The shell's `mark_seen` mutation — the one read-state writer. */
  onMarkSeen: (ids: string[], unread: boolean) => void;
  doorbellInitials: string[];
  /** Per-sender tint hues for the doorbell stack, index-aligned with `doorbellInitials`. */
  doorbellHues?: number[];
  doorbellCount: number;
  /**
   * MAY THIS VIEW STATE ITS EMPTINESS AS A FACT? Derived once in `shell/mail-state.ts` — see
   * {@link MailState.settled} there for the defect and the derivation.
   *
   * Three sentences on this pane are claims about the user's own mail rather than about the
   * list: the meta count, the doorbell's "All clear", and the empty pane. All three were
   * rendered before the first drain had finished, over a mailbox that was not empty.
   *
   * It arrives as a PROP and not from `useMailState()`, because this view is mounted with no
   * provider by `ohbox-read-state.test.ts` and that hook throws without one — deliberately.
   *
   * REQUIRED, with no default. A default would be `true` (nothing else is renderable), which is
   * exactly the silent-omission mode `sync-scheduler.ts` rejects for the wake signal: a caller
   * that forgets it gets the lying surface and no error anywhere. Required, the omission is a
   * type error at the one shipped call site and a visible difference in any harness.
   */
  settled: boolean;
  onDoorbell: () => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /** The verbs a multi-selection offers. */
  bulk: BulkVerbs;
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
  /** The bulk bar's open sub-row. Same union shape as `MessagePane`'s. */
  const [pickPanel, setPickPanel] = useState<PickPanel | null>(null);

  const clearPicked = useCallback(() => {
    if (picked.size > 0) setPicked(new Set());
    setPickPanel(null);
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

  /**
   * The selection IN LIST ORDER, which is the order every verb acts in.
   *
   * A `Set`'s iteration order is insertion order, so a range built upwards and one built
   * downwards would dispatch in different orders for the same visible selection. Deriving it
   * from `all` means the mutations follow what is on screen.
   */
  const pickedIds = useMemo(
    () => all.filter((m) => picked.has(m.id)).map((m) => m.id),
    [all, picked],
  );

  /**
   * Run a bulk verb and drop the selection.
   *
   * Clearing afterwards is the rule `markPicked` has always had: the verb has been applied
   * to exactly these messages, so a set that survived would invite a second application of
   * a verb that has already happened — and after a move or a screening the rows are not
   * even in this list any more.
   */
  const runBulk = useCallback(
    (action: BulkAction) => {
      bulk.run(action, pickedIds);
      clearPicked();
    },
    [bulk, pickedIds, clearPicked],
  );

  /**
   * Mark everything picked read, in ONE mutation — one request, one transaction, one intent.
   *
   * `⇧U` and the bar's Read button are THE SAME CALL, which is the action bar's own rule
   * about the read switch applied to the selection: two paths to one verb is how a button and its key drift
   * into meaning different things. It used to call `onMarkSeen` directly, so the key marked
   * mail read and said nothing while every other bulk verb reported what it had done.
   */
  const markPicked = useCallback(() => runBulk("read"), [runBulk]);

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

  /**
   * THE LIST, READABLE FROM INSIDE A TIMER.
   *
   * The dwell below fires two seconds after the render that armed it and has to judge the
   * list as it is THEN — still present, still unread — without putting `all` in its
   * dependency array (see the dwell for why that would be fatal). Assigned in render rather
   * than refreshed by an effect: an effect would make the dwell's correctness depend on
   * effect DECLARATION ORDER, an invariant nothing states and a reorder would silently
   * break, with this bug as the failure mode. Same shape as `StreamShell` and
   * `useSeenOnScroll` in `@ohmail/ui`.
   */
  const allRef = useRef(all);
  allRef.current = all;

  /**
   * THE WRITER, held the same way, so the dwell's deps are ONE value.
   *
   * `onMarkSeen` was a dependency of the dwell until this slice, which made the dwell's
   * correctness depend on a caller keeping its callback identity stable: `AppShell` does
   * (`markSeen` is a `useCallback`), but a caller that did not would restart the two seconds
   * on every render and the dwell would never fire at all — silently, with no error. That is
   * too much load on a memo somebody else owns. Behind a ref, the effect depends on exactly
   * one thing: the cursor the user put here.
   */
  const markSeenRef = useRef(onMarkSeen);
  markSeenRef.current = onMarkSeen;

  /**
   * THE CURSOR THE USER PUT HERE — and the only value in this file that can arm the dwell.
   *
   * `selectedId` cannot answer this question, and that is what shipped the runaway. It
   * arrives already resolved through TWO implicit fallbacks — `AppShell`'s
   * `?? allOhbox[0]` and this view's on line 83 — so before anything has been picked it
   * means "the newest unread message", and it silently RE-RESOLVES onto a different message
   * every time the list re-partitions. Since the list is partitioned BY `unread`
   * (`ohboxView`), marking one message read is itself a re-partition, so a dwell keyed on
   * `selected` fed itself: commit → the row leaves "New for you" → the fallback lands on the
   * next unread message → the effect sees a selection it never asked for and arms again.
   * Two seconds per message, straight through the Ohbox, onto a real IMAP server.
   *
   * The fix is not a flag consulted inside the effect — it is that the effect's dependencies
   * can no longer EXPRESS a reorder. `dwellOn` is written in exactly two places:
   * `selectByUser`, which is reachable only from j, k and a click, and `open`, which clears
   * it. Nothing derived from the list can produce it.
   */
  const [dwellOn, setDwellOn] = useState<string | null>(null);

  /** Move the cursor because the USER moved it — j, k, and a click on an unselected row. */
  const selectByUser = useCallback((id: string) => {
    setDwellOn(id);
    onSelect(id);
  }, [onSelect]);

  /**
   * Opening a message IS reading it — Enter, a second click on the selected row, mobile tap.
   *
   * `onEnterReader` is an unconditional statement of INTENT ("the user asked to open this
   * message"), not an instruction to raise a sheet. The shell answers it with the
   * reader only where the reading column is hidden; at a split width the column beside this
   * list IS the open, and a sheet over it was the same message rendered twice.
   *
   * It also PINS the selection, and that is not housekeeping. A click on the top row of a
   * fresh Ohbox takes the "already selected" branch below, because the implicit fallback had
   * made it `selected` without anyone choosing it — so the open committed and `ohboxSel`
   * stayed null. The moment the commit moved that row into "Previously seen", the fallback
   * re-resolved to the next unread message and the reader sheet, which renders
   * `selectedOhbox`, swapped to a message the user had not opened — which from the outside
   * looks like the view deciding to load the latest mail on its own.
   *
   * And an open SUPERSEDES a dwell: the commit has already happened, so the timer armed by
   * whichever click selected this row has nothing left to do.
   */
  const open = useCallback((m: EngineMessage) => {
    setDwellOn(null);
    onSelect(m.id);
    if (m.unread) onMarkSeen([m.id], false);
    onEnterReader(m.id);
  }, [onSelect, onMarkSeen, onEnterReader]);

  /**
   * THE MESSAGE `u` JUST PUT BACK TO UNREAD, and why the dwell must not undo it.
   *
   * Pressing `u` on the row under the cursor marks it unread — and in the split pane the
   * cursor is still on it, so the 2 s dwell below arms and marks it read again two seconds
   * later. The mutation fires, the server agrees, and the user's explicit act is reverted
   * by a heuristic while they watch. That is not a subtle bug; it makes `u` useless in the
   * one view whose keyboard map advertises it, and the `?` overlay would be documenting a
   * key that does not do what it says.
   *
   * An explicit "unread" therefore pins the message until the cursor MOVES. A ref rather
   * than state: it must be readable by the dwell effect in the same commit, and it should
   * not cause a render of its own.
   *
   * KEYED TO `dwellOn`, NOT to `selected`, so that the pin and the timer it exists to block
   * agree on what "the cursor" means — `selected` also moves when the list re-partitions
   * underneath the user, which is not a cursor move and must not release a pin.
   *
   * NO GUARD BELOW FAILS IF THIS IS PUT BACK TO `selected?.id`, and that is stated rather
   * than hidden: with `dwellOn` set, `onSelect` has set the shell's `ohboxSel` to the same
   * id, so the two only diverge once the message leaves the Ohbox — and the dwell's
   * fire-time re-read already drops that case. This is coherence, not a fixed bug.
   */
  const pinnedUnread = useRef<string | null>(null);
  useEffect(() => {
    if (pinnedUnread.current && pinnedUnread.current !== dwellOn) pinnedUnread.current = null;
  }, [dwellOn]);

  /**
   * ═══ TWO DIRECTIONS, NOT ONE TOGGLE ═══════════════════════════════════════════════════
   *
   * This was a single `toggleUnread` on a single key. It is now two idempotent commands, and
   * the reason is what a toggle does to a SET: "invert eleven messages" turns a mixed
   * selection into a different mixed selection, so pressing the key twice is not a no-op and
   * pressing it once has an outcome nobody can predict without counting first. A direction
   * always produces the same state from any state, which is why Gmail binds two keys for this
   * and why the bulk vocabulary (`BulkAction`) has always had `read` and `unread` as separate
   * members rather than one flip. The single-message case is the one-element case of that
   * rule, and it should not disagree with it.
   *
   * ── THE PIN IS THE WHOLE REASON THESE ARE NOT `onMarkSeen` AT THE CALL SITE ────────────
   *
   * Marking unread inside the dwell window arms nothing new, but the timer that was already
   * ticking would fire two seconds later and mark it read again — the message would silently
   * un-unread itself. `pinnedUnread` is what the dwell checks when it fires. So an explicit
   * unread SURVIVES the next open, which is the behaviour that was asked for, and it survives
   * it because of this ref rather than because of anything the dwell does differently.
   */
  const markUnread = useCallback((m: EngineMessage) => {
    pinnedUnread.current = m.id;
    onMarkSeen([m.id], true);
  }, [onMarkSeen]);

  const markRead = useCallback((m: EngineMessage) => {
    // Reading it is consent for the dwell to have been right, so the pin is released.
    pinnedUnread.current = null;
    onMarkSeen([m.id], false);
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
   * IT ARMS ON `dwellOn` AND ON NOTHING ELSE, which is the whole of the runaway fix. The
   * dependency array is the guarantee, not a condition in the body: a list that re-partitions
   * — which is exactly what a read commit does to a list grouped by `unread` — cannot change
   * `dwellOn`, so the effect does not re-run and a commit can never arm the next one. The
   * previous version depended on `selected`, which the implicit fallback re-pointed at the
   * next unread message after every commit, and the Ohbox marked itself read at one message
   * per two seconds, on the user's own IMAP server.
   *
   * `all` IS DELIBERATELY NOT A DEPENDENCY. It changes on every sync delta, and a dependency
   * on it would restart the two seconds each time — on a live mailbox the dwell would never
   * reach the end of its own clock. The current list is read through `allRef` instead, at the
   * two moments that need it.
   *
   * THE TARGET IS FROZEN AT ARM TIME. It commits the id the user was standing on, never
   * "whatever is selected now", so a list that reorders mid-dwell cannot redirect the write
   * onto a message nobody looked at. The fire-time re-read covers the three ways the world
   * can have moved on: the message left the Ohbox (filed, moved), it is already read (an
   * open, a `⇧U`, another device), or `u` has pinned it since.
   *
   * Split pane only. On mobile there is no reading column beside the list, so a selection shows
   * nothing and dwelling on it means nothing; there, only `open` counts.
   */
  useEffect(() => {
    if (dwellOn == null) return;
    const id = dwellOn;
    if (pinnedUnread.current === id) return;
    if (!allRef.current.find((m) => m.id === id)?.unread) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(max-width: 900px)").matches) return;
    const timer = window.setTimeout(() => {
      if (pinnedUnread.current === id) return;
      if (!allRef.current.find((m) => m.id === id)?.unread) return;
      markSeenRef.current([id], false);
    }, DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [dwellOn]);

  /**
   * The Ohbox's keys, DECLARED.
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
      run: () => at < order.length - 1 && selectByUser(order[at + 1]!),
    },
    {
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: at <= 0,
      run: () => at > 0 && selectByUser(order[at - 1]!),
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      // ↵ on a focused button presses the button; that is the browser's and it stays so.
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      // The `: onEnterReader()` arm is gone with the boolean it depended on. It meant
      // "open the reader on nothing" — with an empty list there is no message to read, and
      // the sheet it opened rendered a `<span/>`.
      run: () => selected && open(selected),
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
      /**
       * THE PAIR, AND WHY IT IS NOT GMAIL'S EXACT PAIR.
       *
       * Gmail is ⇧I to mark read and ⇧U to mark unread, and it is the precedent worth
       * following — but `shift+u` is taken here, by the bulk "mark what I picked" verb
       * declared a few lines below, and taking it back would break a shipped shortcut to
       * match a convention. So: `⇧I` is Gmail's, verbatim, and `u` keeps the key this
       * product has always used for unread — which is also the better mnemonic of the two.
       *
       * `u` USED TO BE A TOGGLE. See `markUnread` for why a direction is the right shape.
       * Both are listed in the `?` sheet because both declare a label, and the sheet is
       * generated from this registry.
       */
      chord: "u",
      group: "message",
      label: t("keyMarkUnread"),
      disabled: selected == null,
      run: () => selected && markUnread(selected),
    },
    {
      chord: "shift+i",
      group: "message",
      label: t("keyMarkRead"),
      disabled: selected == null,
      run: () => selected && markRead(selected),
    },
    {
      /**
       * THE BULK ACTION, ON THE KEYBOARD.
       *
       * The complaint was that multiple messages could not be selected and marked seen, and
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
       * ESCAPE CANCELS THE OPEN SUB-ROW BEFORE IT CLEARS THE SELECTION.
       *
       * FIRST in this array, and the array's order IS the precedence — `ordered()` walks a
       * layer's bindings in declaration order and the first match runs (`keymap.tsx`). So
       * this is stated where precedence lives rather than as a condition inside the clear
       * binding, which is the shape that rots.
       *
       * It matters most for the confirm row: that row is the last moment before a consent
       * decision commits, and an Escape that blew past it to clear the selection would leave
       * the user with neither the confirmation nor the set they had built.
       *
       * NO NEW `document` LISTENER — there are already five, measured. This is a registry
       * binding in the view layer, which the shell's `overlay` scope still outranks, so a `?`
       * sheet or the palette opened over this closes first and the sub-row survives.
       */
      chord: "Escape",
      group: "message",
      label: t("keyCancelBulk"),
      disabled: pickPanel == null,
      run: () => setPickPanel(null),
    },
    {
      /**
       * Escape clears the selection — when nothing is open on top of it.
       *
       * This used to read `picked.size === 0 || chrome.replyTo != null`, and the second
       * clause is the whole story. The reply tests went red the moment a selection survived
       * into the reply editor — "r opened an inline editor but Esc did not close it" —
       * because this VIEW binding outranked the shell's Escape cascade unconditionally and
       * cleared the selection instead. The patch taught this view to name ONE of the
       * shell's overlays, which left the `?` sheet, the ⌘K palette and the screening
       * popover broken in exactly the same way and put the next overlay one line from
       * joining them.
       *
       * The condition is gone because the precedence is stated where precedence lives: the
       * shell's Escape is registered in the `overlay` scope, which outranks every view
       * layer while something is open and stands down when nothing is (`keymap.tsx`). So
       * this binding is once again only about this view — a picked set is the innermost
       * thing the OHBOX has — and it knows nothing about what the shell may be showing.
       */
      chord: "Escape",
      group: "message",
      label: t("keyClear"),
      disabled: picked.size === 0,
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
      /* `picked` carries BOTH the styling and the ARIA now — it used to be a
         class name only, so `aria-selected` was set on zero rows and the selection existed
         for sighted mouse users and nobody else. See `MessageRow`. */
      picked={picked.has(m.id)}
      onClick={() => {
        if (window.matchMedia("(max-width: 900px)").matches) {
          // Mobile: a tap IS the open — there is no reading column to preview into. `open`
          // selects as well as commits, so the cursor lands here exactly once.
          open(m);
        } else if (selected?.id === m.id) {
          // Second click on the already-selected row: an explicit OPEN, so it is read — and
          // at a split width that is all it is, because the pane beside this list is already
          // showing it. Also the FIRST click on the top row of an untouched
          // Ohbox, which the implicit fallback had already made `selected` — see `open` for
          // what that used to do to the reader.
          open(m);
        } else {
          selectByUser(m.id);
        }
      }}
    />
  );

  return (
    <section className="view split view-ohbox" onClickCapture={onRangeClickCapture}>
      <ListPane
        title={t("title")}
        /* "0 unread of 0 messages" IS A CLAIM ABOUT THE MAILBOX, not a description of the
           list — and it was on screen, beside "Nothing in your Ohbox.", over an account that
           was not empty, for as long as the first drain took. While the mirror has not
           been read there is no count to state, so none is stated: no dash, no zero, no
           substitute. A count that returns the moment there is one to give is not a gap; a
           wrong count is a lie. Any NON-zero total is a real observation whatever the drain is
           doing, so only the empty case is withheld. */
        meta={
          !settled && all.length === 0
            ? undefined
            : t("meta", { unread: newForYou.length, total: all.length })
        }
        header={
          <>
            {/* "All clear" is the doorbell's `=0` arm, and it is the same claim in smaller
                type: nobody is waiting at the gate. Before the mirror has been read nobody is
                KNOWN to be waiting, which is a different sentence. The doorbell is withheld
                entirely rather than reworded — it is an affordance for senders who are
                waiting, and there is nothing yet to open it for. It returns with the count. */}
            {!settled && doorbellCount === 0 ? null : (
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
            )}
            {/* THE SELECTION AFFORDANCE, ABOVE THE SCROLLER.
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
                <BulkBar
                  ids={pickedIds}
                  panel={pickPanel}
                  onPanel={setPickPanel}
                  onRun={runBulk}
                  onMarkSeen={markPicked}
                  bulk={bulk}
                  onDone={clearPicked}
                />
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
            unnamed pair of listboxes is worse than none.

            AND A HEADING OVER NOTHING IS A HEADING THAT LIES. Both pairs rendered
            unconditionally, so an empty Ohbox — which is what a real account looks like for
            the whole of its first sync — was two bare words, "New" and "Earlier", with no rows
            under either and (see `SyncState`) nothing else on the pane at all. A section label
            asserts that a section follows. It also left two empty `role="listbox"` regions for
            a screen reader to land in and find nothing. */}
        {newForYou.length > 0 ? (
          <>
            <ListGroupLabel>{t("newForYou")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("newForYou")}>{newForYou.map(row)}</ListRows>
          </>
        ) : null}
        {previouslySeen.length > 0 ? (
          <>
            <ListGroupLabel>{t("previouslySeen")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("previouslySeen")}>{previouslySeen.map(row)}</ListRows>
          </>
        ) : null}
        {/* The view's own fact — this list is empty — combined with a state derived once, up
            in the shell. `doorbellCount` is the Screener's waiting count, already a prop. */}
        {all.length === 0 ? <SyncState waiting={doorbellCount} settled={settled} /> : null}
        {/* DEMO ONLY, and it was not. "Older mail stays on your server — find it in Search."
            is true of Mila's fixture world, which holds a hand-made slice of a mailbox. It is
            FALSE of a live account: the worker syncs every folder from cursor zero, so what is
            on the server is what is in the mirror, and telling a paying customer their old
            mail is somewhere else is the kind of claim CLAUDE.md forbids shipping. The
            no-collapse rule (invariant #6) is satisfied either way — every message is a real
            row above. */}
        {demo ? <div className="tail-row">{t("tail")}</div> : null}
      </ListPane>
      {/* NO `onEnterReader` ON THE PANE. `ReadingPane` renders a small
          "Open reading mode" button when it is given one, and this column is the ONE place
          that passed it. Below 900px the column is `display:none`, so that button was
          reachable at exactly the widths where the sheet duplicates the pane it is standing
          on — a control whose only outcome was the defect. The reader is not lost: it is
          what "opened" means where there is no column, which is the shell's `enterReader`. */}
      <ReadColumn>
        {selected ? (
          <MessagePane
            message={selected}
            tags={tags}
            now={now}
            onAction={(a) => onAction(a, selected)}
            onAddTag={onAddTag}
          />
        ) : null}
      </ReadColumn>
    </section>
  );
}

/**
 * ═══ THE SELECTION'S ACTION BAR ════════════════════════════════════════════════════════
 *
 * The requirement: a selection must offer more than mark unseen, mark read and Escape — it
 * needs the sender's screening and its tags too.
 *
 * ── IT IS THE MESSAGE BAR'S GROUPING, NOT A SECOND VOCABULARY ─────────────────────────
 *
 * The message action bar established what these verbs are and how they group, and the classes
 * below are that bar's own (`action-bar.css`): one segmented control for the three horizons, two filing
 * verbs adjacent because they answer the same question at two scopes, the read state apart
 * from the verbs, and a More panel that REPLACES the row rather than growing it. A second
 * grouping invented for bulk would mean the same five verbs sit in two different orders
 * depending on how many messages you have selected, which is the kind of thing a user
 * experiences as the app changing its mind.
 *
 * Two deliberate divergences, both forced:
 *
 *   · **No Reply.** There is no such act over eleven messages. The leading slot the accent
 *     verb occupies is taken by Tag, which is the instant, reversible verb here.
 *   · **Read and Unread are two buttons, not a switch.** `role="switch"` reports a current
 *     state, and a selection has a mixed one; a toggle over it would mark six read and five
 *     unread in a gesture that reads as one decision.
 *
 * ── AND SCREENING GETS A CEREMONY THE OTHERS DO NOT ───────────────────────────────────
 *
 * Everything else here is a mail operation on the messages you picked. Screening is a
 * decision about SENDERS: for a sender still waiting at the gate it promotes a rule that
 * governs all their future mail, and it moves every message that sender has in the mirror,
 * not only the ones in the selection. So it is two steps — pick a destination, then a row
 * that states the senders, the messages and the rules before anything is dispatched.
 *
 * **There is no undo, and that is why the confirm row exists.** `POST /screener/:id` has no
 * inverse, so an Undo affordance would either do nothing or move the mail back
 * while the rule it created stood — a control that lies about what it reversed. Stating the
 * counts before committing is the honest version of the same protection.
 */
function BulkBar({
  ids,
  panel,
  onPanel,
  onRun,
  onMarkSeen,
  bulk,
  onDone,
}: {
  ids: string[];
  panel: PickPanel | null;
  onPanel: (next: PickPanel | null) => void;
  onRun: (action: BulkAction) => void;
  /** Mark-read keeps its own path: ⇧U's handler, so the bar and the key are one call. */
  onMarkSeen: () => void;
  bulk: BulkVerbs;
  onDone: () => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");

  const defer = (
    <>
      <button type="button" className="abar-b" onClick={() => onRun("later")}>
        {t("actionLater")}
      </button>
      <button type="button" className="abar-b" onClick={() => onRun("aside")}>
        {t("actionSetAside")}
      </button>
      <button type="button" className="abar-b" onClick={() => onRun("resurface")}>
        {t("actionResurface")}
      </button>
    </>
  );

  const file = (
    <>
      <button type="button" className="abar-b" onClick={() => onPanel({ kind: "screen" })}>
        {tr("action")}
      </button>
      <button type="button" className="abar-b" onClick={() => onPanel({ kind: "move" })}>
        {t("actionMove")}
      </button>
    </>
  );

  const tagButton = (anchorClass: string) => (
    <button
      type="button"
      className={anchorClass}
      onClick={(e) => {
        bulk.tag(ids, (e.currentTarget as HTMLElement | null) ?? null);
        onDone();
      }}
    >
      {t("tagChip")}
    </button>
  );

  if (panel?.kind === "move" || panel?.kind === "screen") {
    const screening = panel.kind === "screen";
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{screening ? tr("bulkTo") : t("moveLabel")}</span>
          {MOVE_TARGETS.map((v) => (
            <button
              key={v}
              type="button"
              className="abar-b abar-solo"
              onClick={() =>
                screening ? onPanel({ kind: "confirm", dest: v }) : onRun(`move:${v}`)
              }
            >
              → {PLACE_LABEL[v] ?? v}
            </button>
          ))}
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  if (panel?.kind === "confirm") {
    /**
     * THE LAST MOMENT BEFORE CONSENT, and it states what will PERSIST separately from what
     * will move. The counts come from the same `planScreeningChange` that will run — not
     * from `ids.length`, which is a different and smaller number whenever a picked sender
     * has other mail in the mirror. Reporting the selection size here would be a
     * confirmation of something other than what happens.
     */
    const plan = bulk.screenPreview(ids, panel.dest);
    const place = PLACE_LABEL[panel.dest] ?? panel.dest;
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">
            {plan.senders === 0
              ? /* Nothing to confirm, said as itself. "0 senders → Ohbox. 0 messages move."
                   is a confirmation of nothing, and a user reading it would reasonably press
                   the button to find out what it meant. */
                tr("bulkConfirmNothing", { place })
              : plan.rules > 0
                ? tr("bulkConfirmRules", {
                    place,
                    senders: plan.senders,
                    count: plan.messages,
                    rules: plan.rules,
                  })
                : tr("bulkConfirm", { place, senders: plan.senders, count: plan.messages })}
          </span>
          <button
            type="button"
            className="abar-b abar-solo primary"
            disabled={plan.senders === 0}
            onClick={() => {
              bulk.screen(ids, panel.dest);
              onDone();
            }}
          >
            {tr("bulkCommit")}
          </button>
          <button type="button" className="abar-b" onClick={() => onPanel({ kind: "screen" })}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  if (panel?.kind === "more") {
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{t("actionMore")}</span>
          <span className="abar-pg abar-p-defer">{defer}</span>
          <span className="abar-pg abar-p-file">{file}</span>
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="abar">
      <div className="abar-row">
        <div className="abar-g">{tagButton("abar-b abar-solo")}</div>

        <div className="abar-g abar-seg abar-defer" role="group" aria-label={t("groupDefer")}>
          {defer}
        </div>

        <div className="abar-g abar-seg abar-file" role="group" aria-label={t("groupFile")}>
          {file}
        </div>

        <div className="abar-g abar-read-g">
          <span className="abar-g abar-seg" role="group" aria-label={t("groupRead")}>
            <button type="button" className="abar-b" onClick={onMarkSeen}>
              {t("pickedMarkSeen")} <Kbd>⇧U</Kbd>
            </button>
            <button type="button" className="abar-b" onClick={() => onRun("unread")}>
              {t("pickedMarkUnseen")}
            </button>
          </span>
          <button
            type="button"
            className="abar-b abar-solo abar-more"
            aria-haspopup="true"
            aria-expanded={false}
            aria-label={t("actionMore")}
            title={t("actionMore")}
            onClick={() => onPanel({ kind: "more" })}
          >
            <Icon name="chev" size={12} className="abar-chev" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * WHY AN EMPTY OHBOX IS EMPTY — the one answer that is this VIEW's to give.
 *
 * ── WHAT THIS PANE USED TO DO, AND WHY IT WAS SILENT FOR HALF AN HOUR ────────────────────
 *
 * A live count was put here — "Syncing your mailbox · 3 messages so far" — gated on
 * `SyncStatus.bootstrapping`. That gate is the defect. `bootstrapping` means "this TAB's first
 * drain has not completed", and a fresh account's first drain completes in seconds against an
 * empty server-side mirror. The WORKER's first import is a different clock entirely: minutes
 * on a mailbox of any size, and tens of minutes on a full one. So the counter switched itself off within
 * seconds and the pane then said nothing at all for the entire import — which is exactly the
 * half hour a first import spends saying "Waiting for first sync" somewhere else.
 *
 * The counter therefore MOVED, and moved UP: it is `SyncBar`'s `importing` state now, keyed on
 * the mirror actually growing (`shell/mail-state.ts`) rather than on a tab-local boolean, and
 * rendered above the deck so it is visible in Reads, Receipts and the Screener too. This is
 * the same lesson a second time — a view can only speak about itself, and "your mail is arriving"
 * is not a fact about the Ohbox.
 *
 * ── WHAT IS LEFT HERE, AND WHY IT BELONGS HERE ──────────────────────────────────────────
 *
 * One thing: an empty Ohbox that is CORRECT. A fresh account is mostly Screener by design, so
 * the true sentence is "nothing has reached the Ohbox because every sender so far is new" —
 * and that is a statement about THIS list, which no shell-level strip may make. Rendered above
 * the deck it would tell somebody standing in the Screener that everything is in the Screener.
 *
 * The split is: `mail-state.ts` derives `screenerCandidate` (mail landed, mirror settled,
 * nothing wrong), ONCE, for everybody. This pane contributes the only fact it owns — that its
 * own list is empty — and renders. **It does not re-derive.**
 *
 * That last rule is why this pane reads no `SyncStatus` field itself. It used to say
 * "`bootstrapping`, `failures` and `terminal` are deliberately no longer read here", which
 * described the mechanism rather than the rule and is no longer true of the second half of what
 * this pane says. It reads {@link MailState.settled}, which is derived from `bootstrapping` and
 * from the ladder's own verdict, ONCE, up in `mail-state.ts`. The argument is untouched: what
 * was wrong was a COUNTER gated on a tab-local boolean that goes false in seconds while the
 * worker's import runs for minutes. Progress still keys on the mirror growing and still lives in
 * the strip. Seconds is exactly the right length for the different question asked here.
 *
 * ── AND THE THIRD STATE THIS PANE USED TO COLLAPSE ──────────────────────────────────────
 *
 * "Empty" and "not looked yet" were one rendering, so a slow connection showed "no messages".
 * The mirror persists in IndexedDB and the client's own first drain had not finished, so
 * `Nothing in your Ohbox.` was a statement about mail the app had simply not read yet. Before the mirror has been read there is no emptiness to report, so this pane reports
 * what is actually happening instead — after {@link LOADING_GRACE_MS}, so a fast connection
 * still gets the silent frame it always had rather than a sub-second flash.
 *
 * **It says the app is loading, never what it will find.** A placeholder row, an invented count
 * or a skeleton shaped like mail would answer this defect by creating the one this product
 * treats as unforgivable.
 *
 * The demo and the Desktop never reach the `screenerCandidate` arms — the derivation returns the
 * resting value for a fixtures engine before it looks at anything else — and `settled` is true
 * for them for the same reason: a fixtures engine is permanently settled.
 */
function SyncState({ waiting, settled }: { waiting: number; settled: boolean }) {
  const t = useTranslations("ohbox");
  const { state } = useMailState();
  const speak = useLoadingGrace(!settled);

  /* THE MIRROR HAS NOT BEEN READ, so this list is not empty — it is unknown. Above every arm
     below, because both of them state something about mail that has arrived. */
  if (!settled) {
    return (
      <div className="empty" role="status" aria-busy="true">
        {/* `.mbx-wait` and not a bare span: `.mbx-spin` sizes itself with `width`/`height` and
            is a `<span>`, so it needs a flex parent or the border collapses to a dot. That
            pairing — spinner beside one muted line — is exactly what `.mbx-wait` already is
            (`app.css`, beside the Settings rows), and reusing it adds no CSS and inherits the
            `prefers-reduced-motion` answer the ring already has. Same reuse `SyncBar` makes,
            for the same reason and with the same note about the `mbx-` prefix. */}
        <span className="mbx-wait">
          <span className="mbx-spin" aria-hidden="true" />
          {speak ? <b>{t("loading")}</b> : null}
        </span>
      </div>
    );
  }

  /* ── AND WHEN THERE IS NO EXPLANATION, SAY THE FACT ANYWAY ────────────────────────────
   *
   * `screenerCandidate` is false for the whole of a first sync — it requires mail to have
   * landed and the mirror to have settled — so outside the demo this returned `null` for the
   * whole of the first import, which is the stretch that matters most, and the pane rendered NOTHING. Combined with the group labels
   * above, an empty Ohbox was literally the two words "New" and "Earlier" on an otherwise blank
   * column, which reads as a broken screen rather than an empty one.
   *
   * The sentence is bare on purpose. `SyncBar` is directly above this pane and it is the one
   * place allowed to say WHY the list is empty — it is the only surface that has derived it,
   * and it is already saying "Connected. The first sync has not finished yet." or "Not
   * syncing — …" or nothing at all. Repeating any of that here would reintroduce the same
   * defect: a view speaking about something that is not a fact about this view. What this
   * pane owns is "this list is empty", which is true in every one of those states.
   */
  if (!state.screenerCandidate) {
    return (
      <div className="empty" role="status">
        <span className="glyph" aria-hidden="true">✉</span>
        <b>{t("emptyPlain")}</b>
      </div>
    );
  }
  return (
    <div className="empty" role="status">
      <span className="glyph" aria-hidden="true">{waiting > 0 ? "🕊" : "✉"}</span>
      {/* Two sentences, because two different things are true. Mail is held at the door and
          the door is one click away — or it arrived and was filed somewhere that is not here,
          and Search is how it is found. Neither claims the Ohbox is broken. */}
      <b>{waiting > 0 ? t("emptyScreenerTitle") : t("emptyFiledTitle")}</b>
      {waiting > 0
        ? t("emptyScreenerHint", { count: waiting })
        : t("emptyFiledHint", { count: state.count })}
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
