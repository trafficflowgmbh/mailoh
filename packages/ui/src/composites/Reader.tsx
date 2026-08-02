import { useEffect, type ReactNode } from "react";
import { Kbd } from "../primitives/Kbd.js";
import "./reader.css";

export interface ReaderProps {
  open: boolean;
  onClose: () => void;
  /** Usually a <ReadingPane> — rendered as the floating lift-3 sheet. */
  children: ReactNode;
  /** The fading top hint; null disables it. */
  hint?: ReactNode | null;
  /**
   * Escape returns from reading mode. Pass `false` while something INSIDE the sheet owns
   * Escape — the inline reply editor does (slice U4). Without the opt-out both handlers
   * fire on one keypress: the editor closes and the message it was quoting disappears
   * from under it in the same frame, which reads as Esc having lost the draft.
   */
  closeOnEscape?: boolean;
  ariaLabel?: string;
}

/**
 * Reading mode — the exhale. While open, `reading` is set on <body> so
 * app chrome using the .shell / .dock classes recedes exactly like the
 * prototype. Escape and a backdrop click both return.
 */
export function Reader({
  open,
  onClose,
  children,
  hint,
  closeOnEscape = true,
  ariaLabel = "Reading",
}: ReaderProps) {
  useEffect(() => {
    if (!open) return;
    document.body.classList.add("reading");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("reading");
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, closeOnEscape]);

  if (!open) return null;
  return (
    <>
      <span className="reader-hint">
        {hint === undefined ? (
          <>
            <Kbd>esc</Kbd> to return
          </>
        ) : (
          hint
        )}
      </span>
      <div
        className="reader"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {children}
      </div>
    </>
  );
}
