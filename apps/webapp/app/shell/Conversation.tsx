"use client";

/**
 * THE CONVERSATION, RENDERED.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Threading reached the mirror and the reader never showed it: opening a message that was one
 * of three on its thread rendered one body and no thread count. The data half shipped; the UI
 * half was never in scope.
 *
 * ── ONE LIST, ONE DENSITY, ONE PLACE ─────────────────────────────────────────────────────
 *
 * A sibling renders as the Blanc `.hmail` card — the same card the Screener uses for held
 * mail, so "a message rendered inside another message" looks the same wherever the product
 * does it.
 *
 * There was a second density once: `variant="quote"`, a tighter `.reply-quoted`
 * block for `InlineReply`'s 190px scroller, with a `focusedId` marker because that copy
 * included the message being answered. Both are gone with that scroller. The pane now keeps
 * the conversation while the editor is open — a reply must not repeat the message that is
 * already on screen — so there is exactly one rendering of a sibling in the product and
 * this is it. A parameterised variant with one caller is a fork nobody is walking; if a
 * second surface ever needs its own density, it comes back with that surface, tested.
 *
 * ── BOTH SIDES OF THE THREAD ────────────────────────────────────────────────────────────
 *
 * This used to render a `ConversationLimit` note saying the user's own replies were not in
 * `messages` at all, because `Sent` was unwatched. The worker watches it now, so the note and the
 * string behind it are gone: they became false the moment the worker shipped, and a claim
 * that has stopped being true is not a caveat, it is an error.
 *
 * The residual limit is a HISTORY DEPTH, not a missing half: the worker ingests the newest
 * `DEFAULT_SENT_HISTORY_MESSAGES` (2 000) of Sent, so a conversation whose outbound half is
 * older than that still shows one side. It is not stated on screen — a permanent caveat on
 * every conversation, for a case that needs two thousand sent messages to reach, is noise —
 * and it is recorded beside the ingest constant that sets the depth instead.
 *
 * ── BOUNDING, AND WHY THERE IS NO ACCORDION ─────────────────────────────────────────────
 *
 * Every message on the thread renders in full. Not "the newest five and a count": a count
 * standing in for mail nobody can open is the collapse invariant #6 forbids, and it is the
 * exact shape of the "N archived" placeholder this product refuses. The cost is bounded by
 * what the mirror actually holds, which for a SIBLING is the snippet.
 *
 * ── AND THAT IS NOW A CHOICE RATHER THAN A LIMIT ─────────────────────────────────────────
 *
 * This paragraph used to say "the same degradation `heldOf()` documents for the Screener",
 * and that sentence has stopped being true: `heldOf` hydrates. `GET /messages/:id/body` is
 * reachable from the client now, so the siblings COULD be filled — and they are deliberately
 * not.
 *
 * The FOCUSED message is hydrated (`MessagePane` reads `bodyOf`); its siblings are context
 * around it. Fetching a whole thread because one message was opened is per-message billed
 * reads for mail nobody asked to read, which is the pile-wide prefetch this product refuses —
 * and a couple of dozen full bodies, which a long thread really can be, in one scrolling column
 * is not a reading surface either. The expand-on-click affordance that was designed
 * and dropped here was dropped because on Cloud it revealed the identical text it hid; that
 * reason is gone, so a per-sibling expand is a REAL option.
 *
 * The work that owns this column's layout was to answer that — and the answer is NO, not yet,
 * stated here rather than left as an open "owed". Its whole job was to stop the reader being
 * shown the same mail twice; adding a per-sibling fetch-and-expand in the same breath would have put a second,
 * billed, failable interaction into the column under test. Siblings stay snippets. The
 * affordance is owed to whichever slice next has a reason to open a sibling, and it inherits
 * `bodyOf` and `hydrateBody` ready-made.
 */
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { BodyText } from "./BodyText";
import { displayTime, rowAddress, senderName } from "./format";

/**
 * What a SIBLING entry shows for a body — never a protected message's contents.
 *
 * Named `entryBody` rather than `bodyOf`: `bodyOf` is the engine selector
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

/** How deep this conversation is. */
export function ConversationHead({ count }: { count: number }) {
  const t = useTranslations("reply");
  return <p className="conv-head num">{t("conversationCount", { count })}</p>;
}

export function ConversationEntries({
  messages,
  threadSubject,
  now,
}: {
  /**
   * The entries to render, OLDEST FIRST — the SIBLINGS only. The opened message keeps the
   * full message anatomy and is rendered by `MessagePane` itself, between the two halves of
   * this list, which is what makes "which one am I reading" answerable without a legend.
   */
  messages: EngineMessage[];
  /** The subject already on screen as the message's own heading — see `subjectKey`. */
  threadSubject?: string;
  now: Date;
}) {
  const t = useTranslations("reply");
  if (messages.length === 0) return null;
  const alreadySaid = threadSubject ? subjectKey(threadSubject) : null;

  return (
    <>
      {messages.map((m) => (
        <article key={m.id} className="hmail" data-conv-id={m.id}>
          <div className="hm-line">
            <b>{senderName(m)}</b>
            {rowAddress(m) ? <span className="addr">{rowAddress(m)}</span> : null}
            {/* A message with no `Date:` header has no stamp, and this rendered the
                slot anyway: an empty `.t` element with the row's stamp styling and nothing
                in it. `MessageRow` already guards the same slot the same way. */}
            {displayTime(m, now) ? <span className="t num">{displayTime(m, now)}</span> : null}
          </div>
          {alreadySaid === subjectKey(m.subject) ? null : <h3>{m.subject}</h3>}
          {/* THE SAME `BodyText` THE FOCUSED MESSAGE USES, and that is the point of
              touching this file at all. The pane's body and the siblings' bodies are the same
              prose problem seen twice; fixing only the pane leaves a fixed message sitting in a
              thread of raw dumps, which is the "built, tested, unreachable" shape this repo has
              shipped five times. A sibling's text is a SNIPPET (see the header — siblings are
              deliberately not hydrated), so in practice it is one paragraph; what it gains is
              the wrap rule and a real anchor when the snippet ends mid-URL. */}
          <div className="hm-body">
            <BodyText text={entryBody(m, t("quotedProtected"))} />
          </div>
        </article>
      ))}
    </>
  );
}
