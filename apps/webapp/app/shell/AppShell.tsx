"use client";

/**
 * The MailOh client shell: rail + views over ONE engine, the reader
 * exhale, Focus & Reply, the ⌘K palette, the tag picker, the dock and
 * the demo ribbon. Every list, count and mutation runs through
 * @mailoh/client-engine — the shell only owns view state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  DEMO_NOW,
  VIEW_OF_FOLDER,
  ohboxView,
  readsPartition,
  receiptsByDay,
  tagsCrossView,
  triagePiles,
  type EngineDraft,
  type EngineMessage,
  type SearchHit,
  type TagDTO,
  type TriagePileEntry,
} from "@mailoh/client-engine";
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
} from "@mailoh/ui";
import { EngineProvider, useDemoMode, useEngine, useEngineVersion } from "./engine";
import { firstName, hueOf, nextFridayNine, resurfaceLabel } from "./format";
import { MessagePane, type MessageAction } from "./MessagePane";
import { useScreenerState } from "./screener-state";
import { TagPicker, placePicker, type TagPickerState } from "./TagPicker";
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

interface ReadsAiChipEntity {
  afterId: string;
  label: string;
  approvedLabel: string;
  correctedLabel: string;
}

const typingGuard = (e: KeyboardEvent): boolean =>
  /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");

/**
 * `demo` here is the SERVER's answer, and it is only a floor — `EngineProvider` re-derives
 * the mode from the real URL on the client and publishes what the engine was actually built
 * in. The chrome below reads THAT (`useDemoMode`), so the ribbon and the frozen demo clock
 * can never disagree with the adapter the data is coming from.
 */
export function AppShell({ demo }: { demo: boolean }) {
  return (
    <EngineProvider demo={demo}>
      <ShellInner />
    </EngineProvider>
  );
}

function ShellInner() {
  const demo = useDemoMode();
  const t = useTranslations();
  const engine = useEngine();
  const version = useEngineVersion();
  const reader = engine.read();
  const toast = useToast();
  const theme = useTheme();
  const route = useHashRoute();
  const palette = useCommandPalette();
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
  const [picker, setPicker] = useState<TagPickerState | null>(null);
  const [chipState, setChipState] = useState<ReadsChipState>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [receiptsSeen, setReceiptsSeen] = useState<Set<string>>(() => new Set());
  const [jump, setJump] = useState<{ view: "reads" | "receipts"; id: string } | null>(null);
  const [fr, setFr] = useState<{ step: number; items: TriagePileEntry[] } | null>(null);
  const [frValues, setFrValues] = useState<Record<number, string>>({});
  const [frDone, setFrDone] = useState<Set<string>>(() => new Set());
  const [ribbonGone, setRibbonGone] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("mailoh.demo-ribbon") === "gone") setRibbonGone(true);
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

  const receiptsIsUnread = useCallback(
    (m: EngineMessage) => m.unread && !receiptsSeen.has(m.id),
    [receiptsSeen],
  );
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
      if (route.view !== "screener") setScreenerFull(false);
    }
    prevRoute.current = route;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  /* ── global keys: / search · c compose (screener owns c while filing) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        go("search");
        return;
      }
      if (e.key === "c") {
        const screenerOwnsC =
          route.view === "screener" &&
          route.screenerSegment === "waiting" &&
          waitingLive.length > 0;
        if (!screenerOwnsC) go("compose");
        return;
      }
      if (e.key === "Escape" && aboutOpen) setAboutOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [route, waitingLive.length, aboutOpen]);

  /* ── shared actions ── */
  const openTagPicker = useCallback((messageId: string, anchor: HTMLElement | null) => {
    setPicker({ forId: messageId, ...placePicker(anchor) });
  }, []);

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
        case "draft":
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
        case "move":
          toast(t("ohbox.toastMove"));
          break;
      }
    },
    [engine, toast, t, piles.replyLater.length, now],
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
          go("triage");
          setTimeout(startFR, 130);
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
        tags: {
          label: t("rail.tags"),
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

  return (
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
                  sessionStorage.setItem("mailoh.demo-ribbon", "gone");
                } catch {
                  /* fine — dismissed for this render only */
                }
              }}
            >
              {t("ribbon.dismiss")}
            </button>
          </div>
        ) : null}

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

          <main className="stage">
            {effectiveView === "ohbox" ? (
              <OhboxView
                newForYou={ohbox.newForYou}
                previouslySeen={ohbox.previouslySeen}
                tags={tags}
                now={now}
                selectedId={selectedOhbox?.id ?? null}
                onSelect={setOhboxSel}
                onEnterReader={() => setReaderOpen(true)}
                doorbellInitials={waitingLive.map((w) => w.initial)}
                doorbellCount={screener.waitingCount}
                onDoorbell={() => go("screener")}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                onAttachment={() => toast(t("ohbox.toastAttachment"))}
                typingGuard={typingGuard}
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
                typingGuard={typingGuard}
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
                markSeen={(id) => setReceiptsSeen((s) => new Set(s).add(id))}
                jumpTo={jump?.view === "receipts" ? jump.id : null}
                onJumped={() => setJump(null)}
                typingGuard={typingGuard}
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
                typingGuard={typingGuard}
              />
            ) : null}

            {effectiveView === "triage" ? (
              <TriageView
                piles={piles}
                frDone={frDone}
                onStartFR={startFR}
                typingGuard={typingGuard}
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

      {/* READING — the exhale */}
      <Reader open={readerOpen && selectedOhbox != null} onClose={() => setReaderOpen(false)}>
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

      {/* Focus & Reply */}
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

      {/* About */}
      {aboutOpen ? (
        <div className="about" role="dialog" aria-label={t("about.title")}>
          <button
            type="button"
            className="x"
            aria-label={t("about.close")}
            onClick={() => setAboutOpen(false)}
          >
            <Icon name="x" />
          </button>
          <h3>
            <Icon name="open" /> {t("about.title")}
          </h3>
          <p>{t("about.p1")}</p>
          <p>{t("about.p2")}</p>
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
  );
}
