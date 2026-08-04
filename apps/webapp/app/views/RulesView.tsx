"use client";

/**
 * RULES — what the consent gate remembered, and the only way to take it back.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────────────────
 *
 * `POST /screener/:id` writes a `rules` row on EVERY decision, and four controls reach it: the
 * DecisionBar, "apply to all", "mark all spam" and the sender menu. The server's five `/rules`
 * endpoints were mounted, contract-tested and referenced by nothing; `/rules` had zero
 * occurrences anywhere in the client; the `rule` entity had been syncing into the client mirror
 * since the first release and was read by no selector. In a product whose thesis is a gate that
 * remembers your decisions, "and you can never see or undo them" is the part that compounds —
 * a real account had four invisible rules on it before this shipped.
 *
 * ── WHAT IT SAYS, AND THE THREE THINGS IT REFUSES TO SAY ────────────────────────────────
 *
 * 1. NO MESSAGE COUNT. `RuleDTO.stats` offers `hits`, `lastHitAt` and `demotions`; nothing
 *    anywhere has ever written one. The columns are declared and faithfully reported, and
 *    every value is still the insert default. A rule that has quietly filed three thousand
 *    messages would render "0". So the note says the count is not recorded, which is true,
 *    instead of a number that is not.
 *
 * 2. NO PROMISE ABOUT WHERE FUTURE MAIL GOES. A revoked rule stops deciding — it does not
 *    put the sender back at the gate. A promoted YES also inserted a `contacts` row
 *    (`screener-service.ts:360`), and the pipeline routes on known senders independently of
 *    rules, so that sender stays known after their rule is gone; a promoted NO wrote no
 *    contact and genuinely does return to the Screener. Two outcomes from one control, and
 *    the row cannot tell which without reading a table it does not have. It therefore claims
 *    only the half that is true of both: this rule stops deciding.
 *
 * 3. NO RETROACTIVE MOVE, STATED BEFORE THE ACT AND NOT AFTER. `RulesService.remove` is one
 *    transaction over `rules` + `change_log` and never touches `folder_state`, so every
 *    message the rule ever filed stays exactly where it is. That is the RIGHT behaviour —
 *    reversing a rule and silently re-sorting a backlog is a worse surprise than the rule
 *    was — but it is only honest if the confirm step says so before the user commits, which
 *    is why revoking is two clicks and the second one is under that sentence.
 *
 * ── WHY IT IS ITS OWN FILE AND NOT INLINE IN `SettingsView` ─────────────────────────────
 *
 * `SettingsView` renders it as a pane, because a top-level view would need `shell/routing.ts`
 * and the rail. Keeping the component here means a test imports THIS and not the whole
 * settings screen, and it means domain rules over all mail — past and future, as the default
 * — can promote it to a route by adding one branch, with no code moving.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection, useToast } from "@ohmail/ui";
import type { Folder, MutationStatus, RuleDTO } from "@ohmail/client-engine";
import { placeLabel } from "../shell/format";

/**
 * The six canonical folders a rule may file into — the same set the server's rule validation
 * enforces, in the order the rail lists them.
 *
 * Named here rather than derived from `VIEW_OF_FOLDER` because this is an OFFER, not a
 * rendering: the picker must not grow a seventh option because a future folder appeared in a
 * lookup table, when the server would answer 400 for it.
 */
export const RULE_DESTINATIONS: readonly Folder[] = [
  "INBOX",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screener",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "4 Aug 2026" — explicit, and deliberately not `toLocaleDateString`.
 *
 * The rest of the client formats dates by hand for the same reason (`selectors.ts`
 * `messageDisplayTime`): a locale-dependent string renders differently under the test
 * runner's ICU than in the browser, so an assertion about it either passes for the wrong
 * reason or is written loosely enough to assert nothing. The YEAR is always present, unlike
 * the message row's stamp — a rule is a standing decision and "2 Aug" on one made last year
 * is the same ambiguity that stamp already fixed for six-day-old mail.
 */
export function ruleDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Which row, if any, has an action open. One at a time — two open confirms is two questions. */
type OpenAction = { ruleId: string; mode: "revoke" | "retarget" } | null;

/**
 * WHAT HAPPENED, AS THE ENGINE REPORTS IT. `engine.mutate` resolves to a `MutationResult`,
 * which satisfies this structurally — the callbacks are `engine.mutate(...)` and nothing else.
 */
export type RuleOutcome = { status: MutationStatus };

export interface RulesViewProps {
  /** Newest first — `rulesList(reader)`. */
  rules: RuleDTO[];
  /** `engine.mutate({ kind: "rule_delete", ruleId })`. */
  onRevoke: (ruleId: string) => Promise<RuleOutcome>;
  /** `engine.mutate({ kind: "rule_update", ruleId, destination })`. */
  onRetarget: (ruleId: string, destination: Folder) => Promise<RuleOutcome>;
}

export function RulesView({ rules, onRevoke, onRetarget }: RulesViewProps) {
  const t = useTranslations("rules");
  const toast = useToast();
  const [open, setOpen] = useState<OpenAction>(null);

  /**
   * THE TOAST WAITS FOR THE OUTCOME, AND IT LIVES HERE RATHER THAN IN THE SHELL.
   *
   * It fired immediately in the first cut, and on a live account that printed *"Rule revoked.
   * Your mail hasn't moved."* over a `403` — the optimistic tombstone rolled back, so the rule
   * REAPPEARED underneath a message saying it was gone. That could only be caught against
   * production: `FixturesAdapter` never refuses, so every test stayed green.
   *
   * The reason it belongs in this file and not in `AppShell` is the same reason the pane takes
   * one prop instead of three — a shell that has to remember to branch on three statuses is a
   * shell that can ship two of them. Here the branch is beside the sentences it chooses
   * between, and `rules-surface.test.ts` drives all three.
   *
   * `queued` is NOT folded into success. The engine keeps a retryable failure on its offline
   * queue with the overlay standing, so the row is correctly gone from the screen — but the
   * server has not been told yet, and "revoked" is a claim about the server.
   */
  const report = (status: MutationStatus, ok: string, queued: string, failed: string): void => {
    toast(status === "rolled_back" ? failed : status === "queued" ? queued : ok);
  };

  if (rules.length === 0) {
    return (
      <SettingsSection>
        <p className="set-note-inline">{t("empty")}</p>
        <SettingsNote>{t("noCount")}</SettingsNote>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection>
      <p className="set-note-inline">{t("intro")}</p>

      {rules.map((rule) => {
        const isOpen = open?.ruleId === rule.id ? open.mode : null;
        /**
         * `kind` decides the SENTENCE, not just a label. "Everyone at lichtgrat.de" and one
         * address are different promises, and a `header` rule matches on something that is
         * not a person at all — rendering its raw expression under a "sender" heading would
         * be the surface inventing a subject for it.
         */
        const what = t(`what.${rule.kind}`, { match: rule.match });
        const origin = t(`origin.${rule.provenance}`);
        const meta = rule.enabled
          ? t("meta", { origin, date: ruleDate(rule.createdAt) })
          : t("metaPaused", { origin, date: ruleDate(rule.createdAt) });

        return (
          <div key={rule.id}>
            <SettingsRow
              label={what}
              description={meta}
              value={t("filesInto", { place: placeLabel(rule.destination) })}
              control={
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 7 }}>
                  <Button
                    variant="ghost"
                    onClick={() => setOpen(isOpen === "retarget" ? null : { ruleId: rule.id, mode: "retarget" })}
                  >
                    {t("change")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setOpen(isOpen === "revoke" ? null : { ruleId: rule.id, mode: "revoke" })}
                  >
                    {t("revoke")}
                  </Button>
                </span>
              }
            />

            {/* THE CONFIRM CARRIES THE DISCLOSURE. It is not a "are you sure?" — the user is
                already sure — it is the one moment at which "your mail does not move" can be
                read before it is true. Removing this step would make the sentence a thing the
                product says AFTER the act, which is not a disclosure. */}
            {isOpen === "revoke" ? (
              <div className="set-note-inline" style={{ display: "grid", gap: 7 }}>
                <span>{t("revokeExplain")}</span>
                <span style={{ display: "inline-flex", gap: 7 }}>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setOpen(null);
                      void onRevoke(rule.id).then((r) =>
                        report(r.status, t("toastRevoked"), t("toastRevokeQueued"), t("toastRevokeFailed")),
                      );
                    }}
                  >
                    {t("revokeConfirm")}
                  </Button>
                  <Button onClick={() => setOpen(null)}>{t("cancel")}</Button>
                </span>
              </div>
            ) : null}

            {isOpen === "retarget" ? (
              <div className="set-note-inline" style={{ display: "grid", gap: 7 }}>
                <span>{t("retargetExplain")}</span>
                <span style={{ display: "inline-flex", gap: 7, flexWrap: "wrap" }}>
                  {/* The CURRENT destination is not offered. A control that re-files mail
                      where it already goes reads as a no-op the user has to reason about,
                      and the row above already states where that is. */}
                  {RULE_DESTINATIONS.filter((f) => f !== rule.destination).map((folder) => (
                    <Button
                      key={folder}
                      onClick={() => {
                        setOpen(null);
                        void onRetarget(rule.id, folder).then((r) =>
                          report(
                            r.status,
                            t("toastRetargeted", { place: placeLabel(folder) }),
                            t("toastRetargetQueued"),
                            t("toastRetargetFailed"),
                          ),
                        );
                      }}
                    >
                      {placeLabel(folder)}
                    </Button>
                  ))}
                  <Button variant="ghost" onClick={() => setOpen(null)}>
                    {t("cancel")}
                  </Button>
                </span>
              </div>
            ) : null}
          </div>
        );
      })}

      <SettingsNote>{t("noCount")}</SettingsNote>
    </SettingsSection>
  );
}
