"use client";

/**
 * Buying AI suggestions for the Screener — the control that names the cost BEFORE it spends.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `screener-state.ts` ──────────────────────────────────
 *
 * The waiting rows come from the message mirror, and the mirror has never carried a
 * suggestion: `/sync` is a feed of changes to mail, and advice about mail is not one. So a
 * live account rendered "No suggestion" on every row, the "Apply all" control had nothing to
 * apply, and Enter had nothing to accept — not because the server could not answer, but
 * because nothing ever asked it. This module is the asking.
 *
 * It holds two things and nothing else: the suggestions known so far (joined onto rows by
 * sender address) and the small state machine of one purchase. Decisions, undo and the
 * commit window stay where they were.
 *
 * ── THE SPEND RULE THIS FILE IMPLEMENTS ──────────────────────────────────────────────────
 *
 * Credits are never moved without an action that named the cost first. That is why the flow
 * has a dry run in the middle of it and cannot be collapsed: opening the control prices the
 * exact set that is about to be posted, on the server, and the confirmation shows the number
 * the server answered. A price computed here would be a second implementation of the
 * eligibility rule — is this sender still held, is their mail withheld from the model, has
 * their answer already been bought — and the moment it disagreed with the server's, the
 * button would be quoting one figure and buying another.
 *
 * The batch is composed here for the same reason the endpoint demands an explicit list:
 * "suggest for everyone" over a backlogged mailbox is a four-figure spend behind one click.
 * The senders are taken from the FRONT of the queue in its own order, so the same press
 * twice covers the same senders and a person can predict what they are buying.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { senderKey } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import { ApiError, apiConfigured, screener as screenerApi } from "../api-client";

/**
 * One sender's suggestion, in the vocabulary the rows already speak.
 *
 * `dest` is `ohbox` or `screened` and never anything else, because those are the only two
 * outcomes `POST /screener/:id` has: a yes files to INBOX, a no to `ohmail/Screened`. The
 * server's own answer is that same yes/no, so nothing is lost in the mapping — and inventing
 * a finer destination here would produce a chip promising a filing the wire cannot perform.
 */
export interface SenderSuggestion {
  dest: "ohbox" | "screened";
  confidence: number;
  rationale: string;
}

/** Suggestions known so far, keyed by {@link senderKey}. */
export type SuggestionOverlay = ReadonlyMap<string, SenderSuggestion>;

export type SuggestPhase = "closed" | "pricing" | "ready" | "running";

/** The control, already bound to the senders it would act on. */
export interface SuggestBatchControl {
  /** Waiting senders with no suggestion yet — how much there is to buy. */
  available: number;
  /** Batch sizes offered, clamped to {@link available} and to the endpoint's per-request cap. */
  sizes: number[];
  /** The size currently chosen. */
  size: number;
  phase: SuggestPhase;
  /** The SERVER's quote for the current size. Null until the dry run answers. */
  quote: { senders: number; credits: number } | null;
  /** One sentence about the current state, already translated, or null when there is none. */
  notice: string | null;
  open: () => void;
  choose: (size: number) => void;
  confirm: () => void;
  cancel: () => void;
}

export interface ScreenerSuggestions {
  suggestions: SuggestionOverlay;
  /**
   * Bind the control to a sender list — the waiting rows with no suggestion, in queue order.
   *
   * A function rather than a hook argument because the list is computed by
   * `useScreenerState`, which in turn consumes {@link suggestions}: passing it in would be a
   * cycle. Called during render, it closes over the list for the one press that follows.
   */
  forSenders: (addresses: string[]) => SuggestBatchControl;
}

/**
 * The per-request cap to assume before the server has published its own.
 *
 * `GET /screener` answers `suggestable.maxPerRequest` and that number is preferred the moment
 * it arrives; this is what the control offers if that read has not landed (offline, or a
 * press faster than the fetch). It is deliberately BELOW the server's real cap of 50 rather
 * than equal to it: guessing low costs the user a second press, guessing high costs them a
 * 413 on a button that had already quoted a price.
 */
const ASSUMED_MAX_PER_REQUEST = 25;

/** The sizes offered, before clamping. Small enough to watch, large enough to be worth it. */
const OFFERED_SIZES = [10, 25, 50];

/** How much of the queue one hydration reads. A `cost: read` page; it spends nothing. */
const HYDRATE_LIMIT = 200;

export function useScreenerSuggestions(opts: {
  /** Is the Screener on screen? Hydration is deferred until it is. */
  active: boolean;
  toast: ToastFn;
}): ScreenerSuggestions {
  const t = useTranslations("screener");
  const { active, toast } = opts;

  const [suggestions, setSuggestions] = useState<SuggestionOverlay>(() => new Map());
  const [phase, setPhase] = useState<SuggestPhase>("closed");
  const [size, setSize] = useState(0);
  const [quote, setQuote] = useState<{ senders: number; credits: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [maxPerRequest, setMaxPerRequest] = useState(ASSUMED_MAX_PER_REQUEST);

  /**
   * Everything a stale answer must not be allowed to overwrite.
   *
   * `run` counts presses: a dry run for 10 senders that resolves AFTER the user has switched
   * to 50 must not paint the price of 10 under the label "50". Compared on arrival, discarded
   * when it does not match.
   */
  const io = useRef({ run: 0, hydrated: false });

  const merge = useCallback(
    (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => {
      if (rows.length === 0) return;
      setSuggestions((prev) => {
        const next = new Map(prev);
        for (const r of rows) next.set(senderKey(r.address), r.suggestion);
        return next;
      });
    },
    [],
  );

  /**
   * Read what has ALREADY been bought.
   *
   * Once per session, when the Screener is first opened, and never again: this is what makes a
   * suggestion survive a reload. Without it the chips would live only as long as the tab that
   * bought them, and the user's next press would re-ask the server for answers it is already
   * holding — free to them (a stored answer is served, not re-bought) but silent, so it would
   * look like the purchase had failed.
   *
   * ONE page. The server's queue is `date desc` and so is the list on screen, so a page covers
   * the front of both. A backlogged mailbox has more senders than this, and the ones past the
   * window simply have no chip until they are bought or scrolled to; paging the whole backlog
   * on every visit would be hundreds of rows of subject and snippet fetched to decorate rows
   * nobody is looking at.
   */
  useEffect(() => {
    if (!active || io.current.hydrated || !apiConfigured()) return;
    io.current.hydrated = true;
    let cancelled = false;
    void (async () => {
      try {
        const page = await screenerApi.list({ limit: HYDRATE_LIMIT });
        if (cancelled) return;
        if (page.suggestable?.maxPerRequest) setMaxPerRequest(page.suggestable.maxPerRequest);
        merge(
          page.items
            .filter((i) => i.aiSuggestion != null)
            .map((i) => ({
              address: i.sender.address,
              suggestion: toSuggestion(i.aiSuggestion!),
            })),
        );
      } catch {
        // A failed read leaves the surface exactly as it was — rows without chips, which is
        // the state it already renders honestly. Nothing is claimed, so nothing is said.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, merge]);

  /**
   * Deliberately NOT memoised. It is called during render and closes over every piece of the
   * control's state, so a `useCallback` would need all of them in its dependency array —
   * including `quote`, a fresh object every render — and the one it would silently get wrong
   * is `phase`: a stale closure keeps reporting "pricing" after the price has landed, and the
   * confirm button never becomes pressable. Building a small object per render is cheaper
   * than the class of bug that memoising it invites.
   */
  const forSenders = (addresses: string[]): SuggestBatchControl => {
    const cap = Math.min(maxPerRequest, addresses.length);
    const sizes = batchSizes(addresses.length, maxPerRequest);
    const chosen = sizes.includes(size) ? size : (sizes[sizes.length - 1] ?? 0);

    /** Price `n` senders on the SERVER. No model, no debit, nothing stored. */
    const price = (n: number) => {
      const set = addresses.slice(0, n);
      if (set.length === 0) {
        setPhase("ready");
        setQuote({ senders: 0, credits: 0 });
        setNotice(t("suggest.nothing"));
        return;
      }
      const run = ++io.current.run;
      setPhase("pricing");
      setQuote(null);
      setNotice(null);
      void (async () => {
        try {
          const res = await screenerApi.suggest(set, { dryRun: true });
          if (io.current.run !== run) return;
          setQuote({ senders: res.quoted, credits: res.quotedCredits });
          setPhase("ready");
          setNotice(res.quoted === 0 ? t("suggest.nothing") : null);
        } catch (err) {
          if (io.current.run !== run) return;
          setPhase("ready");
          setQuote(null);
          // The server's own sentence. Every refusal on this path — no classifier
          // connected, AI switched off, no credits — already has a true one, and a second
          // taxonomy here is how a user gets told the wrong reason.
          setNotice(messageFor(err, t("suggest.failed")));
        }
      })();
    };

    return {
      available: addresses.length,
      sizes,
      size: chosen,
      phase,
      quote,
      notice,
      open: () => {
        const start = sizes.includes(size) ? size : cap;
        setSize(start);
        price(start);
      },
      choose: (n: number) => {
        setSize(n);
        price(n);
      },
      cancel: () => {
        io.current.run++;
        setPhase("closed");
        setQuote(null);
        setNotice(null);
      },
      confirm: () => {
        const set = addresses.slice(0, chosen);
        if (set.length === 0 || phase === "running") return;
        const run = ++io.current.run;
        setPhase("running");
        setNotice(t("suggest.running"));
        void (async () => {
          try {
            // One key per press. A retry of the SAME press replays the answer; a second,
            // deliberate press is a different purchase and gets a different key.
            const res = await screenerApi.suggest(set, { idempotencyKey: newKey() });
            if (io.current.run !== run) return;
            merge(
              res.suggestions.map((s) => ({
                address: s.sender,
                suggestion: toSuggestion(s),
              })),
            );
            setPhase("closed");
            setNotice(null);
            toast(summarize(res, t));
          } catch (err) {
            if (io.current.run !== run) return;
            setPhase("ready");
            setNotice(messageFor(err, t("suggest.failed")));
          }
        })();
      },
    };
  };

  return { suggestions, forSenders };
}

/**
 * The sizes to offer for a queue of `available` senders under a per-request cap.
 *
 * Always ends with the largest single request that is possible, so "everything you can buy in
 * one go" is one press rather than arithmetic the user performs. Sizes at or above that are
 * dropped rather than clamped: two buttons reading 25 and 50 that both buy 12 is worse than
 * one button reading 12.
 */
export function batchSizes(available: number, maxPerRequest: number): number[] {
  const cap = Math.min(Math.max(0, available), Math.max(1, maxPerRequest));
  if (cap === 0) return [];
  const out = OFFERED_SIZES.filter((n) => n < cap);
  out.push(cap);
  return out;
}

/**
 * The server's yes/no, as a destination.
 *
 * `no` is `screened` and not `spam`: a screened-out sender's mail goes to `ohmail/Screened`
 * and stays reversible, which is what the endpoint does. Reading a low-confidence "no" as
 * spam would quarantine a stranger on the model's word.
 */
function toSuggestion(a: { decision: "yes" | "no"; confidence: number; rationale: string }): SenderSuggestion {
  return {
    dest: a.decision === "yes" ? "ohbox" : "screened",
    confidence: a.confidence,
    rationale: a.rationale,
  };
}

/** What one completed purchase actually did, said in numbers. */
function summarize(
  res: {
    suggestions: unknown[];
    charged: number;
    stopped?: "out_of_credits" | "spend_unavailable";
    skipped: Array<{ reason: string }>;
  },
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const withheld = res.skipped.filter((s) => s.reason === "withheld").length;
  const parts = [
    t("suggest.doneCount", { count: res.suggestions.length, credits: res.charged }),
    res.stopped === "out_of_credits" ? t("suggest.stoppedCredits") : null,
    res.stopped === "spend_unavailable" ? t("suggest.stoppedUnavailable") : null,
    withheld > 0 ? t("suggest.withheld", { count: withheld }) : null,
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * The sentence to show for a refusal.
 *
 * An {@link ApiError} already carries the SERVICE's own message — "this deployment has no AI
 * classifier connected", "managed AI is switched off for this account", "no AI actions remain
 * on this account" — and each of those is a different, actionable fact written by the code
 * that made the decision. Re-deriving them from status codes here is how a user with an empty
 * balance is told the model is down. Anything that is not an `ApiError` is a bug in this
 * client, and there is nothing true to say about it.
 */
function messageFor(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * A fresh idempotency key.
 *
 * `crypto.randomUUID` is present in every browser this app supports and in jsdom; the
 * fallback is for a runtime that lacks it, where a merely unique-enough key is still better
 * than sending none — an absent key means a lost response is retried as a second purchase.
 */
function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
