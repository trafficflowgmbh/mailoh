/**
 * The seen-marking machinery from the prototype, as a hook: an element
 * carrying `data-unseen` counts as seen once it has fully risen into
 * (or above) the top third of its scroller — but never before the USER
 * has actually scrolled. Programmatic layout shifts on mount must not
 * burn through the unread state.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";

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
  const userScrolled = useRef(false);
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    // The user-scroll guard: nothing is marked before a real scroll.
    userScrolled.current = false;
    const onScroll = () => {
      userScrolled.current = true;
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const io = new IntersectionObserver(
      (entries) => {
        if (!userScrolled.current) return;
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
      el.removeEventListener("scroll", onScroll);
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
