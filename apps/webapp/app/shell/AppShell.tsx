"use client";

/**
 * The ohmail client shell: rail + views over ONE engine, the reader
 * exhale, the Reply Run, the ⌘K palette, the tag picker, the dock and
 * the demo ribbon. Every list, count and mutation runs through
 * @ohmail/client-engine — the shell only owns view state.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  DEMO_NOW,
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  ohboxView,
  readsPartition,
  receiptsByDay,
  tagsCrossView,
  threadOf,
  triagePiles,
  type EngineDraft,
  type EngineMessage,
  type OhmailView,
  type SearchHit,
  type TagDTO,
  type TriagePileEntry,
} from "@ohmail/client-engine";
import {
  CommandPalette,
  Dock,
  DockIcon,
  DockKey,
  FocusReplyOverlay,
  Icon,
  RailNav,
  Reader,
  useCommandPalette,
  useTheme,
  useToast,
  type Command,
  type RailGroup,
} from "@ohmail/ui";
import {
  EngineProvider,
  useDemoMode,
  useEngine,
  useEngineVersion,
  type OwnerResolver,
} from "./engine";
import { PLACE_LABEL, avatarHue, firstName, hueOf, nextFridayNine, resurfaceLabel } from "./format";
import { MessagePane, type MessageAction } from "./MessagePane";
import { useScreenerState } from "./screener-state";
import { useReplySend } from "./reply-send";
import { TagPicker, placePicker, type TagPickerState } from "./TagPicker";
import { KeymapProvider, useKeyBindings, type KeyBinding } from "./keymap";
import { ShortcutSheet } from "./ShortcutSheet";
import { SyncBar } from "./SyncBar";
import { MessageChromeProvider } from "./message-chrome";
import { readReplyDraft, writeReplyDraft } from "./InlineReply";
import { SenderMenu, type SenderMenuState } from "./SenderMenu";
import {
  planScreeningChange,
  senderScreening,
  type ScreeningDest,
} from "./sender-screening";
import { go, goScreener, goTag, useHashRoute, type ScreenerSegmentId } from "./routing";
import { OhboxView } from "../views/OhboxView";
import { ReadsView, type ReadsChipState } from "../views/ReadsView";
import { ReceiptsView } from "../views/ReceiptsView";
import { ScreenerView } from "../views/ScreenerView";
import { SearchView } from "../views/SearchView";
import { SettingsView, type MailboxEntity } from "../views/SettingsView";
import { TagView } from "../views/TagView";
import { TriageView } from "../views/TriageView";
import { ComposeView } from "../views/ComposeView";
import { usePersistedFlag, UI_KEYS } from "./persisted-ui.js";

interface ReadsAiChipEntity {
  afterId: string;
  label: string;
  approvedLabel: string;
  correctedLabel: string;
}

/*
 * The typing guard used to live here and be threaded into five views as a prop. It is now
 * `isTypingTarget` in `keymap.tsx`, applied once by the one listener — a guard that every
 * caller has to remember to apply is a guard one caller will eventually forget.
 */

/**
 * `demo` here is the SERVER's answer, and it is only a floor — `EngineProvider` re-derives
 * the mode from the real URL on the client and publishes what the engine was actually built
 * in. The chrome below reads THAT (`useDemoMode`), so the ribbon and the frozen demo clock
 * can never disagree with the adapter the data is coming from.
 */
export function AppShell({
  demo,
  resolveOwner,
  accountSection,
  mailboxSection,
  billingSection,
  aboutSection,
}: {
  demo: boolean;
  resolveOwner?: OwnerResolver;
  /**
   * The Cloud client's Settings → Account pane, injected rather than imported — the same
   * seam as `resolveOwner`, and see `views/SettingsView.tsx` for why it has to be one.
   * Absent on Desktop, which is standalone and has no account.
   */
  accountSection?: ReactNode;
  /** The Cloud client's Settings → Mailboxes pane. Same seam. */
  mailboxSection?: ReactNode;
  /** The Cloud client's Settings → Subscription pane (plan, AI switch, Stripe portal). */
  billingSection?: ReactNode;
  /**
   * The BODY of the (i) panel for a live account. Same seam again, and it has to be: the
   * facts worth showing there — which mailbox is connected and when it last synced — come
   * from `GET /mailboxes`, which this shared shell may not call. Absent ⇒ the demo body.
   */
  aboutSection?: ReactNode;
}) {
  return (
    <EngineProvider demo={demo} resolveOwner={resolveOwner}>
      {/* ONE keydown listener for the whole client (slice U2). Outside `ShellInner` so
          every view mounted under it can declare bindings into the same table, which is
          also the table the `?` sheet is generated from. */}
      <KeymapProvider>
        <ShellInner
          accountSection={accountSection}
          mailboxSection={mailboxSection}
          billingSection={billingSection}
          aboutSection={aboutSection}
        />
      </KeymapProvider>
    </EngineProvider>
  );
}

function ShellInner({ accountSection, mailboxSection, billingSection, aboutSection }: {
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  billingSection?: ReactNode;
  aboutSection?: ReactNode;
}) {
  const demo = useDemoMode();
  const t = useTranslations();
  const engine = useEngine();
  const version = useEngineVersion();
  const reader = engine.read();
  const toast = useToast();
  const theme = useTheme();
  const route = useHashRoute();
  // The registry owns ⌘K (see `keymap.tsx`). Leaving the hook's own binding on as well
  // would toggle twice per keypress, which cancels out and never opens the palette.
  const palette = useCommandPalette({ bindKey: false });
  const now = useMemo(() => (demo ? DEMO_NOW : new Date()), [demo]);

  /* ── engine-derived world (recomputed exactly when the mirror moves) ── */
  const ohbox = useMemo(() => ohboxView(reader), [reader, version]);
  const partition = useMemo(() => readsPartition(reader), [reader, version]);
  const receiptGroups = useMemo(() => receiptsByDay(reader, now), [reader, version, now]);
  const piles = useMemo(() => triagePiles(reader), [reader, version]);
  const tagGroups = useMemo(() => tagsCrossView(reader), [reader, version]);
  const tags = useMemo(() => reader.list<TagDTO>("tag"), [reader, version]);
  const mailboxes = useMemo(
    () => reader.list<MailboxEntity>("mailbox"),
    [reader, version],
  );
  const draft = useMemo(
    () => reader.get<EngineDraft>("draft", "draft-compose") ?? null,
    [reader, version],
  );
  const aiChip = useMemo(
    () => reader.get<ReadsAiChipEntity>("view_meta", "reads_ai_chip") ?? null,
    [reader, version],
  );
  const account = useMemo(
    () => reader.get<{ email: string }>("view_meta", "account") ?? null,
    [reader, version],
  );
  const screener = useScreenerState(engine, version, toast);

  /* ── view state ── */
  const [ohboxSel, setOhboxSel] = useState<string | null>(null);
  const [readsCur, setReadsCur] = useState<string | null>(null);
  const [receiptsCur, setReceiptsCur] = useState<string | null>(null);
  const [scnSel, setScnSel] = useState<Record<ScreenerSegmentId, string | null>>({
    waiting: null,
    screened: null,
    spam: null,
  });
  const [screenerFull, setScreenerFull] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [senderMenu, setSenderMenu] = useState<SenderMenuState | null>(null);
  /* The inline reply (U4). The id and the text live HERE, not in `MessagePane`, because
     that pane is mounted twice whenever the reader is open — see `message-chrome.tsx`. */
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  // Survives a reload; see `persisted-ui.ts` for why it is local and read after mount.
  const [tagsOpen, setTagsOpen] = usePersistedFlag(UI_KEYS.tagsOpen, true);
  const [picker, setPicker] = useState<TagPickerState | null>(null);
  const [chipState, setChipState] = useState<ReadsChipState>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [jump, setJump] = useState<{ view: "reads" | "receipts"; id: string } | null>(null);
  const [fr, setFr] = useState<{ step: number; items: TriagePileEntry[] } | null>(null);
  /**
   * U7 — "start a Reply Run once we are on Triage", as an INTENT rather than a race.
   *
   * `f` and the palette both did `go("triage"); setTimeout(startFR, 130)`. The route-transition
   * effect below clears every overlay — `setFr(null)` included — whenever the view changes, so
   * that 130 ms was a bet that the effect would run first. Any extra render moves the deadline:
   * with a row selected the effect landed AFTER the timeout and wiped the state that had just
   * opened the overlay, so `f` navigated to Triage and then silently did nothing. It was filed
   * as "a selection blocks the Reply Run"; the selection was only the cheapest way to buy
   * enough renders to lose the race.
   *
   * A flag the effect itself honours cannot lose it: the clear and the re-arm are one pass, in
   * that order, however many times React re-renders on the way.
   */
  const [frPending, setFrPending] = useState(false);
  const [frValues, setFrValues] = useState<Record<number, string>>({});
  const [frDone, setFrDone] = useState<Set<string>>(() => new Set());
  const [ribbonGone, setRibbonGone] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("ohmail.demo-ribbon") === "gone") setRibbonGone(true);
    } catch {
      /* storage blocked — the ribbon stays */
    }
  }, []);

  const allOhbox = useMemo(
    () => [...ohbox.newForYou, ...ohbox.previouslySeen],
    [ohbox],
  );
  const selectedOhbox =
    allOhbox.find((m) => m.id === ohboxSel) ?? allOhbox[0] ?? null;

  const waitingLive = screener.waiting.filter((w) => !screener.isExiting(w.id));

  /**
   * READ-STATE, for every view (slice U1).
   *
   * One call site for one mutation. Before this, "seen" meant three different things depending
   * on where you were standing: Reads dispatched `feed_mark_seen`, Receipts kept an unpersisted
   * React `Set` that a reload erased, and the Ohbox dispatched nothing at all — opening a
   * message left it bold forever. All three now write the same row, and the worker puts `\Seen`
   * on the user's own IMAP server, which is what makes the state survive the product.
   */
  const markSeen = useCallback(
    (ids: string[], unread: boolean) => {
      if (ids.length === 0) return;
      void engine.mutate({ kind: "mark_seen", messageIds: ids, unread });
    },
    [engine],
  );

  // The engine's `unread` IS the answer now — the client-side overlay that used to sit on top of
  // it is gone. The optimistic overlay already makes the flip instant, and unlike the `Set` it
  // survives a reload, because it is backed by a row.
  const receiptsIsUnread = useCallback((m: EngineMessage) => m.unread, []);
  const receiptsUnread =
    receiptGroups.flatMap((g) => g.items).filter(receiptsIsUnread).length;
  const readsUnread = [...partition.fresh, ...partition.seen].filter((m) => m.unread).length;

  /* ── route transitions: overlays close, pending screener work lands ── */
  const prevRoute = useRef(route);
  useEffect(() => {
    const prev = prevRoute.current;
    if (prev.view !== route.view || prev.screenerSegment !== route.screenerSegment || prev.tagId !== route.tagId) {
      screener.flush();
      setReaderOpen(false);
      setPicker(null);
      setFr(null);
      setRailOpen(false);
      setSenderMenu(null);
      setShortcutsOpen(false);
      setReplyTo(null);
      if (route.view !== "screener") setScreenerFull(false);
      // …and only then honour a pending Reply Run, so the clear above cannot undo it (U7).
      if (route.view === "triage" && frPending) {
        setFrPending(false);
        setFrValues({});
        setFr({ step: 0, items: piles.replyLater });
      }
    }
    prevRoute.current = route;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  /* ── shared actions ── */
  const openTagPicker = useCallback((messageId: string, anchor: HTMLElement | null) => {
    setPicker({ forId: messageId, ...placePicker(anchor) });
  }, []);

  /**
   * THE INLINE REPLY (slice U4).
   *
   * Opening it does NOT change the route and does not close the reader: that is the whole
   * complaint. The draft is restored from `localStorage` on open, so a reload lands you
   * back in the same half-written sentence.
   */
  const openReply = useCallback((messageId: string) => {
    setReplyTo(messageId);
    setReplyBody(readReplyDraft(messageId));
    // MOBILE. Under 900px the reading column is `display:none` (app.css), so an inline
    // reply would mount into a pane nobody can see and `r` would look broken — measured on
    // the shipped build at 390px. There, the reader IS the open message, so open it.
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches) {
      setReaderOpen(true);
    }
  }, []);

  const closeReply = useCallback(() => setReplyTo(null), []);

  const onReplyBody = useCallback(
    (next: string) => {
      setReplyBody(next);
      if (replyTo) writeReplyDraft(replyTo, next);
    },
    [replyTo],
  );

  /**
   * SENDING (slice U4b). The state machine, the retry driver and the U4e triage clear all
   * live in `reply-send.ts`; this only says what "the send settled" means to the shell —
   * close the editor, but ONLY if it is still open on that same message. A confirmation can
   * arrive from a retry long after the user moved on, and closing whatever editor happens to
   * be open then would discard a different half-written reply.
   */
  const onSendSettled = useCallback((messageId: string) => {
    setReplyTo((cur) => (cur === messageId ? null : cur));
  }, []);
  const replySend = useReplySend(engine, toast, onSendSettled);
  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   */
  const sendReply = useCallback(
    (messageId: string) => {
      if (messageId !== replyTo) return;
      replySend.send(messageId, replyBody);
    },
    [replySend, replyTo, replyBody],
  );

  /**
   * SCREENING FROM ANYWHERE (slice U3) — one call site for every surface.
   *
   * The plan comes from `sender-screening.ts`, which decides whether the endpoint can be
   * used at all; this only dispatches it and tells the truth about what happened. Two
   * different toasts because there are two different outcomes, and the difference (a rule
   * for future mail, or no rule at all) is the thing a user needs to know.
   */
  const changeScreening = useCallback(
    (messageId: string, dest: ScreeningDest) => {
      setSenderMenu(null);
      const sender = senderScreening(reader, messageId);
      if (!sender) return;
      const plan = planScreeningChange(sender, dest);
      const place = PLACE_LABEL[dest] ?? dest;
      if (plan.mutations.length === 0) {
        toast(t("screening.toastAlready", { sender: sender.address, place }));
        return;
      }
      for (const m of plan.mutations) void engine.mutate(m);
      toast(
        plan.rule
          ? t("screening.toastRuled", { sender: sender.address, place, count: plan.moved })
          : t("screening.toastMoved", { sender: sender.address, place, count: plan.moved }),
      );
    },
    [engine, reader, toast, t],
  );

  const openSenderMenu = useCallback((messageId: string, anchor: HTMLElement | null) => {
    setSenderMenu({ messageId, ...placePicker(anchor) });
  }, []);

  /**
   * Clicking a sender's circle or address, in ANY list (U3).
   *
   * ONE capture-phase handler on the stage rather than one per view: `MessageRow` renders a
   * `<button>`, so a second interactive control cannot be nested inside it, and every list
   * in the product already stamps `data-id` with a message id. Capture runs before the
   * row's own click, so this opens the screening popover INSTEAD of moving the cursor.
   * Shift is left alone — that gesture belongs to the Ohbox's range selection.
   */
  const onStageClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (e.shiftKey) return;
      const el = e.target as HTMLElement;
      if (!el.closest?.(".row .av, .row .addr")) return;
      const id = el.closest<HTMLElement>(".row[data-id]")?.dataset.id;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      openSenderMenu(id, el.closest<HTMLElement>(".row"));
    },
    [openSenderMenu],
  );

  const toggleTag = useCallback(
    (messageId: string, tagId: string, assigned: boolean) => {
      const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
      void engine.mutate({ kind: "tag_assign", messageId, tagId, assigned });
      toast(assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }));
    },
    [engine, tags, toast, t],
  );

  const onMessageAction = useCallback(
    (action: MessageAction, m: EngineMessage) => {
      switch (action) {
        case "reply":
          // U4: inline, in place. This used to be `setReaderOpen(false); go("compose")` —
          // the message you were answering left the screen as you started answering it.
          openReply(m.id);
          break;
        case "draft":
          // The AI draft-review flow is still its own view (it is a card with sources and
          // a regenerate step, not a text box). It now leaves on Escape; see ComposeView.
          setReaderOpen(false);
          go("compose");
          break;
        case "later":
          if (m.triage?.state === "reply_later") {
            toast(
              t("ohbox.toastAlreadyQueued", {
                name: firstName(m),
                count: piles.replyLater.length,
              }),
            );
          } else {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "reply_later" });
            toast(t("ohbox.toastQueued"));
          }
          break;
        case "aside":
          void engine.mutate({ kind: "triage_set", messageId: m.id, state: "set_aside" });
          toast(t("ohbox.toastAside"));
          break;
        case "resurface": {
          const when = nextFridayNine(now);
          void engine.mutate({
            kind: "triage_set",
            messageId: m.id,
            state: "bubbled_up",
            bubbleUpAt: when,
          });
          toast(t("ohbox.toastResurface", { when: resurfaceLabel(when) }));
          break;
        }
        default: {
          // `move:<view>` — the destination travels with the action (gap C4). Before
          // this the whole branch was a toast reading "Demo — Move isn't wired yet.",
          // rendered on live accounts; the mutation was already on the wire.
          const view = action.slice("move:".length) as OhmailView;
          const folder = FOLDER_OF_VIEW[view];
          if (!folder || folder === m.folder) break;
          void engine.mutate({ kind: "move", messageId: m.id, folder });
          toast(t("ohbox.toastMoved", { place: PLACE_LABEL[view] ?? view }));
          break;
        }
      }
    },
    [engine, toast, t, piles.replyLater.length, now, openReply],
  );

  const readsMarkSeen = useCallback(
    (id: string) => {
      void engine.mutate({
        kind: "feed_mark_seen",
        messageIds: [id],
        upToId: partition.waterline?.afterId ?? id,
      });
    },
    [engine, partition.waterline?.afterId],
  );

  const openMessage = useCallback((m: EngineMessage) => {
    const view = VIEW_OF_FOLDER[m.folder];
    if (view === "ohbox") {
      setOhboxSel(m.id);
      go("ohbox");
    } else if (view === "reads") {
      setReadsCur(m.id);
      setJump({ view: "reads", id: m.id });
      go("reads");
    } else if (view === "receipts") {
      setReceiptsCur(m.id);
      setJump({ view: "receipts", id: m.id });
      go("receipts");
    } else if (view === "spam") {
      goScreener("spam");
    } else if (view === "screened") {
      goScreener("screened");
    } else {
      go("screener");
    }
  }, []);

  const startFR = useCallback(() => {
    setFrValues({});
    setFr({ step: 0, items: piles.replyLater });
  }, [piles.replyLater]);

  /**
   * The message the current view has under the cursor, whichever view that is.
   *
   * `s` and `e` mean the same thing everywhere or they mean nothing; without one answer to
   * "which message?" they would have to be re-declared per view with per-view semantics,
   * which is the state U2 exists to end.
   */
  const focused: EngineMessage | null =
    route.view === "ohbox"
      ? selectedOhbox
      : route.view === "reads"
        ? (readsCur ? (reader.get<EngineMessage>("message", readsCur) ?? null) : null)
        : route.view === "receipts"
          ? (receiptsCur ? (reader.get<EngineMessage>("message", receiptsCur) ?? null) : null)
          : null;

  /**
   * ESCAPE HAS ONE OWNER, and this ORDERED LIST is it (slices U2, S24).
   *
   * Before the registry, Escape was handled by `Reader` (close), `AppShell` (the (i)
   * panel), `OhboxView` (clear the selection), `ScreenerView` (leave the mobile preview)
   * and the palette input — five listeners with no agreed order, which is why the reply
   * editor could not simply add a sixth. `Reader` now takes `closeOnEscape={false}` and
   * this closes the innermost thing that is open.
   *
   * ── IT USED TO BE TWO LISTS, AND THAT WAS THE BUG UNDERNEATH S24 ────────────────────
   *
   * An `if/else if` cascade decided WHAT Escape closes, and a parallel boolean expression
   * beside it decided WHETHER Escape was live at all. Two enumerations of the same eight
   * overlays, and every new overlay had to be added to both — a drift the type system
   * cannot see, in the binding whose whole job is precedence. One array now answers both
   * questions: `find` gives the innermost open overlay, and its absence IS "nothing is
   * open". Adding an overlay is one line in one place, and forgetting it makes Escape
   * inert for that overlay, which is visible on first use rather than subtly wrong.
   *
   * Order is innermost-first and is the list's own order — the palette sits over the sheet,
   * which sits over a popover, which sits over the reader.
   */
  const escapeLayers: Array<[open: boolean, close: () => void]> = [
    [palette.open, palette.closePalette],
    [shortcutsOpen, () => setShortcutsOpen(false)],
    [senderMenu != null, () => setSenderMenu(null)],
    [picker != null, () => setPicker(null)],
    [aboutOpen, () => setAboutOpen(false)],
    [fr != null, () => setFr(null)],
    [replyTo != null, () => setReplyTo(null)],
    [readerOpen, () => setReaderOpen(false)],
  ];
  const closeInnermost = escapeLayers.find(([open]) => open)?.[1] ?? null;

  /**
   * AN OPEN OVERLAY OWNS ESCAPE WHILE IT IS OPEN (slice S24).
   *
   * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
   *
   * The Ohbox's "clear the selection" is a VIEW binding and Escape's cascade was a GLOBAL
   * one, so a picked set outranked the cascade UNCONDITIONALLY: with two rows selected,
   * Escape cleared the selection instead of closing the `?` sheet, the ⌘K palette or the
   * screening popover the user was actually looking at. It had been patched once, for the
   * reply editor only, by teaching the Ohbox's binding to stand down when
   * `chrome.replyTo != null` — a predicate in a view, naming one shell overlay out of
   * eight. That is the shape that rots: the view cannot see the other seven, and the next
   * overlay added would not be in the condition either.
   *
   * ── THE RULE ───────────────────────────────────────────────────────────────────────
   *
   * A third scope, ABOVE view layers (`keymap.tsx`), holding exactly one binding: Escape,
   * live only while something is open. So the precedence is stated as what it actually is
   * — an open overlay is inner to a selection — instead of being re-derived per case:
   *
   *   · nothing open  ⇒ this is disabled, the registry falls through to the view layer,
   *                     and Escape clears the selection exactly as before;
   *   · anything open ⇒ this wins over every view binding there will ever be, closes the
   *                     innermost overlay, and the selection survives untouched.
   *
   * It cannot rot the way the per-case predicate did, because no view names an overlay any
   * more and this binding names none either: it is gated by `escapeLayers` above, the same
   * single list that decides what Escape closes. An overlay that Escape can close is
   * therefore an overlay that outranks a selection, by construction and not by memory.
   */
  useKeyBindings(
    [
      {
        chord: "Escape",
        group: "app",
        label: t("shortcuts.escape"),
        inInput: true,
        disabled: closeInnermost == null,
        run: () => closeInnermost?.(),
      },
    ],
    "overlay",
  );

  /* ── the global key map. Views declare their own; see `keymap.tsx` for precedence. ── */
  const globalKeys: KeyBinding[] = [
    { chord: "g o", group: "navigate", label: t("shortcuts.goOhbox"), run: () => go("ohbox") },
    { chord: "g r", group: "navigate", label: t("shortcuts.goReads"), run: () => go("reads") },
    { chord: "g e", group: "navigate", label: t("shortcuts.goReceipts"), run: () => go("receipts") },
    { chord: "g s", group: "navigate", label: t("shortcuts.goScreener"), run: () => go("screener") },
    { chord: "g t", group: "navigate", label: t("shortcuts.goTriage"), run: () => go("triage") },
    { chord: "/", group: "navigate", label: t("shortcuts.search"), run: () => go("search") },
    { chord: "c", group: "app", label: t("shortcuts.compose"), run: () => go("compose") },
    {
      chord: "f",
      group: "message",
      label: t("shortcuts.replyRun"),
      disabled: piles.replyLater.length === 0,
      run: () => {
        setFrPending(true);
        go("triage");
      },
    },
    {
      chord: "r",
      group: "message",
      label: t("shortcuts.reply"),
      // Only the Ohbox renders a message pane to reply INSIDE; Reads and Receipts are
      // skim streams. Listed everywhere, inert where there is nothing to reply in.
      disabled: route.view !== "ohbox" || selectedOhbox == null,
      run: () => selectedOhbox && openReply(selectedOhbox.id),
    },
    {
      // SENDING FROM THE KEYBOARD (slice U4b). `inInput` is not optional: the editor takes
      // focus the moment it opens, so without it the one place the shortcut is for is the one
      // place it would not fire — the same reasoning Escape's binding already carries.
      //
      // `mod+Enter` and not bare `Enter`, because the field is a multi-line textarea where
      // Enter is a newline. The four views bind bare `Enter` as "open the row" and none of
      // them sets `inInput`, so the typing guard already keeps them out of this editor; this
      // chord does not collide with any of them.
      //
      // It calls the same `sendReply` the button does, so the send lock, the empty-body guard
      // and the whole failure surface apply identically — there is no second path to SMTP.
      chord: "mod+Enter",
      group: "message",
      label: t("shortcuts.sendReply"),
      inInput: true,
      disabled: replyTo == null,
      run: () => replyTo && sendReply(replyTo),
    },
    {
      chord: "s",
      group: "message",
      label: t("shortcuts.screen"),
      disabled: focused == null,
      run: () => {
        if (!focused) return;
        openSenderMenu(
          focused.id,
          document.querySelector<HTMLElement>(`.view .row[data-id="${CSS.escape(focused.id)}"]`),
        );
      },
    },
    {
      // U6. `f` starts a Reply Run over the Answer Later pile, and until this binding there
      // was NO keyboard way to put anything INTO that pile — `later` was reachable only from
      // the reader's action menu. A keyboard user could start a run they could not fill, and
      // `f` sat permanently `disabled` for them. Found while writing the S15 guard, which is
      // blocked on exactly this.
      //
      // `a` for Answer, next to the pile's own name. Free: the bound set was
      // ? / b c e f r s, `g`-prefixed jumps, mod+k and Escape.
      chord: "a",
      group: "message",
      label: t("shortcuts.answerLater"),
      disabled: focused == null,
      run: () => focused && onMessageAction("later", focused),
    },
    {
      chord: "e",
      group: "message",
      // ohmail has no Archive: "out of the way, still here" is the Park pile. Naming it
      // Park rather than Archive is the honest mapping, not a missing feature.
      label: t("shortcuts.park"),
      disabled: focused == null,
      run: () => focused && onMessageAction("aside", focused),
    },
    {
      chord: "b",
      group: "message",
      label: t("shortcuts.resurface"),
      disabled: focused == null,
      run: () => focused && onMessageAction("resurface", focused),
    },
    {
      chord: "mod+k",
      group: "app",
      label: t("shortcuts.palette"),
      inInput: true,
      run: () => palette.toggle(),
    },
    {
      chord: "?",
      group: "app",
      label: t("shortcuts.sheet"),
      run: () => setShortcutsOpen((o) => !o),
    },
    /* Escape is NOT here. It is registered above, in the `overlay` scope, because an open
       overlay has to outrank a view's bindings and a global one does not. */
  ];
  useKeyBindings(globalKeys, "global");

  /* ── the palette command map (every command from the prototype) ── */
  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "go-ohbox", label: t("palette.goOhbox"), keys: ["g", "o"], run: () => go("ohbox") },
      { id: "go-reads", label: t("palette.goReads"), keys: ["g", "r"], run: () => go("reads") },
      { id: "go-receipts", label: t("palette.goReceipts"), keys: ["g", "e"], run: () => go("receipts") },
      { id: "go-screener", label: t("palette.openScreener"), keys: ["g", "s"], run: () => go("screener") },
      { id: "scn-screened", label: t("palette.screenerScreened"), run: () => goScreener("screened") },
      { id: "scn-spam", label: t("palette.screenerSpam"), run: () => goScreener("spam") },
      {
        id: "fr",
        label: t("palette.startFR"),
        keys: ["f"],
        run: () => {
          setFrPending(true);
          go("triage");
        },
      },
      { id: "search", label: t("palette.search"), keys: ["/"], run: () => go("search") },
      { id: "compose", label: t("palette.newMessage"), keys: ["c"], run: () => go("compose") },
      { id: "settings", label: t("palette.openSettings"), run: () => go("settings") },
    ];
    tags.forEach((tag, i) => {
      list.push({
        id: `tag-${tag.id}`,
        label: t("palette.tagToggle", { name: tag.name }),
        icon: "tag",
        ...(i === 0 ? { keys: ["t"] } : {}),
        run: () => {
          if (selectedOhbox) {
            toggleTag(selectedOhbox.id, tag.id, !selectedOhbox.labels.includes(tag.id));
          }
        },
      });
    });
    for (const tag of tags) {
      list.push({
        id: `goto-tag-${tag.id}`,
        label: t("palette.goTag", { name: tag.name }),
        icon: "tag",
        run: () => goTag(tag.id),
      });
    }
    list.push({ id: "theme", label: t("palette.toggleTheme"), run: () => theme.toggle() });
    list.push({
      id: "resurface",
      label: t("palette.resurfaceSel"),
      keys: ["b"],
      run: () => {
        if (selectedOhbox) onMessageAction("resurface", selectedOhbox);
      },
    });
    return list;
  }, [t, tags, selectedOhbox, toggleTag, theme, onMessageAction, startFR]);

  /* ── the rail ── */
  const railGroups: RailGroup[] = useMemo(
    () => [
      {
        items: [
          {
            id: "ohbox",
            label: t("rail.ohbox"),
            count: ohbox.newForYou.length,
            hot: true,
            title: t("rail.ohboxTitle", {
              unread: ohbox.newForYou.length,
              total: allOhbox.length,
            }),
          },
          {
            id: "reads",
            label: t("rail.reads"),
            count: readsUnread,
            title: t("rail.readsTitle", { count: readsUnread }),
          },
          {
            id: "receipts",
            label: t("rail.receipts"),
            count: receiptsUnread,
            title: t("rail.readsTitle", { count: receiptsUnread }),
          },
        ],
      },
      {
        items: [
          {
            id: "screener",
            label: t("rail.screener"),
            count: screener.waitingCount,
            hot: true,
            title: t("rail.screenerTitle", { count: screener.waitingCount }),
          },
        ],
      },
      {
        label: t("rail.triage"),
        items: [
          { id: "triage", label: t("rail.replyLater"), count: piles.replyLater.length },
          { id: "triage-aside", label: t("rail.setAside"), count: piles.setAside.length },
          { id: "triage-resurface", label: t("rail.resurface"), count: piles.resurface.length },
        ],
      },
      // TAGS ARE THEIR OWN GROUP, not a sub-item of Triage. They were nested under it, which
      // said the wrong thing about what they are: triage piles are three fixed places a
      // message can sit, and tags are a cross-cutting dimension over every view (invariant:
      // "Tags (never folders)"). Filing the second under the first made tags read as a fourth
      // pile. Own group, own label, and it stands even when empty — a collapsed group with a
      // count of zero is how someone learns the feature exists.
      {
        // No group label: `TagsGroup` renders its own heading, so setting both printed
        // "Tags" twice in the rail. Caught in the live walkthrough.
        items: [],
        tags: {
          label: t("rail.tags"),
          defaultOpen: true,
          // Persisted, because a rail that springs back open on every reload is a rail that
          // ignores the person using it. `RailNav` stays uncontrolled-by-default so the
          // desktop shell, which has no `localStorage`, keeps working untouched.
          open: tagsOpen,
          onOpenChange: setTagsOpen,
          items: tagGroups.map((g) => ({
            id: g.tag.id,
            label: g.tag.name,
            hue: hueOf(g.tag),
            count: g.messages.length,
          })),
        },
      },
      {
        items: [
          { id: "search", label: t("rail.search"), kbdHint: "/" },
          { id: "settings", label: t("rail.settings") },
        ],
      },
    ],
    [t, ohbox.newForYou.length, allOhbox.length, readsUnread, receiptsUnread, screener.waitingCount, piles, tagGroups],
  );

  const activeRailId =
    route.view === "tag"
      ? undefined
      : route.view === "triage"
        ? "triage"
        : route.view === "compose"
          ? undefined
          : route.view;

  const viewTitles: Record<string, string> = {
    ohbox: t("rail.ohbox"),
    reads: t("rail.reads"),
    receipts: t("rail.receipts"),
    screener: t("rail.screener"),
    triage: t("rail.triage"),
    search: t("rail.search"),
    compose: t("rail.compose"),
    settings: t("rail.settings"),
  };
  const mobileTitle =
    route.view === "tag"
      ? (tagGroups.find((g) => g.tag.id === route.tagId)?.tag.name ?? t("rail.tags"))
      : (viewTitles[route.view] ?? t("rail.ohbox"));

  /* ── views ── */
  const tagGroup =
    route.view === "tag" ? tagGroups.find((g) => g.tag.id === route.tagId) : undefined;
  const effectiveView = route.view === "tag" && !tagGroup ? "ohbox" : route.view;

  const frFinished = fr != null && fr.step >= fr.items.length;
  const frItem = fr && !frFinished ? fr.items[fr.step] : undefined;

  /**
   * THE CONVERSATION, for whichever message a pane is rendering (slice P6b).
   *
   * `engine.read()` is called at INVOCATION time, not closed over, so the callback is
   * stable across version bumps — the chrome context below would otherwise churn for every
   * consumer on every delta — while what it returns is always the current mirror, including
   * the optimistic overlay. A `useMemo` keyed on `version` would give the same freshness and
   * a new identity every bump; a `useMemo` that forgot `version` would go stale, which is
   * exactly the bug `senderMenuFor` carries a `version` dep to avoid.
   */
  const conversationOf = useCallback(
    (messageId: string) => threadOf(engine.read(), messageId),
    [engine],
  );

  const chrome = useMemo(
    () => ({
      replyTo, replyBody, onReplyBody, closeReply, sendReply,
      replySendState: replySend.stateOf,
      openSenderMenu, conversationOf,
    }),
    [replyTo, replyBody, onReplyBody, closeReply, sendReply, replySend, openSenderMenu, conversationOf],
  );

  // Resolved here rather than inside the popover so a sender whose last message has just
  // been moved out from under it closes the popover instead of rendering an empty one.
  const senderMenuFor = useMemo(
    () => (senderMenu ? senderScreening(reader, senderMenu.messageId) : null),
    [senderMenu, reader, version],
  );

  return (
    <MessageChromeProvider value={chrome}>
    <div className="app-root">
      <div className="shell">
        {demo && !ribbonGone ? (
          <div className="demo-ribbon">
            <span>
              {t.rich("ribbon.label", { b: (chunks) => <b>{chunks}</b> })}
            </span>
            <button
              type="button"
              onClick={() => {
                setRibbonGone(true);
                try {
                  sessionStorage.setItem("ohmail.demo-ribbon", "gone");
                } catch {
                  /* fine — dismissed for this render only */
                }
              }}
            >
              {t("ribbon.dismiss")}
            </button>
          </div>
        ) : null}

        {/* A FAILING SYNC, IN EVERY VIEW (P17). Renders nothing while the loop is healthy,
            and nothing at all in the demo or on the desktop. A sibling of the deck rather
            than a child of any view, so it is outside every list's scroller and no view can
            forget it — see `SyncBar.tsx` for why that placement is the fix and the sentence
            is not. */}
        <SyncBar />

        <div className="topbar">
          <button
            type="button"
            className="tb-btn"
            aria-label={t("rail.openNav")}
            onClick={() => setRailOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <b>{mobileTitle}</b>
          <button type="button" className="tb-btn" onClick={palette.openPalette}>
            ⌘K
          </button>
        </div>

        <div className="deck">
          <RailNav
            className={railOpen ? "open" : undefined}
            composeLabel={t("rail.compose")}
            onCompose={() => {
              setRailOpen(false);
              go("compose");
            }}
            composeActive={route.view === "compose"}
            groups={railGroups}
            activeId={activeRailId}
            onNavigate={(id) => {
              setRailOpen(false);
              if (id.startsWith("triage")) go("triage");
              else go(id as "ohbox");
            }}
            activeTagId={route.tagId ?? undefined}
            onNavigateTag={(id) => {
              setRailOpen(false);
              goTag(id);
            }}
            mailboxesLabel={t("rail.mailboxes")}
            mailboxes={mailboxes.map((m) => ({
              name: (m as { name?: string }).name ?? m.address,
              hint: (m as { railHint?: string }).railHint ?? m.provider,
            }))}
            footer={account?.email}
            ariaLabel={t("rail.ariaMain")}
          />

          <main className="stage" onClickCapture={onStageClickCapture}>
            {effectiveView === "ohbox" ? (
              <OhboxView
                demo={demo}
                newForYou={ohbox.newForYou}
                previouslySeen={ohbox.previouslySeen}
                tags={tags}
                now={now}
                selectedId={selectedOhbox?.id ?? null}
                onSelect={setOhboxSel}
                onEnterReader={() => setReaderOpen(true)}
                onMarkSeen={markSeen}
                doorbellInitials={waitingLive.map((w) => w.initial)}
                doorbellHues={waitingLive.map((w) => avatarHue(w.from.address))}
                doorbellCount={screener.waitingCount}
                onDoorbell={() => go("screener")}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                onAttachment={() => toast(t("ohbox.toastAttachment"))}
              />
            ) : null}

            {effectiveView === "reads" ? (
              <ReadsView
                partition={partition}
                tags={tags}
                now={now}
                cur={readsCur}
                onCur={setReadsCur}
                aiChip={aiChip}
                chipState={chipState}
                onChipState={setChipState}
                markSeen={readsMarkSeen}
                isSeen={(m) => !m.unread}
                jumpTo={jump?.view === "reads" ? jump.id : null}
                onJumped={() => setJump(null)}
              />
            ) : null}

            {effectiveView === "receipts" ? (
              <ReceiptsView
                groups={receiptGroups}
                tags={tags}
                now={now}
                cur={receiptsCur}
                onCur={setReceiptsCur}
                unreadCount={receiptsUnread}
                isUnread={receiptsIsUnread}
                markSeen={(id) => markSeen([id], false)}
                jumpTo={jump?.view === "receipts" ? jump.id : null}
                onJumped={() => setJump(null)}
              />
            ) : null}

            {effectiveView === "screener" ? (
              <ScreenerView
                state={screener}
                segment={route.screenerSegment}
                selection={scnSel}
                onSelect={(segment, id) => setScnSel((s) => ({ ...s, [segment]: id }))}
                full={screenerFull}
                onFull={setScreenerFull}
              />
            ) : null}

            {effectiveView === "triage" ? (
              <TriageView
                piles={piles}
                frDone={frDone}
                onStartFR={startFR}
              />
            ) : null}

            {effectiveView === "tag" && tagGroup ? (
              <TagView
                tag={tagGroup.tag}
                messages={tagGroup.messages}
                tags={tags}
                now={now}
                onOpen={openMessage}
              />
            ) : null}

            {effectiveView === "search" ? (
              <SearchView
                engine={engine}
                version={version}
                now={now}
                query={searchQuery}
                onQuery={setSearchQuery}
                onOpen={(hit: SearchHit) => openMessage(hit.message)}
                onServerSearch={() => toast(t("search.toastServer"))}
              />
            ) : null}

            {effectiveView === "compose" ? (
              <ComposeView engine={engine} draft={draft} />
            ) : null}

            {effectiveView === "settings" ? (
              <SettingsView
                mailboxes={mailboxes}
                tags={tags}
                tagCounts={Object.fromEntries(
                  tagGroups.map((g) => [g.tag.id, g.messages.length]),
                )}
                /* `demo` is the ENGINE's answer, not the server's floor (see the note on
                   AppShell): `?demo=1` runs on fixtures with no session and no account, so
                   an Account pane there would offer to erase something that does not
                   exist. */
                accountSection={demo ? undefined : accountSection}
                /* Same rule: `?demo=1` has no session, so "connect a mailbox" there would
                   be a form posting to a server this tab is not talking to. The demo keeps
                   the fixture list, which is the honest thing for it to show. */
                mailboxSection={demo ? undefined : mailboxSection}
                billingSection={demo ? undefined : billingSection}
              />
            ) : null}
          </main>
        </div>
      </div>

      {railOpen ? (
        <div
          className="rail-bg open"
          aria-label={t("rail.closeNav")}
          onClick={() => setRailOpen(false)}
        />
      ) : null}

      {/* READING — the exhale. Escape is the registry's (see `escapeCascade`): with the
          reader owning it too, closing the inline reply would also close the message it
          was quoting, in the same keypress. */}
      <Reader
        open={readerOpen && selectedOhbox != null}
        closeOnEscape={false}
        onClose={() => setReaderOpen(false)}
      >
        {selectedOhbox ? (
          <MessagePane
            message={selectedOhbox}
            tags={tags}
            now={now}
            onAction={(a) => onMessageAction(a, selectedOhbox)}
            onAddTag={openTagPicker}
            onAttachment={() => toast(t("ohbox.toastAttachment"))}
          />
        ) : (
          <span />
        )}
      </Reader>

      {/* Reply Run */}
      <FocusReplyOverlay
        open={fr != null}
        step={fr?.step ?? 0}
        total={fr?.items.length ?? 0}
        message={
          frItem
            ? {
                subject: frItem.subtitle ?? "",
                from: frItem.title,
                preview: frItem.preview ?? "",
              }
            : undefined
        }
        value={fr ? (frValues[fr.step] ?? "") : ""}
        onChange={(v) => fr && setFrValues((vals) => ({ ...vals, [fr.step]: v }))}
        onDone={() => {
          if (!fr || !frItem) return;
          if (frItem.messageId) {
            void engine.mutate({
              kind: "triage_set",
              messageId: frItem.messageId,
              state: "none",
            });
          }
          setFrDone((s) => new Set(s).add(frItem.messageId ?? frItem.title));
          setFr({ ...fr, step: fr.step + 1 });
        }}
        onSkip={() => fr && setFr({ ...fr, step: fr.step + 1 })}
        onClose={() => setFr(null)}
        doneLabel={t("triage.frDone")}
        skipLabel={t("triage.frSkip")}
      />

      {/* Command palette */}
      <CommandPalette
        open={palette.open}
        onClose={palette.closePalette}
        commands={commands}
        placeholder={t("palette.placeholder")}
        emptyHint={t("palette.empty")}
      />

      {/* Tag picker */}
      {picker ? (
        <TagPicker
          state={picker}
          tags={tags}
          assigned={
            reader.get<EngineMessage>("message", picker.forId)?.labels ?? []
          }
          onToggle={(tagId, assigned) => toggleTag(picker.forId, tagId, assigned)}
          onClose={() => setPicker(null)}
        />
      ) : null}

      {/* Sender screening (U3) — reachable from every list and every open message. */}
      {senderMenuFor ? (
        <SenderMenu
          state={senderMenu!}
          sender={senderMenuFor}
          onChoose={(dest) => changeScreening(senderMenu!.messageId, dest)}
          onClose={() => setSenderMenu(null)}
        />
      ) : null}

      {/* The `?` sheet (U2) — generated from the registry above, never hand-written. */}
      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* (i) — AND IT MUST KNOW WHICH MODE IT IS IN.
          This panel used to be unconditional: every signed-in customer opened it and read
          "ohmail — demo / This is the real ohmail client running on a fixture mailbox…".
          It was the implementation talking — the sentence explained the sync engine's
          bootstrap to somebody who wanted to know whether their own mail was arriving — and
          on a live account it was also simply false.
          Live now shows the facts that answer the question actually being asked (which
          mailbox, synced when, which build), supplied by `aboutSection` because this shared
          shell cannot call the API. The demo keeps a demo panel, because there it is true. */}
      {aboutOpen ? (
        <div className="about" role="dialog" aria-label={demo ? t("about.title") : t("about.titleLive")}>
          <button
            type="button"
            className="x"
            aria-label={t("about.close")}
            onClick={() => setAboutOpen(false)}
          >
            <Icon name="x" />
          </button>
          <h3>
            <Icon name="open" /> {demo ? t("about.title") : t("about.titleLive")}
          </h3>
          {demo ? (
            <>
              <p>{t("about.p1")}</p>
              <p>{t("about.p2")}</p>
            </>
          ) : (
            aboutSection
          )}
          {/* This used to be a hand-typed key list ("Keyboard: j/k, ↵, y + o/r/c/n/x…")
              which is a SECOND copy of the bindings and had already drifted from them.
              It points at the sheet, which is generated from the registry. */}
          <p>{t("about.keys")}</p>
        </div>
      ) : null}

      {/* floating dock */}
      <Dock>
        <DockKey label={t("dock.command")} kbdHint="⌘K" onPress={palette.openPalette} />
        <span className="dock-sep" />
        <DockIcon icon="sun" label={t("dock.theme")} onPress={theme.toggle} />
        <DockIcon
          icon="info"
          label={t("dock.about")}
          onPress={() => setAboutOpen((o) => !o)}
        />
      </Dock>
    </div>
    </MessageChromeProvider>
  );
}
