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
 * order, the count, the focus marker and the honest limit are decided here, once.
 *
 * Exactly one of them is on screen at a time — see `MessagePane`, which stands its own copy
 * down while the reply editor below it is showing the same list.
 *
 * ── WHAT IT DOES NOT CLAIM ──────────────────────────────────────────────────────────────
 *
 * `Sent` is not in `WATCHED_FOLDERS` (gap U4c), so nothing the user sends ever enters
 * `messages`, and this can only ever show the counterpart's half of a conversation.
 * `ConversationLimit` says so on screen rather than leaving the user to work it out from
 * their own replies being missing. When U4c lands, this component fills out and the note
 * goes with the condition that produced it.
 *
 * ── BOUNDING, AND WHY THERE IS NO ACCORDION ─────────────────────────────────────────────
 *
 * Every message on the thread renders in full. Not "the newest five and a count": a count
 * standing in for mail nobody can open is the collapse invariant #6 forbids, and it is the
 * exact shape of the "N archived" placeholder the owner rejected. The cost is bounded by
 * what the mirror actually holds, which is SNIPPETS — the wire `MessageDTO` carries
 * `snippet`, not `body`, so a server-fed entry is one short paragraph (the same degradation
 * `heldOf()` documents for the Screener). An expand-on-click affordance was designed and
 * dropped: on Cloud it would reveal the identical text it hides, i.e. a primary-looking
 * control that does nothing, which is what gap U4b is already filed for. If a future slice
 * mirrors full bodies, the bound to add is here — and it is a real decision then, not now.
 */
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { displayTime, rowAddress, senderName } from "./format";

export type ConversationVariant = "pane" | "quote";

/** What an entry shows for a body — never a protected message's contents. */
function bodyOf(m: EngineMessage, protectedLabel: string): string {
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

/**
 * The limit, stated. It is not a disclaimer bolted on: without it the view IMPLIES that a
 * conversation with no replies from you is one you never answered.
 */
export function ConversationLimit() {
  const t = useTranslations("reply");
  return <p className="conv-note">{t("onlyTheirSide")}</p>;
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
            <div className="hm-body">{bodyOf(m, t("quotedProtected"))}</div>
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
            <div className="rq-body">{bodyOf(m, t("quotedProtected"))}</div>
          </article>
        );
      })}
    </>
  );
}
