"use client";

/**
 * Screener decisions with a real undo window on a real engine.
 *
 * The wire vocabulary has no inverse for `screener_decide` (the server
 * has no un-decide endpoint either), so undo is a DELAYED COMMIT: a
 * decision hides the row and counts instantly, the toast carries Undo,
 * and the engine mutation fires when the window closes. Navigating away
 * (or switching segments) flushes pending commits so destinations are
 * always up to date when you look at them.
 *
 * Client view-state that Stage 2 replaces with wire endpoints:
 *  - senders you mark spam stay visible in the Spam segment (pinned
 *    locally; the engine files their held mail to Quarantine + a rule);
 *  - "Not spam → Screener" pulls a fixture spam sender back to Waiting;
 *  - "Delete" hides a spam row.
 *
 * DERIVED ROWS. On a Cloud account every row comes out of the
 * message mirror, not out of a `screener_sender` fixture, and the two are
 * not interchangeable here: `POST /screener/:id` resolves only mail still
 * held in `ohmail/Screener`, so a sender who has already left the gate is a
 * 404 and is released with `move` instead. `sender.derived` is the switch.
 *
 * WHAT THE DECIDE CARRIES, AND WHAT IT USED TO NOT. This comment said the
 * endpoint "has exactly two outcomes (yes ⇒ INBOX, no ⇒ ohmail/Screened)"
 * and that a derived row "composes the rest out of `move`". Both were true
 * and the composition did not work: `decide` reads its held rows outside its
 * transaction and writes `desired_folder` inside it, so a `move` fired
 * beside it was clobbered as often as not. `POST /screener/:id` now takes
 * `dest`, all five destinations ride the decision itself, and the only thing
 * still composed on top is `mark_seen` for "&read" — a flag, not a folder.
 */
import { useMemo, useReducer, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  FOLDER_OF_VIEW,
  screenerSegments,
  senderKey,
  type EngineMessage,
  type Folder,
  type OhmailEngine,
  type ScreenDest,
  type ScreenerSenderDTO,
} from "@ohmail/client-engine";
import type { SuggestionOverlay } from "./screener-suggest";
import {
  DECISION_DONE_LABEL,
  type DecisionDestination,
  type DecisionScope,
  type ToastFn,
} from "@ohmail/ui";

export interface SpamRow {
  sender: ScreenerSenderDTO;
  /** Locally pinned: a sender the user marked spam this session. */
  pinned: boolean;
}

export interface DecideOptions {
  read: boolean;
  scope: DecisionScope;
  quiet?: boolean;
}

interface PendingEntry {
  sender: ScreenerSenderDTO;
  dest: DecisionDestination;
  read: boolean;
  scope: DecisionScope;
  commitTimer: ReturnType<typeof setTimeout>;
  outTimer: ReturnType<typeof setTimeout>;
}

export interface ScreenerState {
  /** Waiting rows to render (rows mid-exit carry `pendingOut`). */
  waiting: ScreenerSenderDTO[];
  /** Waiting minus everything decided — rail badge, doorbell, meta. */
  waitingCount: number;
  /**
   * How many of those rows actually CARRY a suggestion.
   *
   * Never assume this tracks `waitingCount`. `selectors.ts` mints `ai: null` for every
   * derived row — `/sync` carries no suggestion, because a suggestion is advice about mail
   * rather than a change to it, and no classifier runs client-side — so on a live account
   * this is 0 until something buys one. What buys one is `shell/screener-suggest.ts`, whose
   * result arrives here as the `suggestions` overlay; before that surface existed the number
   * could ONLY be 0 outside the demo, which is why "Apply all" had nothing to apply.
   *
   * It exists so the surface can decline to offer "Apply all suggestions" over an
   * empty set rather than quietly meaning something else.
   */
  suggestedCount: number;
  /**
   * The waiting senders with no suggestion yet, in the queue's own order — the batch a
   * purchase would be composed from.
   *
   * Lower-cased addresses, because that is the key the endpoint normalises to, and DERIVED
   * rows only: a fixture sender does not exist on the server and would come back `not_held`,
   * padding a batch the user was charged nothing for but had counted.
   */
  unsuggestedSenders: string[];
  screenedOut: ScreenerSenderDTO[];
  spam: SpamRow[];
  isExiting: (id: string) => boolean;
  decide: (sender: ScreenerSenderDTO, dest: DecisionDestination, opts: DecideOptions) => void;
  applyAll: (scopeOf: (s: ScreenerSenderDTO) => DecisionScope) => void;
  markAllSpam: (scopeOf: (s: ScreenerSenderDTO) => DecisionScope) => void;
  allowScreened: (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => void;
  notSpamToWaiting: (row: SpamRow) => void;
  notSpamToOhbox: (row: SpamRow) => void;
  deleteSpam: (row: SpamRow) => void;
  /** Commit every pending decision now (route/segment changes). */
  flush: () => void;
}

const OUT_MS = 330;
/**
 * ═══ HOW LONG "UNDO" IS TRUE, AND THE TWO NUMBERS THAT HAVE TO AGREE ═══════════════════
 *
 * Observed in real use: "Ohbox — filed … Undo" was still on screen twenty minutes later,
 * across every view, until another toast replaced it.
 *
 * ── WHAT IS ACTUALLY REPRODUCIBLE, MEASURED RATHER THAN ASSUMED ────────────────────────
 *
 * `ToastHost` (`packages/ui/src/primitives/Toast.tsx`) DOES run a timer, and it does drop the
 * `on` class on schedule — so `.toast{opacity:0;pointer-events:none}` takes the capsule off
 * screen. What it never does is clear `toast` state, so the message and its **`<button>` stay
 * mounted for ever**: still in the accessibility tree of a `role="status"` region, still
 * `tabIndex 0`, still firing `onAction` when activated. `pointer-events:none` stops a mouse; it
 * does not stop Tab + Enter, and it does not stop a screen reader. Proven in jsdom: 20 minutes
 * after the toast, the node still read `"Ohbox — filed.Undo"` and activating the button still
 * called `onAction`.
 *
 * ── AND THAT IS THE SMALLER HALF. THE UNDO WAS ALREADY DEAD BY THEN ────────────────────
 *
 * `commit` fires on its own timer and `undo` only restores rows still in `pending`. So a press
 * after the commit window restored NOTHING and then said `toastUndone` with `count: 0` —
 * **"Undone — 0 waiting again."** — which is the product claiming an act it did not perform, on
 * the one screen a user goes to in order to check. That is the defect worth fixing; the stale
 * button is what makes it reachable.
 *
 * ── SO THE WINDOW IS ONE NUMBER, DECLARED ONCE ────────────────────────────────────────
 *
 * The acceptance asks for an 8–10 s dismissal *and* asks what Undo does after that long. The two
 * questions are the same question: the toast may not outlive the act it offers to reverse, or it
 * is a live control for something that has already happened. `UNDO_MS` is the offer, and the
 * commit is deliberately derived from it rather than written beside it — the shipped pair was
 * 6000 (toast) against 6200 (commit), which had already left a 200 ms slice of exactly this bug
 * and would have grown to 2–4 s had the toast simply been lengthened to 8 s.
 *
 * `COMMIT_GRACE_MS` covers `toast.css`'s own .25 s opacity transition, so the capsule is
 * visually gone before the decision is sent, never after.
 *
 * `undo()` is still guarded independently and always will be. A number cannot fix a control that
 * outlives its own toast; only refusing to claim an undo that did not happen can.
 */
export const UNDO_MS = 8000;
const COMMIT_GRACE_MS = 400;
/**
 * Exported so the suite reads the REAL number. `screener-cloud.test.ts` carried
 * `const COMMIT_MS = 6200` — a hand-copied duplicate of a value it does not own, which would
 * have gone green against a shipped 8400 for exactly as long as nobody re-ran it.
 */
export const COMMIT_MS = UNDO_MS + COMMIT_GRACE_MS;
const BULK_STEP_MS = 240;
/** `PATCH /messages` takes at most 200 ids (413 above it) — `routes/messages.ts:52`. */
const MARK_SEEN_MAX = 200;

export function useScreenerState(
  engine: OhmailEngine,
  version: number,
  toast: ToastFn,
  /**
   * Suggestions bought for this account, keyed by sender — `shell/screener-suggest.ts`.
   *
   * OPTIONAL, and absent means exactly what it meant before there was anything to pass:
   * every derived row's `ai` stays null and the surface says so. It is joined on here rather
   * than inside `screenerSegments` because the mirror is a record of mail and this is not
   * mail — the engine has no business holding it, and a client-engine that did would have to
   * persist and evict it.
   */
  suggestions?: SuggestionOverlay,
): ScreenerState {
  const t = useTranslations("screener");
  const [, bump] = useReducer((c: number) => c + 1, 0);
  const store = useRef({
    pending: new Map<string, PendingEntry>(),
    out: new Set<string>(),
    pins: [] as ScreenerSenderDTO[],
    overrides: new Set<string>(),
    hidden: new Set<string>(),
    bulkBusy: false,
  });

  const reader = engine.read();
  const segments = useMemo(() => screenerSegments(reader), [reader, version]);
  const s = store.current;

  const senderLabel = (x: ScreenerSenderDTO) => x.from.name || x.from.address;
  const scopeText = (x: ScreenerSenderDTO, scope: DecisionScope) =>
    scope === "domain"
      ? t("wholeDomain", { domain: "@" + (x.from.address.split("@")[1] ?? x.from.address) })
      : x.from.address;

  /** A derived row's held ids ARE message ids; a fixture row's are not. */
  const heldMessageIds = (sender: ScreenerSenderDTO): string[] =>
    sender.derived ? sender.held.map((h) => h.id) : [];

  const moveAll = (ids: string[], folder: Folder) => {
    for (const messageId of ids) void engine.mutate({ kind: "move", messageId, folder });
  };

  const commit = (id: string) => {
    const entry = s.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.commitTimer);
    clearTimeout(entry.outTimer);
    s.pending.delete(id);
    s.out.delete(id);
    if (entry.dest === "spam") {
      s.pins = [entry.sender, ...s.pins];
    }
    s.overrides.delete(id);
    const derived = entry.sender.derived === true;
    // Spam must ride the NO branch on a derived row: `yes` is the verb that ADMITS a sender,
    // and the server now refuses `{decision:"yes", dest:"ohmail/Quarantine"}` outright (400)
    // rather than guessing which half the caller meant. The old "yes unless screened" mapping
    // filed spam into the Ohbox on a live account, which is the failure that predicate exists
    // for.
    //
    // Fixture rows keep the demo's own semantics — spam rides `yes` there, so the local effect
    // materialises the held mail straight into Quarantine instead of moving the sender to the
    // screened-out ledger. That pairing (`decision:"yes"` with `dest:"spam"`) is the one shape
    // the server would refuse, and it cannot reach it: a fixture row exists only under
    // `FixturesAdapter`, which serves `mutationEffects` in-process and never opens a socket.
    const decision: "yes" | "no" =
      entry.dest === "screened" || (derived && entry.dest === "spam") ? "no" : "yes";
    const heldIds = heldMessageIds(entry.sender);

    void engine.mutate({
      kind: "screener_decide",
      senderId: id,
      decision,
      // ── THE DESTINATION RIDES THE DECIDE NOW, ON BOTH BRANCHES ────────────────────────────
      //
      // It used to be sent only on a `yes`, which left `spam` — the one destination that rides
      // `no` on a derived row — with no way to say `ohmail/Quarantine`, so the server filed it
      // to `ohmail/Screened` and the follow-up `move` below was supposed to finish the job.
      // Sent unconditionally, the server files where the user pressed on all five.
      dest: entry.dest as ScreenDest,
      ...(decision === "yes" ? { read: entry.read } : {}),
      scope: entry.scope,
    });

    if (derived) {
      // ── THE COMPENSATING `move` IS GONE, AND ITS ABSENCE IS THE FIX ──────────────────────
      //
      // This used to fire one `move` per held message for any destination the wire could not
      // name — Reads, Receipts, Quarantine — dispatched unawaited beside the decide. It lost:
      // `decide` reads its held rows outside its transaction and then upserts `desired_folder`
      // inside it, so a `move` that committed in that window was stamped back to the decide's
      // own folder. Measured on production 2026-08-05 as four `promoted → INBOX` rules and 97
      // bulletins in the Ohbox for senders the user had admitted with **Reads**.
      //
      // Two independent requests writing one field cannot be ordered into correctness from a
      // browser, so the destination travels WITH the decision instead. The server also refuses
      // to re-route a row that has left the gate, which is what protects a shipped desktop
      // mirror that still composes the old pair.
      //
      // "&read" survives, and deliberately: it is not a folder. `read` is still not a field on
      // `POST /screener/:id`, so the seen half stays the same `PATCH /messages` batch the Ohbox
      // uses — a flag, not a destination, so it cannot be clobbered by one.
      if (entry.read) {
        for (let i = 0; i < heldIds.length; i += MARK_SEEN_MAX) {
          void engine.mutate({
            kind: "mark_seen",
            messageIds: heldIds.slice(i, i + MARK_SEEN_MAX),
            unread: false,
          });
        }
      }
    }
    bump();
  };

  const undo = (ids: string[]) => {
    let restored = 0;
    for (const id of ids) {
      const entry = s.pending.get(id);
      if (!entry) continue;
      clearTimeout(entry.commitTimer);
      clearTimeout(entry.outTimer);
      s.pending.delete(id);
      s.out.delete(id);
      restored++;
    }
    // NOTHING RESTORED IS NOT AN UNDO, so it does not get the undo sentence. Every id
    // had already committed (or was never pending), the mutation is dispatched, and
    // `toastUndone` at `count: 0` said "Undone — 0 waiting again." to a person who had just
    // pressed the button precisely to find out. Reachable long after the capsule fades,
    // because the button outlives it — see UNDO_MS.
    if (restored === 0) {
      toast(t("toastUndoExpired"));
      return;
    }
    bump();
    toast(t("toastUndone", { count: restored }));
  };

  const decide = (
    sender: ScreenerSenderDTO,
    dest: DecisionDestination,
    opts: DecideOptions,
  ) => {
    const id = sender.id;
    if (s.pending.has(id)) return;
    const entry: PendingEntry = {
      sender,
      dest,
      read: opts.read,
      scope: opts.scope,
      outTimer: setTimeout(() => {
        s.out.delete(id);
        bump();
      }, OUT_MS),
      commitTimer: setTimeout(() => commit(id), COMMIT_MS),
    };
    s.pending.set(id, entry);
    s.out.add(id);
    bump();
    if (opts.quiet) return;
    const target = scopeText(sender, opts.scope);
    const message =
      dest === "screened"
        ? t("toastScreened", { target, read: opts.read ? "true" : "false" })
        : dest === "spam"
          ? t("toastSpam", { target: sender.from.address })
          : t("toastFiled", {
              dest: DECISION_DONE_LABEL[dest],
              read: opts.read ? "true" : "false",
              target,
            });
    toast(message, {
      action: t("toastUndo"),
      duration: UNDO_MS,
      onAction: () => undo([id]),
    });
  };

  /**
   * Join one bought suggestion onto a row.
   *
   * Three guards, and each one is a row this must NOT touch. A fixture row carries the demo's
   * own `ai` and is not a real sender, so the overlay has nothing true to say about it. A row
   * that already has an `ai` keeps it — the mirror is never overwritten by this. And a row
   * with no match is returned UNCHANGED rather than rebuilt, so the identity every `useMemo`
   * downstream compares stays stable when nothing was bought.
   */
  const withSuggestion = (x: ScreenerSenderDTO): ScreenerSenderDTO => {
    if (!suggestions || x.ai || x.derived !== true) return x;
    const found = suggestions.get(senderKey(x.from.address));
    return found ? { ...x, ai: found } : x;
  };

  const waiting = useMemo(() => {
    const overridden = segments.spam.filter((x) => s.overrides.has(x.id));
    return [...segments.waiting, ...overridden].map(withSuggestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, version, s.overrides.size, suggestions]);

  const visibleWaiting = waiting.filter((x) => !s.pending.has(x.id) || s.out.has(x.id));
  const undecided = waiting.filter((x) => !s.pending.has(x.id));
  const waitingCount = undecided.length;
  // Counted over the SAME set the bulk would act on, so the control can never appear for
  // rows that are already on their way out.
  const suggestedCount = undecided.filter((x) => x.ai != null).length;
  /**
   * The buy list, from the SAME set and in the SAME order.
   *
   * Deduped on the normalised address rather than trusted to be distinct: the queue is one
   * row per sender, but a spam row pulled back to Waiting by `notSpamToWaiting` joins this
   * list too, and a batch that named one address twice would reserve two of the user's
   * chosen 25 slots for one sender. The endpoint dedupes as well — this is so the COUNT the
   * confirmation shows is the count that gets bought.
   */
  const unsuggestedSenders = [
    ...new Set(
      undecided
        .filter((x) => x.derived === true && x.ai == null)
        .map((x) => senderKey(x.from.address)),
    ),
  ];

  const bulk = (
    destOf: (x: ScreenerSenderDTO) => DecisionDestination,
    scopeOf: (x: ScreenerSenderDTO) => DecisionScope,
    summary: (snaps: Array<{ id: string; dest: DecisionDestination }>) => string,
    /** Restricts the bulk to rows it can honestly speak for. Absent ⇒ every waiting row. */
    only?: (x: ScreenerSenderDTO) => boolean,
  ) => {
    const items = waiting.filter((x) => !s.pending.has(x.id) && (only ? only(x) : true));
    if (!items.length || s.bulkBusy) return;
    s.bulkBusy = true;
    const snaps: Array<{ id: string; dest: DecisionDestination }> = [];
    items.forEach((item, i) => {
      setTimeout(() => {
        const dest = destOf(item);
        decide(item, dest, { read: false, scope: scopeOf(item), quiet: true });
        snaps.push({ id: item.id, dest });
      }, i * BULK_STEP_MS);
    });
    setTimeout(() => {
      s.bulkBusy = false;
      // The bulk summary appears only after the last row's `decide`, and every row runs its own
      // `COMMIT_MS` clock from its own start — so over a long bulk the earliest rows can commit
      // while this capsule is still up, and this Undo is genuinely PARTIAL. That is stated
      // rather than papered over: `undo()` counts what it actually restored and `toastUndone`
      // reports that number, so a partial press says how many came back and a fully expired one
      // takes the `toastUndoExpired` arm. Shortening the capsule to cover the FIRST row instead
      // would leave a forty-row bulk with no undo on screen at all, which is worse.
      toast(summary(snaps), {
        action: t("toastUndo"),
        duration: UNDO_MS,
        onAction: () => undo(snaps.map((x) => x.id)),
      });
    }, items.length * BULK_STEP_MS + 160);
  };

  /**
   * "APPLY ALL SUGGESTIONS" MAY ONLY APPLY SUGGESTIONS THAT EXIST.
   *
   * Reported from live use: the Screener offers "apply all suggestions" while none of the
   * mail on screen shows what the suggestion would be. That was right, and the button was
   * worse than dead. It read `x.ai?.dest ?? "ohbox"`, and on a live account `x.ai` is
   * ALWAYS null — so the fallback, not the suggestion, decided every row. One press meant
   * "accept every waiting stranger into the Ohbox and promote a rule for each of them",
   * under a label that said it was applying suggestions the user had never been shown.
   *
   * On a backlogged mailbox that is hundreds of senders and thousands of held messages,
   * dispatched 240 ms apart, with the single Undo toast arriving minutes after the first
   * one moved. A consent gate
   * whose bulk control silently grants consent is the product inverted.
   *
   * So the fallback is GONE — not replaced. `only` restricts the bulk to rows that carry a
   * suggestion, and `dest` is read from that suggestion with no default, so a row this
   * cannot speak for is never decided by it. With no suggestions anywhere the set is empty
   * and the whole thing is a no-op; the surface additionally declines to render the control
   * (`ScreenerView.tsx`), because an inert button is its own small lie.
   */
  const applyAll = (scopeOf: (x: ScreenerSenderDTO) => DecisionScope) =>
    bulk(
      (x) => x.ai!.dest as DecisionDestination,
      scopeOf,
      (snaps) => {
        const n = (d: DecisionDestination) => snaps.filter((x) => x.dest === d).length;
        const parts = [
          n("ohbox") ? t("bulkOhbox", { count: n("ohbox") }) : null,
          n("reads") ? t("bulkReads", { count: n("reads") }) : null,
          n("receipts") ? t("bulkReceipts", { count: n("receipts") }) : null,
          n("screened") ? t("bulkScreened", { count: n("screened") }) : null,
          n("spam") ? t("bulkSpam", { count: n("spam") }) : null,
        ].filter(Boolean);
        return t("toastBulkDecided", { count: snaps.length, parts: parts.join(" · ") });
      },
      (x) => x.ai != null,
    );

  const markAllSpam = (scopeOf: (x: ScreenerSenderDTO) => DecisionScope) =>
    bulk(
      () => "spam",
      scopeOf,
      (snaps) => t("toastBulkSpam", { count: snaps.length }),
    );

  /**
   * Releasing a sender the Screener already decided about.
   *
   * There is no un-screen endpoint: `decide` resolves `:id` only against mail whose
   * DESIRED folder is still `ohmail/Screener`, so a screened-out or quarantined
   * representative is a 404. Per-message `move` releases the held mail for real. It
   * creates no rule, and the copy says so instead of promising future mail will follow.
   */
  const release = (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => {
    moveAll(heldMessageIds(sender), FOLDER_OF_VIEW[dest]);
    toast(
      t("toastReleased", {
        count: sender.held.length,
        sender: sender.from.address,
        dest: DECISION_DONE_LABEL[dest],
      }),
    );
  };

  const allowScreened = (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => {
    if (sender.derived) {
      release(sender, dest);
      return;
    }
    void engine.mutate({
      kind: "screener_decide",
      senderId: sender.id,
      decision: "yes",
      dest,
      scope: "sender",
    });
    toast(
      t("toastAllowed", {
        count: sender.held.length,
        sender: sender.from.address,
        dest: DECISION_DONE_LABEL[dest],
      }),
    );
  };

  const notSpamToWaiting = (row: SpamRow) => {
    if (row.pinned) return;
    if (row.sender.derived) {
      // Back to Waiting means the mail goes back to `ohmail/Screener` — the derived
      // queue reads the folder, so a local override would show a row whose mail is
      // still quarantined and whose decision would 404.
      moveAll(heldMessageIds(row.sender), FOLDER_OF_VIEW.screener);
      toast(t("toastNotSpamWaiting", { sender: senderLabel(row.sender) }));
      return;
    }
    s.overrides.add(row.sender.id);
    bump();
    toast(t("toastNotSpamWaiting", { sender: senderLabel(row.sender) }));
  };

  const notSpamToOhbox = (row: SpamRow) => {
    if (row.pinned) {
      // The engine already filed this sender's held mail to Quarantine —
      // release it to the Ohbox with real move mutations.
      const quarantined = reader
        .list<EngineMessage>("message")
        .filter(
          (m) =>
            m.folder === FOLDER_OF_VIEW.spam &&
            m.from.address === row.sender.from.address,
        );
      for (const m of quarantined) {
        void engine.mutate({ kind: "move", messageId: m.id, folder: "INBOX" });
      }
      s.pins = s.pins.filter((p) => p.id !== row.sender.id);
      bump();
    } else if (row.sender.derived) {
      release(row.sender, "ohbox");
      return;
    } else {
      void engine.mutate({
        kind: "screener_decide",
        senderId: row.sender.id,
        decision: "yes",
        dest: "ohbox",
        scope: "sender",
      });
    }
    toast(t("toastNotSpamOhbox", { sender: senderLabel(row.sender) }));
  };

  const deleteSpam = (row: SpamRow) => {
    if (row.pinned) s.pins = s.pins.filter((p) => p.id !== row.sender.id);
    else s.hidden.add(row.sender.id);
    bump();
    toast(t("toastDeleted", { sender: senderLabel(row.sender) }));
  };

  const flush = () => {
    for (const id of [...s.pending.keys()]) commit(id);
  };

  // A pinned sender and the DERIVED row for the same address are the same sender: the
  // pin is this session's memory of a decision whose mail the mirror now reports sitting
  // in `ohmail/Quarantine`. Without the address filter, marking a sender spam lists them
  // twice the moment the move lands.
  const pinnedKeys = new Set(s.pins.map((p) => senderKey(p.from.address)));
  const spam: SpamRow[] = [
    ...s.pins.map((p) => ({ sender: p, pinned: true })),
    ...segments.spam
      .filter((x) => !s.overrides.has(x.id) && !s.hidden.has(x.id) && !pinnedKeys.has(senderKey(x.from.address)))
      .map((x) => ({ sender: x, pinned: false })),
  ];

  return {
    waiting: visibleWaiting,
    waitingCount,
    suggestedCount,
    unsuggestedSenders,
    screenedOut: segments.screenedOut,
    spam,
    isExiting: (id) => s.pending.has(id),
    decide,
    applyAll,
    markAllSpam,
    allowScreened,
    notSpamToWaiting,
    notSpamToOhbox,
    deleteSpam,
    flush,
  };
}
