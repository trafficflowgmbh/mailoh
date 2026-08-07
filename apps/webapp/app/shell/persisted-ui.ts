import { useCallback, useEffect, useState } from "react";

/**
 * UI state that must survive a reload — "saved if it's collapsed or not so ui stays as one
 * left it" (owner, on the Tags rail group).
 *
 * ── WHY LOCAL, NOT SERVER ───────────────────────────────────────────────────────────────
 *
 * This is chrome, not data. Whether a rail group is folded says nothing about the mailbox and
 * is worth neither a column, a migration, nor a request on every toggle. It is also the kind
 * of preference that is legitimately per-machine: a 13" laptop and a 27" display want
 * different answers, and syncing it would make the small screen dictate to the large one.
 *
 * ── WHY IT IS NOT SIMPLY `useState(localStorage.getItem(...))` ──────────────────────────
 *
 * Two reasons, and both are real rather than theoretical here.
 *
 * **Hydration.** The first render happens on the server, where `localStorage` does not exist.
 * Reading it in the initial state makes the server and client render different markup, which
 * React reports as a hydration mismatch and — worse — resolves by keeping the SERVER's value.
 * So the stored preference would be read and then silently discarded. The read therefore
 * happens in an effect, after mount, which is one frame of the default and then the truth.
 *
 * **Storage can refuse.** Safari in private mode throws on `setItem`, and a browser with
 * site data blocked throws on read. A preference is never worth breaking the shell over, so
 * every access is wrapped and a failure simply means the preference does not persist.
 */
export function usePersistedFlag(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(fallback);

  // Read AFTER mount — see the hydration note above. Runs once per key.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === "0" || raw === "1") setValue(raw === "1");
    } catch {
      /* storage blocked or unavailable — the fallback stands */
    }
  }, [key]);

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* private mode refuses writes; the toggle still works for this session */
      }
    },
    [key],
  );

  return [value, set];
}

/**
 * A CAPPED SET OF IDS UNDER ONE KEY — the store behind the dark viewer's per-message "show
 * the original (light) rendering" override.
 *
 * ── WHY ONE KEY, AND WHY CAPPED ─────────────────────────────────────────────────────────
 *
 * The alternative is a key per message, which is unbounded in a different, worse way — a
 * reader who opens ten thousand messages leaves ten thousand keys nobody ever collects. One
 * JSON array under one key is bounded to `cap` ids and evicted oldest-first, so the footprint
 * is fixed and the thing forgotten is the least surprising one (the message read longest ago).
 * An override is a viewing preference, not data: dropping the oldest one silently is fine, and
 * the message simply falls back to following the theme the next time it is opened.
 *
 * ── SAME TWO HAZARDS AS `usePersistedFlag`, HANDLED THE SAME WAY ─────────────────────────
 *
 * The read is a POST-MOUNT effect — the server has no `localStorage`, and reading it during
 * render is a hydration mismatch that resolves by keeping the server's value. And every access
 * is wrapped, because Safari private mode throws on write and a site-data-blocked browser
 * throws on read; a viewing preference is never worth breaking the surface over.
 */
const OVERRIDE_CAP = 300;

export function usePersistedIdSet(
  key: string,
  cap = OVERRIDE_CAP,
): { has: (id: string) => boolean; set: (id: string, on: boolean) => void } {
  const [ids, setIds] = useState<string[]>([]);

  // Read AFTER mount — the hydration note above. Runs once per key.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setIds(parsed.filter((x): x is string => typeof x === "string").slice(-cap));
      }
    } catch {
      /* storage blocked, or a malformed value — the empty set stands */
    }
  }, [key, cap]);

  const set = useCallback(
    (id: string, on: boolean) => {
      setIds((prev) => {
        // Re-adding moves an id to the newest slot, so eviction stays honestly oldest-first.
        const without = prev.filter((x) => x !== id);
        const next = on ? [...without, id].slice(-cap) : without;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* private mode refuses writes; the choice still holds for this session */
        }
        return next;
      });
    },
    [key, cap],
  );

  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { has, set };
}

/**
 * Namespaced so a future preference cannot collide with an unrelated one, and so everything
 * this app stores is greppable from a single prefix.
 */
export const UI_KEYS = {
  tagsOpen: "ohmail.ui.rail.tagsOpen",
  /** Ids the reader chose to view in their ORIGINAL (light) rendering, despite a dark theme. */
  mailOriginal: "ohmail.ui.mail.original",
} as const;
