import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../primitives/Button.js";
import { Kbd } from "../primitives/Kbd.js";
import "./focus-reply.css";

export interface FocusReplyMessage {
  subject: string;
  from: string;
  preview: string;
}

export interface FocusReplyOverlayProps {
  open: boolean;
  /** Zero-based position in the pile. */
  step: number;
  total: number;
  /** The current message; omit to show the done state. */
  message?: FocusReplyMessage;
  value?: string;
  onChange?: (value: string) => void;
  onDone: () => void;
  onSkip: () => void;
  onClose: () => void;
  doneLabel?: string;
  skipLabel?: string;
  /** Rendered when the pile is exhausted (step >= total). */
  emptyState?: ReactNode;
}

/**
 * Focus & Reply: steps through the Reply Later pile, one message per
 * screen, with the hairline progress bar filling on the spring.
 */
export function FocusReplyOverlay({
  open,
  step,
  total,
  message,
  value,
  onChange,
  onDone,
  onSkip,
  onClose,
  doneLabel = "Done → next",
  skipLabel = "Skip",
  emptyState,
}: FocusReplyOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && message) textareaRef.current?.focus();
  }, [open, message, step]);

  if (!open) return null;

  const finished = step >= total || !message;
  return (
    <div
      className="fr-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fr-card" role="dialog" aria-modal="true" aria-label="Focus and reply">
        {finished ? (
          (emptyState ?? (
            <div className="empty" style={{ padding: "20px 10px" }}>
              <span className="glyph">🕊</span>
              <b>Reply Later is empty.</b>
              <div style={{ marginTop: 18 }}>
                <Button variant="primary" onClick={onClose}>
                  Back to Triage
                </Button>
              </div>
            </div>
          ))
        ) : (
          <>
            <div className="fr-prog num">
              <span>
                {step + 1} of {total}
              </span>
              <span className="fr-bar">
                <i style={{ width: `${((step + 1) / total) * 100}%` }} />
              </span>
            </div>
            <h3>{message.subject}</h3>
            <div className="from">{message.from}</div>
            <p className="prev">{message.preview}</p>
            <textarea
              ref={textareaRef}
              placeholder="Your reply"
              aria-label="Reply"
              value={value}
              onChange={onChange ? (e) => onChange(e.target.value) : undefined}
            />
            <div className="fr-foot">
              <Button variant="primary" onClick={onDone}>
                {doneLabel}
              </Button>
              <Button onClick={onSkip}>{skipLabel}</Button>
              <span className="esc">
                <Kbd>esc</Kbd> exit
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
