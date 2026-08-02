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
 * ── THE CONVERSATION ABOVE IT IS ONE MESSAGE, AND THAT IS NOT A DESIGN CHOICE ───────────
 *
 * "Scroll through the actual email conversation" needs threads, and threads do not exist
 * yet: ingestion never sets `thread_id`, so it is NULL on all 301 production rows and no
 * two messages in the mirror share one (gap C3, measured 2026-08-02 by `P6-THREAD`).
 * `context` is therefore a LIST that today holds exactly one entry — the message being
 * answered — and C3 fills it with the rest of the chain without touching this component.
 * Faking a thread from subject prefixes would be a different feature wearing C3's name.
 *
 * The draft is kept in `localStorage`, per message: this is the client's own scratch
 * buffer, not an IMAP draft. Drafts on the server are P3 and the owner has ruled they must
 * live on the mailbox; nothing here claims they already do.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { Button, Kbd } from "@ohmail/ui";
import { displayTime, rowAddress, senderName } from "./format";

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
   * The conversation, oldest first, rendered above the editor. One entry today — see the
   * header. Whatever C3 puts in here renders without further work.
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

      {/* The context, scrollable in its own right so a long conversation never pushes the
          editor off the bottom of the reading pane. */}
      <div className="reply-context">
        {context.map((m) => (
          <article key={m.id} className="reply-quoted">
            <div className="rq-line">
              <b>{senderName(m)}</b>
              <span className="t num">{displayTime(m, now)}</span>
            </div>
            <div className="rq-body">{m.protected ? t("quotedProtected") : (m.body ?? m.snippet)}</div>
          </article>
        ))}
        {context.length <= 1 ? <p className="reply-note">{t("singleMessage")}</p> : null}
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
