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
  ariaLabel?: string;
}

/**
 * Reading mode — the exhale. While open, `reading` is set on <body> so
 * app chrome using the .shell / .dock classes recedes exactly like the
 * prototype. Escape and a backdrop click both return.
 */
export function Reader({ open, onClose, children, hint, ariaLabel = "Reading" }: ReaderProps) {
  useEffect(() => {
    if (!open) return;
    document.body.classList.add("reading");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("reading");
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

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
