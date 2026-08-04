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
 * A COUNTER that survives a reload, for a hint that must be shown a few times and then never.
 *
 * Same storage discipline as {@link usePersistedFlag} — read after mount, every access
 * wrapped — and the same reason for both. It is separate rather than a generalisation because
 * the flag's API is a boolean and widening it to `string` would make every existing caller
 * carry a parse.
 *
 * `bump` is idempotent per call and NEVER decreases: it is used to decide whether somebody has
 * done a thing enough times to be told there is a faster way, and a counter that can go
 * backwards would ask them again forever. Once `stop()` is called the value is pinned at
 * {@link DISMISSED_FOREVER} and no `bump` moves it, which is what "dismissed" has to mean.
 */
export function usePersistedCount(key: string): {
  count: number;
  bump: () => void;
  stop: () => void;
} {
  const [count, setCount] = useState(0);

  useEffect(() => {
    try {
      const raw = Number(window.localStorage.getItem(key));
      if (Number.isFinite(raw) && raw > 0) setCount(raw);
    } catch {
      /* storage blocked — the hint simply never reaches its threshold */
    }
  }, [key]);

  const write = useCallback(
    (next: number) => {
      setCount(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        /* private mode refuses writes; the count still works for this session */
      }
    },
    [key],
  );

  const bump = useCallback(() => {
    setCount((cur) => {
      if (cur >= DISMISSED_FOREVER) return cur;
      const next = cur + 1;
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        /* as above */
      }
      return next;
    });
  }, [key]);

  const stop = useCallback(() => write(DISMISSED_FOREVER), [write]);

  return { count, bump, stop };
}

/**
 * The pinned value that means "this person has dismissed the hint and is never to see it
 * again". A sentinel rather than a second key: two storage entries for one decision is two
 * things that can disagree, and the one that says "show it" would win on a fresh read.
 */
export const DISMISSED_FOREVER = 9999;

/**
 * Namespaced so a future preference cannot collide with an unrelated one, and so everything
 * this app stores is greppable from a single prefix.
 */
export const UI_KEYS = {
  tagsOpen: "ohmail.ui.rail.tagsOpen",
  /** How many times a pile has been reached by CLICKING the rail. See `AppShell`'s number keys. */
  navClicks: "ohmail.ui.rail.navClicks",
} as const;
