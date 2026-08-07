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
  /**
   * WHAT `body` ACTUALLY IS. Omitted ⇒ `"full"`, the shape every existing caller had.
   *
   * It is here rather than in the app because it changes the CARD'S OWN measurement, and
   * that measurement is what hid the affordance. `short` is computed from `scrollHeight`, so
   * a card holding a one-line snippet measures short, `.scast.short .sc-x{display:none}`
   * hides the Expand pill, and there is no way left to ask for the rest — on a live account
   * that was every card in Reads and Receipts. Anything other than `"full"` therefore keeps
   * the pill reachable however short the text is, because the text being short is precisely
   * the symptom.
   */
  bodyState?: "full" | "snippet" | "loading" | "failed";
  /** Shown in place of the body while it is being fetched. App-owned copy. */
  loadingLabel?: string;
  /** Shown when the fetch failed — distinct from "this is the whole message". */
  failedLabel?: string;
  /**
   * THE RENDERED MESSAGE, swapped in for the plain-text preview once the card is OPEN.
   *
   * Omitted ⇒ the card is text-only, exactly as before. When present it renders ONLY while
   * expanded: the collapsed card keeps the fast, clamp-measured `body` preview, and expanding
   * lifts the clamp and drops in this node — the sanitized html viewer the reading pane uses,
   * so Reads and Receipts read the same as the Ohbox and the reader instead of dumping
   * `body.text`. A plain-text message passes no slot and is untouched.
   *
   * The viewer sizes itself (an iframe measured to its own content), which is why the
   * measuring effect and the clamp step aside for it — see `showViewer` below.
   */
  bodySlot?: ReactNode;
  onSelect?: (id: string) => void;
  /**
   * Called after the expand state flips (collapse-keeping-in-view etc.).
   *
   * `open: true` is also the point at which a caller should hydrate: a card that has only a
   * snippet is expanded FIRST and filled afterwards, because the body is what the expand was
   * asking for.
   */
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
  bodyState = "full",
  loadingLabel,
  failedLabel,
  bodySlot,
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
    // The open viewer sizes ITSELF (an iframe measured to its content), so it is never
    // clamp-measured: recomputing `short` from the viewer's height could hide the very
    // collapse pill an open card needs. `short` keeps its last text measurement instead.
    if (open && bodySlot != null) return;
    setShort(clip.scrollHeight <= clampHeight + 28); // no point clamping a few lines
    /**
     * RE-PIN AN OPEN CARD WHEN ITS TEXT CHANGES.
     *
     * `toggle` opens by pinning `max-height` to the content height MEASURED AT THAT MOMENT.
     * Before hydration that moment holds a two-line snippet, so an expand-then-fill card
     * would clip the fetched body at the snippet's height — the pill would work, the request
     * would succeed, and the mail would still be one line. `scrollHeight` ignores the
     * constraint, so re-reading it here is enough.
     */
    if (open) clip.style.maxHeight = `${clip.scrollHeight}px`;
  }, [clampHeight, body, open, bodySlot]);

  /** An open card showing its `bodySlot` — the viewer replaces the clamped text preview. */
  const showViewer = open && bodySlot != null;

  /**
   * THE BODY IS NOT (YET) THE WHOLE MESSAGE.
   *
   * `short` is a fact about the text on screen; this is a fact about whether that text is
   * the mail. They come apart wherever a snippet is short AND incomplete at once — and the
   * card must keep its affordance in that case rather than concluding from the height that
   * there is nothing more to show. `.pend` in `stream.css` re-enables the pill
   * and drops the fade for a card that is both short and pending.
   */
  const pending = bodyState !== "full";
  const note = bodyState === "loading" ? loadingLabel : bodyState === "failed" ? failedLabel : null;

  const toggle = () => {
    const clip = clipRef.current;
    // `short` alone used to gate this, so a pill made reachable by `pending` would have been
    // a button that did nothing when clicked. A card WITH a `bodySlot` always has more to
    // show than its preview (the rendered html), so it opens even when the preview is short.
    if (short && !pending && bodySlot == null) return;
    const next = !open;
    if (clip) {
      if (next) {
        // A viewer is unclamped in CSS (`.scast.viewer .sc-clip`); pinning a fixed pixel
        // height here would clip an iframe that has not measured its content yet.
        clip.style.maxHeight = bodySlot != null ? "" : `${clip.scrollHeight}px`;
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
    pending ? "pend" : null,
    open ? "open" : null,
    showViewer ? "viewer" : null,
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
        {showViewer ? (
          // The rendered message, unclamped. The preview text is set aside, not stacked
          // above it — one copy of the message on screen, the same rule the reading pane keeps.
          <div className="sc-viewer">{bodySlot}</div>
        ) : (
          chunks.map((chunk, i) => (
            <Fragment key={i}>
              {i > 0 ? art : null}
              <p className="sc-body">{chunk.trim()}</p>
            </Fragment>
          ))
        )}
        {/* The one line of chrome hydration adds, and only for the two states that need it:
            "we are fetching this" and "we could not". A card whose body has not been asked
            for says nothing — the Expand pill IS that signal — and a complete body says
            nothing either, which is the Blanc card unchanged. It sits INSIDE `.sc-clip`
            beside the text it qualifies, above the fade. */}
        {note ? (
          <p className={bodyState === "failed" ? "sc-state warn" : "sc-state"} role="status">
            {note}
          </p>
        ) : null}
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
