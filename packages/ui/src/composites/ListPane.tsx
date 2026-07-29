import { useRef, type ReactNode, type RefObject } from "react";
import { useSeenOnScroll, type SeenObserver } from "../hooks/useSeenOnScroll.js";
import "./list-pane.css";

export interface ListPaneProps {
  title: string;
  /** Right of the title — "4 unread of 9". */
  meta?: string;
  /** Between header and scroller (doorbell, segmented control, bulk bar). */
  header?: ReactNode;
  /** Scroller content: rows, group labels, waterline, footers. */
  children: ReactNode;
  /** Keyboard hints strip pinned under the scroller. */
  hints?: ReactNode;
  /** Centered standalone column (Tag view). */
  solo?: boolean;
  /**
   * Wire the seen-on-scroll machinery: children carrying [data-unseen]
   * are marked seen (via their data-id) once they fully rise into the
   * top third — but only after the user actually scrolls.
   */
  onSeen?: (id: string) => void;
  /** External scroller ref, if the app drives scrolling itself. */
  scrollerRef?: RefObject<HTMLDivElement>;
  className?: string;
}

/**
 * The list column shared by Ohbox · Reads · Receipts · Screener · Tag:
 * lift-1 panel, view header, scroller with dock clearance.
 * Returns the pane; re-scan for new unseen rows via the returned
 * observer of `useSeenOnScroll` when composing manually.
 */
export function ListPane({
  title,
  meta,
  header,
  children,
  hints,
  solo,
  onSeen,
  scrollerRef,
  className,
}: ListPaneProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = scrollerRef ?? internalRef;
  useSeenOnScroll({
    root: ref,
    onSeen: onSeen ?? (() => {}),
  });

  const cls = ["list-col", solo ? "solo" : null, className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="vhead">
        <h1>{title}</h1>
        {meta ? <span className="meta num">{meta}</span> : null}
      </div>
      {header}
      <div className="scroller" ref={ref}>
        {children}
      </div>
      {hints ? <div className="list-hints">{hints}</div> : null}
    </div>
  );
}

/** Group label inside a list scroller ("New for you", "Today"). */
export function ListGroupLabel({ children }: { children: ReactNode }) {
  return <div className="grouplabel">{children}</div>;
}

/** Row container with the shadow-safe gutter. */
export function ListRows({ children }: { children: ReactNode }) {
  return <div className="rows">{children}</div>;
}

export type { SeenObserver };
