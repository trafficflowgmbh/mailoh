"use client";

/**
 * THE SENT-MAIL SEED — "you've written to these people; shall I let them through?"
 *
 * The first question a new mailbox is asked cannot be "who do you want to hear from", because
 * nobody can answer that against fifteen thousand messages. The strongest thing anybody has
 * done towards a correspondent is WRITE TO THEM, and that is already sitting in the mailbox.
 *
 * ── THE LIST IS SHOWN BEFORE IT ACTS, AND THAT IS THE WHOLE SCREEN ────────────────────────
 *
 * Everything here exists so the confirmation is informed rather than assumed:
 *
 *   · the count is stated first, and it is the count of PEOPLE, not of messages;
 *   · every row is unticked-able, and the button says how many are ticked right now;
 *   · the robot filter's removals are DISCLOSED, collapsed, with the reason it gave — a
 *     filter nobody can inspect is a filter nobody can correct;
 *   · the sentence above the button says what pressing it will do, and what it will not do.
 *
 * The last one is the one worth being stubborn about. This writes rules and moves nothing:
 * confirming consent for four hundred people must never turn into four hundred moves inside
 * somebody's real mailbox, and somebody about to press a button that could is entitled to
 * know it will not before they press it rather than after.
 *
 * ── AND THERE IS EXACTLY ONE CONFIRM ──────────────────────────────────────────────────────
 *
 * The server refuses a second (409), because the review is an offer made once. A retry of a
 * confirmation whose answer was lost is a different thing and is handled by the idempotency
 * key this screen mints per press — one key per press of one button, so a network retry
 * replays the answer instead of asking the question again.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { ApiError, consent as consentApi, type SeedReviewWire } from "../api-client";

type Phase =
  | { state: "loading" }
  | { state: "ready"; review: SeedReviewWire }
  | { state: "confirming"; review: SeedReviewWire }
  | { state: "failed"; message: string };

/** A stable key per press, so a retry replays rather than re-asks. */
const newKey = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function SeedReviewView({
  onDone,
  onLater,
}: {
  /** The consent event landed. The caller re-reads the world; the mirror has not seen the rules yet. */
  onDone: () => void;
  /** Left without answering. Nothing was written, and the offer stands next time. */
  onLater: () => void;
}) {
  const t = useTranslations("seed");
  const [phase, setPhase] = useState<Phase>({ state: "loading" });
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const review = await consentApi.seedReview();
        if (!live) return;
        setPhase({ state: "ready", review });
        // EVERYONE STARTS TICKED. The list is people the user has written to — the default is
        // the answer that matches what they already did — and a screen that starts empty makes
        // somebody tick four hundred boxes to get where writing to those people already put
        // them. Anyone already decided about is left out: they are shown, not re-written.
        setChecked(new Set(review.candidates.filter((c) => !c.alreadyDecided).map((c) => c.address)));
      } catch (err) {
        if (!live) return;
        setPhase({
          state: "failed",
          message: err instanceof ApiError ? err.message : t("errorGeneric"),
        });
      }
    })();
    return () => { live = false; };
  }, [t]);

  const review = phase.state === "ready" || phase.state === "confirming" ? phase.review : null;

  const shown = useMemo(() => {
    if (!review) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return review.candidates;
    return review.candidates.filter(
      (c) => c.address.includes(q) || (c.name ?? "").toLowerCase().includes(q),
    );
  }, [review, filter]);

  const toggle = useCallback((address: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }, []);

  const confirm = useCallback(async () => {
    if (!review) return;
    setPhase({ state: "confirming", review });
    try {
      await consentApi.confirmSeed([...checked], { idempotencyKey: newKey() });
      onDone();
    } catch (err) {
      setPhase({
        state: "failed",
        message: err instanceof ApiError ? err.message : t("errorGeneric"),
      });
    }
  }, [review, checked, onDone, t]);

  if (phase.state === "loading") {
    return (
      <section className="view center view-seed">
        <div className="gate-card" aria-busy="true">
          <p className="set-note-inline">{t("loading")}</p>
        </div>
      </section>
    );
  }

  if (phase.state === "failed") {
    return (
      <section className="view center view-seed">
        <div className="gate-card">
          <h1>{t("errorTitle")}</h1>
          {/* The SERVER's sentence, verbatim. A second copy of the taxonomy here is how
              somebody ends up being told the wrong reason. */}
          <p className="set-note-inline">{phase.message}</p>
          <Button variant="ghost" onClick={onLater}>{t("later")}</Button>
        </div>
      </section>
    );
  }

  const busy = phase.state === "confirming";

  return (
    <section className="view center view-seed">
      <div className="seed-card">
        <h1>{t("title", { count: review!.candidates.length })}</h1>
        <p className="view-note">{t("lede")}</p>
        {review!.truncated ? <p className="view-note">{t("truncated", { scanned: review!.scannedMessages })}</p> : null}

        <input
          className="seed-filter"
          type="search"
          value={filter}
          placeholder={t("filterPlaceholder")}
          aria-label={t("filterPlaceholder")}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />

        <ul className="seed-list">
          {shown.map((c) => (
            <li key={c.address} className="seed-row">
              <label>
                <input
                  type="checkbox"
                  checked={checked.has(c.address)}
                  disabled={c.alreadyDecided || busy}
                  onChange={() => toggle(c.address)}
                />
                <span className="seed-who">{c.name ?? c.address}</span>
                {c.name ? <span className="seed-addr">{c.address}</span> : null}
                <span className="seed-count">{t("wroteN", { count: c.messages })}</span>
                {/* Shown, and not silently dropped: a person already decided about is part of
                    why the number on the button is smaller than the list. */}
                {c.alreadyDecided ? <span className="seed-note">{t("alreadyDecided")}</span> : null}
              </label>
            </li>
          ))}
        </ul>

        {review!.excluded.length ? (
          <details
            className="seed-excluded"
            open={showExcluded}
            onToggle={(e) => setShowExcluded((e.currentTarget as HTMLDetailsElement).open)}
          >
            {/* COLLAPSED, NOT HIDDEN. The robot filter is the part of this screen nobody asked
                for and the part most likely to be wrong about somebody, so it says what it
                removed and why, one press away. */}
            <summary>{t("excludedSummary", { count: review!.excluded.length })}</summary>
            <ul className="seed-list">
              {review!.excluded.map((e) => (
                <li key={e.address} className="seed-row">
                  <span className="seed-who">{e.address}</span>
                  <span className="seed-note">{t(`excluded.${e.reason}`)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {/* WHAT THE BUTTON WILL DO, BEFORE IT IS PRESSED — including the thing it will not do. */}
        <p className="view-note">{t("willDo", { count: checked.size })}</p>
        <div className="gate-actions">
          <Button onClick={confirm} disabled={busy}>
            {busy ? t("confirming") : t("confirm", { count: checked.size })}
          </Button>
          <Button variant="ghost" onClick={onLater} disabled={busy}>{t("later")}</Button>
        </div>
      </div>
    </section>
  );
}
