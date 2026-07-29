import type { ReactNode } from "react";
import { Avatar } from "../primitives/Avatar.js";
import "./doorbell.css";

export interface DoorbellProps {
  /** Waiting senders' initials, stacked. */
  initials: string[];
  /** "<b>3 new senders</b> waiting" */
  message: ReactNode;
  actionLabel?: string;
  onPress: () => void;
  /** Collapses the doorbell away (all decided). */
  gone?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** The Screener doorbell — a knock, not a nag. */
export function Doorbell({
  initials,
  message,
  actionLabel = "Screener ›",
  onPress,
  gone,
  ariaLabel,
  className,
}: DoorbellProps) {
  const cls = ["doorbell", gone ? "gone" : null, className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} aria-label={ariaLabel} onClick={onPress}>
      <span className="avs">
        {initials.map((i, idx) => (
          <Avatar key={`${i}-${idx}`} initials={i} size="s" />
        ))}
      </span>
      <span className="db-txt">{message}</span>
      <span className="db-go">{actionLabel}</span>
    </button>
  );
}
