"use client";

/**
 * REPLYING INSIDE THE MESSAGE (slice U4).
 *
 * Owner, verbatim: *"writing an email opens the compose dialog which is very unusuful (cant
 * even esc out of it with key)"* · *"must open an inline (within the open mail) classic
 * reply editor which shows me context of the message, allows me to scroll through the
 * actual email conversation"* · *"replys have to be within context of the message"*.
 *
 * Reply used to navigate `#/ohbox` → `#/compose`: the message you were answering left the
 * screen at the exact moment you started answering it. This renders inside
 * `<article class="msg">`, so the subject, the sender line and the body stay where they
 * were and the quoted original sits directly above the editor.
 *
 * ── THE CONVERSATION ABOVE IT ───────────────────────────────────────────────────────────
 *
 * "Scroll through the actual email conversation" needed threads. When this shipped they did
 * not exist — `thread_id` was NULL on every production row (gap C3) — so `context` was a
 * LIST holding exactly one entry, the message being answered, with a note on screen saying
 * so. C3 landed on 2026-08-02 and `threadOf` reads it, so `MessagePane` now passes the whole
 * chain and this renders it, oldest first, in its own 190px scroller: the editor never gets
 * pushed off the bottom of the reading pane however deep the conversation runs.
 *
 * It shows BOTH sides since U4c: the worker watches the mailbox's own Sent folder, so the
 * user's replies are in `messages` and on the thread. The `ConversationLimit` note that used
 * to say otherwise is gone with the condition it described — see `Conversation.tsx`.
 *
 * The draft is kept in `localStorage`, per message: this is the client's own scratch
 * buffer, not an IMAP draft. Drafts on the server are P3 and the owner has ruled they must
 * live on the mailbox; nothing here claims they already do.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { Button, Kbd } from "@ohmail/ui";
import { ConversationEntries, ConversationHead } from "./Conversation";
import { rowAddress, senderName } from "./format";
import type { ReplySendState } from "./reply-send";

/** `localStorage` key for a per-message reply draft. */
export const replyDraftKey = (messageId: string): string => `ohmail.ui.reply:${messageId}`;

export function readReplyDraft(messageId: string): string {
  try {
    return window.localStorage.getItem(replyDraftKey(messageId)) ?? "";
  } catch {
    return ""; // storage blocked — the editor still works for this session
  }
}

export function writeReplyDraft(messageId: string, body: string): void {
  try {
    if (body) window.localStorage.setItem(replyDraftKey(messageId), body);
    else window.localStorage.removeItem(replyDraftKey(messageId));
  } catch {
    /* private mode refuses writes; the draft lives in React state only */
  }
}

/**
 * MAY THIS REPLY BE SENT RIGHT NOW? — ONE predicate, two consumers.
 *
 * The button's `disabled` and the state machine's own refusal used to be two copies of the
 * same rule, and a mutation test proved what that costs: deleting the guard inside
 * `useReplySend.send` left every assertion green, because they all went through the button.
 * A rule with two implementations has one that nothing watches.
 *
 * `sending`/`queued` are locked because a second press mints a second Idempotency-Key, which
 * is a second reservation, which is a second delivery to a real person. Empty is locked
 * because the server accepts a blank body (`drafts-service.ts:167-171`) and would post it.
 * `unverified` and `failed` are NOT locked: both are terminal on the server for that draft,
 * so the only way forward is a fresh send the user deliberately chooses.
 */
export function canSend(send: ReplySendState, body: string): boolean {
  if (send.phase === "sending" || send.phase === "queued") return false;
  return body.trim().length > 0;
}

export function InlineReply({
  message,
  context,
  now,
  value,
  send = { phase: "idle" },
  onChange,
  onClose,
  onSend,
}: {
  message: EngineMessage;
  /**
   * The conversation, oldest first, rendered above the editor — `threadOf`. Holds exactly
   * one entry (the message being answered) when there is no conversation to show.
   */
  context: EngineMessage[];
  now: Date;
  value: string;
  /** How the send is going — see `reply-send.ts`. Defaults to idle for panes with no shell. */
  send?: ReplySendState;
  onChange: (next: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const t = useTranslations("reply");
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editor.current?.focus();
  }, [message.id]);

  const inFlight = send.phase === "sending" || send.phase === "queued";
  // LOCKED, not merely styled: `disabled` is what stops a second key being minted. Shared
  // with the state machine — see `canSend`.
  const locked = !canSend(send, value);

  /**
   * The line under the buttons, and the reason it is `role="status"` with `aria-live`: a
   * send resolves out of band, sometimes minutes later on a retry, so the outcome has to
   * reach a screen reader without the focus being anywhere near it.
   *
   * `queued` and `unverified` deliberately do NOT say "sent". They are the two states a
   * hurried reader is most likely to misread as success, and the copy is written against
   * that: one says it has not gone yet, the other says we cannot tell.
   */
  const status: { tone: "pending" | "warn" | "error"; text: string } | null =
    send.phase === "sending"
      ? { tone: "pending", text: t("statusSending") }
      : send.phase === "queued"
        ? { tone: "pending", text: t("statusQueued") }
        : send.phase === "unverified"
          ? { tone: "warn", text: t("statusUnverified") }
          : send.phase === "failed"
            ? { tone: "error", text: t("statusFailed", { reason: send.reason ?? t("reasonUnknown") }) }
            : null;

  return (
    <div className="reply" data-reply-for={message.id}>
      <div className="reply-head">
        <b>{t("to", { name: senderName(message) })}</b>
        {/* Only when it adds something — see `rowAddress`. */}
        {rowAddress(message) ? <small>{rowAddress(message)}</small> : null}
      </div>

      {/* The conversation, scrollable in its own right so a deep one never pushes the
          editor off the bottom of the reading pane. Same component and same order as the
          copy `MessagePane` renders when this editor is closed. */}
      <div className="reply-context" role="group" aria-label={t("conversationAria")}>
        {context.length > 1 ? <ConversationHead count={context.length} /> : null}
        <ConversationEntries messages={context} focusedId={message.id} now={now} variant="quote" />
        {context.length > 1 ? null : <p className="reply-note">{t("singleMessage")}</p>}
      </div>

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

      {status ? (
        <p className={`reply-status ${status.tone}`} role="status" aria-live="polite">
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
