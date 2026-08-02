/**
 * Command-palette state + the global ⌘K / Ctrl-K binding.
 */
import { useCallback, useEffect, useState } from "react";

export interface CommandPaletteState {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
  toggle: () => void;
}

export interface UseCommandPaletteOptions {
  /**
   * Bind ⌘K / Ctrl-K on `document`. Default true.
   *
   * Pass `false` when the host app owns a keyboard registry and wants ⌘K declared there
   * instead — otherwise the binding fires TWICE for one keypress, and since this is a
   * toggle, two calls cancel out and the palette never opens. See
   * `apps/webapp/app/shell/keymap.tsx`.
   */
  bindKey?: boolean;
}

export function useCommandPalette(
  { bindKey = true }: UseCommandPaletteOptions = {},
): CommandPaletteState {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    if (!bindKey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bindKey]);

  return { open, openPalette, closePalette, toggle };
}
