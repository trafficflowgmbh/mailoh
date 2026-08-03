"use client";

/**
 * SENDING A REPLY (slice U4b) — the client half of the gated send, and the one action in
 * this app that cannot be taken back.
 *
 * Everything else the shell dispatches is a local edit the server later agrees with; a
 * rejection rolls the overlay back and nothing is lost. A send is not that. So this state
 * machine exists for one reason: **a send that has not been delivered must never look like
 * one that has.** Four outcomes, four different things on screen:
 *
 *   `sending`     the request is out. Send is locked — a second press would mint a second
 *                 Idempotency-Key, which is a second draft AND a second reservation, which
 *                 is a real double-send to a real person.
 *   `queued`      the transport failed or the server said `in_flight`. The intent stands
 *                 (the engine kept the overlay and the key), the editor keeps the text, and
 *                 the copy says "not sent yet" — never "sent". Retried on a backoff below.
 *   `unverified`  SMTP threw AND the server's Sent-folder probe found no copy. Genuinely
 *                 ambiguous: it may have gone out. We do NOT retry — invariant #2 forbids an
 *                 automatic resend on ambiguity — and we do not lock the button either,
 *                 because the server refuses every further send of THAT draft
 *                 (`send-service.ts:162-168`), so a lock would brick the reply forever after
 *                 one hiccup. The warning stays on screen and the next press is a fresh
 *                 send the user deliberately chose.
 *   `failed`      a definite refusal. Text kept, reason shown, Send live again.
 *
 * ── WHY THERE IS A RETRY DRIVER HERE ────────────────────────────────────────────────────
 *
 * `OhmailEngine.flushPending()` had NO caller anywhere in the app. A retryable rejection
 * queues the mutation with its key preserved and then nothing ever drains it — so `queued`
 * would have been a permanent state wearing a hopeful label. Convergence is safe on the
 * server's side: while the first invocation lives, a same-key request answers `in_flight`;
 * once it finalizes, the same key replays the terminal outcome; past `SEND_STALE_AFTER_MS`
 * the retry itself triggers verify-by-Sent recovery. ONE timer for the whole queue, because
 * `flushPending` drains all of it.
 *
 * ── COMPLETION IS ROUTED THROUGH HERE, NOT THROUGH THE BUTTON ───────────────────────────
 *
 * A confirmation can arrive from the original `mutate()` OR from a flush minutes later, by
 * which time the user may have closed the editor or walked to another view. Both paths land
 * in `settle`, so the local draft is cleared and U4e fires either way, and the editor is
 * closed only if it still happens to be open on that message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, MutationResult, OhmailEngine } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import { canSend, replyDraftKey } from "./InlineReply";

export type ReplySendPhase = "idle" | "sending" | "queued" | "unverified" | "failed";

export interface ReplySendState {
  phase: ReplySendPhase;
  /** The server's or the transport's own words, for `failed`. */
  reason?: string;
}

export interface ReplySend {
  stateOf: (messageId: string) => ReplySendState;
  /** Press Send. A no-op while that message's reply is already in flight or queued. */
  send: (messageId: string, body: string) => void;
}

const IDLE: ReplySendState = { phase: "idle" };

/**
 * `MutationResult` → what the editor shows. A pure function because it is the whole
 * correctness of the slice compressed into six lines — "queued must not read as sent",
 * "ambiguous is its own thing" — and a hook is a poor place to keep something that wants
 * asserting one row at a time.
 */
export function phaseFor(res: MutationResult): ReplySendState {
  if (res.status === "confirmed") return IDLE;
  if (res.status === "queued") return { phase: "queued" };
  if (res.error?.code === "send_unverified") return { phase: "unverified" };
  return { phase: "failed", ...(res.error?.message ? { reason: res.error.message } : {}) };
}

/**
 * U4e — which triage states a delivered reply discharges.
 *
 * `reply_later` (Answer Later) and `bubbled_up` (a Resurface that came due) are both "come
 * back to this", and replying IS coming back to it. `set_aside` (Parked) and `muted` are
 * statements about the message rather than an owed answer, and a reply is not an obvious
 * argument to undo either.
 */
export function clearsTriage(state: string | undefined): boolean {
  return state === "reply_later" || state === "bubbled_up";
}

/**
 * Retry schedule for a queued send, in ms. Capped and finite-stepped rather than
 * exponential-forever: past ten minutes the server's own verify-by-Sent recovery is what
 * resolves the row, and a client hammering it faster than that buys nothing.
 */
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export function useReplySend(
  engine: OhmailEngine,
  toast: ToastFn,
  /** Close the editor if it is still open on this message. */
  onSettled: (messageId: string) => void,
): ReplySend {
  const t = useTranslations("reply");
  const [states, setStates] = useState<Record<string, ReplySendState>>({});
  /** `Idempotency-Key → messageId` for everything currently queued, so a flush can settle it. */
  const queued = useRef(new Map<string, string>());
  /**
   * THE LOCK — a ref, and it has to be, which a test proved rather than a comment claimed.
   *
   * `send` first gated on `states[messageId]`, i.e. React state captured at RENDER. Two calls
   * inside one tick therefore both read `idle`, both dispatched, and each minted its own
   * Idempotency-Key: two reservations, two deliveries, to a real person. The button's
   * `disabled` does not save you — it only exists after the re-render the second call beat,
   * and a double-tap or any programmatic caller gets there first.
   *
   * Holds every message whose reply is `sending` OR `queued` — the two phases where an intent
   * is already out under a key. Cleared on any terminal outcome, from whichever path
   * delivered it.
   */
  const locked = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const setPhase = useCallback((messageId: string, next: ReplySendState) => {
    setStates((prev) => {
      if (next.phase === "idle") {
        if (!(messageId in prev)) return prev;
        const { [messageId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [messageId]: next };
    });
  }, []);

  /**
   * A send that DID land. The local draft goes, the triage debt goes (U4e), and the editor
   * closes if it is still the one on screen.
   */
  const settle = useCallback(
    (messageId: string) => {
      try {
        window.localStorage.removeItem(replyDraftKey(messageId));
      } catch {
        /* private mode refuses writes and therefore holds nothing to remove */
      }

      // ── U4e: the reply IS the evidence the message was answered ──────────────────────
      //
      // Read at CONFIRM time, not at press time: the state may have moved while the request
      // was out, and a send that failed must never clear a debt.
      const msg = engine.read().get<EngineMessage>("message", messageId);
      if (clearsTriage(msg?.triage?.state)) {
        void engine.mutate({ kind: "triage_set", messageId, state: "none" });
      }

      setPhase(messageId, IDLE);
      settledRef.current(messageId);
      toast(t("toastSent"));
    },
    [engine, setPhase, toast, t],
  );

  const absorb = useCallback(
    (messageId: string, res: MutationResult) => {
      const next = phaseFor(res);
      if (res.status === "queued") {
        queued.current.set(res.key, messageId);
        // STILL LOCKED: the intent is out there under this key and a second press would
        // mint another one.
        locked.current.add(messageId);
      } else {
        queued.current.delete(res.key);
        locked.current.delete(messageId);
      }
      // A confirmation is the only outcome that does anything beyond the phase, and `settle`
      // is where all of it lives — so a confirmation from a flush minutes later clears the
      // draft and fires U4e exactly as the first press would have.
      if (res.status === "confirmed") settle(messageId);
      else setPhase(messageId, next);
    },
    [settle, setPhase],
  );

  const flush = useCallback(async (): Promise<void> => {
    timer.current = null;
    if (queued.current.size === 0) return;
    const results = await engine.flushPending();
    let stillQueued = false;
    for (const res of results) {
      const messageId = queued.current.get(res.key);
      // A queued mutation that is not one of ours (a move that failed offline, say) is
      // drained by the same call and is none of this state machine's business.
      if (!messageId) continue;
      absorb(messageId, res);
      if (res.status === "queued") stillQueued = true;
    }
    if (stillQueued) {
      const wait = BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)]!;
      attempt.current += 1;
      timer.current = setTimeout(() => void flush(), wait);
    } else {
      attempt.current = 0;
    }
  }, [engine, absorb]);

  const arm = useCallback(() => {
    if (timer.current !== null) return; // one timer for the whole queue
    const wait = BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)]!;
    attempt.current += 1;
    timer.current = setTimeout(() => void flush(), wait);
  }, [flush]);

  // Coming back online is better news than any timer, so take it immediately.
  useEffect(() => {
    const onOnline = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      attempt.current = 0;
      void flush();
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [flush]);

  const send = useCallback(
    (messageId: string, body: string) => {
      // THE LOCK FIRST, off the ref, because it is the only check that is correct within one
      // tick. `canSend` then applies the SAME rule the button's `disabled` uses, so a caller
      // that is not the button (a keyboard shortcut, a future Reply Run step) cannot get past
      // something the button enforces.
      if (locked.current.has(messageId)) return;
      if (!canSend(states[messageId] ?? IDLE, body)) return;

      locked.current.add(messageId);
      setPhase(messageId, { phase: "sending" });
      void engine
        .mutate({ kind: "reply_send", messageId, body })
        .then((res) => {
          absorb(messageId, res);
          if (res.status === "queued") arm();
        })
        .catch((err: unknown) => {
          // `mutate` resolves rather than throws for every outcome it models; anything that
          // gets here is a bug in the engine, and swallowing it would leave the editor stuck
          // on "Sending…" with no way out.
          locked.current.delete(messageId);
          setPhase(messageId, { phase: "failed", reason: String(err) });
        });
    },
    [engine, states, setPhase, absorb, arm],
  );

  return useMemo(
    () => ({ stateOf: (messageId: string) => states[messageId] ?? IDLE, send }),
    [states, send],
  );
}
