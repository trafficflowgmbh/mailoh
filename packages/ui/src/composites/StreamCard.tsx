import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "../icons.js";
import "./stream.css";

const SC_CLAMP = 348;

export interface StreamCardProps {
  /** Stable id, stamped as data-sid (used by useSeenOnScroll + scroll-spy). */
  id: string;
  from: string;
  address?: string;
  /** Receipts: the amount beside the sender. */
  amount?: string;
  time: string;
  subject: string;
  /**
   * Body text (white-space: pre-line). A "[[img]]" marker splits the
   * body around the inline `art` node.
   */
  body: string;
  /** Inline figure rendered at the [[img]] marker. */
  art?: ReactNode;
  unread?: boolean;
  /** Fades the unread dot in place after seen-marking. */
  justSeen?: boolean;
  /** Scroll-spy current card — raised to lift-2. */
  current?: boolean;
  /** Clamp height in px; the card only clamps if meaningfully taller. */
  clampHeight?: number;
  expandLabel?: string;
  collapseLabel?: string;
  onSelect?: (id: string) => void;
  /** Called after the expand state flips (collapse-keeping-in-view etc.). */
  onToggle?: (open: boolean) => void;
}

/**
 * A clamped reading-stream card: light falloff instead of a border, the
 * single functional fade gradient over the clamp, and an expand pill
 * whose chevron turns with aria-expanded.
 */
export function StreamCard({
  id,
  from,
  address,
  amount,
  time,
  subject,
  body,
  art,
  unread,
  justSeen,
  current,
  clampHeight = SC_CLAMP,
  expandLabel = "Expand",
  collapseLabel = "Collapse",
  onSelect,
  onToggle,
}: StreamCardProps) {
  const [open, setOpen] = useState(false);
  const [short, setShort] = useState(false);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  // Clamp decisions need real layout — measure only once the card is
  // actually visible (offsetHeight > 0), like the prototype.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const clip = clipRef.current;
    if (!card || !clip || card.offsetHeight === 0) return;
    setShort(clip.scrollHeight <= clampHeight + 28); // no point clamping a few lines
  }, [clampHeight, body]);

  const toggle = () => {
    const clip = clipRef.current;
    if (short) return;
    const next = !open;
    if (clip) {
      if (next) {
        clip.style.maxHeight = `${clip.scrollHeight}px`;
      } else {
        clip.style.maxHeight = `${clip.scrollHeight}px`;
        void clip.offsetHeight;
        clip.style.maxHeight = "";
      }
    }
    setOpen(next);
    onToggle?.(next);
  };

  const chunks = body.split("[[img]]");
  const cls = [
    "scast",
    short ? "short" : null,
    open ? "open" : null,
    current ? "cur" : null,
    justSeen ? "justseen" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      ref={cardRef}
      className={cls}
      data-sid={id}
      data-unseen={unread ? "1" : undefined}
      onClick={() => onSelect?.(id)}
    >
      <div className="sc-head">
        <div className="sc-line">
          {unread ? <span className="dot-unread" /> : null}
          <b>{from}</b>
          {address ? <span className="addr">{address}</span> : null}
          {amount ? <span className="amt num">{amount}</span> : null}
          <span className="t num">{time}</span>
        </div>
        <h3>{subject}</h3>
      </div>
      <div className="sc-clip" ref={clipRef}>
        {chunks.map((chunk, i) => (
          <Fragment key={i}>
            {i > 0 ? art : null}
            <p className="sc-body">{chunk.trim()}</p>
          </Fragment>
        ))}
        <div className="sc-fade" />
      </div>
      <button
        type="button"
        className="sc-x"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <span>{open ? collapseLabel : expandLabel}</span>
        <Icon name="chev" className="chev" />
      </button>
    </article>
  );
}

export interface StreamArtProps {
  ariaLabel: string;
  caption?: string;
  children: ReactNode;
}

/** Figure wrapper for inline stream illustrations. */
export function StreamArt({ ariaLabel, caption, children }: StreamArtProps) {
  return (
    <figure className="sc-art" role="img" aria-label={ariaLabel}>
      {children}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
