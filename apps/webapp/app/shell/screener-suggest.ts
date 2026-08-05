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

/**
 * HOW MANY SENDERS ONE AUTOMATIC BATCH BUYS — the opt-in's entire spend per Screener open.
 *
 * Ten, not the endpoint's cap of fifty and not the largest size the manual control offers. The
 * automatic path spends without a press, so its bound has to be a number somebody can live with
 * being wrong about: at `AI_ACTION_COST` per sender, ten is a rounding error against the smallest
 * tier's monthly allowance, and a person who wants the other forty presses the manual control and
 * sees a quote first. A backlog is drained ten at a time across visits rather than in one
 * four-figure purchase nobody authorised individually — the reason the endpoint demands an
 * explicit sender list in the first place (see the header's spend rule).
 *
 * It is also why the flag needs no per-period ceiling stored on the account: the only thing that
 * can spend automatically is a person opening the Screener, and each open buys at most this many.
 */
const AUTO_BATCH_SIZE = 10;

export function useScreenerSuggestions(opts: {
  /** Is the Screener on screen? Hydration is deferred until it is. */
  active: boolean;
  /**
   * HAS THIS ACCOUNT OPTED IN to buying suggestions without a press (mail 0040)?
   *
   * Optional, and absent means NO. Every host that has no server — the demo, the desktop shell —
   * omits it, and so does a shell whose `GET /consent` failed. The default has to be the one that
   * spends nothing, because the alternative is a fetch error that costs money.
   */
  autoSuggest?: boolean;
  toast: ToastFn;
}): ScreenerSuggestions {
  const t = useTranslations("screener");
  const { active, toast } = opts;
  const autoSuggest = opts.autoSuggest === true;

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
  const io = useRef({
    run: 0,
    hydrated: false,
    /**
     * THE AUTO LATCH — the whole safety of the automatic path is these three fields.
     *
     * `autoFired` goes true before the request leaves, so a re-render, a second effect pass under
     * StrictMode, or a warming mirror cannot buy a second batch. It is reset when the Screener goes
     * AWAY, which makes the unit "one batch per Screener-open": a person who comes back later gets
     * the next few senders, and a backlog drains across visits instead of in one purchase nobody
     * authorised individually.
     *
     * `autoDisarmed` is the refusal latch, and the reset above is what gives it a job. When the
     * server refuses — no credits (402), managed AI switched off (409), no classifier connected
     * (503) — the automatic path stops for the whole session and does not try again on the next
     * visit. Without it, an account with an empty balance would issue one doomed request every
     * time the Screener was opened: a client hammering a wall it has already been told about, and
     * for a 503 an automatic loop against a misconfiguration. The manual control still works and
     * still carries the server's own sentence, so nobody is left without a way in.
     *
     * The two were briefly redundant — `autoFired` was never reset, so nothing could reach the
     * second latch and REMOVING IT LEFT THE SUITE GREEN. That is recorded because a guard nobody
     * has watched fail is not evidence, and the fix was to give each of them a distinct
     * reachable state rather than to delete the one that happened to be unreachable.
     *
     * `queue` is the sender list the control was last bound to, recorded during render so the
     * effect below can read it without the render cycle `forSenders` exists to avoid.
     */
    autoFired: false,
    autoDisarmed: false,
    queue: [] as string[],
  });

  /**
   * Bumped ONCE, the first time the control is bound to a non-empty queue.
   *
   * The automatic batch cannot fire from the first render: the queue comes from the message
   * mirror, and on a cold tab the mirror is still filling, so `forSenders` is called with an empty
   * list several times before it has anything. An effect keyed only on `active` would look once,
   * find nothing and never look again — which is how this feature would ship doing nothing on
   * every real account and working on every test that pre-warms its fixture.
   *
   * One state write per session, guarded by `autoSeen`, purely to give the effect below a
   * dependency that changes when there is finally something to buy.
   */
  const [queueReady, setQueueReady] = useState(0);
  const autoSeen = useRef(false);

  /** True once the stored-suggestion hydration has SETTLED, either way. See its `finally`. */
  const [hydrateSettled, setHydrateSettled] = useState(false);

  /**
   * `toast` and `t` HELD IN A REF, so the automatic effect does not depend on their identity.
   *
   * Not a micro-optimisation — it is what makes the effect's dependency list mean something.
   * `useTranslations` returns a fresh function every render, and a parent is free to pass a fresh
   * `toast` arrow, so listing either in the deps re-runs the effect on EVERY render. The batch is
   * still safe (the latch stops a second purchase), but the cold-mirror behaviour then works by
   * accident: `queueReady` would be dead weight and the real retrigger would be the parent's
   * render churn, which is not something this module can promise.
   *
   * Measured, not assumed. With these in the deps, deleting the `setQueueReady` bump left the
   * whole suite GREEN — a guard that cannot fail is not evidence. With them in a ref, that
   * deletion goes red, which is the assertion the test claims to be making.
   */
  const notify = useRef({ toast, t });
  notify.current = { toast, t };

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
      } finally {
        // SETTLED, not "succeeded". The automatic batch waits on this so it does not buy answers
        // the account already owns — but a hydration that FAILED must not block it for ever,
        // because the stored-skip is the server's job anyway and a re-ask for a stored answer is
        // free (`charged: 0`). So both outcomes release the gate; only the ordering is bought.
        if (!cancelled) setHydrateSettled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, merge]);

  /**
   * THE AUTOMATIC BATCH — one per mounted Screener, only when the account opted in.
   *
   * Everything this path is allowed to do is buy suggestions. It reaches `screenerApi.suggest`
   * and nothing else: there is no branch here that can call `POST /screener/:id`, write a rule or
   * move a message, which is what keeps the opt-in an opt-in to WORK rather than to a decision.
   * `screener-auto-suggest.test.tsx` asserts that by watching the calls, because "I did not write
   * that line" is not a property a reader can check later.
   *
   * There is no dry run in front of it, and that is the one place this path differs from the
   * manual control. The control prices first because a person is about to press a button and has
   * to see what it costs; here the cost was named when the setting was turned on, and the batch is
   * bounded by {@link AUTO_BATCH_SIZE} so the figure quoted then is the figure that applies. A dry
   * run would double the round trips to re-tell the client something it already fixed.
   */
  useEffect(() => {
    if (!active) {
      // LEAVING RE-ARMS THE BATCH, BUT NEVER THE REFUSAL. Coming back to the Screener is the
      // event the opt-in is scoped to, so the next visit may buy the next few senders; a refusal
      // is a standing condition and must not be re-tested on every visit. Two latches, one reset.
      io.current.autoFired = false;
      return;
    }
    if (!autoSuggest || !apiConfigured()) return;
    if (!hydrateSettled) return;
    if (io.current.autoFired || io.current.autoDisarmed) return;
    const set = io.current.queue.slice(0, AUTO_BATCH_SIZE);
    if (set.length === 0) return;
    // LATCHED BEFORE THE AWAIT. Set after it, two effect passes racing each other both read
    // false and both buy — and the second batch is money nobody asked for.
    io.current.autoFired = true;
    const run = ++io.current.run;
    void (async () => {
      try {
        const res = await screenerApi.suggest(set, { idempotencyKey: newKey() });
        if (io.current.run !== run) return;
        merge(res.suggestions.map((s) => ({ address: s.sender, suggestion: toSuggestion(s) })));
        // SAID OUT LOUD, every time, even though nobody pressed anything. This is the "visible
        // after the fact" half of the opt-in: money moved, so the same sentence the manual
        // purchase shows is shown here. A spend the user only discovers on their next invoice is
        // the failure mode the setting exists to avoid, not one it is licensed to create.
        notify.current.toast(summarize(res, notify.current.t));
      } catch (err) {
        if (io.current.run !== run) return;
        // DISARM, DO NOT RETRY. See the latch's own comment: every refusal on this path is a
        // standing condition (no credits, AI off, no classifier), not a blip, so retrying it
        // automatically is a flood against a wall.
        io.current.autoDisarmed = true;
        const why = messageFor(err, notify.current.t("suggest.failed"));
        // TOASTED, NOT ONLY NOTICED — and the distinction was found by a test rather than by
        // reading. `notice` is painted INSIDE the suggest panel, which on this path nobody
        // opened, so setting it alone left a refused automatic purchase completely invisible: the
        // user turned a setting on, it silently did nothing, and the only way to find out was to
        // notice the absence of chips. A setting that fails quietly is the failure mode this
        // whole feature is supposed to avoid, so the refusal goes through the same channel the
        // success does. `notice` is set as well, for the panel they may open next.
        setNotice(why);
        notify.current.toast(why);
      }
    })();
    // FOUR DEPENDENCIES, ALL OF THEM REAL SIGNALS: is the Screener open, did the account opt in,
    // has hydration settled, and is there anything in the queue yet. `toast`/`t` are read through
    // `notify` precisely so they cannot smuggle a fifth — see that ref's comment for the
    // measurement that made this necessary rather than tidy.
  }, [active, autoSuggest, hydrateSettled, queueReady, merge]);

  /**
   * Deliberately NOT memoised. It is called during render and closes over every piece of the
   * control's state, so a `useCallback` would need all of them in its dependency array —
   * including `quote`, a fresh object every render — and the one it would silently get wrong
   * is `phase`: a stale closure keeps reporting "pricing" after the price has landed, and the
   * confirm button never becomes pressable. Building a small object per render is cheaper
   * than the class of bug that memoising it invites.
   */
  const forSenders = (addresses: string[]): SuggestBatchControl => {
    // The automatic batch's only view of the queue. A REF write during render, which is safe —
    // it schedules nothing and changes no output — and the alternative (passing the list in as a
    // hook argument) is the cycle this function's own docblock exists to explain.
    io.current.queue = addresses;
    // One state write, the first time there is anything to buy, so the effect above gets a
    // dependency that changes when the cold mirror finally has senders in it.
    if (!autoSeen.current && addresses.length > 0) {
      autoSeen.current = true;
      setQueueReady((n) => n + 1);
    }
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
          setPhase("ready");
          // NO PRICE, NO PURCHASE. A server that answers without `quotedCredits` — one
          // deployed before the field existed, reached during the minutes between two
          // deploys — leaves the cost unknown, and an unknown cost is not one a person can
          // consent to. The confirm stays disabled because `quote` is null; the alternative,
          // multiplying the count by an assumed credit cost, is the exact guess this field
          // was added to remove.
          if (typeof res.quotedCredits !== "number") {
            setQuote(null);
            setNotice(t("suggest.failed"));
            return;
          }
          setQuote({ senders: res.quoted, credits: res.quotedCredits });
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
