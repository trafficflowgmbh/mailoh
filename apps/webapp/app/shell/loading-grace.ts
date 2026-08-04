"use client";

/**
 * THE QUIET FRAME, AND WHEN IT STOPS BEING HONEST.
 *
 * ── TWO TRUE THINGS THAT PULL IN OPPOSITE DIRECTIONS ────────────────────────────────────
 *
 * `engine.tsx` argues, correctly, that the session gate carries no text because it is
 * "normally two or three hundred milliseconds, and a sentence that flashes is worse than a
 * quiet frame". Owner, 2026-08-04: *"sometimes takes several seconds to load, it should
 * actually load instantly optimally out from cache or so, or in case of loading actually show
 * loading messages."* Both are right, about different connections. A single answer has to be
 * wrong for one of them.
 *
 * So the answer is a function of TIME rather than a constant. Nothing is said while the wait is
 * the length a wait is supposed to be; once it is not, the screen says what is happening. A fast
 * connection never sees a word; a slow one is never left guessing.
 *
 * ── WHY THIS IS NOT "A SPINNER AFTER A DELAY" ───────────────────────────────────────────
 *
 * The states it gates are not decorations. Underneath them the panes would otherwise be stating
 * "Nothing in your Ohbox." and "No one's waiting." as settled facts about the user's own mail
 * (see `mail-state.ts`'s {@link MailState.settled}). The grace decides only WHEN the true
 * sentence is spoken; the false one is gone either way, at zero milliseconds.
 */

import { useEffect, useState } from "react";

/**
 * How long a wait may go unremarked.
 *
 * Six hundred milliseconds. Above the 200–300 ms `engine.tsx` measured for the ordinary session
 * resolution — so the ordinary case is still a silent frame and nobody sees a flash — and well
 * below the "several seconds" that produced the report. It is also comfortably under the 8 s
 * `POLL_MS`, so a tab that has to wait out one poll interval has been talking for most of it.
 *
 * Exported so a test can drive fake timers to either side of it rather than sleeping past a
 * literal it cannot see.
 */
export const LOADING_GRACE_MS = 600;

/**
 * Has this surface been waiting long enough to say so?
 *
 * `false` on the first render and on the server, which is what makes the quiet frame quiet:
 * reading a clock in the initializer would make the server and the client render different
 * markup, and React resolves that by keeping the server's — the same hydration trap
 * `persisted-ui.ts` documents for saved drafts.
 *
 * `active: false` disarms the timer AND resets, so a surface that finishes and later waits
 * again gets a fresh grace rather than announcing instantly on the strength of an earlier wait.
 */
export function useLoadingGrace(active: boolean, ms: number = LOADING_GRACE_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const id = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(id);
  }, [active, ms]);
  return active && elapsed;
}
