import type { ReactNode } from "react";
import { Icon } from "../icons.js";
import { Avatar } from "../primitives/Avatar.js";
import "./message.css";

export interface ReadingPaneAttachment {
  filename: string;
  size?: string;
  onPress?: () => void;
}

export interface ReadingPaneProps {
  from: string;
  address?: string;
  time?: string;
  threadCount?: number;
  subject: string;
  /** Routing/tracker/tag chips row. */
  chips?: ReactNode;
  /** Body text (pre-line). Ignored when `children` is given. */
  body?: string;
  /** Rich body (e.g. a ProtectedBlock). */
  children?: ReactNode;
  /**
   * A statement ABOUT the body, immediately under it (slice U5-BODY): the message text is
   * being fetched, or the fetch failed.
   *
   * A sibling rather than something folded into `body`, because the two must not be
   * confusable: `body` is the sender's words and this is the product's. It also keeps
   * `.msg-body` holding exactly the mail and nothing else, which is what `conversation.test.ts`
   * asserts about the pane and what a reader is entitled to assume.
   */
  bodyNote?: ReactNode;
  /** Carries the accent on {@link ReadingPaneProps.bodyNote}: a failure, not a quiet aside. */
  bodyNoteFailed?: boolean;
  attachment?: ReadingPaneAttachment;
  /** Action buttons row. */
  actions?: ReactNode;
  /** Renders the small open-reader affordance in the from-line. */
  onEnterReader?: () => void;
  /** The sender's initial circle in the from-line. */
  avatarInitial?: string;
  /** Deterministic per-sender hue for that circle; see `Avatar`. */
  avatarHue?: number;
  /**
   * Makes the from-line a CONTROL — avatar and address together (slice U3).
   *
   * The owner's words: "needing to be able to directly click a mail adress and change its
   * screener mode even on ohbox etc". A row cannot carry this affordance (`.row` is itself
   * a `<button>`, and nesting interactive content in one is invalid), so the open message
   * is where the address becomes clickable for real, with a focusable, keyboard-reachable
   * control rather than a span with a mouse handler.
   *
   * Receives the control itself so a popover can be anchored on it — this pane is mounted
   * twice while the reader is open (read column and sheet) and the caller must be able to
   * hang the popover off the copy that was clicked.
   */
  onSender?: (anchor: HTMLElement) => void;
  /** Tooltip/aria for that control — supplied by the app, which owns the copy. */
  senderTitle?: string;
  /**
   * Rendered INSIDE the message, after the actions: the inline reply editor (slice U4).
   *
   * A slot rather than a component so the app owns the editor's behaviour, drafts and
   * copy, and so this file stays the anatomy of a message and nothing more. What matters
   * structurally is that it lives inside `<article class="msg">` — a reply that is not in
   * the message is the compose route the owner rejected.
   */
  reply?: ReactNode;
  className?: string;
}

/** Message anatomy: from-line, subject, chips, body, attachment, actions. */
export function ReadingPane({
  from,
  address,
  time,
  threadCount,
  subject,
  chips,
  body,
  children,
  bodyNote,
  bodyNoteFailed,
  attachment,
  actions,
  onEnterReader,
  avatarInitial,
  avatarHue,
  onSender,
  senderTitle,
  reply,
  className,
}: ReadingPaneProps) {
  const who = (
    <>
      {avatarInitial !== undefined ? (
        <Avatar initials={avatarInitial} hue={avatarHue} size="s" />
      ) : null}
      <b>{from}</b>
      {address ? <small>{address}</small> : null}
    </>
  );
  return (
    <article className={className ? `msg ${className}` : "msg"}>
      <div className="msg-from">
        {onSender ? (
          <button
            type="button"
            className="msg-sender"
            title={senderTitle}
            aria-label={senderTitle}
            onClick={(e) => onSender(e.currentTarget)}
          >
            {who}
          </button>
        ) : (
          who
        )}
        <span className="t num">
          {threadCount ? `thread (${threadCount}) · ` : ""}
          {time}
          {onEnterReader ? (
            <button
              type="button"
              className="msg-open"
              title="Read (↵)"
              aria-label="Open reading mode"
              onClick={onEnterReader}
            >
              <Icon name="open" size={13} />
            </button>
          ) : null}
        </span>
      </div>
      <h2>{subject}</h2>
      {chips ? <div className="chips">{chips}</div> : null}
      {children ?? (body !== undefined ? <p className="msg-body">{body}</p> : null)}
      {bodyNote ? (
        <p className={bodyNoteFailed ? "msg-body-state warn" : "msg-body-state"} role="status">
          {bodyNote}
        </p>
      ) : null}
      {attachment ? (
        <button type="button" className="attach" onClick={attachment.onPress}>
          <Icon name="clip" /> {attachment.filename}
          {attachment.size ? <small>({attachment.size})</small> : null}
        </button>
      ) : null}
      {actions ? <div className="msg-actions">{actions}</div> : null}
      {reply}
    </article>
  );
}

/** The lift-1 reading column that hosts a ReadingPane in split views. */
export function ReadColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `read-col ${className}` : "read-col"}>{children}</div>;
}
