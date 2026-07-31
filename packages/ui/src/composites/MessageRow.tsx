import type { ReactNode } from "react";
import { Avatar } from "../primitives/Avatar.js";
import { Badge, Chip, type TagHueName } from "../primitives/Chip.js";
import "./row.css";

export interface MessageRowTag {
  name: string;
  hue: TagHueName;
}

export interface MessageRowProps {
  /** Stable id, stamped as data-id (and used by useSeenOnScroll). */
  id: string;
  from: string;
  address?: string;
  time?: string;
  subject: string;
  preview?: string;
  /** Receipts: right-aligned amount. */
  amount?: string;
  unread?: boolean;
  /** Seen styling (quiet ink, lighter weights). */
  seen?: boolean;
  /** The unread dot fades in place after being marked seen. */
  justSeen?: boolean;
  selected?: boolean;
  /** Spam-grade rendering — less ink. */
  dull?: boolean;
  threadCount?: number;
  hasAttachment?: boolean;
  /** Protected badge (shield + "protected"). */
  protected?: boolean;
  tags?: MessageRowTag[];
  /** Cross-view badge naming the message's home (Tag view). */
  place?: string;
  /** Screener variant: initial avatar. */
  avatarInitial?: string;
  /** Screener variant: AI suggestion chip ("→ Reads 0.88"). */
  aiSuggestion?: { destLabel: string; confidence: number };
  /** Screener variant: held-mail count chip. */
  heldCount?: number;
  /** Spam variant: detection badge text. */
  detection?: string;
  onClick?: () => void;
  className?: string;
}

/**
 * The one row language shared by every list in ohmail. Variants are
 * additive: unread dot, badges, tag chips, right-aligned amount,
 * screener avatar + AI suggestion, quiet/dull spam rendering.
 */
export function MessageRow(props: MessageRowProps) {
  const {
    id,
    from,
    address,
    time,
    subject,
    preview,
    amount,
    unread,
    seen,
    justSeen,
    selected,
    dull,
    threadCount,
    hasAttachment,
    tags,
    place,
    avatarInitial,
    aiSuggestion,
    heldCount,
    detection,
    onClick,
    className,
  } = props;

  const badges: ReactNode[] = [];
  if (threadCount) badges.push(<Badge key="thread">⤷ {threadCount}</Badge>);
  if (hasAttachment) badges.push(<Badge key="attach" icon="clip" />);
  if (props.protected)
    badges.push(
      <Badge key="protected" variant="shield" icon="shield">
        protected
      </Badge>,
    );
  for (const t of tags ?? [])
    badges.push(
      <Chip key={`tag-${t.name}`} variant="tag" hue={t.hue}>
        {t.name}
      </Chip>,
    );
  if (place)
    badges.push(
      <Badge key="place" variant="place">
        {place}
      </Badge>,
    );

  const cls = [
    "row",
    avatarInitial !== undefined ? "srow" : null,
    seen ? "seen" : null,
    justSeen ? "justseen" : null,
    selected ? "sel" : null,
    dull ? "dull" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const chips: ReactNode[] = [];
  if (aiSuggestion)
    chips.push(
      <Badge key="ai" variant="ai">
        → {aiSuggestion.destLabel} <span className="num">{aiSuggestion.confidence.toFixed(2)}</span>
      </Badge>,
    );
  if (heldCount !== undefined && heldCount > 1)
    chips.push(<Badge key="held">{heldCount} held</Badge>);
  if (detection) chips.push(<Badge key="det">{detection}</Badge>);

  const body = (
    <>
      <span className="row-top">
        {unread ? <span className="dot-unread" /> : null}
        <span className="who">{from}</span>
        {address ? <span className="addr">{address}</span> : null}
        {time ? <span className="t num">{time}</span> : null}
      </span>
      <span className="row-mid">
        <span className="subj">
          {subject}
          {badges.length ? <span className="badges">{badges}</span> : null}
        </span>
        {amount ? <span className="amt num">{amount}</span> : null}
      </span>
      {preview ? <span className="prev" style={{ display: "block" }}>{preview}</span> : null}
      {chips.length ? <span className="sr-chips">{chips}</span> : null}
    </>
  );

  return (
    <button
      type="button"
      className={cls}
      data-id={id}
      data-unseen={unread ? "1" : undefined}
      aria-label={`${from}: ${subject}`}
      onClick={onClick}
    >
      {avatarInitial !== undefined ? (
        <>
          <Avatar initials={avatarInitial} />
          <span className="sr-main">{body}</span>
        </>
      ) : (
        body
      )}
    </button>
  );
}
