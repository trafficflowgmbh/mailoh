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
 * ── O19: THE SCOPE, AND THE HALF OF O19 THAT IS NOT BUILDABLE FROM HERE ──────────────────
 *
 * `scope: "domain"` widens both halves of a decision together — the mail that moves, and the
 * `kind` of the rule the server promotes. It was on the wire and in the mutation vocabulary
 * from the start (`EngineMutation.screener_decide.scope`, `http-adapter.ts`'s body) and NO
 * surface had ever set it, so the whole feature was one argument away and unreachable.
 *
 * **What is still not reachable, and it is a hard blocker rather than a decision.** O19 asks
 * for rule creation to be the DEFAULT everywhere, including from the Ohbox — i.e. for a sender
 * whose mail has already left the gate. That cannot be composed here:
 *
 *   · `screener_decide` is the only rule-creating verb in `EngineMutation`;
 *   · `mutationEffects`' derived branch returns NO effects unless the representative message
 *     is still in `ohmail/Screener` (`mutations.ts`);
 *   · `Engine.mutate` turns zero effects into `status: "rolled_back"` and **never sends the
 *     request** (`engine.ts`), so relaxing the server's own 404 changes nothing;
 *   · and this module cannot go around the engine — `app/api-client` is DENY'd from the
 *     desktop mirror this file is copied into (`scripts/publish-desktop.mjs`).
 *
 * So the honest surface is: a domain decision makes a rule where the gate can still see the
 * sender, and moves mail where it cannot. `footNoRule` therefore STAYS TRUE and stays unchanged
 * for the non-waiting case — it is not a sentence O19 made obsolete, it is one that is still
 * describing what actually happens.
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

/**
 * WHOSE MAIL A CHOICE IS ABOUT (O19).
 *
 * The owner's case is `no-reply-kbdtwjmegmd_he…@x.com` — a per-send address from a sender they
 * experience as one list, which no one would ever rule on individually. `domain` widens both
 * halves of a decision at once: the mail that moves AND, when the sender is still waiting, the
 * `kind` of the rule the server promotes.
 */
export type ScreeningScope = "sender" | "domain";

/** One scope's worth of facts. The sheet renders whichever the user has chosen. */
export interface ScreeningSubject {
  /** Every message the mirror holds for this subject, across all folders. */
  messages: EngineMessage[];
  /** Where that mail sits, or null when it is spread across more than one view. */
  current: ScreeningDest | "screener" | null;
  /** Still waiting: the ONLY state `POST /screener/:id` will resolve. */
  waiting: boolean;
  /** The representative message id that endpoint takes (the newest held one). */
  representativeId: string | null;
  /** How many distinct addresses this subject covers — 1 for `sender`, N for `domain`. */
  senders: number;
}

export interface SenderScreening {
  /** The address, case-folded — the same key the selectors and the server group by. */
  key: string;
  address: string;
  /**
   * The part after the `@`, lower-cased, or `""` for an address that has none.
   *
   * Empty means the domain scope must not be OFFERED: `decide` refuses it with a 400, because
   * an empty `match` on a `kind:'domain'` row is compared against
   * `split_part(lower(from_address), '@', 2)` — also `""` for any other malformed address — so
   * one such rule would quietly rule on all of them.
   */
  domain: string;
  name: string | null;
  /** Every message the mirror holds from this sender, across all folders. */
  messages: EngineMessage[];
  /** Where their mail sits, or null when it is spread across more than one view. */
  current: ScreeningDest | "screener" | null;
  /** Still waiting: the ONLY state `POST /screener/:id` will resolve. */
  waiting: boolean;
  /** The representative message id that endpoint takes (the newest held one). */
  representativeId: string | null;
  /** The same four facts for each scope — `sender` mirrors the four fields above. */
  scopes: Record<ScreeningScope, ScreeningSubject>;
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
  const domain = domainOf(seed.from.address);

  // ONE pass over the mirror for both scopes. Two `.filter()` calls would walk every message in
  // the account twice on a click, and the sheet reads this on every render.
  const mine: EngineMessage[] = [];
  const theirs: EngineMessage[] = [];
  for (const m of reader.list<EngineMessage>("message")) {
    const k = senderKey(m.from.address);
    if (k === key) mine.push(m);
    // `domain !== ""` guards the malformed-address case: without it every address with no `@`
    // would be grouped with every other one under the empty domain.
    if (domain !== "" && domainOf(m.from.address) === domain) theirs.push(m);
  }
  mine.sort(byDateDesc);
  theirs.sort(byDateDesc);

  const sender = subjectOf(mine);
  return {
    key,
    address: seed.from.address,
    domain,
    name: seed.from.name,
    messages: sender.messages,
    current: sender.current,
    waiting: sender.waiting,
    representativeId: sender.representativeId,
    // With no domain there is nothing to widen to, so the domain subject IS the sender subject
    // and `SenderMenu` refuses to offer the switch. It is never a silently-empty second option.
    scopes: { sender, domain: domain === "" ? sender : subjectOf(theirs) },
  };
}

/** The part after the `@`, lower-cased — the server's `domainOf`, on the client. */
export function domainOf(address: string): string {
  const at = address.indexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/** The four facts the sheet renders, plus the sender count, for one already-sorted message set. */
function subjectOf(messages: EngineMessage[]): ScreeningSubject {
  const places = new Set(messages.map((m) => DEST_OF_FOLDER.get(m.folder)).filter(Boolean));
  const held = messages.filter((m) => m.folder === FOLDER_OF_VIEW.screener);
  return {
    messages,
    current: places.size === 1 ? ([...places][0] as ScreeningDest | "screener") : null,
    waiting: held.length > 0,
    // The newest HELD message, because `POST /screener/:id` resolves `:id` against held mail
    // only. Under domain scope that may belong to a different address than the one clicked —
    // which is correct: the server reads the representative's DOMAIN and rules on that.
    representativeId: held[0]?.id ?? null,
    senders: new Set(messages.map((m) => senderKey(m.from.address))).size,
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
  /** The rule's subject, when one is made — `domain` widens it to everyone at the domain. */
  ruleScope: ScreeningScope | null;
  /** Messages this will relocate. */
  moved: number;
  /** Distinct addresses whose mail this touches — the number the domain copy states. */
  senders: number;
  /**
   * Whether committing this ALSO hands mail to auto-unsubscribe, which the sheet must say
   * before the click and not after.
   *
   * True exactly when a rule is made AND the decision is the endpoint's `no`. `decide` calls
   * `unsubscribe.onScreenOut(ctx, <the mail it just re-routed>)` after its commit on the reject
   * branch, and `apps/api-vercel/src/deps.ts` wires that dependency in, so this is live in
   * production rather than latent. A plain `move` to Screened does NOT arm it — nothing calls
   * the drain (`sweepScreenedOut` has no production caller) — so this is false for a sender who
   * has already left the gate, which is the honest answer and not a convenient one.
   */
  unsubscribes: boolean;
}

/**
 * The mutations that put every message from `s` into `dest`.
 *
 * Order matters and is the correctness: the decide goes first so each follow-up `move`
 * computes its optimistic effect against an overlay that already contains it (the engine's
 * overlay is last-write-wins per entity), which is the same ordering `screener-state.ts`
 * documents for the Screener's own path.
 */
export function planScreeningChange(
  s: SenderScreening,
  dest: ScreeningDest,
  scope: ScreeningScope = "sender",
): ScreeningPlan {
  const wanted = FOLDER_OF_VIEW[dest];
  const subject = s.scopes[scope];
  const mutations: EngineMutation[] = [];
  const movedByDecide = new Set<string>();
  const rule = subject.waiting && subject.representativeId != null;

  if (subject.waiting && subject.representativeId) {
    const decision = DECISION_OF_DEST[dest];
    mutations.push({
      kind: "screener_decide",
      senderId: subject.representativeId,
      decision,
      scope,
      ...(decision === "yes" ? { dest: "ohbox" as const } : {}),
    });
    // ── THE DECIDE OWNS EVERY HELD MESSAGE IN SCOPE, AND IS NOT SECOND-GUESSED ────────────
    //
    // The endpoint moves the WAITING mail and nothing else, to its own folder. Anything it has
    // already put where we want it must not be moved a second time — and under `scope:
    // "domain"` that is now the whole domain's held mail, because `decide` re-routes what its
    // scope covers (`screener-service.ts#heldRowsForDomain`).
    //
    // The tempting alternative is to emit `move`s for the domain's OTHER held senders so the
    // overlay paints them at once, since `mutationEffects` only overlays ONE address's held
    // mail whatever `scope` says. It is wrong twice. `AppShell` fires mutations in parallel
    // (`void engine.mutate(m)`), so a `move` that lands FIRST takes the message out of
    // `ohmail/Screener` and `decide`'s held-only lookup then cannot see it — the message is
    // filed with no rule and no consent record, which is the fork this composition exists to
    // avoid. And a message that reaches the destination through `move` instead of `decide` has
    // no learning signal behind it.
    //
    // So those rows lag by one `/sync` drain, visibly and briefly, and that is the accepted
    // cost. The toast already states the true count.
    if (WIRE_DECIDE_FOLDER[decision] === wanted) {
      for (const m of subject.messages) {
        if (m.folder === FOLDER_OF_VIEW.screener) movedByDecide.add(m.id);
      }
    }
  }

  const toMove = subject.messages.filter((m) => m.folder !== wanted && !movedByDecide.has(m.id));
  for (const m of toMove) mutations.push({ kind: "move", messageId: m.id, folder: wanted });

  return {
    mutations,
    rule,
    ruleScope: rule ? scope : null,
    moved: toMove.length + movedByDecide.size,
    senders: subject.senders,
    unsubscribes: rule && DECISION_OF_DEST[dest] === "no",
  };
}
