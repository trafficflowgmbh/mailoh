"use client";

/**
 * One message anatomy for the Ohbox read column AND the reader overlay:
 * from-line, subject, chips (routing rationale, tracker shield, tags,
 * add-affordance), body or the protected-OTP block, attachment, actions.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FOLDER_OF_VIEW, type EngineMessage, type OhmailView, type TagDTO } from "@ohmail/client-engine";
import { Button, Chip, ProtectedBlock, ReadingPane } from "@ohmail/ui";
import { PLACE_LABEL, avatarHue, displayTime, hueOf, initialsOf, rowAddress, senderName, tagsOfMessage } from "./format";
import { InlineReply } from "./InlineReply";
import { useMessageChrome } from "./message-chrome";

/**
 * MOVE CARRIES ITS DESTINATION (gap C4).
 *
 * It used to be a bare `"move"` that AppShell answered with a toast reading "Demo — Move
 * isn't wired yet." — on live, paying accounts. The mutation it needed has been on the
 * wire the whole time (`POST /messages/:id/move`, contract-tested), and the only thing
 * missing was a destination, so the action carries one. A template member rather than a
 * second callback argument: every pass-through of `onAction` keeps compiling unchanged.
 */
export type MoveTarget = Extract<OhmailView, "ohbox" | "reads" | "receipts" | "screened" | "spam">;
export type MessageAction = "reply" | "later" | "aside" | "resurface" | "draft" | `move:${MoveTarget}`;

/** The DecisionBar's vocabulary, so filing means the same thing everywhere. */
const MOVE_TARGETS: MoveTarget[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/** "Protected — …" renders with the leading word bolded, like the prototype. */
function ProtectedPolicy({ text }: { text: string }) {
  const dash = text.indexOf(" — ");
  if (dash < 0) return <>{text}</>;
  return (
    <>
      <b>{text.slice(0, dash)}</b>
      {text.slice(dash)}
    </>
  );
}

export function MessagePane({
  message,
  tags,
  now,
  onEnterReader,
  onAction,
  onAddTag,
  onAttachment,
}: {
  message: EngineMessage;
  tags: TagDTO[];
  now: Date;
  onEnterReader?: () => void;
  onAction: (action: MessageAction) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  onAttachment: () => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");
  const addRef = useRef<HTMLSpanElement>(null);
  const isProtected = message.protected != null;
  const mine = tagsOfMessage(message, tags);
  const [moving, setMoving] = useState(false);
  const chrome = useMessageChrome();

  // A half-open destination row must not carry over to the next message.
  useEffect(() => setMoving(false), [message.id]);

  return (
    <ReadingPane
      from={senderName(message)}
      address={rowAddress(message)}
      avatarInitial={initialsOf(senderName(message))}
      avatarHue={avatarHue(message.from.address)}
      onSender={(anchor) => chrome.openSenderMenu(message.id, anchor)}
      senderTitle={tr("openFor", { sender: message.from.address })}
      time={`${message.threadCount ? t("threadMeta", { count: message.threadCount }) : ""}${displayTime(message, now)}`}
      subject={message.subject}
      onEnterReader={onEnterReader}
      chips={
        <>
          {message.rationale ? <Chip variant="rationale">{message.rationale}</Chip> : null}
          {message.trackerNote ? <Chip variant="tracker">{message.trackerNote}</Chip> : null}
          {mine.map((tag) => (
            <Chip key={tag.id} variant="tag" hue={hueOf(tag)} big>
              {tag.name}
            </Chip>
          ))}
          <span ref={addRef} style={{ display: "inline-flex" }}>
            <Chip
              variant="add"
              kbdHint="t"
              onPress={() => onAddTag(message.id, addRef.current)}
            >
              {t("tagChip")}
            </Chip>
          </span>
        </>
      }
      {...(isProtected
        ? {}
        : { body: message.body ?? message.snippet })}
      attachment={
        message.attachment
          ? {
              filename: message.attachment.filename,
              size: message.attachment.size,
              onPress: onAttachment,
            }
          : undefined
      }
      actions={
        moving ? (
          <>
            <span className="choose-lab">{t("moveLabel")}</span>
            {MOVE_TARGETS.filter((v) => FOLDER_OF_VIEW[v] !== message.folder).map((v) => (
              <Button
                key={v}
                onClick={() => {
                  setMoving(false);
                  onAction(`move:${v}`);
                }}
              >
                → {PLACE_LABEL[v] ?? v}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => setMoving(false)}>
              {t("moveCancel")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onAction("reply")}>{t("actionReply")}</Button>
            <Button onClick={() => onAction("later")}>{t("actionReplyLater")}</Button>
            <Button onClick={() => onAction("aside")}>{t("actionSetAside")}</Button>
            <Button onClick={() => onAction("resurface")}>{t("actionResurface")}</Button>
            {/* U3. "Move" relocates THIS message; screening decides where this SENDER's
                mail goes, which is a different question and had no control anywhere
                outside the Screener. */}
            <Button
              kbdHint="s"
              onClick={(e) =>
                chrome.openSenderMenu(
                  message.id,
                  (e.currentTarget as HTMLElement | null) ?? null,
                )
              }
            >
              {tr("action")}
            </Button>
            <Button variant="ghost" onClick={() => setMoving(true)}>
              {t("actionMove")}
            </Button>
            <Button
              variant="primary"
              icon="spark"
              style={{ marginLeft: "auto" }}
              onClick={() => onAction("draft")}
            >
              {t("actionDraftReply")}
            </Button>
          </>
        )
      }
      reply={
        chrome.replyTo === message.id ? (
          <InlineReply
            message={message}
            /* ONE entry, and `InlineReply`'s header says why: threading does not exist
               yet (C3 — `thread_id` is NULL on every row), so the conversation this can
               honestly show is the message being answered. */
            context={[message]}
            now={now}
            value={chrome.replyBody}
            onChange={chrome.onReplyBody}
            onClose={chrome.closeReply}
            onSend={chrome.sendReply}
          />
        ) : undefined
      }
    >
      {isProtected ? (
        <ProtectedBlock
          label={message.protected!.label}
          redactedNote={message.protected!.redactedNote}
          policy={<ProtectedPolicy text={message.protected!.policy} />}
        />
      ) : undefined}
    </ReadingPane>
  );
}
