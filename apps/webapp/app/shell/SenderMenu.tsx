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
 *     out ALSO arms auto-unsubscribe (the screener calls `onScreenOut` after the commit, and the
 *     server wires that dependency in), so one click on a domain can send
 *     one-click unsubscribe requests to every list under it. O19-RISK: *"that must be stated
 *     in the sheet before it runs, not discovered afterwards."* It is therefore a CONFIRM and
 *     not a toast — the same construction `RulesView` uses for revoke, and for the same
 *     reason: a sentence shown after the act is not a disclosure.
 *  3. **A way into the detail view** — every message from this address or domain and what
 *     accounts for where it sits (`sender-audit.ts`).
 *
 * ── O19c ADDS THE FOURTH, AND IT IS THE ONE THAT CHANGES THE DEFAULT ────────────────────
 *
 * Owner: *"but also allow it to actually create the rule and apply it to ALL messages future
 * and previous, this should be the default behaviour."* Choosing a destination for a sender
 * PAST the gate now writes a rule as well as moving the mail, through `rule_create` — the verb
 * `4a3ff4f` named and could not build. The toggle is ON by default, because the default is
 * where the request lives, and OFF is the explicit non-default O19(d) asks to keep reachable.
 *
 * It is only offered for a sender the Screener is NOT holding. A waiting sender's rule is
 * promoted by `POST /screener/:id` inside the decision itself, so a switch there would be a
 * control that cannot change the outcome.
 *
 * **It does NOT carry the unsubscribe disclosure, and that is checked rather than assumed.**
 * `unsubscribe.onScreenOut` has exactly one production caller — `screener-service.ts`, on
 * `decide`'s reject branch — `RulesService.create` calls nothing, the routing pass that
 * consults rules on arrival calls nothing, and `sweepScreenedOut` still has no production
 * caller. A rule written from past the gate arms NOTHING today, so warning here would train
 * people to click through the confirm above, which is real.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { DECISION_DONE_LABEL } from "@ohmail/ui";
import { Avatar } from "@ohmail/ui";
import { avatarHue, initialsOf } from "./format";
import "./sender-sheet.css";
import {
  DECISION_OF_DEST,
  RETRO_DEFAULT_ON,
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
  onChoose: (dest: ScreeningDest, scope: ScreeningScope, makeRule: boolean) => void;
  onOpenDetail: (scope: ScreeningScope) => void;
  onClose: () => void;
}) {
  const t = useTranslations("screening");
  const rootRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<ScreeningScope>("sender");
  /** The reject destination awaiting its second click, or null. One question at a time. */
  const [confirm, setConfirm] = useState<ScreeningDest | null>(null);
  /** O19c — ON by default. The owner's request is about the DEFAULT, not about an option. */
  const [makeRule, setMakeRule] = useState(true);

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
  const preview = confirm ? planScreeningChange(sender, confirm, scope, makeRule) : null;

  const commit = (dest: ScreeningDest) => {
    // The disclosure is owed exactly when the wire will arm auto-unsubscribe, and
    // `ScreeningPlan.unsubscribes` is the one place that condition is decided.
    if (planScreeningChange(sender, dest, scope, makeRule).unsubscribes) {
      setConfirm(dest);
      return;
    }
    onChoose(dest, scope, makeRule);
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

      {/* ── THE RULE, WHICH IS NOW THE DEFAULT (O19c) ────────────────────────────────────
          ABOVE the destinations, because it changes what clicking one of them does and a
          control read afterwards is not a choice. Offered only past the gate: a waiting
          sender's rule is promoted by the decide itself, so a switch there would be a control
          that cannot change the outcome.

          It reuses `.sm-scope`'s styling because `sender-sheet.css` is not this slice's to
          restyle, and carries `sm-rule` so a test can name it without depending on order. The
          scope switch's own test now selects it by `role="radiogroup"` rather than by that
          class, which is what this file's tests were supposed to do in the first place. */}
      {!subject.waiting ? (
        <div className="sm-scope">
          <button
            type="button"
            role="switch"
            aria-checked={makeRule}
            aria-label={t("ruleToggleAria")}
            className={makeRule ? "sm-rule on" : "sm-rule"}
            onClick={() => setMakeRule((on) => !on)}
          >
            {makeRule ? `✓ ${t("ruleToggle")}` : t("ruleToggle")}
            {/* ── THE RETROACTIVE HALF, SAID BEFORE THE CLICK AND WITH ITS SIZE (O19-retro) ──
                The rule is now applied to mail already on the server, by a worker pass, and this
                is where the user learns that and how much it is about. It rides the SAME switch
                rather than getting one of its own: turning the rule off is the opt-out, and
                `planScreeningChange` reports `retro: false` for every plan that writes no rule,
                so the control and the behaviour cannot come apart.

                It says "apply the rule to", never "move" and never "every message". The pass
                re-evaluates each message through `evaluateRules`, so a higher-priority deny rule
                keeps its mail where it is; and it skips anything the user has already acted on.
                A promise about the outcome would be false for both. */}
            {makeRule && RETRO_DEFAULT_ON ? (
              <small>{t("ruleRetro", { count: subject.messages.length })}</small>
            ) : null}
          </button>
        </div>
      ) : null}

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
            <button type="button" className="go" onClick={() => { setConfirm(null); onChoose(confirm, scope, makeRule); }}>
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

      {/* ── THE FOOTER, WHICH NOW HAS THREE TRUE SENTENCES INSTEAD OF TWO ────────────────
          A Screener-held sender goes through the endpoint that promotes a rule. Past the gate,
          the sentence follows the toggle — and `footNoRule` is the one O19 predicted would
          become false. It did, the moment `rule_create` existed, so it is no longer the
          default sentence; it is what the OPT-OUT says, and it is still exactly true there.

          `footWillRule` states the OUTCOME ("future mail files there too") rather than the
          mechanism ("this makes a rule"), because the footer cannot know which destination is
          about to be clicked: for a destination a rule already covers, nothing is written and
          only the outcome sentence stays true. The toast, which does know, names the
          difference — `screeningToast` in `sender-screening.ts`. */}
      <div className="sm-foot">
        {subject.waiting
          ? scope === "domain"
            ? t("footRuleDomain", { domain: sender.domain })
            : t("footRule", { sender: sender.address })
          : makeRule
            ? RETRO_DEFAULT_ON
              // O19-retro: the sentence that used to promise only the future. It now names the
              // past as well, AND the thing that has no undo — mail this moves stays moved when
              // the rule is later revoked, because `DELETE /rules/:id` touches the rules row and
              // nothing else. Saying so here is the "way back" this feature actually has: the
              // count and the choice, before the click.
              ? scope === "domain"
                ? t("footWillRuleRetroDomain", { domain: sender.domain })
                : t("footWillRuleRetro", { sender: sender.address })
              : scope === "domain"
                ? t("footWillRuleDomain", { domain: sender.domain })
                : t("footWillRule", { sender: sender.address })
            : t("footNoRule")}
      </div>
    </div>
  );
}
