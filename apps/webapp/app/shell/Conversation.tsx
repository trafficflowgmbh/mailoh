"use client";

/**
 * THE CONVERSATION, RENDERED (slice P6b).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * C3 put threading in the mirror — 2 319 threads on the owner's mailbox, largest 18 — and
 * the reader never showed it. Measured live on 2026-08-02: opening "Re: Quote for the north
 * elevation", one of THREE messages on thread `d3901e85`, rendered one body and no thread
 * count. The data half shipped; the UI half was never in scope.
 *
 * ── ONE LIST, TWO DENSITIES, ONE SURFACE AT A TIME ──────────────────────────────────────
 *
 * `variant="pane"` renders the Blanc `.hmail` card — the same card the Screener uses for
 * held mail, so "a message rendered inside another message" looks the same wherever the
 * product does it. `variant="quote"` renders the tighter `.reply-quoted` block that lives
 * in `InlineReply`'s 190px scroller. Two densities of ONE list, not two features: the
 * order, the count and the focus marker are decided here, once.
 *
 * Exactly one of them is on screen at a time — see `MessagePane`, which stands its own copy
 * down while the reply editor below it is showing the same list.
 *
 * ── BOTH SIDES, SINCE U4c ───────────────────────────────────────────────────────────────
 *
 * This used to render a `ConversationLimit` note saying the user's own replies were not in
 * `messages` at all, because `Sent` was unwatched. Slice U4c watches it, so the note and the
 * string behind it are gone: they became false the moment the worker shipped, and a claim
 * that has stopped being true is not a caveat, it is an error.
 *
 * The residual limit is a HISTORY DEPTH, not a missing half: the worker ingests the newest
 * `DEFAULT_SENT_HISTORY_MESSAGES` (2 000) of Sent, so a conversation whose outbound half is
 * older than that still shows one side. It is not stated on screen — a permanent caveat on
 * every conversation, for a case that needs two thousand sent messages to reach, is noise —
 * and it is recorded in `packages/core/src/adapters/imap-types.ts` and BETA-GAPS instead.
 *
 * ── BOUNDING, AND WHY THERE IS NO ACCORDION ─────────────────────────────────────────────
 *
 * Every message on the thread renders in full. Not "the newest five and a count": a count
 * standing in for mail nobody can open is the collapse invariant #6 forbids, and it is the
 * exact shape of the "N archived" placeholder the owner rejected. The cost is bounded by
 * what the mirror actually holds, which for a SIBLING is the snippet.
 *
 * ── AND THAT IS NOW A CHOICE RATHER THAN A LIMIT (slice U5-BODY) ─────────────────────────
 *
 * This paragraph used to say "the same degradation `heldOf()` documents for the Screener",
 * and that sentence has stopped being true: `heldOf` hydrates. `GET /messages/:id/body` is
 * reachable from the client now, so the siblings COULD be filled — and they are deliberately
 * not.
 *
 * The FOCUSED message is hydrated (`MessagePane` reads `bodyOf`); its siblings are context
 * around it. Fetching a whole thread because one message was opened is per-message billed
 * reads for mail nobody asked to read, which is the pile-wide prefetch the U5 ruling refuses
 * — and eighteen full bodies (the largest thread on the owner's mailbox) in one scrolling
 * column is not a reading surface either. The expand-on-click affordance that was designed
 * and dropped here was dropped because on Cloud it revealed the identical text it hid; that
 * reason is gone, so a per-sibling expand is now a REAL option and is filed as owed for
 * U5-REPLY, which is the slice that owns this column's layout.
 */
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { displayTime, rowAddress, senderName } from "./format";

export type ConversationVariant = "pane" | "quote";

/**
 * What a SIBLING entry shows for a body — never a protected message's contents.
 *
 * Named `entryBody` rather than `bodyOf` since U5-BODY: `bodyOf` is now the engine selector
 * every open-context surface uses, and two functions with one name meaning different things
 * in one app is how the wrong one gets called. This one deliberately does NOT consult a
 * `message_body` record — see the header for why siblings are not hydrated.
 */
function entryBody(m: EngineMessage, protectedLabel: string): string {
  return m.protected ? protectedLabel : (m.body ?? m.snippet);
}

/**
 * A subject with its reply prefixes stripped, case-folded — used ONLY to decide whether an
 * entry's subject says anything the conversation's own heading did not.
 *
 * Without it a three-deep thread prints "Re: Quote for the north elevation" three times
 * under the h2 that already says it. Multilingual on purpose: the mailboxes this reads are
 * the customer's existing ones, so German (`AW:`, `WG:`) and Nordic (`SV:`, `VS:`) prefixes
 * are as likely as `Re:`. It never CHANGES a subject — a renamed branch of a thread still
 * prints its own heading, which is the case where the heading earns its space.
 */
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;

function subjectKey(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").trim().toLowerCase();
}

/** How deep this conversation is. The count the `P6-THREAD` journey looks for. */
export function ConversationHead({ count }: { count: number }) {
  const t = useTranslations("reply");
  return <p className="conv-head num">{t("conversationCount", { count })}</p>;
}

export function ConversationEntries({
  messages,
  focusedId,
  threadSubject,
  now,
  variant,
}: {
  /** The entries to render, OLDEST FIRST. */
  messages: EngineMessage[];
  /**
   * The message the reader opened, marked `aria-current` when it appears in `messages`.
   * The pane variant renders the focused message with the full message anatomy instead and
   * passes only its siblings, so nothing here is marked; the quote variant includes it.
   */
  focusedId?: string;
  /** The subject already on screen as the message's own heading — see `subjectKey`. */
  threadSubject?: string;
  now: Date;
  variant: ConversationVariant;
}) {
  const t = useTranslations("reply");
  if (messages.length === 0) return null;
  const alreadySaid = threadSubject ? subjectKey(threadSubject) : null;

  return (
    <>
      {messages.map((m) => {
        const focused = m.id === focusedId;
        const current = focused ? ({ "aria-current": "true" } as const) : {};
        return variant === "pane" ? (
          <article
            key={m.id}
            className={focused ? "hmail conv-focus" : "hmail"}
            data-conv-id={m.id}
            {...current}
          >
            <div className="hm-line">
              <b>{senderName(m)}</b>
              {rowAddress(m) ? <span className="addr">{rowAddress(m)}</span> : null}
              <span className="t num">{displayTime(m, now)}</span>
            </div>
            {alreadySaid === subjectKey(m.subject) ? null : <h3>{m.subject}</h3>}
            <div className="hm-body">{entryBody(m, t("quotedProtected"))}</div>
          </article>
        ) : (
          <article
            key={m.id}
            className={focused ? "reply-quoted conv-focus" : "reply-quoted"}
            data-conv-id={m.id}
            {...current}
          >
            <div className="rq-line">
              <b>{senderName(m)}</b>
              {focused ? <span className="conv-here">{t("conversationHere")}</span> : null}
              <span className="t num">{displayTime(m, now)}</span>
            </div>
            <div className="rq-body">{entryBody(m, t("quotedProtected"))}</div>
          </article>
        );
      })}
    </>
  );
}
