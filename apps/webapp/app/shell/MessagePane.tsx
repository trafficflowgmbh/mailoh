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
import { ConversationEntries, ConversationHead } from "./Conversation";
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
  /** The conversation's copy lives with the reply's — one namespace owns the thread. */
  const tc = useTranslations("reply");
  const addRef = useRef<HTMLSpanElement>(null);
  const isProtected = message.protected != null;
  const mine = tagsOfMessage(message, tags);
  const [moving, setMoving] = useState(false);
  const chrome = useMessageChrome();

  // A half-open destination row must not carry over to the next message.
  useEffect(() => setMoving(false), [message.id]);

  /**
   * THE CONVERSATION (slice P6b) — oldest first, empty when there is no conversation.
   *
   * Computed on every render rather than memoised: the value it derives from is the engine
   * mirror, which has no signal reachable from here (this pane deliberately holds no engine
   * hook — see `message-chrome.tsx`). The shell re-renders this pane on every version bump,
   * so an inline call is always fresh and a `useMemo` with no version dep would go stale
   * the first time a delta landed.
   */
  const conversation = chrome.conversationOf(message.id);
  const replying = chrome.replyTo === message.id;
  /**
   * ONE COPY OF THE CONVERSATION ON SCREEN, EVER.
   *
   * The reply editor mounts INSIDE this same `<article class="msg">`, three inches below,
   * and its `.reply-context` scroller shows the same list. Rendering both would put the
   * conversation twice in one scrolling column, which reads as a bug. The pane stands its
   * copy down while its own editor is open; nothing is hidden, it moved.
   */
  const showConversation = conversation.length > 0 && !replying;
  /**
   * The from-line count. Real on Cloud now; the fixture fallback stays because the demo
   * world sets `threadId: null` on every row (`fixtures-adapter.ts`) and carries a curated
   * `threadCount` instead — dropping it would delete chrome the demo ships today.
   */
  const threadCount = conversation.length >= 2 ? conversation.length : message.threadCount;

  const focusedBody = isProtected ? (
    <ProtectedBlock
      label={message.protected!.label}
      redactedNote={message.protected!.redactedNote}
      policy={<ProtectedPolicy text={message.protected!.policy} />}
    />
  ) : (
    <p className="msg-body">{message.body ?? message.snippet}</p>
  );

  return (
    <ReadingPane
      from={senderName(message)}
      address={rowAddress(message)}
      avatarInitial={initialsOf(senderName(message))}
      avatarHue={avatarHue(message.from.address)}
      onSender={(anchor) => chrome.openSenderMenu(message.id, anchor)}
      senderTitle={tr("openFor", { sender: message.from.address })}
      time={`${threadCount ? t("threadMeta", { count: threadCount }) : ""}${displayTime(message, now)}`}
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
      {...(isProtected || showConversation
        // `children` REPLACES `body` in `ReadingPane`, so the conversation case composes the
        // whole middle section itself. A message with no conversation keeps exactly the
        // shape it had before this slice: the `body` prop, or the protected block.
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
        replying ? (
          <InlineReply
            message={message}
            /* THE CONVERSATION, not one entry. It used to be `[message]` with a comment
               saying C3 would fill it; C3 landed, `threadOf` reads it, and this is the
               list. Falls back to the message being answered when there is no
               conversation — a reply still quotes what it answers. */
            context={conversation.length > 0 ? conversation : [message]}
            now={now}
            value={chrome.replyBody}
            onChange={chrome.onReplyBody}
            onClose={chrome.closeReply}
            onSend={chrome.sendReply}
          />
        ) : undefined
      }
    >
      {/* THE CONVERSATION IN THE MESSAGE (P6b).
          Oldest first, and the message you opened keeps the full anatomy — plain prose
          between carded siblings — so which one is focused needs no legend. Siblings older
          than it sit above and newer ones below, which means the stack reads in order
          whichever message was opened, not only the newest. */}
      {showConversation ? (
        // `role="group"` because `aria-label` on a bare div is ignored, and a landmark
        // (`<section>`) would be too loud for one part of one message.
        <div className="conv" role="group" aria-label={tc("conversationAria")}>
          <ConversationHead count={conversation.length} />
          <ConversationEntries
            messages={conversation.filter((m) => before(m, message))}
            threadSubject={message.subject}
            now={now}
            variant="pane"
          />
          <div className="conv-focus" data-conv-id={message.id} aria-current="true">
            {focusedBody}
          </div>
          <ConversationEntries
            messages={conversation.filter((m) => m.id !== message.id && !before(m, message))}
            threadSubject={message.subject}
            now={now}
            variant="pane"
          />
        </div>
      ) : isProtected ? (
        focusedBody
      ) : undefined}
    </ReadingPane>
  );
}

/**
 * Is `m` earlier in the conversation than the opened message?
 *
 * The comparison is on the ORDER `threadOf` already sorted by — date, id as the tiebreak —
 * rather than on dates alone, so a thread whose messages share a timestamp (a seeded or
 * imported chain) still splits at exactly one place and never renders a message twice or
 * not at all. The opened message itself is never "before" itself.
 */
function before(m: EngineMessage, focused: EngineMessage): boolean {
  const tm = m.date ? Date.parse(m.date) : 0;
  const tf = focused.date ? Date.parse(focused.date) : 0;
  if (tm !== tf) return tm < tf;
  return m.id < focused.id;
}
