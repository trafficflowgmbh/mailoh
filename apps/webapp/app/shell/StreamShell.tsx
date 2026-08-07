"use client";

/**
 * The reading-stream machinery shared by Reads and Receipts: one
 * scroll container with
 *  - scroll-spy (the stream drives the list selection),
 *  - seen-on-scroll (a card fully risen into the top third marks seen,
 *    only after a real user scroll — via @ohmail/ui's useSeenOnScroll),
 *  - imperative scrollTo(id) for row clicks and j/k.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { useSeenOnScroll } from "@ohmail/ui";

export interface StreamHandle {
  scrollTo: (id: string) => void;
  element: () => HTMLDivElement | null;
}

/** The card the scroll settles on marks itself seen after this long — the Ohbox's dwell. */
const DWELL_MS = 2000;

export const StreamShell = forwardRef<
  StreamHandle,
  {
    ariaLabel: string;
    onCurrentChange: (id: string) => void;
    onSeen: (id: string) => void;
    /**
     * A card has come within a lookahead of the viewport — hydrate it. Optional: a stream with
     * no bodies to fetch (Receipts today, the demo, a test) leaves it off and no observer is
     * armed. This is the ONLY viewport-driven fetch trigger; it is per-card and fires once per
     * id, never pile-wide: a paid fetch follows a person's explicit intent, never a scroll.
     */
    onNear?: (id: string) => void;
    /** Changes re-scan the container for [data-unseen] cards. */
    contentKey: unknown;
    children: ReactNode;
  }
>(function StreamShell({ ariaLabel, onCurrentChange, onSeen, onNear, contentKey, children }, ref) {
  const divRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const dwellRef = useRef(0);
  const curRef = useRef<string | null>(null);
  const onCurrentRef = useRef(onCurrentChange);
  onCurrentRef.current = onCurrentChange;
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;

  const observer = useSeenOnScroll({
    root: divRef,
    onSeen,
    rootMargin: "0px 0px -62% 0px",
  });
  // Read inside the []-deps scroll effect, so it must reach the LATEST observer by ref.
  const observerRef = useRef(observer);
  observerRef.current = observer;

  useEffect(() => {
    observer.observe();
  }, [observer, contentKey]);

  /**
   * HYDRATE ON VIEWPORT INTENT — one IntersectionObserver, bottom-only lookahead.
   *
   * `rootMargin: "0px 0px 50% 0px"` extends the root half a viewport DOWNWARD only, so a card
   * fires `onNear` just before it would scroll into view and the rendered message is ready when
   * it arrives. Fired once per id ever (`nearFired`), and never for the pile above the fold that
   * a reader may never reach. Re-scanning happens on `contentKey` below; the fired set survives
   * it, so a card already asked for is not asked again after a delta re-renders the stream.
   */
  const nearFired = useRef<Set<string>>(new Set());
  const nearIoRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const el = divRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const fn = onNearRef.current;
        if (!fn) return;
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const id = (en.target as HTMLElement).dataset.sid;
          if (id && !nearFired.current.has(id)) {
            nearFired.current.add(id);
            fn(id);
          }
        }
      },
      { root: el, rootMargin: "0px 0px 50% 0px" },
    );
    nearIoRef.current = io;
    for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) io.observe(c);
    return () => {
      io.disconnect();
      nearIoRef.current = null;
    };
  }, []);
  useEffect(() => {
    const el = divRef.current;
    const io = nearIoRef.current;
    if (!el || !io) return;
    io.disconnect();
    for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) io.observe(c);
  }, [contentKey]);

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const cards = Array.from(el.querySelectorAll<HTMLElement>(".scast[data-sid]"));
        if (!cards.length) return;
        let current: HTMLElement | null = null;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          current = cards[cards.length - 1]!; // pinned to the end — the last card is current
        } else {
          const top = el.getBoundingClientRect().top;
          for (const c of cards) {
            if (c.getBoundingClientRect().top - top <= 90) current = c;
            else break;
          }
        }
        if (!current) current = cards[0]!;
        const id = current.dataset.sid!;
        if (id !== curRef.current) {
          curRef.current = id;
          onCurrentRef.current(id);
          /**
           * DWELL-TO-SEEN. The card a scroll SETTLES on marks itself seen after 2s — the last
           * screenful never exits the top, so the IntersectionObserver's "risen above the line"
           * rule never reaches it (see `useSeenOnScroll`). Cancel-on-change means only the card
           * a sweep LANDS on survives to fire: a j/k fly-past re-lands current on every
           * intermediate and cancels each before 2s, and `ReadsView.jump` already marks the
           * key's own target. Gated on `userHasDriven()` — the SAME authority the IO commit
           * sits behind — because read-state writes `\Seen` to the user's real IMAP, and a
           * programmatic jump must never trip it.
           */
          if (dwellRef.current) window.clearTimeout(dwellRef.current);
          dwellRef.current = window.setTimeout(() => {
            dwellRef.current = 0;
            if (observerRef.current.userHasDriven()) onSeenRef.current(id);
          }, DWELL_MS);
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (dwellRef.current) window.clearTimeout(dwellRef.current);
      dwellRef.current = 0;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    element: () => divRef.current,
    scrollTo: (id: string) => {
      const el = divRef.current;
      if (!el) return;
      const card = el.querySelector<HTMLElement>(`.scast[data-sid="${CSS.escape(id)}"]`);
      if (!card) return;
      curRef.current = id;
      el.scrollTo({
        top:
          card.getBoundingClientRect().top -
          el.getBoundingClientRect().top +
          el.scrollTop -
          14,
        behavior: "smooth",
      });
    },
  }));

  return (
    <div className="stream" ref={divRef} aria-label={ariaLabel}>
      {children}
    </div>
  );
});

/** The Wohnfalz newsletter's inline product illustration (KLAPPRI), verbatim. */
export function FoldTableArt() {
  return (
    <svg
      viewBox="0 0 520 216"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
    >
      <rect x="0.7" y="0.7" width="518.6" height="214.6" rx="14" stroke="none" fill="var(--tint)" />
      <path d="M96 26v152" />
      <path d="M60 178h404" />
      <path d="M98 96h224" />
      <path d="M98 104h224" />
      <path d="M310 104l-46 74" />
      <path d="M310 104l8 74" />
      <circle cx="150" cy="86" r="9" />
      <path d="M159 86h7" />
      <path d="M418 178v-64M404 114h28M410 100l8-14 8 14" />
    </svg>
  );
}
