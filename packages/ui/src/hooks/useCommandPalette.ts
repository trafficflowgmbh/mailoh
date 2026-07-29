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

export function useCommandPalette(): CommandPaletteState {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return { open, openPalette, closePalette, toggle };
}
