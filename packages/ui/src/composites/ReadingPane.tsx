import type { ReactNode } from "react";
import { Icon } from "../icons.js";
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
  attachment?: ReadingPaneAttachment;
  /** Action buttons row. */
  actions?: ReactNode;
  /** Renders the small open-reader affordance in the from-line. */
  onEnterReader?: () => void;
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
  attachment,
  actions,
  onEnterReader,
  className,
}: ReadingPaneProps) {
  return (
    <article className={className ? `msg ${className}` : "msg"}>
      <div className="msg-from">
        <b>{from}</b>
        {address ? <small>{address}</small> : null}
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
      {attachment ? (
        <button type="button" className="attach" onClick={attachment.onPress}>
          <Icon name="clip" /> {attachment.filename}
          {attachment.size ? <small>({attachment.size})</small> : null}
        </button>
      ) : null}
      {actions ? <div className="msg-actions">{actions}</div> : null}
    </article>
  );
}

/** The lift-1 reading column that hosts a ReadingPane in split views. */
export function ReadColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `read-col ${className}` : "read-col"}>{children}</div>;
}
