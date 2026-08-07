/**
 * Theme management, matching the prototype's contract exactly:
 * - explicit preference is stamped as `data-theme` on <html>;
 * - "system" removes the attribute so the tokens.css
 *   prefers-color-scheme fallback takes over;
 * - toggle() flips the *effective* theme (system+dark → explicit light).
 *
 * SSR-safe by construction: the first client render is deterministic and
 * byte-identical to the server render (defaultPreference + "light" system
 * fallback — no localStorage or matchMedia reads during render). The
 * persisted preference and the real OS theme are adopted in a post-mount
 * effect. To avoid a pre-hydration flash, inline `themeInitScript()`
 * before your app markup: it stamps the persisted `data-theme` before
 * first paint, and the provider leaves that stamp untouched until it has
 * adopted the same stored value.
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

function isPreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStored(storageKey: string): ThemePreference | null {
  try {
    const stored = window.localStorage?.getItem(storageKey);
    return isPreference(stored) ? stored : null;
  } catch {
    return null; // storage blocked (private mode etc.) — fall back to default
  }
}

/**
 * A tiny inline script that stamps the persisted theme on <html> before
 * first paint (same contract as the provider: absent attribute = follow
 * the system, which tokens.css resolves via prefers-color-scheme).
 * Render it as the first child of <body> (or in <head>):
 *
 *   <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
 */
export function themeInitScript(storageKey = "ohmail.theme"): string {
  const key = JSON.stringify(storageKey);
  return `(function(){try{var t=localStorage.getItem(${key});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})()`;
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
  storageKey = "ohmail.theme",
}: ThemeProviderProps) {
  // null = not yet hydrated: render with the deterministic default and do
  // NOT touch <html> — the themeInitScript stamp stays in charge until the
  // stored preference has been adopted post-mount.
  const [stored, setStored] = useState<ThemePreference | null>(null);
  const [system, setSystem] = useState<ResolvedTheme>("light");

  const preference: ThemePreference = stored ?? defaultPreference;

  // Post-mount adoption: persisted preference + the real OS theme.
  // Declared first so the stamp effect below runs with the adopted value.
  useEffect(() => {
    setStored((current) => {
      if (current !== null) return current; // a click beat us to it — user wins
      return (storageKey ? readStored(storageKey) : null) ?? defaultPreference;
    });
    setSystem(systemTheme());
  }, [storageKey, defaultPreference]);

  // Stamp <html data-theme> exactly like the prototype: absent = system.
  // Skipped until adoption so hydration never clobbers the pre-paint stamp.
  useEffect(() => {
    if (stored === null) return;
    const root = document.documentElement;
    if (stored === "system") delete root.dataset.theme;
    else root.dataset.theme = stored;
    if (storageKey) {
      try {
        window.localStorage?.setItem(storageKey, stored);
      } catch {
        /* storage blocked — the in-memory preference still applies */
      }
    }
  }, [stored, storageKey]);

  // Track the OS preference while in system mode.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? system : preference;

  const setTheme = useCallback((p: ThemePreference) => setStored(p), []);
  const toggle = useCallback(() => {
    setStored((prev) => {
      const current = prev ?? defaultPreference;
      const effective = current === "system" ? systemTheme() : current;
      return effective === "dark" ? "light" : "dark";
    });
  }, [defaultPreference]);

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

/**
 * The theme, or `null` when there is no provider — for a component that renders BOTH inside
 * the app shell and outside it.
 *
 * `useTheme` throws off-provider, and that is correct for the app's own chrome, which always
 * has one. `MessageBody` does not: it is mounted bare in the desktop shell and in unit tests
 * that render it directly (`message-body.test.ts`), and a message must still render there.
 * So it reads the theme through this and treats `null` as light — the same default the
 * provider itself starts from before it has adopted a preference.
 */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
