"use client";

/**
 * CHANGING A SENDER'S SCREENING FROM ANYWHERE (slice U3).
 *
 * Owner, twice: *"I cant select a sender and change it's screening type"* and *"needing to
 * be able to directly click a mail adress and change its screener mode even on ohbox etc"*.
 * Before this, screening could only be decided from the Screener, and only for mail still
 * waiting there. Everywhere else the sender's routing was a thing that had happened to you.
 *
 * ── WHAT THE WIRE WILL ACTUALLY DO, AND WHERE THAT ENDS ─────────────────────────────────
 *
 * `POST /screener/:id` has exactly two outcomes — yes ⇒ `INBOX`, no ⇒ `ohmail/Screened`
 * (`screener-service.ts:17-18`) — and it resolves `:id` only against mail whose desired
 * folder is still `ohmail/Screener` (`:257`). So:
 *
 *   · a sender still WAITING can be re-decided through the endpoint, which also promotes a
 *     rule server-side, and the remaining three destinations are composed on top with
 *     `move` — the same shape `screener-state.ts` already uses for Reads and Receipts;
 *   · a sender whose mail has left the Screener (the Ohbox case the owner is asking about)
 *     would 404. There is no un-screen endpoint and this slice does not invent one. Their
 *     mail is moved with `move`, which is real and immediate, and **no rule is created** —
 *     so the toast says so rather than promising that future mail will follow.
 *
 * That second half is a genuine limitation, filed as C5 ("`POST /screener/:id` must carry
 * `dest`"). Stating it in the toast is the difference between a product that is narrower
 * than you hoped and one that lies to you.
 *
 * This module is pure: it reads the mirror and returns mutations. `SenderMenu` renders it
 * and `AppShell` dispatches them, so the mapping below is testable without a DOM.
 */
import {
  FOLDER_OF_VIEW,
  senderKey,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
} from "@ohmail/client-engine";
import type { DecisionDestination } from "@ohmail/ui";

/** The five places a sender's mail can be screened to — the DecisionBar's own vocabulary. */
export type ScreeningDest = DecisionDestination;

export const SCREENING_DESTS: ScreeningDest[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * THE MAPPING THAT MUST NOT SLIP: which destinations ride the endpoint's `no`.
 *
 * The endpoint's yes is `INBOX`, full stop. C1 was caught shipping "yes unless screened",
 * which meant "Mark spam" asked the server to file that sender into the Ohbox and promoted
 * a rule sending their future mail there. Spam and Screen-out are the same branch — `no` —
 * and everything else is `yes` with a follow-up move.
 */
export const DECISION_OF_DEST: Record<ScreeningDest, "yes" | "no"> = {
  ohbox: "yes",
  reads: "yes",
  receipts: "yes",
  screened: "no",
  spam: "no",
};

/** Where each of the endpoint's two answers actually files the mail. */
export const WIRE_DECIDE_FOLDER: Record<"yes" | "no", Folder> = {
  yes: FOLDER_OF_VIEW.ohbox,
  no: FOLDER_OF_VIEW.screened,
};

export interface SenderScreening {
  /** The address, case-folded — the same key the selectors and the server group by. */
  key: string;
  address: string;
  name: string | null;
  /** Every message the mirror holds from this sender, across all folders. */
  messages: EngineMessage[];
  /** Where their mail sits, or null when it is spread across more than one view. */
  current: ScreeningDest | "screener" | null;
  /** Still waiting: the ONLY state `POST /screener/:id` will resolve. */
  waiting: boolean;
  /** The representative message id that endpoint takes (the newest held one). */
  representativeId: string | null;
}

const DEST_OF_FOLDER = new Map<Folder, ScreeningDest | "screener">([
  [FOLDER_OF_VIEW.ohbox, "ohbox"],
  [FOLDER_OF_VIEW.reads, "reads"],
  [FOLDER_OF_VIEW.receipts, "receipts"],
  [FOLDER_OF_VIEW.screened, "screened"],
  [FOLDER_OF_VIEW.spam, "spam"],
  [FOLDER_OF_VIEW.screener, "screener"],
]);

const byDateDesc = (a: EngineMessage, b: EngineMessage) =>
  String(b.date ?? "").localeCompare(String(a.date ?? ""));

/**
 * Read a sender out of the mirror, starting from ANY of their messages.
 *
 * Every list in the product stamps `data-id` with a message id, and the Screener's row id
 * is its representative message id, so one lookup serves the Ohbox, Reads, Receipts, the
 * Screener, Tags and Search without any view having to know what a "sender" entity is.
 */
export function senderScreening(reader: EntityReader, messageId: string): SenderScreening | null {
  const seed = reader.get<EngineMessage>("message", messageId);
  if (!seed) return null;
  const key = senderKey(seed.from.address);
  const messages = reader
    .list<EngineMessage>("message")
    .filter((m) => senderKey(m.from.address) === key)
    .sort(byDateDesc);

  const places = new Set(messages.map((m) => DEST_OF_FOLDER.get(m.folder)).filter(Boolean));
  const held = messages.filter((m) => m.folder === FOLDER_OF_VIEW.screener);

  return {
    key,
    address: seed.from.address,
    name: seed.from.name,
    messages,
    current: places.size === 1 ? ([...places][0] as ScreeningDest | "screener") : null,
    waiting: held.length > 0,
    representativeId: held[0]?.id ?? null,
  };
}

export interface ScreeningPlan {
  /** What goes on the wire, in dispatch order. Empty means nothing to do. */
  mutations: EngineMutation[];
  /**
   * Whether the server will remember this. Only `POST /screener/:id` promotes a rule; a
   * composition of `move`s does not, and the copy has to say which one happened.
   */
  rule: boolean;
  /** Messages this will relocate. */
  moved: number;
}

/**
 * The mutations that put every message from `s` into `dest`.
 *
 * Order matters and is the correctness: the decide goes first so each follow-up `move`
 * computes its optimistic effect against an overlay that already contains it (the engine's
 * overlay is last-write-wins per entity), which is the same ordering `screener-state.ts`
 * documents for the Screener's own path.
 */
export function planScreeningChange(s: SenderScreening, dest: ScreeningDest): ScreeningPlan {
  const wanted = FOLDER_OF_VIEW[dest];
  const mutations: EngineMutation[] = [];
  const movedByDecide = new Set<string>();

  if (s.waiting && s.representativeId) {
    const decision = DECISION_OF_DEST[dest];
    mutations.push({
      kind: "screener_decide",
      senderId: s.representativeId,
      decision,
      scope: "sender",
      ...(decision === "yes" ? { dest: "ohbox" as const } : {}),
    });
    // The endpoint moves the WAITING mail and nothing else, to its own folder. Anything it
    // has already put where we want it must not be moved a second time.
    if (WIRE_DECIDE_FOLDER[decision] === wanted) {
      for (const m of s.messages) {
        if (m.folder === FOLDER_OF_VIEW.screener) movedByDecide.add(m.id);
      }
    }
  }

  const toMove = s.messages.filter((m) => m.folder !== wanted && !movedByDecide.has(m.id));
  for (const m of toMove) mutations.push({ kind: "move", messageId: m.id, folder: wanted });

  return {
    mutations,
    rule: s.waiting && s.representativeId != null,
    moved: toMove.length + movedByDecide.size,
  };
}
