/**
 * Theme management, matching the prototype's contract exactly:
 * - explicit preference is stamped as `data-theme` on <html>;
 * - "system" removes the attribute so the tokens.css
 *   prefers-color-scheme fallback takes over;
 * - toggle() flips the *effective* theme (system+dark → explicit light).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  /** The stored preference (may be "system"). */
  preference: ThemePreference;
  /** What is actually rendered right now. */
  resolved: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
  /** Flip the effective theme, like the dock's sun button. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Initial preference; defaults to following the system. */
  defaultPreference?: ThemePreference;
  /** localStorage key; pass null to disable persistence. */
  storageKey?: string | null;
}

export function ThemeProvider({
  children,
  defaultPreference = "system",
  storageKey = "mailoh.theme",
}: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    if (storageKey && typeof window !== "undefined") {
      const stored = window.localStorage?.getItem(storageKey);
      if (stored === "light" || stored === "dark" || stored === "system") return stored;
    }
    return defaultPreference;
  });
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  // Stamp <html data-theme> exactly like the prototype: absent = system.
  useEffect(() => {
    const root = document.documentElement;
    if (preference === "system") delete root.dataset.theme;
    else root.dataset.theme = preference;
    if (storageKey) window.localStorage?.setItem(storageKey, preference);
  }, [preference, storageKey]);

  // Track the OS preference while in system mode.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? system : preference;

  const setTheme = useCallback((p: ThemePreference) => setPreference(p), []);
  const toggle = useCallback(() => {
    setPreference((prev) => {
      const effective = prev === "system" ? systemTheme() : prev;
      return effective === "dark" ? "light" : "dark";
    });
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setTheme, toggle }),
    [preference, resolved, setTheme, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
