"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineMessage, OhmailEngine, OhmailView } from "@ohmail/client-engine";

/**
 * THE BOTTOM OF A PILE, WHEN THE DEVICE HOLDS ONLY PART OF THE MAILBOX.
 *
 * The browser's mirror is a window: the newest slice of the mail, kept on disk, in front of a
 * server that still holds all of it. That makes the end of a list an ambiguous place. It can mean
 * "this is your mail" or it can mean "this is what this device kept", and those are different
 * sentences — one of them has more mail behind it and the other does not.
 *
 * This hook is what lets a list tell them apart and act on the difference. It asks the engine
 * whether there is anything further back at all, fetches one page at a time when somebody asks
 * for it, and reports what it has in a shape a surface can render honestly.
 *
 * ── ONE PAGE PER ASK, NEVER SPECULATIVE ─────────────────────────────────────────────────────
 *
 * Nothing here fires on mount, on scroll position, or on a re-render. The fetch happens when
 * {@link OlderMail.loadMore} is called, which is a person reaching the end of a list and asking
 * to see further. A pile-wide prefetch would be the whole mailbox coming back down the wire to
 * fill a mirror that deliberately does not want it.
 *
 * ── THE ROWS ARE NOT MIRROR ROWS, AND THAT IS THE POINT ─────────────────────────────────────
 *
 * `engine.listOlder` returns items and writes nothing: they have no sync sequence, so the mirror
 * has no way to reconcile them and the next prune pass would evict them anyway. They live here,
 * in this hook's state, for as long as the view is open.
 *
 * The MERGE prefers the mirror's own row wherever it has one. The mirror row carries the
 * optimistic overlay and this device's triage state; a wire item is a snapshot from before
 * whatever the user just did. Preferring the wire would make a message somebody has just filed
 * reappear in the pile they filed it out of.
 *
 * ── RESET ON VIEW CHANGE ────────────────────────────────────────────────────────────────────
 *
 * Everything is keyed to one view. Leaving and returning starts again from the top of the older
 * mail rather than resuming a cursor from a list that is no longer on screen — a paging position
 * is only meaningful while the list it pages is being read.
 */

/** What the surface renders below its own rows. */
export interface OlderMail {
  /**
   * Is there anywhere further back to look?
   *
   * `false` for a client whose mirror IS the mailbox — the demo, and the standalone desktop
   * client. A list must render nothing at all in that case: an affordance to load older mail,
   * over a client that has every message already, is an offer that cannot be kept.
   */
  available: boolean;
  /** Older messages fetched so far, mirror-preferred by id, in the order the server sent them. */
  items: EngineMessage[];
  /** A page is in flight. */
  loading: boolean;
  /** The server's own sentence, when the last attempt was refused. */
  error: string | null;
  /**
   * The server has said there is no more. Distinct from `items.length === 0`, which is what a
   * list looks like before anyone has asked, and distinct from a failure — a surface that
   * conflated the three would claim the mailbox ends where the network did.
   */
  exhausted: boolean;
  /** Ask for the next page. A no-op while one is in flight, or once the server has said no more. */
  loadMore: () => void;
}

interface Page {
  items: EngineMessage[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  exhausted: boolean;
}

const EMPTY: Page = { items: [], cursor: null, loading: false, error: null, exhausted: false };

export function useOlderMail(engine: OhmailEngine, view: OhmailView, version: number): OlderMail {
  const available = engine.listOlderAvailable();
  const [page, setPage] = useState<Page>(EMPTY);

  // The view (or the engine) changed: a cursor into one list means nothing in another.
  useEffect(() => {
    setPage(EMPTY);
  }, [engine, view]);

  /**
   * THE PAGING POSITION, AS REFS RATHER THAN AS STATE READ INSIDE `loadMore`.
   *
   * Three reasons, and the third is the one that bites:
   *
   *  · `loadMore` is stable across renders — a list hangs it on a button and, if it wants, on an
   *    intersection observer — so a cursor CLOSED OVER would be the one from the render that
   *    created the callback, and every page would ask for page one;
   *  · two calls in the same tick both read a `loading` React has not re-rendered yet. The engine
   *    coalesces identical view+cursor requests, so the cost was never a duplicate fetch; it is
   *    the same page APPENDED twice, which is the same mail on screen twice;
   *  · a `setState` updater must be pure. Firing the request from inside one would issue it twice
   *    under StrictMode's double-invoke, which is a real request against somebody's mailbox.
   */
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);
  const done = useRef(false);
  useEffect(() => {
    cursor.current = null;
    inFlight.current = false;
    done.current = false;
  }, [engine, view]);

  const loadMore = useCallback(() => {
    if (!available || inFlight.current || done.current) return;
    inFlight.current = true;
    setPage((p) => ({ ...p, loading: true, error: null }));

    void engine
      .listOlder(view, cursor.current ? { cursor: cursor.current } : {})
      .then((outcome) => {
        inFlight.current = false;
        if (outcome.state === "unavailable") {
          done.current = true;
          setPage((prev) => ({ ...prev, loading: false, exhausted: true }));
          return;
        }
        if (outcome.state === "failed") {
          // NOT exhausted. A refusal leaves the cursor where it was, so pressing again retries
          // the same page rather than skipping it — and the list keeps offering the control,
          // because "the network failed" is not "your mail ends here".
          setPage((prev) => ({ ...prev, loading: false, error: outcome.error }));
          return;
        }
        cursor.current = outcome.nextCursor;
        done.current = outcome.nextCursor === null;
        setPage((prev) => {
          // Appended BY ID, so a page the server repeats cannot render the same mail twice.
          const seen = new Set(prev.items.map((m) => m.id));
          const added = outcome.items.filter((m) => !seen.has(m.id));
          return {
            items: added.length === 0 ? prev.items : [...prev.items, ...added],
            cursor: outcome.nextCursor,
            loading: false,
            error: null,
            exhausted: outcome.nextCursor === null,
          };
        });
      });
  }, [engine, view, available]);

  /**
   * MIRROR-PREFERRED BY ID, recomputed when the mirror changes.
   *
   * `version` is the engine's overlay-aware mirror version, so this re-runs when somebody files
   * one of these messages, marks it read, or a drain brings its row down — which is exactly when
   * a held wire item goes stale. Without it the older rows would freeze at the moment they were
   * fetched and quietly disagree with the list above them.
   */
  const items = useMemo(() => {
    if (page.items.length === 0) return page.items;
    const reader = engine.read();
    return page.items.map((item) => reader.get<EngineMessage>("message", item.id) ?? item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, page.items, version]);

  return {
    available,
    items,
    loading: page.loading,
    error: page.error,
    exhausted: page.exhausted,
    loadMore,
  };
}
