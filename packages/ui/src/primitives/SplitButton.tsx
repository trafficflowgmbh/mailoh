import type { ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "./Kbd.js";
import "./split-button.css";

export interface SplitButtonProps {
  /** Main segment content. */
  label: ReactNode;
  /** Fires when the main segment is pressed. */
  onPress: () => void;
  /** Fires when the attached ✓ segment is pressed — a distinct action. */
  onCheckPress: () => void;
  /** Accessible name for the ✓ segment (required — it is icon-only). */
  checkLabel: string;
  /** The AI-preselected destination: accent ring + warm main segment. */
  ai?: boolean;
  /** Quiet styling for the demoting destinations (Screen out, Spam). */
  quiet?: boolean;
  /** Keyboard hint shown inside the main segment (e.g. "y"). */
  kbdHint?: string;
  /**
   * Keyboard hint shown inside the ✓ segment (e.g. "⇧").
   *
   * The ✓ half is a SECOND verb wearing an icon, and the only thing that used to say so was a
   * legend detached from it at the other end of the bar. A cap here is the same move the
   * message action bar makes — the key sits on the verb it belongs to — and it is
   * `aria-hidden` because `checkLabel` already carries the accessible name.
   */
  checkKbdHint?: string;
  title?: string;
  checkTitle?: string;
  className?: string;
}

/**
 * One capsule, two decisions. The main segment files; the attached ✓
 * segment files AND marks read — each with its own handler.
 *
 * Both halves can carry their own keycap (`kbdHint`, `checkKbdHint`), which is
 * what replaced the bar's detached "o r c n x file" legend: the key goes on the
 * verb, exactly as the message action bar's does.
 */
export function SplitButton({
  label,
  onPress,
  onCheckPress,
  checkLabel,
  ai,
  quiet,
  kbdHint,
  checkKbdHint,
  title,
  checkTitle,
  className,
}: SplitButtonProps) {
  const cls = ["dbtn", quiet ? "quiet" : null, ai ? "ai" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls}>
      <button type="button" className="d-main" title={title} onClick={onPress}>
        {label}
        {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
      </button>
      <button
        type="button"
        className="d-read"
        title={checkTitle}
        aria-label={checkLabel}
        onClick={onCheckPress}
      >
        <Icon name="check" size={12} />
        {/* `aria-label` on this button already wins over its contents, so the cap is shown
            and never spoken. */}
        {checkKbdHint ? <Kbd className="d-readk">{checkKbdHint}</Kbd> : null}
      </button>
    </span>
  );
}
