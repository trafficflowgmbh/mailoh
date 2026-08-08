import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import "./palette.css";

export interface Command {
  id: string;
  label: string;
  /** Key sequence hints shown right-aligned. */
  keys?: string[];
  icon?: IconName;
  /**
   * THIS COMMAND HAS NOTHING TO ACT ON RIGHT NOW — shown, dimmed, and inert.
   *
   * The same word the keyboard registry uses (`keymap.tsx`'s `disabled`), and the same
   * treatment the `?` sheet gives one: the row stays in the list so the command remains
   * discoverable, and it says out loud that it cannot act instead of running to no effect.
   *
   * Listing rather than hiding, because a palette whose contents change with the cursor is a
   * palette you cannot learn. Enter and a click both do nothing at all — not even close the
   * sheet, since closing is the one thing that would read as "that worked".
   */
  disabled?: boolean;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
  emptyHint?: ReactNode;
  ariaLabel?: string;
}

/**
 * The ⌘K palette: filter, arrow-key navigation, Enter runs, Escape and
 * scrim close. Pair with useCommandPalette() for the global binding.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder = "Type a command…",
  emptyHint = "No command — try “screener”, “tag”, “theme”…",
  ariaLabel = "Command palette",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const items = commands.filter((c) => c.label.toLowerCase().includes(q));
  const selIdx = Math.min(sel, Math.max(0, items.length - 1));

  const run = (c: Command) => {
    /* Before `onClose()`, deliberately: a disabled row that closed the palette would look
       exactly like one that had acted. */
    if (c.disabled) return;
    onClose();
    c.run();
  };

  return (
    <>
      <div className="pal-bg" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(Math.min(selIdx + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(Math.max(selIdx - 1, 0));
            } else if (e.key === "Enter" && items[selIdx]) {
              run(items[selIdx]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul className="pal-list" role="listbox">
          {items.length ? (
            items.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === selIdx}
                aria-disabled={c.disabled ? true : undefined}
                className={[i === selIdx ? "sel" : "", c.disabled ? "off" : ""]
                  .filter(Boolean)
                  .join(" ") || undefined}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(c)}
              >
                <Icon name={c.icon ?? "spark"} size={13} />
                {c.label}
                <span className="keys">
                  {c.keys?.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))
          ) : (
            <li className="none">{emptyHint}</li>
          )}
        </ul>
        <div className="pal-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </>
  );
}
