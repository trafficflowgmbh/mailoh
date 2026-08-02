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
  /**
   * MULTI-SELECT MEMBERSHIP, and why it changes the row's ROLE (slice U1d).
   *
   * Measured live on 2026-08-02: picking rows in the Ohbox set `aria-selected` on zero of
   * them. The pick was a class name and nothing else, so a screen reader could not tell a
   * picked row from any other and the bulk action operated on a set the user could not
   * perceive.
   *
   * `aria-selected` is only meaningful on `option`/`row`/`gridcell`/`tab` — putting it on a
   * `button` is invalid ARIA that some readers ignore — so a row that participates in a
   * multi-select declares `role="option"` and its container declares `role="listbox"`
   * (`ListRows`). The element stays a focusable `<button>`; only the role changes, and the
   * row has no interactive descendants, which is what `option` requires.
   *
   * `aria-pressed` was the alternative and it describes the wrong action: clicking a row
   * moves the CURSOR, `x` picks. A toggle button would announce the click as the toggle.
   *
   * Undefined ⇒ this list has no multi-select and the row stays a plain button. Every list
   * but the Ohbox is untouched.
   */
  picked?: boolean;
  /** Spam-grade rendering — less ink. */
  dull?: boolean;
  threadCount?: number;
  hasAttachment?: boolean;
  /** Protected badge (shield + "protected"). */
  protected?: boolean;
  tags?: MessageRowTag[];
  /** Cross-view badge naming the message's home (Tag view). */
  place?: string;
  /**
   * The sender's initial circle. Started as the Screener's own variant and is now the
   * lead of every mail row (slice F10) — one row language, so the Ohbox and the Screener
   * do not describe the same person two different ways.
   */
  avatarInitial?: string;
  /** Deterministic per-sender hue for the circle; see `Avatar`. */
  avatarHue?: number;
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
    picked,
    dull,
    threadCount,
    hasAttachment,
    tags,
    place,
    avatarInitial,
    avatarHue,
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
    picked ? "picked" : null,
    dull ? "dull" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // See `picked` above: opting into the multi-select changes the role, because that is the
  // only role `aria-selected` is defined on.
  const selection =
    picked === undefined
      ? {}
      : ({ role: "option", "aria-selected": picked ? "true" : "false" } as const);

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
      {...selection}
      onClick={onClick}
    >
      {avatarInitial !== undefined ? (
        <>
          <Avatar initials={avatarInitial} hue={avatarHue} />
          <span className="sr-main">{body}</span>
        </>
      ) : (
        body
      )}
    </button>
  );
}
