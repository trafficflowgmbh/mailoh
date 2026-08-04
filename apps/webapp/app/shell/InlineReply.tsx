"use client";

/**
 * REPLYING INSIDE THE MESSAGE.
 *
 * Three requirements that are really one: a reply belongs inside the message it answers.
 * Compose opened a dialog the keyboard could not leave; it took the message off the screen at
 * the moment you started answering it; and the conversation has to stay scrollable while you
 * write.
 *
 * Reply used to navigate `#/ohbox` → `#/compose`: the message you were answering left the
 * screen at the exact moment you started answering it. This renders inside
 * `<article class="msg">`, so the subject, the sender line and the body stay exactly where
 * they were and the editor opens underneath them.
 *
 * ── THE CONVERSATION IS ABOVE IT, AND IT IS NOT THIS COMPONENT'S ────────────────────────
 *
 * And the editor must not repeat the message that is already on screen.
 *
 * This used to render a `.reply-context` scroller of its own — the whole conversation,
 * oldest first, 190px tall, including the message being answered. `MessagePane` stood its
 * own copy down while that was up, so the LIST was never doubled; the focused message's body
 * was, once as the pane's `.msg-body` and once inside the quote. The reader got the same mail
 * twice in one scrolling column and had to scroll past a duplicate to reach the textarea.
 *
 * So the ownership inverted: the pane keeps the conversation in full message anatomy and
 * this is head + textarea + actions + status, scrolled into view on open. "Scroll through
 * the actual email conversation" is answered by the actual conversation — which is what the
 * request said — rather than by a quote of it in a nested scroller.
 *
 * NOTHING ABOUT THE PAYLOAD CHANGED. Sending was, and is, `{inReplyTo, body}` with `body`
 * exactly what was typed (`http-adapter.ts` `mailSend`). There has never been a quoted
 * original in outgoing mail and this slice did not add one: the parent's text in the payload
 * is how a `no_forward` message's redacted body would leave the account (invariant #1).
 * What the editor shows and what it sends are two different questions, and only the first
 * one moved.
 *
 * The draft is kept in `localStorage`, per message: this is the client's own scratch
 * buffer, not an IMAP draft. Server-side drafts are a later phase and belong on the mailbox
 * itself; nothing here claims they already exist.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { Button, Kbd } from "@ohmail/ui";
import { rowAddress, senderName } from "./format";
import { canSend, type SendState } from "./mail-send";
import { SendStatus } from "./SendStatus";
import { useMailboxFacts } from "./MailStateProvider";
import { optionsFromFacts, resolveReplyFrom } from "./compose-from";

/*
 * The scratch-buffer helpers and `canSend` used to live here and now live in `mail-send.ts`,
 * with the send machine that consumes them — clearing the buffer is part of what "the send
 * landed" means, and `canSend` is shared with Compose since U4f. Keeping them here while
 * `mail-send.ts` imported them would also have made a real import cycle out of what used to
 * be a type-only one.
 */

export function InlineReply({
  message,
  value,
  send = { phase: "idle" },
  onChange,
  onClose,
  onSend,
}: {
  message: EngineMessage;
  value: string;
  /** How the send is going — see `mail-send.ts`. Defaults to idle for panes with no shell. */
  send?: SendState;
  onChange: (next: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const t = useTranslations("reply");
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  /**
   * WHICH ADDRESS IS ANSWERING.
   *
   * A reply goes out from the mailbox the message ARRIVED in — `Engine.enrich` has always
   * derived that from the parent (`engine.ts:671`) and this slice does not change it. What it
   * changes is that the editor now says so, and that the one case where the default is not
   * available is stated instead of discovered afterwards.
   *
   * The SAME pure call `AppShell.sendReply` makes, over the same options, so the sentence below
   * and the id on the wire are one decision. `resolveReplyFrom` returns nothing at all when the
   * facts cannot be seen (Desktop, demo, a pane mounted with no provider) — and no line is
   * rendered then, because a From line is a claim.
   *
   * THE MIRROR'S `"mailbox"` ENTITIES ARE DELIBERATELY NOT CONSULTED HERE, though Compose does
   * use them. Reading them needs `useEngine()`, which throws outside an `EngineProvider`, and
   * this component is mounted bare in more than one harness. The trade is honest rather than
   * merely convenient: the fixture rows carry no status, so on the demo and the Desktop they
   * could only ever repeat the parent's own mailbox — the substitution, which is the whole
   * reason this line is worth rendering on a reply, is a fact only `GET /mailboxes` holds.
   */
  const facts = useMailboxFacts();
  const from = resolveReplyFrom(facts ? optionsFromFacts(facts) : [], message.mailboxId);

  /**
   * BRING THE EDITOR TO THE READER.
   *
   * The conversation above is no longer a bounded 190px quote — it is the real thread, as
   * tall as it is, inside the column that scrolls (`.read-col` / `.reader`; the conversation
   * deliberately has no scroller of its own, see `app.css`). On a deep thread the editor can
   * therefore open below the fold, and an editor nobody can see is the compose dialog's
   * failure wearing different clothes.
   *
   * `focus()` alone already scrolls in a browser, which is exactly why the scroll is stated
   * separately: that is a side effect of focusing rather than an intent, and what it brings
   * into view is the CARET — so a tall editor could arrive with its head and its `to` line
   * still above the fold. The BOX is scrolled, `block: "nearest"`, so a column that is
   * already showing it does not jump.
   *
   * `scrollIntoView` is optional-chained on the METHOD, not only the node: jsdom does not
   * implement it (see `body-open.test.ts`, which stubs it for the views that call it
   * unguarded), and the suites that drive the whole shell must not have to patch the DOM in
   * order to open a reply editor.
   */
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
    editor.current?.focus();
  }, [message.id]);

  const inFlight = send.phase === "sending" || send.phase === "queued";
  // LOCKED, not merely styled: `disabled` is what stops a second key being minted. Shared
  // with the state machine — see `canSend`. The mutation it judges is the one this editor
  // would send, so the button and the machine cannot reach different verdicts; a reply needs
  // no recipient of its own (`enrich` derives it from the parent), which is why `inReplyTo`
  // and `body` are the whole shape here.
  const locked = !canSend(send, { kind: "mail_send", inReplyTo: message.id, body: value });

  return (
    <div className="reply" data-reply-for={message.id} ref={box}>
      <div className="reply-head">
        <b>{t("to", { name: senderName(message) })}</b>
        {/* Only when it adds something — see `rowAddress`. */}
        {rowAddress(message) ? <small>{rowAddress(message)}</small> : null}
      </div>

      {/* FROM, and the substitution said out loud. Static text, never a control: a
          reply has a right answer — the address the sender wrote to — and offering to change it
          here is a different feature from being able to SEE it. */}
      {from.address !== null ? (
        <p className="reply-from">
          <span>{t("from", { address: from.address })}</span>
          {from.substituted ? (
            <span className="reply-from-sub">
              {from.substitutedFrom
                ? t("fromSubstituted", { was: from.substitutedFrom })
                : t("fromSubstitutedUnknown")}
            </span>
          ) : null}
        </p>
      ) : null}

      {/* NO QUOTED CONTEXT HERE. It was a `.reply-context` scroller between the head and the
          textarea; the conversation it held is the pane's, above — see the header. */}
      <textarea
        ref={editor}
        className="reply-editor"
        aria-label={t("editorAria")}
        placeholder={t("placeholder")}
        value={value}
        /* The text is never taken away from the author, not even mid-send: a failed send
           whose draft had been cleared would be a reply the user has to write twice. */
        readOnly={inFlight}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="reply-actions">
        <Button
          variant="primary"
          disabled={locked}
          aria-busy={send.phase === "sending" || undefined}
          onClick={() => onSend()}
        >
          {send.phase === "sending" ? t("sending") : t("send")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
        <span className="reply-hint">
          <Kbd>esc</Kbd> {t("hintEsc")}
        </span>
      </div>

      <SendStatus send={send} scope="reply" />
    </div>
  );
}
