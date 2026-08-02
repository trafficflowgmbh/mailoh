/**
 * The seen-marking machinery from the prototype, as a hook: an element
 * carrying `data-unseen` counts as seen once it has fully risen into
 * (or above) the top third of its scroller — but never before the USER
 * has actually driven the scroller.
 *
 * ── WHY THE GUARD IS ON INPUT AND NOT ON `scroll` (slice U1f) ─────────────
 *
 * It used to arm on the scroller's `scroll` event, and the comment above
 * used to say "never before the USER has actually scrolled". That sentence
 * was false: `scroll` is a CONSEQUENCE, fired identically for
 * `scrollIntoView`, `scrollTo` and an anchor jump, and the two views that
 * wire this hook up to a real `\Seen` write issue exactly those calls —
 * `ReadsView`/`ReceiptsView` scroll the list to follow the selection, and
 * both scroll the reading stream on a cross-view jump. So a jump from
 * Search or a Tag row armed the guard and the observer then committed
 * every unread row the jump had swept past. Measured in
 * `apps/webapp/test/seen-on-scroll-runaway.test.ts` against the real view:
 * a jump to the 16th receipt marked ELEVEN messages read, with no user
 * scroll anywhere in the sequence, and read-state is not local — the
 * worker reconciles it onto `\Seen` on the user's own IMAP server.
 *
 * INPUT is intent; scroll position is a consequence of it. So the guard
 * arms on the events a human produces to move a scroller and on nothing
 * else, and a programmatic scroll — however it is issued, by whichever
 * caller, now or later — cannot reach the commit path because it produces
 * none of them. That is what makes this proof against the next caller
 * rather than against the two that exist: a suppression window around
 * today's `scrollIntoView` calls would have to be added to each new one,
 * and a smooth scroll that lands after the window closes defeats it
 * anyway.
 *
 * The bias is deliberate: a missed mark leaves mail bold, a false mark
 * writes `\Seen` to the user's server. Everything ambiguous is therefore
 * left OUT of `arm` — notably `pointerdown` (a scrollbar drag is a real
 * scroll, but so is a click on a row, and a row click is what makes these
 * views scroll themselves) and the app's own `j`/`k`, which move a cursor
 * and call `scrollIntoView` rather than scrolling natively.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * The keys with which the browser itself scrolls a focused scroller.
 *
 * Deliberately NOT the app's navigation letters. `j`/`k` in Reads and
 * Receipts move the cursor and then call `scrollTo` on the stream, so
 * treating a keypress as scroll intent would let a j-sweep mark every card
 * it flew past — the same defect through a different door.
 */
const SCROLL_KEYS = new Set([
  "PageDown",
  "PageUp",
  "Home",
  "End",
  "ArrowDown",
  "ArrowUp",
  " ",
  "Spacebar",
]);

export interface UseSeenOnScrollOptions {
  /** The scrolling container. */
  root: RefObject<HTMLElement>;
  /** Called once per element, with its data-id / data-sid. */
  onSeen: (id: string) => void;
  /** Which elements count; default: anything with [data-unseen]. */
  selector?: string;
  /**
   * IntersectionObserver rootMargin. The prototype uses
   * "0px 0px -67% 0px" for list panes and "0px 0px -62% 0px" for
   * reading streams.
   */
  rootMargin?: string;
}

export interface SeenObserver {
  /** Re-scan the scroller for [data-unseen] elements (call after re-render). */
  observe: () => void;
}

export function useSeenOnScroll({
  root,
  onSeen,
  selector = "[data-unseen]",
  rootMargin = "0px 0px -67% 0px",
}: UseSeenOnScrollOptions): SeenObserver {
  const ioRef = useRef<IntersectionObserver | null>(null);
  const userDrove = useRef(false);
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    // The user-intent guard: nothing is marked until a human moves this scroller.
    userDrove.current = false;
    const arm = () => {
      userDrove.current = true;
    };
    const armOnScrollKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) userDrove.current = true;
    };
    // Both listeners sit on the scroller, so they only ever see input aimed at
    // THIS pane — the list and the stream each keep their own guard, and a wheel
    // over one cannot commit rows in the other.
    el.addEventListener("wheel", arm, { passive: true });
    el.addEventListener("touchmove", arm, { passive: true });
    el.addEventListener("keydown", armOnScrollKey);

    const io = new IntersectionObserver(
      (entries) => {
        if (!userDrove.current) return;
        for (const en of entries) {
          const t = en.target as HTMLElement;
          if (!t.hasAttribute("data-unseen") || !en.rootBounds) continue;
          if (en.boundingClientRect.bottom <= en.rootBounds.bottom + 2) {
            const id = t.dataset.id ?? t.dataset.sid;
            if (id) onSeenRef.current(id);
          }
        }
      },
      { root: el, rootMargin, threshold: [0, 0.99] },
    );
    ioRef.current = io;
    for (const n of el.querySelectorAll(selector)) io.observe(n);

    return () => {
      el.removeEventListener("wheel", arm);
      el.removeEventListener("touchmove", arm);
      el.removeEventListener("keydown", armOnScrollKey);
      io.disconnect();
      ioRef.current = null;
    };
  }, [root, selector, rootMargin]);

  const observe = useCallback(() => {
    const el = root.current;
    const io = ioRef.current;
    if (!el || !io) return;
    io.disconnect();
    for (const n of el.querySelectorAll(selector)) io.observe(n);
  }, [root, selector]);

  return { observe };
}
