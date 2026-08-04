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
  bodyOf,
  consentPartition,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  readsPartition,
  receiptsByDay,
  rulesList,
  senderKey,
  sendingMailboxId,
  tagsCrossView,
  threadOf,
  triagePiles,
  type ConsentPartition,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
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
  SettingsSection,
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
import { MessagePane, type BulkAction, type MessageAction } from "./MessagePane";
import { useMessageAttachments } from "./attachments";
import { useRemoteImages } from "./remote-images";
import { useConsentState } from "./consent-state";
import { useScreenerState } from "./screener-state";
import { useScreenerSuggestions } from "./screener-suggest";
import { COMPOSE_SEND_KEY, useMailSend, readReplyDraft, writeReplyDraft } from "./mail-send";
import {
  composePlan,
  readComposeDraft,
  writeComposeDraft,
  EMPTY_COMPOSE,
  type ComposeFields,
} from "./compose";
import { TagPicker, placePicker, type TagPickerState } from "./TagPicker";
import { TagCreate, TAG_CREATE_ROW_ID } from "./TagCreate";
import { KeymapProvider, useKeyBindings, type KeyBinding } from "./keymap";
import { ShortcutSheet } from "./ShortcutSheet";
import { SyncBar } from "./SyncBar";
import { MailStateProvider, useMailState, type MailboxProbe } from "./MailStateProvider";
import {
  optionsFromFacts,
  optionsFromMirror,
  resolveComposeFrom,
  resolveReplyFrom,
} from "./compose-from";
import { MessageChromeProvider } from "./message-chrome";
import { SenderMenu, type SenderMenuState } from "./SenderMenu";
import { SenderAuditPanel, type SenderAuditState } from "./SenderAuditPanel";
import { attributeMessages } from "./sender-audit";
import {
  dispatchScreeningChange,
  planScreeningChange,
  senderScreening,
  type ScreeningDest,
  type ScreeningScope,
} from "./sender-screening";
import {
  go, goScreener, goTag, goTriage, useHashRoute,
  type ScreenerSegmentId, type TriagePileId,
} from "./routing";
import { HistoryView } from "../views/HistoryView";
import { SeedReviewView } from "../views/SeedReviewView";
import { OhboxView } from "../views/OhboxView";
import { ReadsView, type ReadsChipState } from "../views/ReadsView";
import { ReceiptsView } from "../views/ReceiptsView";
import { ScreenerView } from "../views/ScreenerView";
import { SearchView } from "../views/SearchView";
import { SettingsView, type MailboxEntity, type NotificationsMeta } from "../views/SettingsView";
import { TagView } from "../views/TagView";
import { TriageView } from "../views/TriageView";
import { ComposeView } from "../views/ComposeView";
import { usePersistedCount, usePersistedFlag, DISMISSED_FOREVER, UI_KEYS } from "./persisted-ui.js";

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
 * The stable name of a Reply Run entry: the message it stands for, or its title when it has
 * none (fixture-only `triage_item` rows, which nothing can be sent in reply to).
 *
 * `TriageView` already keys its done-marks this way. Naming it once means the map of typed
 * replies, the done set and the pile row cannot drift apart over what counts as "this item".
 */
const frKeyOf = (item: TriagePileEntry): string => item.messageId ?? item.title;

/**
 * THE RAIL ROW ↔ THE TRIAGE PILE, stated once.
 *
 * The rail's ids are historical (`triage`, `triage-aside`, `triage-resurface`) and the route's
 * are the piles' own names (`reply`, `aside`, `resurface`), so exactly one place converts. It
 * used to be `if (id.startsWith("triage")) go("triage")` — a conversion that threw the answer
 * away, which is the whole of the reported defect.
 */
const TRIAGE_PILE_OF_RAIL: Record<string, TriagePileId> = {
  triage: "reply",
  "triage-aside": "aside",
  "triage-resurface": "resurface",
};
const RAIL_OF_TRIAGE_PILE: Record<TriagePileId, string> = {
  reply: "triage",
  aside: "triage-aside",
  resurface: "triage-resurface",
};

/**
 * The rail ids the number keys reach, and the ONLY hand-written part of that feature: which
 * rows are piles. The ORDER is not written here — it is read off `railGroups` — so this list
 * cannot put `3` on the wrong row, only include or exclude a row from being numbered.
 */
const PILE_IDS: string[] = ["ohbox", "reads", "receipts", "screener", ...Object.keys(TRIAGE_PILE_OF_RAIL)];

/**
 * How many rail CLICKS before the number keys are mentioned once.
 *
 * Six, and the number is the argument: fewer reads as nagging somebody who has barely arrived,
 * and more means the hint lands after the habit has set. It counts clicks and not sessions
 * because clicking is the evidence — somebody who navigates by keyboard never reaches it, and
 * somebody who has clicked six times has told us what they are doing.
 */
const NAV_HINT_AFTER = 6;

/**
 * How long the located row stays marked, and how long we look for it.
 *
 * The flash is long enough to be seen after a route transition and short enough that it is
 * plainly a "here it is" rather than a selection — the cursor is what says selected, and this
 * must not compete with it. The search window is bounded because a row that never appears
 * means the message has left that pile, and looking forever would keep a `requestAnimationFrame`
 * loop alive for the life of the tab.
 */
const LOCATE_FLASH_MS = 1600;
const LOCATE_TIMEOUT_MS = 2000;

/**
 * WHERE A MESSAGE OPENS — the decision, with nothing else in it.
 *
 * Extracted from `openMessage` because the decision and the navigation are two things and
 * only one of them is checkable without a browser. Every arm below answers a reported
 * defect, and each is now an assertion rather than a paragraph.
 */
export type OpenTarget =
  | { kind: "ohbox"; id: string; reader: boolean }
  | { kind: "stream"; view: "reads" | "receipts"; id: string }
  | { kind: "screener"; segment: ScreenerSegmentId; row: string | null }
  | { kind: "reader"; id: string };

/**
 * @param narrow  the reading column is `display:none` — under 900px, `app.css`.
 * @param rowFor  the Screener row that speaks for this sender, or null when none is held.
 */
export function openTargetFor(
  m: EngineMessage,
  narrow: boolean,
  rowFor: (m: EngineMessage, segment: ScreenerSegmentId) => string | null,
): OpenTarget {
  const view: OhmailView | undefined = VIEW_OF_FOLDER[m.folder];
  if (view === "ohbox") return { kind: "ohbox", id: m.id, reader: narrow };
  if (view === "reads" || view === "receipts") return { kind: "stream", view, id: m.id };
  if (view === "screener" || view === "screened" || view === "spam") {
    const segment: ScreenerSegmentId =
      view === "screener" ? "waiting" : view === "screened" ? "screened" : "spam";
    return { kind: "screener", segment, row: rowFor(m, segment) };
  }
  // A folder no view owns. `Folder` is a closed six-member union today, so this is not
  // reachable from the wire — see `openMessage` for why it is written anyway.
  return { kind: "reader", id: m.id };
}

/**
 * The tags EVERY message in `ids` carries — the intersection, not the union.
 *
 * The picker renders a tag as assigned or not, and pressing an assigned one REMOVES it. Over
 * a set, "any of them has it" would therefore draw a half-applied tag as done, and the next
 * press would strip it from the two that had it instead of adding it to the eight that did
 * not — the opposite of what the row appears to offer. One message is the one-element case
 * of the same rule, so there is one derivation and no branch.
 */
function tagsOnAll(reader: EntityReader, ids: string[]): string[] {
  const lists = ids.map((id) => reader.get<EngineMessage>("message", id)?.labels ?? []);
  if (lists.length === 0) return [];
  return lists.reduce<string[]>(
    (acc, labels) => acc.filter((tagId) => labels.includes(tagId)),
    [...lists[0]!],
  );
}

/**
 * `demo` here is the SERVER's answer, and it is only a floor — `EngineProvider` re-derives
 * the mode from the real URL on the client and publishes what the engine was actually built
 * in. The chrome below reads THAT (`useDemoMode`), so the ribbon and the frozen demo clock
 * can never disagree with the adapter the data is coming from.
 */
export function AppShell({
  demo,
  resolveOwner,
  mailboxFacts,
  accountSection,
  mailboxSection,
  billingSection,
  securitySection,
  aboutSection,
}: {
  demo: boolean;
  resolveOwner?: OwnerResolver;
  /**
   * "What state are this account's mailboxes in?", as a function the SHELL does not know how
   * to answer — the seventh injected prop, and the same seam as `resolveOwner` for the same
   * reason: `scripts/publish-desktop.mjs` DENYs `app/api-client`, so this shared shell may not
   * call `GET /mailboxes`. The Cloud client supplies one from `(product)/mailbox/CloudShell`;
   * Desktop and the demo supply nothing, and the sync strip then withholds every mailbox-keyed
   * state rather than guessing one. See `MailStateProvider` — a probe MUST reject on failure,
   * because an empty array is a claim about the account.
   */
  mailboxFacts?: MailboxProbe;
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
  securitySection?: ReactNode;
  /**
   * The BODY of the (i) panel for a live account. Same seam again, and it has to be: the
   * facts worth showing there — which mailbox is connected and when it last synced — come
   * from `GET /mailboxes`, which this shared shell may not call. Absent ⇒ the demo body.
   */
  aboutSection?: ReactNode;
}) {
  return (
    <EngineProvider demo={demo} resolveOwner={resolveOwner}>
      {/* ONE keydown listener for the whole client. Outside `ShellInner` so
          every view mounted under it can declare bindings into the same table, which is
          also the table the `?` sheet is generated from. */}
      <KeymapProvider>
        <MailStateHost probe={mailboxFacts}>
          <ShellInner
            accountSection={accountSection}
            mailboxSection={mailboxSection}
            billingSection={billingSection}
            securitySection={securitySection}
            aboutSection={aboutSection}
          />
        </MailStateHost>
      </KeymapProvider>
    </EngineProvider>
  );
}

/**
 * The mail-state provider, hoisted ABOVE `ShellInner`.
 *
 * It used to be the outermost element of `ShellInner`'s own return, which meant the shell
 * PROVIDED the mailbox facts and could not read them. That was fine while the only consumers
 * were leaves — the strip, the Ohbox's empty pane, the injected Settings rows — and stopped
 * being fine the moment the From line needed the same facts on the WIRE: `sendReply` and the
 * compose plan are built in `ShellInner`, and a fact the shell cannot see is a fact the mutation
 * cannot carry. Moving the plan down into the views instead would have split the rule across
 * two components and left `sendReply` — whose signature is frozen behind `message-chrome.tsx` —
 * with no mechanism at all.
 *
 * `mirrored` moved up with it because the provider needs it and nothing else did.
 *
 * Nothing else changed position: `MessageChromeProvider` is still inside `ShellInner`, and the
 * three existing consumers read a context rather than a position, so none of them notices.
 */
function MailStateHost({ probe, children }: { probe?: MailboxProbe; children: ReactNode }) {
  const engine = useEngine();
  const version = useEngineVersion();
  /**
   * EVERY message in the MIRROR — Screener, Reads and Receipts included, not the Ohbox's rows.
   *
   * The progress signal. `MailStateProvider` folds it into a stateful growth reducer, and two
   * surfaces each sampling their own could disagree about whether the mirror is growing, so it
   * is sampled exactly once — here. The engine calls `notify()` once per drained page, so this
   * is live with no extra plumbing.
   */
  const mirrored = useMemo(() => engine.read().list("message").length, [engine, version]);
  return (
    <MailStateProvider probe={probe} mirrored={mirrored}>
      {children}
    </MailStateProvider>
  );
}

function ShellInner({ accountSection, mailboxSection, billingSection, securitySection, aboutSection }: {
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  billingSection?: ReactNode;
  securitySection?: ReactNode;
  aboutSection?: ReactNode;
}) {
  const demo = useDemoMode();
  const t = useTranslations();
  const engine = useEngine();
  const version = useEngineVersion();
  /**
   * The account's mailboxes as `GET /mailboxes` reported them, or `null` for "we cannot see"
   * (Desktop, demo, a Cloud tab before its first poll). Read here — rather than provided here,
   * as it once was — so the From line and the mutation it describes come from one source.
   */
  /**
   * `settled` travels to the piles as a PROP and not through `useMailState()` at their top
   * level, and that is a hard constraint rather than a preference: `ohbox-read-state.test.ts`
   * mounts `OhboxView` under `KeymapProvider` alone, and `useMailState` THROWS without a
   * provider by design (`MailStateProvider`'s header argues why a resting default would be
   * worse). A hook at the top of the view would take that harness down on mount, in every
   * branch, whether or not the list was empty.
   *
   * It is still derived exactly once, up here, from the one binding, which is the rule the
   * mail-state ladder established. A prop is how a derivation reaches a component that must be mountable alone.
   */
  const { mailboxes: facts, state: mailState } = useMailState();
  /**
   * THE MIRROR AS IT IS. Where each message physically sits on the server.
   *
   * Every mutation, every body open and the search index read from THIS reader and never from
   * the projected one below. A mutation reads a message's current folder to work out what it
   * is moving from; handing it a presentation would make it move from a place the server has
   * never heard of.
   */
  const reader = engine.read();
  const toast = useToast();
  const theme = useTheme();
  const route = useHashRoute();
  // The registry owns ⌘K (see `keymap.tsx`). Leaving the hook's own binding on as well
  // would toggle twice per keypress, which cancels out and never opens the palette.
  const palette = useCommandPalette({ bindKey: false });
  const now = useMemo(() => (demo ? DEMO_NOW : new Date()), [demo]);

  /* ── consent: what is PRESENTED, as opposed to where it sits ────────────────────────────
   *
   * Mail is shown by who sent it and whether the user has decided about them, not by which
   * folder the mail server has it in. A consented sender's whole backlog appears in the Ohbox
   * while every message of it is still physically in the Screener folder, and mail from
   * senders who went quiet years ago and were never screened presents in History. Nothing
   * moves; this is a filter over the same mirror.
   */
  const consent = useConsentState(!demo);
  /**
   * THE SEED REVIEW, OFFERED ONCE THE SERVER SAYS IT IS OWED — and dismissible.
   *
   * `seedConfirmedAt` is null until somebody has answered the review, which is also the state
   * a reset puts an account back into. The screen takes over the stage rather than sitting in
   * a corner, because it is the step that decides what the Ohbox contains and a mailbox that
   * has not been through it presents almost everything through the Screener.
   *
   * "Later" is a real answer and is remembered for this tab only. Nothing about the product is
   * gated on completing it — an account that never does simply screens every stranger, which
   * is the old behaviour and not a broken one — so a modal nobody could leave would be a wall
   * in front of somebody's mail for a step that is an offer.
   */
  const [seedDismissed, setSeedDismissed] = useState(false);
  const seedOwed = !demo && consent.known && consent.seedConfirmedAt === null && !seedDismissed;
  /**
   * The account's OWN addresses, from `GET /mailboxes` — passed EXPLICITLY and not left to
   * the default.
   *
   * `consentPartition` falls back to the mirror's `mailbox` entities, and a live `/sync` feed
   * carries none: the fallback is an empty set on exactly the surface that matters. With an
   * empty set the user is not recognised as themselves, and their own mail — a note to
   * themselves, a forward from another account — lands in their own Screener queue asking
   * whether they would like to hear from themselves. The demo's mirror DOES hold mailbox rows,
   * so no fixture test could ever have shown this.
   */
  const ownAddresses = useMemo(() => facts?.map((m) => m.address) ?? [], [facts]);
  const consentView: ConsentPartition | null = useMemo(
    // THE DEMO IS NOT PARTITIONED, and this is a fact about the data rather than a shortcut.
    //
    // Consent is derived from rules, and the fixture world has none — nobody has ever screened
    // anybody in it, because there is no server to screen against. Run over that mirror the
    // partition is right and useless: every read message older than the window is undecided
    // and dormant, so the whole curated world empties into History and the tour has nothing to
    // show. The fixture placements were AUTHORED to demonstrate the piles; they are not a
    // record of decisions this model can read, and pretending otherwise is what would be
    // dishonest here.
    //
    // AND NOTHING IS PARTITIONED BEFORE THE SERVER HAS ANSWERED. `consent.known` is false
    // until `GET /consent` lands, and false for ever if it never does. That is the safe
    // direction and the only one: partitioning on a guessed window would move mail out of the
    // piles and into History on the strength of a default the account may not be using, and a
    // request that simply failed would silently hide somebody's mail. Unpartitioned is what
    // the product did before consent existed — every message in the pile its folder names —
    // so a tab that cannot reach the endpoint degrades to showing MORE, never less.
    () =>
      demo || !consent.known
        ? null
        : consentPartition(reader, { now, dormancyDays: consent.dormancyDays, ownAddresses }),
    [demo, consent.known, reader, version, now, consent.dormancyDays, ownAddresses],
  );
  /**
   * The same mirror, with every message sitting where it is PRESENTED.
   *
   * Fed to the pile selectors and to nothing else. They group by folder, and after this
   * projection grouping by folder IS grouping by place — which is what lets History exist
   * without a single server-side move. History's own contents are absent from it entirely and
   * are read from `consentView.history`.
   */
  const presented = useMemo(
    () => (consentView ? presentationReader(reader, consentView) : reader),
    [reader, consentView],
  );

  /* ── engine-derived world (recomputed exactly when the mirror moves) ── */
  const ohbox = useMemo(() => ohboxView(presented), [presented, version]);
  const partition = useMemo(() => readsPartition(presented), [presented, version]);
  const receiptGroups = useMemo(() => receiptsByDay(presented, now), [presented, version, now]);
  const piles = useMemo(() => triagePiles(presented), [presented, version]);
  const tagGroups = useMemo(() => tagsCrossView(presented), [presented, version]);
  /**
   * History: dormant, undecided, and read by construction. Newest first.
   *
   * Every row is stamped with `physicalFolder`, which the projection does not do for History
   * (it removes those messages rather than re-placing them). That stamp is the single rule the
   * reading pane goes by: **if a message carries one, what you are looking at is not where it
   * is, and the pane says where it is.** Without it, History would be the one place in the
   * product that shows mail somewhere other than its folder and does not admit to it.
   */
  const history = useMemo(
    () => (consentView?.history ?? []).map((m) => ({ ...m, physicalFolder: m.folder })),
    [consentView],
  );
  const tags = useMemo(() => reader.list<TagDTO>("tag"), [reader, version]);
  /** Every rule the consent gate has written, newest first. */
  const rules = useMemo(() => rulesList(reader), [reader, version]);
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
  /** The demo's VIP block; `/sync` cannot emit `view_meta`, so a live account gets null. */
  const notifications = useMemo(
    () => reader.get<NotificationsMeta>("view_meta", "notifications") ?? null,
    [reader, version],
  );
  /**
   * Suggestions for the Screener — bought explicitly, never as a side effect of looking.
   *
   * `active` defers the one read this makes (what has already been bought) until the Screener
   * is actually open, and the DEMO is excluded outright: `?demo=1` promises that nothing
   * leaves the tab, and a suggestion fetched from a server would break that promise even
   * though it costs nothing. Two hooks rather than one because the mirror owns the rows and
   * this owns the advice about them; `useScreenerState` joins the second onto the first.
   */
  const suggestions = useScreenerSuggestions({
    active: !demo && route.view === "screener",
    toast,
  });
  const screener = useScreenerState(engine, version, toast, suggestions.suggestions);

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
  /**
   * THE READER IS A MESSAGE NOW, NOT A BOOLEAN.
   *
   * It was `readerOpen: boolean` rendering `selectedOhbox`, which made the overlay a
   * property of ONE pile: nothing outside the Ohbox could open a message, and a message in
   * a folder this client has no view for could not be opened at all. `openMessage` — the
   * one answer to "open it where it lives" — therefore had no way to finish the job for
   * search hits, which is where three of the four reported defects met: one missing call.
   *
   * An id and not the `EngineMessage`: the mirror re-issues entities on every delta, so a
   * held object would be a snapshot that stops tracking read-state, tags and triage the
   * moment the reader is open — exactly the window in which they change.
   */
  const [readerFor, setReaderFor] = useState<string | null>(null);
  /**
   * An open that has to SURVIVE the route transition it travels with (the `frPending`
   * shape, and for the same reason).
   *
   * `openMessage` navigates and opens in one gesture. The route-transition effect below
   * closes every overlay when the view changes — `setReaderFor(null)` included — so an
   * open written directly would be erased by the navigation that was meant to carry it.
   * The effect honours this flag in the same pass, after its own clear, so the order is a
   * rule rather than a race between two `setState`s and a `hashchange`.
   */
  const [readerPending, setReaderPending] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  /** The sidebar's "New tag" dialog. See `TagCreate` for why it is not an inline rail input. */
  const [tagCreateOpen, setTagCreateOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [senderMenu, setSenderMenu] = useState<SenderMenuState | null>(null);
  const [senderAudit, setSenderAudit] = useState<SenderAuditState | null>(null);
  /* The inline reply. The id and the text live HERE, not in `MessagePane`, because
     that pane is mounted twice whenever the reader is open — see `message-chrome.tsx`. */
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  /**
   * THE COMPOSE FORM, and why it lives up here rather than in `ComposeView`.
   *
   * The view is mounted only while `#/compose` is the route, so state inside it is erased by
   * navigating to the Ohbox and back — which is a message the user has to write twice. Holding
   * it in the shell is the same reason the reply body is held here, and it is also what lets
   * ONE `onSendSettled` clear whichever surface just delivered.
   *
   * The `localStorage` mirror on top of that is for a RELOAD, and it is read after mount for
   * the hydration reason `persisted-ui.ts` spells out: reading storage in the initializer makes
   * the server and client render different markup, and React resolves that by keeping the
   * server's — so the saved draft would be read and then silently discarded.
   */
  const [compose, setCompose] = useState<ComposeFields>(EMPTY_COMPOSE);
  useEffect(() => {
    const saved = readComposeDraft();
    if (saved.to || saved.subject || saved.body) setCompose(saved);
  }, []);
  // Survives a reload; see `persisted-ui.ts` for why it is local and read after mount.
  const [tagsOpen, setTagsOpen] = usePersistedFlag(UI_KEYS.tagsOpen, true);
  /**
   * HOW MANY TIMES THIS PERSON HAS REACHED A PILE BY CLICKING, and whether they have been
   * told there is a faster way. See `NAV_HINT_AFTER` for the whole argument.
   */
  const navClicks = usePersistedCount(UI_KEYS.navClicks);
  const [picker, setPicker] = useState<TagPickerState | null>(null);
  /**
   * WHO THE OPEN TAG PICKER IS ACTUALLY FOR.
   *
   * `TagPickerState` carries a single `forId` and belongs to another module, so the
   * SET a bulk tag edit acts on is held beside it rather than inside it. `null` means "the
   * one message in `picker.forId`", which is every existing caller; a list means the pick
   * set, and the two things the shell supplies — `assigned` and `onToggle` — are computed
   * over it. The picker component itself is unchanged and does not know the difference.
   */
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  const [chipState, setChipState] = useState<ReadsChipState>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [jump, setJump] = useState<{ view: "reads" | "receipts"; id: string } | null>(null);
  /**
   * THE ROW A SEARCH HIT LANDED ON — so the user can SEE where they were taken.
   *
   * Reported as: opening a search result "brings me to the mail in the screener but does not
   * highlight / select it". The routing was right and the arrival was silent: `openMessage`
   * set each view's cursor and navigated, and the user was handed a list with a cursor
   * somewhere in it and no indication which row they had just asked for. On the Screener,
   * where rows are SENDERS and the list is long, that is indistinguishable from having been
   * dropped at the top of a queue of strangers.
   *
   * This holds the id that the destination view puts in `data-id` — the message id in three
   * views, the SENDER row's id in the Screener — and is cleared once the flash has run.
   */
  const [located, setLocated] = useState<string | null>(null);
  const [fr, setFr] = useState<{ step: number; items: TriagePileEntry[] } | null>(null);
  /**
   * "Start a Reply Run once we are on Triage", as an INTENT rather than a race.
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
  /**
   * WHAT THE USER TYPED IN THE RUN, KEYED BY MESSAGE.
   *
   * This was `Record<number, string>` — keyed by the STEP INDEX — and nothing in the file read
   * it: the overlay wrote into it and `onDone` dispatched `triage_set → none` without ever
   * looking. Both halves are fixed here, and the re-keying is not cosmetic. A step index is
   * re-issued by the next run over a pile that has since moved, so "step 0's text" is a
   * different person's answer tomorrow; the message id is the only stable name for what was
   * written. It is also the key `writeReplyDraft`, `sendKeyOf` and `settle` already use, which
   * is what lets the run share one scratch buffer with the inline editor rather than inventing
   * a second one that `settle` would not know to clear.
   */
  const [frValues, setFrValues] = useState<Record<string, string>>({});
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

  /**
   * What the reader is showing, read from the mirror on every render.
   *
   * `?? null` and never a fallback to `selectedOhbox`: the reader shows the message it was
   * opened on or it shows nothing. A fallback here would re-create the defect
   * `OhboxView.open` documents — the sheet swapping to a message nobody opened the moment
   * the list re-partitioned underneath it.
   */
  const readerMessage: EngineMessage | null = readerFor
    ? (reader.get<EngineMessage>("message", readerFor) ?? null)
    : null;

  /**
   * Is the reading column absent? Under 900px `app.css` sets `display:none` on it, so a
   * split-pane selection shows the user nothing and "opened" has to mean the reader sheet.
   * One predicate, used by `openReply` (which had it inline) and by `openMessage`.
   */
  const readColumnHidden = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 900px)").matches === true,
    [],
  );

  /**
   * OPENING THE READER — THE ONE GATE.
   *
   * A live walk at 1440 found the reading experience rendered TWICE: the message painted in
   * the split's 752px column AND a 660px modal over it, with the ghost of that column — and
   * a second action bar — legible behind the sheet. The sheet is not a bigger view of the
   * message; it is a NARROWER duplicate of one already on screen.
   *
   * The rule was never in doubt, only unenforced: `readColumnHidden` is what "opened" means
   * on a width whose reading column is `display:none`, and `openReply` and `openMessage`
   * both already ask it. `OhboxView.open` was the one path that did not — it called
   * `onEnterReader` unconditionally, so ↵ and a second click on the selected row opened the
   * sheet at every width.
   *
   * IT IS GATED HERE AND NOT IN THE VIEW, deliberately. A view that asked the media query
   * itself would be a second copy of the predicate, live in one place and drifting from the
   * two that already exist — the shape the keyboard registry deleted from the (i) panel and
   * the action bar deleted from its own labels. The view's contract stays "the user asked to open this message"; what
   * that MEANS at a given width is the shell's answer, given once.
   *
   * The id still travels (see the call site): this narrows WHETHER, never WHAT.
   */
  const enterReader = useCallback(
    (messageId: string) => {
      if (readColumnHidden()) setReaderFor(messageId);
    },
    [readColumnHidden],
  );

  const waitingLive = screener.waiting.filter((w) => !screener.isExiting(w.id));

  /**
   * READ-STATE, for every view.
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

  /**
   * BODY HYDRATION, WIRED ONCE.
   *
   * Two callbacks, both stable across version bumps and both reading `engine.read()` at
   * INVOCATION time — the same discipline `conversationOf` documents below. A `useMemo` keyed
   * on `version` would give the same freshness and a new identity every bump, which for
   * `hydrateBody` means every view effect that depends on it re-firing once per delta.
   *
   * `hydrateBody` swallows nothing: `OhmailEngine.hydrateBody` never rejects, because its
   * outcome is a record the UI renders rather than an exception thrown at a React effect. The
   * `void` is therefore a statement that there is no promise worth awaiting here, not a
   * discarded error.
   */
  const hydrateBody = useCallback(
    (messageId: string) => {
      void engine.hydrateBody(messageId);
    },
    [engine],
  );
  const bodyOfMessage = useCallback(
    (m: EngineMessage) => bodyOf(engine.read(), m),
    [engine],
  );

  /*
   * Attachments for the OPEN message only, and released when it changes.
   *
   * The release is not tidiness: the engine hands out `blob:` URLs, and a URL nobody revokes
   * outlives the message that owned it for the life of the tab.
   */
  const attachments = useMessageAttachments(engine, selectedOhbox?.id ?? null, {
    onDownloadAllFailed: () => toast(t("ohbox.toastDownloadAllFailed")),
  });

  /*
   * The spy-pixel blocker's consent half. NOT keyed on the open message: consent is a
   * decision about a message and it outlives the selection, so a reader who loads images,
   * moves on and comes back does not have to press again.
   *
   * The failure sentence is the SERVER'S, through `messageOf`. There is no `en.json` key for
   * it deliberately: `api-client.ts`'s header is explicit that re-deriving these sentences in
   * the client is how somebody is told the wrong reason, and a consent write can fail for
   * reasons this shell has no way to enumerate.
   */
  const remoteImages = useRemoteImages({ onFailed: (message) => toast(message) });

  /**
   * THE OHBOX'S SPLIT-PANE SELECTION IS THE INTENT.
   *
   * Selecting a row IS opening the message here — the reading column renders it in full
   * message anatomy, which is precisely why the snippet-only bug was hardest to see in this
   * pile: a truncation inside that anatomy reads as a short email rather than as a missing
   * body. So the selected message's body is fetched, one id, on selection.
   *
   * It lives in the shell rather than in `OhboxView` for the reason `message-chrome.tsx`
   * gives: the pane is mounted twice while the reader is open, `ohbox-read-state.test.ts`
   * mounts the view with no `EngineProvider`, and the dwell machinery in that view is not
   * something this slice may reach into. The reader sheet shows the same message, so opening
   * it needs no second trigger.
   */
  useEffect(() => {
    if (selectedOhbox) hydrateBody(selectedOhbox.id);
  }, [selectedOhbox?.id, hydrateBody]);

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
      setReaderFor(null);
      setPicker(null);
      setPickerIds(null);
      setFr(null);
      setRailOpen(false);
      setTagCreateOpen(false);
      setSenderMenu(null);
      setShortcutsOpen(false);
      setReplyTo(null);
      if (route.view !== "screener") setScreenerFull(false);
      // …and only then honour a pending Reply Run, so the clear above cannot undo it.
      if (route.view === "triage" && frPending) {
        setFrPending(false);
        // NOT `setFrValues({})` — see `startFR`. Wiping the map here is the same data loss.
        setFr({ step: 0, items: piles.replyLater });
      }
      // …and a pending OPEN, for exactly the same reason. `openMessage` sets both
      // the destination and the intent to open before the hash changes; the clear above runs
      // first, so without this an Ohbox hit tapped at 390px would navigate and then close the
      // reader it had just asked for, which is the shape the Reply Run already paid for once.
      if (readerPending) {
        setReaderFor(readerPending);
        setReaderPending(null);
      }
    }
    prevRoute.current = route;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  /* ── shared actions ── */
  const openTagPicker = useCallback((messageId: string, anchor: HTMLElement | null) => {
    setPickerIds(null);
    setPicker({ forId: messageId, ...placePicker(anchor) });
  }, []);

  /**
   * THE INLINE REPLY.
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
    if (readColumnHidden()) setReaderFor(messageId);
  }, [readColumnHidden]);

  const closeReply = useCallback(() => setReplyTo(null), []);

  const onReplyBody = useCallback(
    (next: string) => {
      setReplyBody(next);
      if (replyTo) writeReplyDraft(replyTo, next);
    },
    [replyTo],
  );

  /**
   * SENDING. The state machine, the retry driver and the triage clear all live in
   * `mail-send.ts`; this only says what "the send settled" means to the shell.
   *
   * For a reply: close the editor, but ONLY if it is still open on that same message. A
   * confirmation can arrive from a retry long after the user moved on, and closing whatever
   * editor happens to be open then would discard a different half-written reply.
   *
   * For a compose: empty the form. The scratch buffer in `localStorage` is cleared by the send
   * machine itself (it must happen even if this view is long gone); this is the in-memory half,
   * and without it the fields would still be full of a message that has already been delivered.
   *
   * ── AND FOR A REPLY RUN STEP: THIS IS WHERE IT IS DISCHARGED ────────────────────────────
   *
   * `onDone` used to dispatch `triage_set → none` at PRESS time and step forward, with no send
   * anywhere. Adding a send while keeping that would have left TWO independent discharge
   * rules, and two discharge rules is exactly how a FAILED send still clears the debt — the
   * same bug wearing the fix as a costume. So the press only sends, and everything that means
   * "this one is dealt with" happens here: `settle` calls this on a CONFIRMATION and on
   * nothing else, so a step is left behind only by a reply that exists. The triage state
   * itself is cleared by `settle` in `mail-send.ts`, which is now the only rule
   * that clears one.
   */
  const onSendSettled = useCallback((key: string) => {
    if (key === COMPOSE_SEND_KEY) {
      setCompose(EMPTY_COMPOSE);
      return;
    }
    setReplyTo((cur) => (cur === key ? null : cur));

    /*
     * Guarded on the item the run is STANDING ON, not on "a run is open". A confirmation can
     * arrive from a flush minutes after the press — by which time the user may have skipped
     * past that message, or closed the run and started a second one over a fresh snapshot of
     * a pile that has moved. Advancing on the key alone would step over a message nobody
     * answered, which is the same lie in a rarer form. A late confirmation for a message the
     * run is no longer on still discharges the debt (`settle` does that), and simply does not
     * move a cursor that has gone elsewhere.
     *
     * `fr` is closed over rather than read from a ref because `useMailSend` re-points
     * `settledRef` on every render, so what runs here is always the latest committed run.
     */
    const item = fr ? fr.items[fr.step] : undefined;
    if (!fr || !item || item.messageId !== key) return;
    setFrDone((s) => new Set(s).add(key));
    // The typed text is spent. `settle` has already removed the `localStorage` half.
    setFrValues((vals) => {
      if (!(key in vals)) return vals;
      const { [key]: _delivered, ...rest } = vals;
      return rest;
    });
    setFr({ ...fr, step: fr.step + 1 });
  }, [fr]);
  const mailSend = useMailSend(engine, toast, onSendSettled);
  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   */
  /**
   * WHICH ADDRESSES THIS ACCOUNT CAN SEND FROM. The rule is `compose-from.ts`; this
   * is the one place the two sources of mailboxes are reconciled.
   *
   * `GET /mailboxes` when we have it — it is the only source that knows an address is
   * `disabled`, and the only one with a `createdAt` to order by. The mirror's `"mailbox"`
   * entities otherwise, which is the demo and the Desktop: `"mailbox"` is not an `EntityType`
   * in the change log, so those rows exist only where the FixturesAdapter seeded them.
   *
   * An EMPTY list is "nothing can be named", and every consumer below renders no From line and
   * puts nothing extra on the wire rather than guessing. That is the Desktop, and it is also a
   * Cloud tab in the moment before its first poll lands.
   */
  const fromOptions = useMemo(
    () => (facts ? optionsFromFacts(facts) : optionsFromMirror(mailboxes)),
    [facts, mailboxes],
  );

  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   *
   * ── AND IT NAMES A MAILBOX ONLY TO OVERRIDE ONE ─────────────────────────────────────────
   *
   * A reply sends from the mailbox the message arrived in, and `Engine.enrich` already derives
   * that from the parent (`engine.ts:671`) — so the ordinary case adds NOTHING here and the
   * envelope is unchanged. `mailboxId` is attached in exactly one situation: the parent's
   * mailbox is `disabled` or gone, `resolveReplyFrom` named a substitute, and `InlineReply` is
   * SAYING SO on screen. The wire and the sentence come from the same call, which is the point
   * of it being a pure function.
   *
   * When nothing can be named the field stays off and `enrich` behaves exactly as before —
   * `sendingMailboxId`'s newest-message guess is a COMPOSE fallback and must never reach a
   * reply, where it would silently answer from an address the sender never wrote to.
   */
  const sendReply = useCallback(
    (messageId: string) => {
      if (messageId !== replyTo) return;
      const parent = reader.get<EngineMessage>("message", messageId) ?? null;
      const from = resolveReplyFrom(fromOptions, parent?.mailboxId ?? null);
      mailSend.send({
        kind: "mail_send",
        inReplyTo: messageId,
        body: replyBody,
        ...(from.substituted && from.mailboxId ? { mailboxId: from.mailboxId } : {}),
      });
    },
    [mailSend, replyTo, replyBody, reader, version, fromOptions],
  );

  /**
   * THE COMPOSE PLAN — the mutation, the rejected recipients and the empty-subject note, all
   * derived in one place from the form (`compose.ts`).
   *
   * The mailbox is resolved here rather than left to `Engine.enrich`, even though enrich would
   * fill a value: the BUTTON has to know whether a mailbox exists, because offering Send on an
   * account with nothing to send from is the inert affordance Compose used to be. One derivation, two
   * consumers — the same discipline as `canSend`.
   *
   * ── AND IT IS NO LONGER `sendingMailboxId` THAT DECIDES ─────────────────────────────────
   *
   * `sendingMailboxId` answers with the mailbox of the account's NEWEST MESSAGE, which on an
   * account with two connected addresses flips the From line every time the other one receives
   * mail. It survives only as the last resort for the case `resolveComposeFrom` cannot speak
   * to — no facts and no seeded mirror rows — where it is still better than refusing to send,
   * and where there is no From line on screen for it to contradict.
   */
  const composeFrom = useMemo(
    () => resolveComposeFrom(fromOptions, compose.fromMailboxId),
    [fromOptions, compose.fromMailboxId],
  );
  const composeMailbox = composeFrom.mailboxId ?? sendingMailboxId(reader);
  const plan = useMemo(() => composePlan(compose, composeMailbox), [compose, composeMailbox]);
  const onComposeFields = useCallback((next: ComposeFields) => {
    setCompose(next);
    writeComposeDraft(next);
  }, []);
  const sendCompose = useCallback(() => mailSend.send(plan.mutation), [mailSend, plan]);

  /**
   * SCREENING FROM ANYWHERE — one call site for every surface.
   *
   * The plan comes from `sender-screening.ts`, which decides whether the endpoint can be
   * used at all; this only dispatches it and tells the truth about what happened.
   *
   * ── THE RULE'S OUTCOME IS AWAITED, AND ONLY THE RULE'S ──────────────────────────────────
   *
   * This used to toast on click for every outcome, which was survivable while the only claim
   * was "your mail moved" — a `move` that fails rolls its own row back on screen. It stopped
   * being survivable the moment the sentence started claiming something about FUTURE mail:
   * the rules surface's first cut printed "Rule revoked" over a 403 on a live account, and the fixtures
   * adapter never refuses, so every test was green. So `plan.ruleMutations` — and nothing else
   * — is awaited, and `screeningToast` picks the sentence from what the server actually said.
   * The branch lives beside the sentences in `sender-screening.ts`, never here.
   */
  const changeScreening = useCallback(
    (messageId: string, dest: ScreeningDest, scope: ScreeningScope = "sender", makeRule = true) => {
      setSenderMenu(null);
      const sender = senderScreening(reader, messageId);
      if (!sender) return;
      const plan = planScreeningChange(sender, dest, scope, makeRule);
      const place = PLACE_LABEL[dest] ?? dest;
      // The SUBJECT of the sentence follows the scope, or a domain decision would report
      // itself as being about the one address the user happened to click.
      const who = scope === "domain" ? sender.domain : sender.address;
      if (plan.mutations.length === 0) {
        toast(t("screening.toastAlready", { sender: who, place }));
        return;
      }
      void dispatchScreeningChange(plan, (m) => engine.mutate(m)).then((key) => {
        toast(t(`screening.${key}`, { sender: who, place, count: plan.moved }));
      });
    },
    [engine, reader, toast, t],
  );

  /**
   * Open the detail view for whichever scope the sheet was showing.
   *
   * The rows are attributed HERE, at open time, rather than inside the panel: the panel then
   * holds a plain snapshot and cannot re-derive a different answer on a re-render caused by a
   * sync drain landing mid-read. The sheet closes, because the panel replaces it.
   */
  const openSenderAudit = useCallback(
    (messageId: string, scope: ScreeningScope) => {
      setSenderMenu(null);
      const sender = senderScreening(reader, messageId);
      if (!sender) return;
      setSenderAudit({
        title: scope === "domain" ? sender.domain : sender.address,
        domain: scope === "domain",
        rows: attributeMessages(reader, sender.scopes[scope].messages),
      });
    },
    [reader],
  );

  const openSenderMenu = useCallback((messageId: string, anchor: HTMLElement | null) => {
    setSenderMenu({ messageId, ...placePicker(anchor) });
  }, []);

  /**
   * Clicking a sender's circle or address, in ANY list.
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

  const revokeRule = useCallback(
    (ruleId: string) => engine.mutate({ kind: "rule_delete", ruleId }),
    [engine],
  );

  const retargetRule = useCallback(
    (ruleId: string, destination: Folder) => engine.mutate({ kind: "rule_update", ruleId, destination }),
    [engine],
  );

  const toggleTag = useCallback(
    (messageId: string, tagId: string, assigned: boolean) => {
      const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
      void engine.mutate({ kind: "tag_assign", messageId, tagId, assigned });
      toast(assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }));
    },
    [engine, tags, toast, t],
  );

  /**
   * The same verb over a SET — and it is `tag_assign` fanned out.
   *
   * No new bulk mutation kind: `tag_assign` is per-message on the wire, the round trips are
   * one per message that actually CHANGES, and a selection is a handful of rows rather than
   * a pile. Inventing a bulk kind would mean a second server route to keep honest for a cost
   * nobody has measured — the brief asks for a measurement before that claim, and there is
   * none, so the fan-out stands.
   *
   * Messages that already agree with the target state are skipped. `tag_assign` is
   * idempotent, so this is not correctness — it is not asking a server to restate forty
   * things it already holds.
   */
  const bulkToggleTag = useCallback(
    (ids: string[], tagId: string, assigned: boolean) => {
      const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
      const targets = ids.filter((id) => {
        const m = reader.get<EngineMessage>("message", id);
        return m != null && m.labels.includes(tagId) !== assigned;
      });
      if (targets.length === 0) return;
      for (const messageId of targets) {
        void engine.mutate({ kind: "tag_assign", messageId, tagId, assigned });
      }
      if (targets.length === 1) {
        toast(assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }));
        return;
      }
      toast(
        assigned
          ? t("tag.toastTaggedMany", { name, count: targets.length })
          : t("tag.toastUntaggedMany", { name, count: targets.length }),
      );
    },
    [engine, reader, tags, toast, t],
  );

  /**
   * Mint a tag and put it on this message.
   *
   * ONE mutation, not two. The shell cannot call the API directly — `scripts/publish-desktop.mjs`
   * DENYs `app/api-client` from this shared shell — so the engine is the only wire, and
   * `tag_assign` carries the new name rather than a second `tag_create` verb: a create that
   * succeeded followed by an assign that failed would leave an empty tag the user never asked
   * for, and the two-request version has no transaction to undo it.
   *
   * The id is minted HERE so the optimistic effect paints the same tag the database stores. If
   * the name already exists the server's row wins and this id is simply never seen — the chip
   * then appears on the next drain under the real id, which is why nothing here asserts the
   * tag is visible yet.
   */
  const createTag = useCallback(
    (messageId: string, name: string) => {
      void engine.mutate({
        kind: "tag_assign", messageId, tagId: crypto.randomUUID(), assigned: true, createName: name,
      });
      toast(t("tag.toastTagged", { name }));
    },
    [engine, toast, t],
  );

  /**
   * ═══ THE TAG, WITHOUT A MESSAGE ═══════════════════════════════════════════════════════
   *
   * Reported as: the sidebar should let you add tags, and Settings → Tags is not implemented.
   * Both had one cause — `tag_assign`'s tag-or-create was the only way to mint a tag, so a
   * name had to be attached to a message to exist, and there was no rename or delete verb at
   * all. `POST /tags`, `PATCH /tags/:id` and `DELETE /tags/:id` had been mounted the whole
   * time with no caller; these three are the callers.
   *
   * The id is minted here for the optimistic row only. `POST /tags` lets the DATABASE choose
   * the id (unlike tag-or-create, which mints under the client's), so this uuid names a row
   * that lives exactly as long as the overlay — see the mutation's own comment.
   */
  const createTagAlone = useCallback(
    (name: string) => {
      void engine.mutate({ kind: "tag_create", tagId: crypto.randomUUID(), name });
      toast(t("tag.toastCreated", { name }));
    },
    [engine, toast, t],
  );

  const renameTag = useCallback(
    (tagId: string, name: string) => {
      void engine.mutate({ kind: "tag_rename", tagId, name });
      toast(t("tag.toastRenamed", { name }));
    },
    [engine, toast, t],
  );

  /**
   * The name is read BEFORE the mutation. Afterwards the optimistic effect has already
   * tombstoned the row, so `reader.get` answers undefined and the sentence would be about a
   * tag it could not name.
   */
  const deleteTag = useCallback(
    (tagId: string) => {
      const name = reader.get<TagDTO>("tag", tagId)?.name ?? "";
      void engine.mutate({ kind: "tag_delete", tagId });
      toast(t("tag.toastDeleted", { name }));
    },
    [engine, reader, toast, t],
  );
  const tagAdmin = useMemo(
    () => ({ onRename: renameTag, onDelete: deleteTag }),
    [renameTag, deleteTag],
  );

  const onMessageAction = useCallback(
    (action: MessageAction, m: EngineMessage) => {
      switch (action) {
        case "reply":
          // Inline, in place. This used to be `setReaderOpen(false); go("compose")` —
          // the message you were answering left the screen as you started answering it.
          openReply(m.id);
          break;
        case "draft":
          // The AI draft-review flow is still its own view (it is a card with sources and
          // a regenerate step, not a text box). It now leaves on Escape; see ComposeView.
          setReaderFor(null);
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
        case "unread":
          /**
           * THE READ TOGGLE'S FALLBACK ARM, and it is deliberately not the normal path.
           *
           * In the product the bar's switch presses `u` itself, so this is reached only
           * where that binding does not exist — the desktop shell, or a pane mounted with no
           * keymap provider. It goes through the same `markSeen` every other read-state path
           * in this file goes through, which is what keeps "one call site for one mutation"
           * true; what it CANNOT do from here is set `OhboxView`'s `pinnedUnread`, which is
           * exactly why the button prefers the key. See `ActionBar` in `MessagePane.tsx`.
           */
          // `!m.unread` is the DESIRED state, written the way `OhboxView.toggleUnread`
          // writes it — one expression for "flip it", not two that could drift apart.
          markSeen([m.id], !m.unread);
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
          // `move:<view>` — the destination travels with the action. Before
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
    [engine, toast, t, piles.replyLater.length, now, openReply, markSeen],
  );

  /**
   * ═══ THE SELECTION'S VERBS ══════════════════════════════════════════════════════════
   *
   * The requirement: a selection must offer more than mark unseen, mark read and Escape — it
   * needs the sender's screening and its tags too. The count was exact: ⇧U and Escape, in
   * one view.
   *
   * The vocabulary is the ACTION BAR's, not a second one invented for bulk — the same three
   * horizons, the same two filing verbs, the same read state. Reply is the one verb that is
   * dropped, because "reply to eleven messages" is not a thing the product can mean.
   *
   * Everything here dispatches through the ordinary engine path, one mutation per message,
   * and says ONE sentence at the end. A per-message toast over a selection of forty is not
   * feedback, it is a denial of service on your own screen.
   */
  const onBulkAction = useCallback(
    (action: BulkAction, ids: string[]) => {
      if (ids.length === 0) return;
      if (action === "read" || action === "unread") {
        // The batch mutation, unchanged: one request, one transaction, one intent.
        markSeen(ids, action === "unread");
        toast(
          t(action === "unread" ? "ohbox.toastBulkUnread" : "ohbox.toastBulkRead", {
            count: ids.length,
          }),
        );
        return;
      }
      if (action === "later" || action === "aside" || action === "resurface") {
        const state = action === "later" ? "reply_later" : action === "aside" ? "set_aside" : "bubbled_up";
        const when = action === "resurface" ? nextFridayNine(now) : null;
        for (const messageId of ids) {
          void engine.mutate({
            kind: "triage_set",
            messageId,
            state,
            ...(when ? { bubbleUpAt: when } : {}),
          });
        }
        toast(
          action === "resurface"
            ? t("ohbox.toastBulkResurface", { count: ids.length, when: resurfaceLabel(when!) })
            : t(action === "later" ? "ohbox.toastBulkLater" : "ohbox.toastBulkAside", {
                count: ids.length,
              }),
        );
        return;
      }
      // `move:<view>` — the destination travels with the action, exactly as it does for one
      // message. A message already in the destination is not re-moved: the count in
      // the toast is what CHANGED, which is the only count worth reporting.
      const view = action.slice("move:".length) as OhmailView;
      const folder = FOLDER_OF_VIEW[view];
      let moved = 0;
      for (const messageId of ids) {
        const m = reader.get<EngineMessage>("message", messageId);
        if (!m || m.folder === folder) continue;
        void engine.mutate({ kind: "move", messageId, folder });
        moved++;
      }
      toast(t("ohbox.toastBulkMoved", { count: moved, place: PLACE_LABEL[view] ?? view }));
    },
    [engine, reader, markSeen, toast, t, now],
  );

  /**
   * THE BULK SCREENING PLAN — grouped by SENDER, because that is what screening is about.
   *
   * A screener decision is not a per-message action, and a selection routinely mixes the two
   * cases the single-sender path already distinguishes: a sender still WAITING is decided
   * through `POST /screener/:id`, which promotes a **rule that governs all their future
   * mail**; a sender whose mail has left the Screener is a composition of `move`s with no
   * lasting effect at all. Ten messages from six senders, two of them waiting, is two
   * permanent consent records and four one-off moves — and a naive bulk apply would report
   * "10 messages moved" and never mention the two.
   *
   * So this returns the counts SEPARATELY and the surface states them before committing.
   * `planScreeningChange` per sender, never a bulk shortcut: forty senders decided through a
   * path that skips `screener_decide` would fork the consent record from the one
   * `screener-service.decide` writes.
   *
   * NOTE THE COUNT THIS DELIBERATELY REPORTS. The plan moves every message the mirror holds
   * from that sender, not only the ones that were picked — that IS what screening a sender
   * means, and it is precisely why the number has to be on screen before the button commits.
   */
  const planBulkScreening = useCallback(
    (ids: string[], dest: ScreeningDest) => {
      const seen = new Set<string>();
      const plans: EngineMutation[] = [];
      let senders = 0;
      let messages = 0;
      let rules = 0;
      for (const id of ids) {
        const s = senderScreening(reader, id);
        if (!s || seen.has(s.key)) continue;
        seen.add(s.key);
        /**
         * `makeRule: false`, EXPLICITLY. The single-sender sheet makes a rule by
         * default; bulk does not, and the reason is its own confirm copy — `bulkConfirm`
         * promises *"No rule is made, so future mail is unchanged"* and `bulkConfirmRules`
         * counts only the senders the SCREENER will rule on. Letting the default through here
         * would have made both sentences false for up to forty senders at once, silently, and
         * would have claimed rules whose outcome this path does not await. Owed, not dropped:
         * bulk rule-creation needs its own confirm copy and its own three-outcome reporting.
         */
        const plan = planScreeningChange(s, dest, "sender", false);
        if (plan.mutations.length === 0) continue;
        senders++;
        messages += plan.moved;
        if (plan.rule) rules++;
        plans.push(...plan.mutations);
      }
      return { senders, messages, rules, mutations: plans };
    },
    [reader],
  );

  const onBulkScreen = useCallback(
    (ids: string[], dest: ScreeningDest) => {
      const plan = planBulkScreening(ids, dest);
      const place = PLACE_LABEL[dest] ?? dest;
      if (plan.mutations.length === 0) {
        toast(t("screening.toastBulkNothing", { place }));
        return;
      }
      for (const m of plan.mutations) void engine.mutate(m);
      // Two sentences because there are two outcomes, and the second one is permanent. The
      // single-sender path already says which happened; this keeps that vocabulary and adds
      // the only thing bulk introduces — that a selection can contain both.
      toast(
        plan.rules > 0
          ? t("screening.toastBulkRuled", {
              place,
              senders: plan.senders,
              count: plan.messages,
              rules: plan.rules,
            })
          : t("screening.toastBulkMoved", {
              place,
              senders: plan.senders,
              count: plan.messages,
            }),
      );
    },
    [engine, planBulkScreening, toast, t],
  );

  /** Tag a whole selection: the shell's picker, pointed at a set. See `pickerIds`. */
  const openBulkTagPicker = useCallback((ids: string[], anchor: HTMLElement | null) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
    setPicker({ forId: ids[0]!, ...placePicker(anchor) });
  }, []);

  /**
   * The four callbacks the bulk bar takes, as one stable object.
   *
   * `screenPreview` deliberately drops the mutation list `planBulkScreening` also returns:
   * the confirm row renders on every keystroke of a re-render and must not be able to
   * dispatch anything. Committing is `screen`, which recomputes from the same function — so
   * the numbers on screen and the mutations that run come from one derivation, and a
   * selection that changed between the two cannot commit a plan nobody was shown.
   */
  const bulkVerbs = useMemo(
    () => ({
      run: onBulkAction,
      tag: openBulkTagPicker,
      screenPreview: (ids: string[], dest: ScreeningDest) => {
        const { senders, messages, rules } = planBulkScreening(ids, dest);
        return { senders, messages, rules };
      },
      screen: onBulkScreen,
    }),
    [onBulkAction, openBulkTagPicker, planBulkScreening, onBulkScreen],
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

  /**
   * The Screener row that speaks for `m`, in `segment`.
   *
   * The Screener's rows are SENDERS, not messages: a derived row's id is the newest held
   * message from that address (`screener-state.ts`), which is almost never the message
   * somebody clicked in a search result. Matching on `senderKey` is therefore the only
   * lookup that can land on the right row, and it is the same key the selectors and the
   * server group by. Null when this client holds no row for them — the caller navigates
   * without a selection rather than inventing one.
   */
  const screenerRowFor = useCallback(
    (m: EngineMessage, segment: ScreenerSegmentId): string | null => {
      const want = senderKey(m.from.address);
      const rows =
        segment === "waiting"
          ? screener.waiting
          : segment === "screened"
            ? screener.screenedOut
            : screener.spam.map((r) => r.sender);
      return rows.find((r) => senderKey(r.from.address) === want)?.id ?? null;
    },
    [screener.waiting, screener.screenedOut, screener.spam],
  );

  /**
   * OPEN IT WHERE IT LIVES — the one answer, finished.
   *
   * Reported as "search does not allow a message to be opened; it should open the message
   * where it lives". The literal claim was wrong — a `SearchHit` is a real `<button>` and has
   * always called this. What was wrong is everything AFTER the routing
   * decision, and it is the same seam in every arm: this function set a view and a cursor
   * and then stopped, so on three of the five destinations the user arrived at a list and
   * had to find the thing they had just clicked, and on the fourth they arrived at a pane
   * that is `display:none` at their screen width.
   *
   *   · **ohbox** — the split pane IS the open, so the cursor is enough… on a desktop. Under
   *     900px the reading column is hidden, so the reader sheet is what "opened" means
   *     there, exactly as `OhboxView`'s own tap handler already decided.
   *   · **reads / receipts** — cursor plus a `jump`, which scrolls the stream to the card.
   *     Unchanged: these piles open IN PLACE and the clamp is their contract.
   *   · **screener / screened / spam** — now SELECTS THE SENDER as well as navigating. The
   *     segment alone was the misroute the ruling named third: a consent surface that drops
   *     you at a queue of strangers when you asked about one of them.
   *   · **anything else** — a folder this client has no view for. There is no pile to route
   *     to, so the message opens in the reader over wherever you are. This arm is defensive
   *     rather than reachable: `Folder` is a closed six-member union and `MessageDTO.folder`
   *     is typed to it, so `VIEW_OF_FOLDER` is total today and no hit can fall here. The gap
   *     row's "a hit in Sent falls into the Screener" is therefore NOT reachable — see the
   *     report. It is written because the contract says a server may add folders a shipped
   *     client has never heard of, and the honest answer to one is the message itself.
   */
  const openMessage = useCallback(
    (m: EngineMessage) => {
      const target = openTargetFor(m, readColumnHidden(), screenerRowFor);
      switch (target.kind) {
        case "ohbox":
          setOhboxSel(target.id);
          // The reader, and via `readerPending` because `go` is about to clear it.
          if (target.reader) setReaderPending(target.id);
          setLocated(target.id);
          go("ohbox");
          return;
        case "stream":
          (target.view === "reads" ? setReadsCur : setReceiptsCur)(target.id);
          setJump({ view: target.view, id: target.id });
          setLocated(target.id);
          go(target.view);
          return;
        case "screener":
          if (target.row) {
            const row = target.row;
            setScnSel((s) => ({ ...s, [target.segment]: row }));
            // The SENDER row's id, not the message's: that is what this view puts in
            // `data-id`, and the flash has to name the thing on screen.
            setLocated(row);
          }
          goScreener(target.segment);
          return;
        default:
          // No navigation, so no `readerPending` is needed: nothing will clear this.
          setReaderFor(target.id);
      }
    },
    [readColumnHidden, screenerRowFor],
  );

  /**
   * ═══ LOCATE THE ROW, IN WHICHEVER VIEW IT LANDED ══════════════════════════════════════
   *
   * ── WHY THIS IS ONE DOM EFFECT AND NOT FOUR PROPS ─────────────────────────────────────
   *
   * A search hit can land in four view shapes — the Ohbox's split pane, the two skim streams,
   * and the Screener's sender queue — and threading a `locatedId` through all four would be
   * four props, four effects and four chances for the fifth view to be added without one.
   *
   * All four already agree on a contract this can use instead: every row is
   * `.row[data-id="<id>"]`, and each view already finds its own cursor that way to scroll it
   * (`ReadsView`, `ReceiptsView`, `ScreenerView`) or to anchor the screening popover
   * (`OhboxView`, and `AppShell`'s own `s` binding). This is a fifth reader of an established
   * selector, not a new coupling — and it means a view added later is located correctly
   * without being taught anything.
   *
   * ── WHY IT RETRIES ────────────────────────────────────────────────────────────────────
   *
   * `openMessage` sets the cursor and CHANGES THE ROUTE in the same gesture. The destination
   * view has not mounted when this effect first runs, so a single query would miss every time
   * — the row appears a frame or two later, after the hash change, the route effect and the
   * view's own render. It re-tries on animation frames for a short bounded window and then
   * gives up rather than looping: a hit whose row never appears is a message that is no longer
   * in that pile, and flashing nothing is the honest outcome.
   *
   * The class is removed on a timer AND on unmount, so leaving the view mid-flash cannot
   * leave a row permanently marked.
   */
  useEffect(() => {
    if (!located) return;
    let raf = 0;
    let done = false;
    const deadline = Date.now() + LOCATE_TIMEOUT_MS;
    let clear: ReturnType<typeof setTimeout> | undefined;
    let found: Element | null = null;

    const look = () => {
      if (done) return;
      const row =
        typeof document === "undefined"
          ? null
          : document.querySelector(`.view .row[data-id="${CSS.escape(located)}"]`);
      if (row) {
        done = true;
        found = row;
        row.scrollIntoView({ block: "center" });
        row.classList.add("is-located");
        clear = setTimeout(() => {
          row.classList.remove("is-located");
          setLocated(null);
        }, LOCATE_FLASH_MS);
        return;
      }
      if (Date.now() > deadline) {
        done = true;
        setLocated(null);
        return;
      }
      raf = requestAnimationFrame(look);
    };
    raf = requestAnimationFrame(look);

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      if (clear) clearTimeout(clear);
      found?.classList.remove("is-located");
    };
  }, [located]);

  const startFR = useCallback(() => {
    // NO `setFrValues({})`. Keyed by message, what is in that map is a reply somebody wrote
    // and has not sent — a run that begins by erasing it is the bug this slice exists to end,
    // one keystroke earlier. A delivered reply is removed by `onSendSettled`, and nothing else
    // has the standing to.
    setFr({ step: 0, items: piles.replyLater });
  }, [piles.replyLater]);

  /**
   * The message the current view has under the cursor, whichever view that is.
   *
   * `s` and `e` mean the same thing everywhere or they mean nothing; without one answer to
   * "which message?" they would have to be re-declared per view with per-view semantics,
   * which is the state the keyboard registry exists to end.
   */
  const focused: EngineMessage | null =
    /**
     * AN OPEN READER IS THE CURSOR, WHATEVER VIEW IT IS OVER.
     *
     * First, and deliberately: the reader is the innermost thing on screen, so a message
     * verb pressed while it is open acts on the message being READ.
     *
     * NO GUARD FAILS IF THIS LINE IS DELETED, and that is stated rather than hidden — the
     * same honesty `OhboxView.pinnedUnread` uses about its own key. Every path that opens
     * the reader today also sets the pile's cursor to the same message (`OhboxView.open`,
     * `openMessage`'s Ohbox arm, `openReply` on mobile), so the two cannot yet disagree.
     * What makes the reader generalisable is precisely that it no longer has to be an Ohbox
     * message; the first surface that opens it over a pile with its own cursor would make
     * this load-bearing, and it is cheaper to be right now than to find out then. Coherence,
     * not a fixed bug — nothing observable changes today.
     */
    readerMessage ??
    (route.view === "ohbox"
      ? selectedOhbox
      : route.view === "reads"
        ? (readsCur ? (reader.get<EngineMessage>("message", readsCur) ?? null) : null)
        : route.view === "receipts"
          ? (receiptsCur ? (reader.get<EngineMessage>("message", receiptsCur) ?? null) : null)
          : null);

  /**
   * ESCAPE HAS ONE OWNER, and this ORDERED LIST is it.
   *
   * Before the registry, Escape was handled by `Reader` (close), `AppShell` (the (i)
   * panel), `OhboxView` (clear the selection), `ScreenerView` (leave the mobile preview)
   * and the palette input — five listeners with no agreed order, which is why the reply
   * editor could not simply add a sixth. `Reader` now takes `closeOnEscape={false}` and
   * this closes the innermost thing that is open.
   *
   * ── IT USED TO BE TWO LISTS, AND THAT WAS THE BUG UNDERNEATH ───────────────────────
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
    // Above the popover: the audit panel is opened FROM the sheet and replaces it, so it is
    // the innermost thing on screen whenever it exists.
    [senderAudit != null, () => setSenderAudit(null)],
    [senderMenu != null, () => setSenderMenu(null)],
    [tagCreateOpen, () => setTagCreateOpen(false)],
    [picker != null, () => setPicker(null)],
    [fr != null, () => setFr(null)],
    [replyTo != null, () => setReplyTo(null)],
    [readerFor != null, () => setReaderFor(null)],
  ];
  const closeInnermost = escapeLayers.find(([open]) => open)?.[1] ?? null;

  /**
   * AN OPEN OVERLAY OWNS ESCAPE WHILE IT IS OPEN.
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
      // SENDING FROM THE KEYBOARD. `inInput` is not optional: the editor takes
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
      // `f` starts a Reply Run over the Answer Later pile, and until this binding there
      // was NO keyboard way to put anything INTO that pile — `later` was reachable only from
      // the reader's action menu. A keyboard user could start a run they could not fill, and
      // `f` sat permanently `disabled` for them. Found while writing the guard for it, which is
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
          items: [
            ...tagGroups.map((g) => ({
              id: g.tag.id,
              label: g.tag.name,
              hue: hueOf(g.tag),
              count: g.messages.length,
            })),
            /* "New tag" — the affordance the sidebar did not have. It is a row in this list
               rather than a control inside the group because `RailNav` (packages/ui, shared
               with the desktop shell) exposes no slot there, and growing the design system to
               serve one host is what its own header argues against for the collapse state.
               `onNavigateTag` intercepts the id; `TagCreate` owns the input. It sits LAST so
               it does not move when tags are added. `action: true` is what makes it read as a
               VERB rather than as a tag called "New tag": `RailNav` then draws a `+` where the
               tag dot would be and withholds the count, because a count is a property of a tag
               and this is not one. Without that flag it renders identically to a real tag —
               which is how it shipped once. */
            { id: TAG_CREATE_ROW_ID, label: t("rail.tagNew"), hue: "moss" as const, action: true },
          ],
        },
      },
      {
        items: [
          /**
           * HISTORY CARRIES NO COUNT, AND THAT IS A PROPERTY RATHER THAN A STYLE CHOICE.
           *
           * A sender with ANY unread mail is active whatever its age, so nothing unread can
           * reach History — the engine's cutline guarantees it by construction. A place that
           * cannot contain anything unread has nothing to demand, so a badge here would be a
           * number that is always the size of the past and never a call to act.
           *
           * `count` is therefore ABSENT rather than zero: `RailNav` renders an absent count as
           * nothing at all, and a literal `0` would draw a badge saying nothing is there.
           * `rail-history.test.tsx` asserts the key is missing, because a future edit adding
           * `count: history.length` would look like an improvement.
           */
          { id: "history", label: t("rail.history"), title: t("rail.historyTitle") },
          { id: "search", label: t("rail.search"), kbdHint: "/" },
          { id: "settings", label: t("rail.settings") },
        ],
      },
    ],
    [t, ohbox.newForYou.length, allOhbox.length, readsUnread, receiptsUnread, screener.waitingCount, piles, tagGroups],
  );

  /**
   * ═══ THE NUMBER KEYS ══════════════════════════════════════════════════════════════════
   *
   * `1`…`N` reach the piles in the order the rail lists them. Requested as navigation that
   * does not need the mouse and does not need a two-key sequence — `g o` / `g r` / `g e` /
   * `g s` already exist but only cover four destinations and none of the triage horizons.
   *
   * ── DERIVED FROM THE RAIL, NOT WRITTEN OUT BESIDE IT ──────────────────────────────────
   *
   * The numbers ARE the menu order, so they are read off `railGroups` rather than declared in
   * a parallel list. A hand-written table would be a second enumeration of the nav — the shape
   * the (i) panel's hand-typed key list had, and the one the `?` sheet is generated to avoid —
   * and it would go wrong the first time a group gained an item.
   *
   * Only the PILES are numbered: the three streams, the Screener and the three triage
   * horizons. Tags is a collapsible group whose contents are the user's own and change; Search
   * has `/` and Settings is not somewhere you flick to. `slice(0, 9)` because there is no key
   * `10` — a tenth pile would simply not be numbered rather than silently shifting the rest.
   */
  const numberNav = useMemo(
    () =>
      railGroups
        .flatMap((g) => g.items)
        .filter((item) => PILE_IDS.includes(item.id))
        .slice(0, 9),
    [railGroups],
  );

  /**
   * ── DISCOVERABILITY, IN THREE LAYERS, AND NONE OF THEM IS ALWAYS-ON ───────────────────
   *
   * A shortcut nobody knows about is not a feature, and a badge on every row forever is
   * clutter charged to every user so that a few learn something once. So:
   *
   *   1. the `?` sheet lists them, free, because the bindings above declare their own labels
   *      and the sheet is generated from the registry;
   *   2. the rail rows show their keycap WHILE THE SHEET IS OPEN — the moment somebody is
   *      asking "what are the keys", the answer is on the thing itself as well as in the list;
   *   3. once, after {@link NAV_HINT_AFTER} clicks, a dismissible line. Somebody who has
   *      clicked the rail six times is demonstrably navigating and demonstrably not using the
   *      keys, which is the only evidence available that the hint is worth their attention.
   *
   * Dismiss is forever (`stop()` pins the counter), and the hint stops on its own once the
   * keys are used — pressing one navigates without going through `onNavigate`, so the counter
   * never reaches the threshold for somebody who already knows.
   */
  const railGroupsWithHints = useMemo(
    () =>
      shortcutsOpen
        ? railGroups.map((g) => ({
            ...g,
            items: g.items.map((item) => {
              const n = numberNav.findIndex((x) => x.id === item.id);
              // `kbdHint` REPLACES the count in `RailNav`, which is right here: while the
              // sheet is open the question on screen is "what is the key", not "how many".
              return n < 0 ? item : { ...item, kbdHint: String(n + 1) };
            }),
          }))
        : railGroups,
    [railGroups, numberNav, shortcutsOpen],
  );

  const showNavHint =
    numberNav.length > 0 &&
    navClicks.count >= NAV_HINT_AFTER &&
    navClicks.count < DISMISSED_FOREVER;

  useKeyBindings(
    numberNav.map((item, i) => ({
      chord: String(i + 1),
      group: "navigate" as const,
      // The rail's own label, so the sheet and the rail cannot disagree about what `3` is.
      label: t("shortcuts.goPile", { pile: item.label }),
      run: () => {
        // The SAME conversion the rail handler uses, from the same table. A `startsWith`
        // test here would be a second opinion about which rows are triage rows.
        const pile = TRIAGE_PILE_OF_RAIL[item.id];
        if (pile) goTriage(pile);
        else go(item.id as "ohbox");
      },
    })),
    "global",
  );

  const activeRailId =
    route.view === "tag"
      ? undefined
      : route.view === "triage"
        // The row for the pile that is actually open. Hard-coded to `"triage"` before, which
        // is why the rail lit Answer Later however you arrived.
        ? RAIL_OF_TRIAGE_PILE[route.triagePile]
        : route.view === "compose"
          ? undefined
          : route.view;

  const viewTitles: Record<string, string> = {
    ohbox: t("rail.ohbox"),
    reads: t("rail.reads"),
    receipts: t("rail.receipts"),
    screener: t("rail.screener"),
    triage: t("rail.triage"),
    history: t("rail.history"),
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
  /**
   * `"seed"` matches no view below, which is how the review screen TAKES the stage instead of
   * appearing above a pile. Stated here rather than by guarding each of the ten renders: a
   * condition repeated ten times is nine chances to forget it, and the tenth view added later
   * would render underneath the screen with nobody noticing.
   */
  const effectiveView = seedOwed
    ? "seed"
    : route.view === "tag" && !tagGroup
      ? "ohbox"
      : route.view;

  const frFinished = fr != null && fr.step >= fr.items.length;
  const frItem = fr && !frFinished ? fr.items[fr.step] : undefined;
  /** The step's send, off the one machine — the run is a caller of it, not a second one. */
  const frSend = frItem?.messageId ? mailSend.stateOf(frItem.messageId) : null;

  /**
   * A REPLY BEGUN BEFORE A RELOAD IS STILL OWED.
   *
   * Seeded from the same per-message scratch buffer the inline editor uses, so a run resumed
   * in a new tab finds the sentence that was already written. Read AFTER mount rather than in
   * the state initializer, for the hydration reason `persisted-ui.ts` spells out: reading
   * storage during render makes the server and the client produce different markup and React
   * keeps the server's, so the saved text would be read and then silently discarded.
   *
   * Never overwrites what is already in memory. The map is the live editor; the buffer is only
   * its backup, and a key present with an empty string means "this one has been opened", not
   * "this one is unknown".
   */
  useEffect(() => {
    const id = frItem?.messageId;
    if (!id) return;
    setFrValues((vals) => (id in vals ? vals : { ...vals, [id]: readReplyDraft(id) }));
  }, [frItem?.messageId]);

  /**
   * A SEND THE RUN MADE THAT DID NOT LAND MUST SAY SO.
   *
   * `FocusReplyOverlay` renders a card and two buttons and has no status line, so the run's
   * only other feedback for a failure is the step NOT advancing — which is silence to somebody
   * who pressed Done and is waiting. The inline editor's four status strings say exactly the
   * same four things, so they are reused rather than re-worded, and none of them claims a
   * delivery: `settle`'s toast is the only sentence in the app that does, and it fires only on
   * a confirmation.
   *
   * Keyed on the PHASE moving, not on `t`/`toast` identity — a render-keyed effect here would
   * re-announce the same failure on every keystroke.
   */
  const frPhase = frSend?.phase ?? "idle";
  const frReason = frSend?.reason;
  useEffect(() => {
    if (frPhase === "idle" || frPhase === "sending") return;
    toast(
      frPhase === "queued"
        ? t("reply.statusQueued")
        : frPhase === "unverified"
          ? t("reply.statusUnverified")
          : t("reply.statusFailed", { reason: frReason ?? t("reply.reasonUnknown") }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frPhase, frReason]);

  /**
   * THE CONVERSATION, for whichever message a pane is rendering.
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
      replySendState: mailSend.stateOf,
      openSenderMenu, conversationOf,
      bodyOf: bodyOfMessage, hydrateBody,
      attachments, remoteImages,
    }),
    [replyTo, replyBody, onReplyBody, closeReply, sendReply, mailSend, openSenderMenu,
      conversationOf, bodyOfMessage, hydrateBody, attachments, remoteImages],
  );

  // Resolved here rather than inside the popover so a sender whose last message has just
  // been moved out from under it closes the popover instead of rendering an empty one.
  const senderMenuFor = useMemo(
    () => (senderMenu ? senderScreening(reader, senderMenu.messageId) : null),
    [senderMenu, reader, version],
  );

  return (
    // `MailStateProvider` used to open here. It is now ABOVE this component
    // (`MailStateHost`) so the shell can READ the mailbox facts as well as publish them — see
    // the note there. Every surface that reports mailbox state is still inside it.
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

        {/* A FAILING SYNC, IN EVERY VIEW. Renders nothing while the loop is healthy,
            and nothing at all in the demo or on the desktop. A sibling of the deck rather
            than a child of any view, so it is outside every list's scroller and no view can
            forget it — see `SyncBar.tsx` for why that placement is the fix and the sentence
            is not. */}
        <SyncBar />

        {/* The one-time hint. Layer 3 — see `railGroupsWithHints`. It names the real range,
            counted from the rail rather than typed, so it cannot claim a key that is not
            bound. Dismiss is permanent. */}
        {showNavHint ? (
          <div className="nav-hint">
            <span>{t("rail.numberHint", { last: numberNav.length })}</span>
            <button type="button" onClick={navClicks.stop}>{t("rail.numberHintGot")}</button>
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
            groups={railGroupsWithHints}
            activeId={activeRailId}
            onNavigate={(id) => {
              setRailOpen(false);
              navClicks.bump();
              // THE FIX. This was `if (id.startsWith("triage")) go("triage")`, which threw
              // away which of the three rows had been pressed — so Park and Resurface both
              // opened Answer Later, and the rail lit Answer Later either way.
              const pile = TRIAGE_PILE_OF_RAIL[id];
              if (pile) goTriage(pile);
              else go(id as "ohbox");
            }}
            activeTagId={route.tagId ?? undefined}
            onNavigateTag={(id) => {
              setRailOpen(false);
              // The sentinel row, not a tag. See `railGroups` for why the affordance is a row.
              if (id === TAG_CREATE_ROW_ID) setTagCreateOpen(true);
              else goTag(id);
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
            {/* THE SEED REVIEW TAKES THE STAGE while it is owed. It decides what the Ohbox
                contains, so answering it before reading the piles is the order that makes the
                piles mean something — and "Later" leaves immediately, because it is an offer
                and not a gate. `window.location.reload()` on success rather than a local state
                flip: the confirmation wrote rules the mirror has not seen yet, and a shell
                that re-partitioned before the next sync drain would show the old answer with
                a new heading over it. */}
            {seedOwed ? (
              <SeedReviewView
                onDone={() => {
                  setSeedDismissed(true);
                  if (typeof window !== "undefined") window.location.reload();
                }}
                /* Nothing was written, so nothing needs re-reading. The offer stands next
                   time this tab loads — it is not remembered on the server, because "not
                   now" is not an answer to "shall I let these people through". */
                onLater={() => setSeedDismissed(true)}
              />
            ) : null}

            {effectiveView === "ohbox" ? (
              <OhboxView
                demo={demo}
                newForYou={ohbox.newForYou}
                previouslySeen={ohbox.previouslySeen}
                tags={tags}
                now={now}
                selectedId={selectedOhbox?.id ?? null}
                onSelect={setOhboxSel}
                /* The ID travels, and that is not tidiness. This was `() => setReaderOpen(true)`
                   against a reader hard-wired to `selectedOhbox`, so the indirection hid a
                   staleness: `OhboxView.open` calls `onSelect(id)` and this in the SAME tick,
                   so the shell's `selectedOhbox` here is still the PREVIOUS row. With the
                   reader holding an id of its own, reading that stale value would open the
                   message the user was on before the one they tapped.

                   It is `enterReader` and no longer `setReaderFor` — see the gate above. */
                onEnterReader={enterReader}
                onMarkSeen={markSeen}
                doorbellInitials={waitingLive.map((w) => w.initial)}
                doorbellHues={waitingLive.map((w) => avatarHue(w.from.address))}
                doorbellCount={screener.waitingCount}
                /* May this view state its emptiness as a fact yet? Derived once in
                   `mail-state.ts`; see `MailState.settled`. */
                settled={mailState.settled}
                onDoorbell={() => go("screener")}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                bulk={bulkVerbs}
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
                bodyOf={bodyOfMessage}
                hydrateBody={hydrateBody}
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
                bodyOf={bodyOfMessage}
                hydrateBody={hydrateBody}
                jumpTo={jump?.view === "receipts" ? jump.id : null}
                onJumped={() => setJump(null)}
              />
            ) : null}

            {effectiveView === "screener" ? (
              <ScreenerView
                state={screener}
                /* Bound HERE, at the render, to the exact list the state computed this
                   frame — so the set that gets priced and the set that gets bought are one
                   list rather than two computations that agree today. Withheld from the
                   demo, which has no server to ask. */
                suggest={demo ? undefined : suggestions.forSenders(screener.unsuggestedSenders)}
                segment={route.screenerSegment}
                selection={scnSel}
                onSelect={(segment, id) => setScnSel((s) => ({ ...s, [segment]: id }))}
                /* Same flag, same reason — the Screener's "No one's waiting." and its
                   "all clear" meta are the same claim the Ohbox was making. */
                settled={mailState.settled}
                hydrateBody={hydrateBody}
                full={screenerFull}
                onFull={setScreenerFull}
              />
            ) : null}

            {effectiveView === "triage" ? (
              <TriageView
                piles={piles}
                pile={route.triagePile}
                onPile={goTriage}
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

            {effectiveView === "history" ? (
              <HistoryView
                messages={history}
                tags={tags}
                now={now}
                /**
                 * The reader, IN PLACE — not `openMessage`, and the difference is a defect
                 * rather than a preference.
                 *
                 * `openMessage` answers "open it where it lives", and where a History message
                 * lives is the INBOX — so it would navigate to the Ohbox and select a row that
                 * is not in the Ohbox's list, because the whole point of History is that this
                 * message does not present there. The reader takes an id and reads the message
                 * straight from the mirror, so it works for a message belonging to no pile.
                 *
                 * `setReaderFor` and not `enterReader`: that gate exists because the piles have
                 * a reading COLUMN under 900px and the sheet would duplicate it. History is a
                 * solo list with no such column, so the sheet is the only reading surface it
                 * has, at every width.
                 *
                 * It is what makes decide-on-encounter work: the pane renders the full body and
                 * thread, and the sender menu inside it offers the screening decision with the
                 * sender's count and the explicit retro-apply — the same affordance as
                 * everywhere else, reached from the mail that prompted the thought.
                 */
                onOpen={(m) => setReaderFor(m.id)}
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
                /* The chip on a hit answers "where do I go to find this again?", and for a
                   History message the folder and the place are different answers. The INDEX is
                   deliberately not projected — mail in History must stay searchable. */
                placeOf={consentView?.placeOf}
                onServerSearch={() => toast(t("search.toastServer"))}
              />
            ) : null}

            {effectiveView === "compose" ? (
              <ComposeView
                engine={engine}
                draft={draft}
                fields={compose}
                onFields={onComposeFields}
                from={composeFrom}
                plan={plan}
                send={mailSend.stateOf(COMPOSE_SEND_KEY)}
                onSend={sendCompose}
              />
            ) : null}

            {effectiveView === "settings" ? (
              <SettingsView
                notifications={notifications}
                mailboxes={mailboxes}
                tags={tags}
                tagCounts={Object.fromEntries(
                  tagGroups.map((g) => [g.tag.id, g.messages.length]),
                )}
                rules={{ items: rules, onRevoke: revokeRule, onRetarget: retargetRule }}
                /* Rename and delete. Not gated on `demo`, unlike the four injected panes:
                   both are ordinary engine mutations, so the FixturesAdapter serves them out
                   of `mutationEffects` and the demo is correct with no special case. */
                tagAdmin={tagAdmin}
                /* `demo` is the ENGINE's answer, not the server's floor (see the note on
                   AppShell): `?demo=1` runs on fixtures with no session and no account, so
                   an Account pane there would offer to erase something that does not
                   exist. */
                /* Same demo rule again: Security is nothing but step-up ceremonies against a
                   session `?demo=1` does not have. */
                securitySection={demo ? undefined : securitySection}
                accountSection={demo ? undefined : accountSection}
                /* Same rule: `?demo=1` has no session, so "connect a mailbox" there would
                   be a form posting to a server this tab is not talking to. The demo keeps
                   the fixture list, which is the honest thing for it to show. */
                mailboxSection={demo ? undefined : mailboxSection}
                billingSection={demo ? undefined : billingSection}
                /* ABOUT — the one injected pane the demo also gets, because the demo has
                   something true to say here and no API to say it with. The live body comes
                   from the Cloud client (which mailbox, synced when, which build, and who
                   publishes this); the demo body is the two sentences that describe the
                   fixture world, which are only correct there. */
                aboutSection={
                  demo ? (
                    <SettingsSection>
                      <p className="set-note-inline">{t("about.p1")}</p>
                      <p className="set-note-inline">{t("about.p2")}</p>
                      <p className="set-note-inline">{t("about.keys")}</p>
                    </SettingsSection>
                  ) : (
                    aboutSection
                  )
                }
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
        open={readerMessage != null}
        closeOnEscape={false}
        onClose={() => setReaderFor(null)}
      >
        {readerMessage ? (
          <MessagePane
            message={readerMessage}
            tags={tags}
            now={now}
            onAction={(a) => onMessageAction(a, readerMessage)}
            onAddTag={openTagPicker}
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
        value={frItem ? (frValues[frKeyOf(frItem)] ?? "") : ""}
        onChange={(v) => {
          if (!frItem) return;
          setFrValues((vals) => ({ ...vals, [frKeyOf(frItem)]: v }));
          // Mirrored into the SAME per-message buffer the inline editor writes and `settle`
          // clears — so the run's text survives a reload exactly as the editor's does, and a
          // reply begun in one surface can be finished in the other.
          if (frItem.messageId) writeReplyDraft(frItem.messageId, v);
        }}
        /**
         * DONE SENDS. That is all it does.
         *
         * Through `useMailSend` and never `engine.mutate({kind:"mail_send"})`: the lock that
         * makes a second press within one tick a no-op is a ref inside that hook
         * (`mail-send.ts:203-215`, which names a Reply Run step as exactly the caller a
         * button's `disabled` cannot save), and a second key is a second reservation and a
         * second delivery to a real person. Invariant #2.
         *
         * ── AN EMPTY TEXTAREA ───────────────────────────────────────────────────────────
         *
         * Nothing happens: no send, no advance, no discharge. `canSend` already refuses a
         * blank body — the server would accept and post one (`drafts-service.ts:167-171`) —
         * and Skip is the affordance for moving on without writing. Letting Done fall through
         * to Skip would put back a second way to leave a step having sent no mail, which is
         * the shape of the bug this slice removes; the run stays put instead, and the pile
         * keeps the reminder.
         *
         * An entry with no `messageId` is refused for the same reason twice over: there is no
         * message to reply to, so there is nothing to send and nothing that could be paid.
         */
        onDone={() => {
          if (!frItem?.messageId) return;
          mailSend.send({
            kind: "mail_send",
            inReplyTo: frItem.messageId,
            body: frValues[frKeyOf(frItem)] ?? "",
          });
        }}
        onSkip={() => fr && setFr({ ...fr, step: fr.step + 1 })}
        onClose={() => setFr(null)}
        doneLabel={frPhase === "sending" ? t("reply.sending") : t("triage.frDone")}
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
          /* Over a SET, a tag is "assigned" only when EVERY message carries it.
             The alternative — any — would render a half-applied tag as done, so pressing it
             would remove it from the two that had it instead of adding it to the eight that
             did not. `pickerIds` is null for every single-message caller, which is the
             one-element case of the same rule. */
          assigned={tagsOnAll(reader, pickerIds ?? [picker.forId])}
          onToggle={(tagId, assigned) =>
            bulkToggleTag(pickerIds ?? [picker.forId], tagId, assigned)
          }
          onCreate={(name) => { createTag(picker.forId, name); setPicker(null); }}
          onClose={() => { setPicker(null); setPickerIds(null); }}
        />
      ) : null}

      {/* New tag, from the sidebar — the standalone mint that did not exist. */}
      {tagCreateOpen ? (
        <TagCreate
          tags={tags}
          onCreate={(name) => { createTagAlone(name); setTagCreateOpen(false); }}
          onClose={() => setTagCreateOpen(false)}
        />
      ) : null}

      {/* Sender screening — reachable from every list and every open message. */}
      {senderAudit ? (
        <SenderAuditPanel state={senderAudit} onClose={() => setSenderAudit(null)} />
      ) : null}
      {senderMenuFor ? (
        <SenderMenu
          state={senderMenu!}
          sender={senderMenuFor}
          onChoose={(dest, scope, makeRule) => changeScreening(senderMenu!.messageId, dest, scope, makeRule)}
          onOpenDetail={(scope) => openSenderAudit(senderMenu!.messageId, scope)}
          onClose={() => setSenderMenu(null)}
        />
      ) : null}

      {/* The `?` sheet — generated from the registry above, never hand-written. */}
      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* THE (i) PANEL IS GONE, AND ITS CONTENT IS NOT.
          It was a floating dock button opening a dialog over the mail, holding three facts
          that are settings — which mailbox is connected, when it last synced, which build —
          and it was the only place they were readable. Facts do not need an overlay. They
          are a Settings pane now (`aboutSection`, below), which is where somebody looks for
          them and where they can be linked to; the dock is back to the two controls that
          act on what is on screen rather than describe it. */}

      {/* floating dock */}
      <Dock>
        <DockKey label={t("dock.command")} kbdHint="⌘K" onPress={palette.openPalette} />
        <span className="dock-sep" />
        <DockIcon icon="sun" label={t("dock.theme")} onPress={theme.toggle} />
      </Dock>
    </div>
    </MessageChromeProvider>
  );
}
