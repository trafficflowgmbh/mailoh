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

export function InlineReply({
  message,
  context,
  now,
  value,
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
  onChange: (next: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const t = useTranslations("reply");
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editor.current?.focus();
  }, [message.id]);

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
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="reply-actions">
        <Button variant="primary" aria-disabled="true" title={t("sendTitle")} onClick={onSend}>
          {t("send")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
        <span className="reply-hint">
          <Kbd>esc</Kbd> {t("hintEsc")}
        </span>
      </div>
    </div>
  );
}
