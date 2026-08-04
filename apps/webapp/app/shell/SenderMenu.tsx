"use client";

/**
 * The sender's screening, as a popover you can reach from any list or any open message
 * (slice U3). Anchored like the tag picker; Escape and an outside click dismiss.
 *
 * It states the consequence BEFORE the click, and the two consequences are genuinely
 * different: from the Screener the change becomes a rule, from anywhere else it moves the
 * mail and future mail is unaffected. See `sender-screening.ts` for why.
 *
 * ── O19 ADDS THREE THINGS AND CHANGES NOTHING THAT WAS HERE ──────────────────────────────
 *
 * The owner asked for the existing sheet to stay exactly as it is — the avatar, the
 * `1 message · now in Ohbox` line, the five destinations, the honest footer — so the
 * additions sit around it rather than replacing it:
 *
 *  1. **A scope switch**, offered only when the address has a domain. `no-reply-kbdtwj…@x.com`
 *     is not a sender anyone wants to rule on individually, which is the whole case for it.
 *     It DEFAULTS TO THE ADDRESS. Defaulting to the domain would silently widen what every
 *     existing click does — and on a shared provider ("everyone at gmail.com") that is a
 *     mailbox-destroying gesture one habit-click away. The counts are stated on the switch so
 *     the wide option is chosen with its size visible, which is the mitigation O19-RISK asks
 *     for: consent by count, not by cap.
 *  2. **A pre-click disclosure for the two reject destinations.** Screening a waiting sender
 *     out ALSO arms auto-unsubscribe (`screener-service.ts` calls `onScreenOut` after the
 *     commit; `apps/api-vercel/src/deps.ts` wires it in), so one click on a domain can send
 *     one-click unsubscribe requests to every list under it. O19-RISK: *"that must be stated
 *     in the sheet before it runs, not discovered afterwards."* It is therefore a CONFIRM and
 *     not a toast — the same construction `RulesView` uses for revoke, and for the same
 *     reason: a sentence shown after the act is not a disclosure.
 *  3. **A way into the detail view** — every message from this address or domain and what
 *     accounts for where it sits (`sender-audit.ts`).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { DECISION_DONE_LABEL } from "@ohmail/ui";
import { Avatar } from "@ohmail/ui";
import { avatarHue, initialsOf } from "./format";
import "./sender-sheet.css";
import {
  DECISION_OF_DEST,
  SCREENING_DESTS,
  planScreeningChange,
  type ScreeningDest,
  type ScreeningScope,
  type SenderScreening,
} from "./sender-screening";

export interface SenderMenuState {
  /** Any message from the sender — the mirror resolves the rest. */
  messageId: string;
  x: number;
  y: number;
}

export function SenderMenu({
  state,
  sender,
  onChoose,
  onOpenDetail,
  onClose,
}: {
  state: SenderMenuState;
  sender: SenderScreening;
  onChoose: (dest: ScreeningDest, scope: ScreeningScope) => void;
  onOpenDetail: (scope: ScreeningScope) => void;
  onClose: () => void;
}) {
  const t = useTranslations("screening");
  const rootRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<ScreeningScope>("sender");
  /** The reject destination awaiting its second click, or null. One question at a time. */
  const [confirm, setConfirm] = useState<ScreeningDest | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    // `mousedown` on the document, matching the tag picker: a `click` listener would race
    // the very click that opened this.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const label = sender.name || sender.address;
  // Offered only when there IS a domain: `decide` answers 422 for an address with no `@`
  // (an empty `match` on a domain rule is compared against the empty domain of every other
  // malformed address), so the switch must not present a choice the server refuses.
  const canScope = sender.domain !== "";
  const subject = sender.scopes[scope];

  /**
   * Committing goes through `planScreeningChange` — the SAME function `AppShell` will call —
   * so the number this sheet shows and the work that happens cannot disagree. Computing it
   * here for the preview and there for the dispatch is one function evaluated twice, not two
   * implementations that agree today.
   */
  const preview = confirm ? planScreeningChange(sender, confirm, scope) : null;

  const commit = (dest: ScreeningDest) => {
    // The disclosure is owed exactly when the wire will arm auto-unsubscribe, and
    // `ScreeningPlan.unsubscribes` is the one place that condition is decided.
    if (planScreeningChange(sender, dest, scope).unsubscribes) {
      setConfirm(dest);
      return;
    }
    onChoose(dest, scope);
  };

  return (
    <div
      ref={rootRef}
      className="senderm"
      role="dialog"
      aria-label={t("aria", { sender: sender.address })}
      style={{ left: state.x, top: state.y }}
    >
      <div className="sm-head">
        <Avatar initials={initialsOf(label)} hue={avatarHue(sender.address)} size="s" />
        <span className="sm-who">
          <b>{label}</b>
          {sender.name ? <small>{sender.address}</small> : null}
        </span>
      </div>

      {canScope ? (
        <div className="sm-scope" role="radiogroup" aria-label={t("scopeAria")}>
          {(["sender", "domain"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className={scope === s ? "on" : undefined}
              onClick={() => { setScope(s); setConfirm(null); }}
            >
              {s === "sender" ? t("scopeAddress") : t("scopeDomain", { domain: sender.domain })}
              {/* THE SIZE OF THE CHOICE, ON THE CHOICE. Domain scope on a shared provider is
                  the foot-gun; "214 messages · 38 senders" is what makes that visible without
                  a blocklist nobody can maintain. */}
              <small>
                {s === "domain"
                  ? t("scopeCount", {
                      count: sender.scopes.domain.messages.length,
                      senders: sender.scopes.domain.senders,
                    })
                  : t("scopeCountOne", { count: sender.scopes.sender.messages.length })}
              </small>
            </button>
          ))}
        </div>
      ) : null}

      <div className="sm-now">
        {subject.current
          ? t("nowIn", {
              place: subject.current === "screener" ? t("placeScreener") : DECISION_DONE_LABEL[subject.current],
              count: subject.messages.length,
            })
          : t("nowSpread", { count: subject.messages.length })}
      </div>

      {/* ── THE CONFIRM, WHICH CARRIES THE DISCLOSURE ──────────────────────────────────────
          Not an "are you sure?" — the user is sure. It is the one moment at which "this will
          also ask these senders to stop mailing you" can be READ, before it is true. */}
      {confirm && preview ? (
        <div className="sm-confirm">
          <p>
            {scope === "domain"
              ? t("unsubDomain", {
                  domain: sender.domain,
                  senders: preview.senders,
                  place: DECISION_DONE_LABEL[confirm],
                })
              : t("unsubSender", { sender: sender.address, place: DECISION_DONE_LABEL[confirm] })}
          </p>
          <p className="sm-confirm-fine">{t("unsubFine")}</p>
          <span className="sm-confirm-row">
            <button type="button" className="go" onClick={() => { setConfirm(null); onChoose(confirm, scope); }}>
              {t("unsubCommit")}
            </button>
            <button type="button" onClick={() => setConfirm(null)}>{t("cancel")}</button>
          </span>
        </div>
      ) : (
        <ul role="listbox">
          {SCREENING_DESTS.map((dest) => (
            <li
              key={dest}
              role="option"
              aria-selected={subject.current === dest}
              className={subject.current === dest ? "sel" : undefined}
              onClick={() => commit(dest)}
            >
              {DECISION_DONE_LABEL[dest]}
              {/* The two destinations that can send mail on your behalf are marked before you
                  reach them, not only in the confirm that follows. */}
              {DECISION_OF_DEST[dest] === "no" && subject.waiting ? (
                <span className="sm-warn" aria-hidden="true">↗</span>
              ) : null}
              {subject.current === dest ? <span className="ck">✓</span> : null}
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="sm-detail" onClick={() => onOpenDetail(scope)}>
        {t("auditOpen", { count: subject.messages.length })}
      </button>

      {/* The honest half. A Screener-held sender goes through the endpoint that promotes a
          rule; everyone else gets moves, and moves do not remember anything.

          `footNoRule` IS UNCHANGED AND STILL TRUE. O19 expected this sentence to become false,
          and for the non-waiting case it did not: rule creation for a sender whose mail has
          left the gate is not reachable from this shell at all — `screener_decide` is the only
          rule-creating verb in the engine's vocabulary and `mutationEffects` produces no
          effects for a representative outside `ohmail/Screener`, which `Engine.mutate` turns
          into a local rollback with no request sent. See `sender-screening.ts`. */}
      <div className="sm-foot">
        {subject.waiting
          ? scope === "domain"
            ? t("footRuleDomain", { domain: sender.domain })
            : t("footRule", { sender: sender.address })
          : t("footNoRule")}
      </div>
    </div>
  );
}
