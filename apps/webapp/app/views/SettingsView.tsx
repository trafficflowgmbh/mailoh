"use client";

/**
 * Settings — General (language + theme, wired to the ThemeProvider),
 * Notifications (only-what-matters defaults + VIP + the learned
 * suggestion), Mailboxes (the mirror's mailbox entities) and Tags.
 *
 * ── AND A FIFTH PANE THIS FILE DELIBERATELY KNOWS NOTHING ABOUT ─────────────────────────
 *
 * `accountSection` is the same seam `AppShell`'s `resolveOwner` is, for the same reason.
 * This file is SHARED with `apps/desktop` and copied into a public GPL mirror that does not
 * contain `app/api-client` at all (`scripts/publish-desktop.mjs` DENYs it), so it cannot
 * import "erase this account from the server" — and Desktop, which is standalone and has no
 * account, must not grow an Account pane by accident. The Cloud client passes a node in
 * (`(product)/mailbox/AccountSection.tsx`); Desktop passes nothing and the pane does not
 * exist. Nothing about account deletion is written down in this file.
 */
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { Folder, RuleDTO, TagDTO } from "@ohmail/client-engine";
import {
  Button,
  SegmentedControl,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSubhead,
  Switch,
  TagDot,
  useTheme,
  useToast,
  VipChip,
  type ThemePreference,
} from "@ohmail/ui";
import { hueOf } from "../shell/format";
import { RulesView, type RuleOutcome } from "./RulesView";

type PaneId = "general" | "notifications" | "mailboxes" | "billing" | "tags" | "rules" | "security" | "account";

/**
 * The notification channels, and why this list is here rather than in the fixtures.
 *
 * It used to be `notificationSettings` from `@ohmail/fixtures`, rendered unconditionally, which
 * put two kinds of demo content on every live account's Settings screen (slice U4f). The
 * channel labels were merely MISFILED — they are ordinary product copy that a live account
 * legitimately sees, so they moved to `messages/en.json` and the ids below are their keys.
 *
 * The VIP list and the "you usually open Petra's mail within 5 minutes" suggestion were the
 * real defect: those are Mila's people, invented for the demo world, and a paying customer was
 * reading a learned pattern about someone who does not exist. They reach this view through the
 * MIRROR now ({@link NotificationsMeta}) rather than through an import.
 */
const NOTIFICATION_CHANNELS: Array<{ id: string; enabled: boolean }> = [
  { id: "people", enabled: true },
  { id: "known", enabled: true },
  { id: "reads", enabled: false },
  { id: "receipts", enabled: false },
  { id: "screener", enabled: false },
];

/**
 * The demo world's Notifications extras, as a `view_meta` row.
 *
 * `/sync` has no `view_meta` entity type (`packages/db/src/change-log.ts`), so a Cloud account
 * can never be sent one: absent ⇒ the VIP block does not render, structurally, with no boolean
 * for a view to forget. Only `FixturesAdapter` seeds it — the demo and Desktop.
 *
 * There is no VIP backend and no learning loop behind either control. In the demo that is what
 * it is — the Blanc prototype's screen, brought to life on invented mail. On a live account it
 * would be a claim, which is exactly what this row's absence prevents.
 */
export interface NotificationsMeta {
  vipLabel: string;
  vips: string[];
  learnedSuggestion: {
    text: string;
    target: string;
    acceptedToast: string;
    dismissedToast: string;
  };
}

export interface MailboxEntity {
  id: string;
  address: string;
  provider: string;
  protocol: string;
  status: string;
}

export function SettingsView({
  notifications,
  mailboxes,
  tags,
  tagCounts,
  rules,
  accountSection,
  mailboxSection,
  billingSection,
  securitySection,
}: {
  /** The demo world's VIP block, or `null` on any account — see {@link NotificationsMeta}. */
  notifications: NotificationsMeta | null;
  mailboxes: MailboxEntity[];
  tags: TagDTO[];
  tagCounts: Record<string, number>;
  /**
   * THE RULES PANE (gap O16) — ONE PROP, ALL THREE PARTS, OR NO PANE AT ALL.
   *
   * ── WHY IT IS NOT A `ReactNode` SEAM ────────────────────────────────────────────────────
   *
   * Account, Mailboxes, Subscription and Security are all injected nodes because each one
   * needs `app/api-client`, which `scripts/publish-desktop.mjs` DENYs from this shared file.
   * Rules needs nothing of the sort: `rule` is a real `/sync` entity, so the list comes from
   * the mirror via `rulesList(reader)`, and both verbs are engine mutations on the same wire
   * `tag_assign` uses. Desktop and `?demo=1` are therefore correct without a special case —
   * the FixturesAdapter serves `rule_delete` and `rule_update` out of `mutationEffects` like
   * every other verb.
   *
   * ── WHY IT IS ONE OBJECT AND NOT THREE PROPS ────────────────────────────────────────────
   *
   * Three optional props can be half-supplied: a shell that passes the list and forgets a
   * callback yields a pane whose buttons throw, which is the shape this gap is about. As one
   * object the state space is two — wired, or absent — and `undefined` means "this shell has
   * not wired rules yet", which removes the pane from the nav entirely rather than offering
   * an empty list on an account that has four. An EMPTY `items` array is the other thing
   * altogether: a real account that has decided nothing yet, and it renders as such.
   */
  rules?: {
    /** Newest first — `rulesList(reader)`. */
    items: RuleDTO[];
    /** `engine.mutate({ kind: "rule_delete", ruleId })` — the RESULT decides what is said. */
    onRevoke: (ruleId: string) => Promise<RuleOutcome>;
    onRetarget: (ruleId: string, destination: Folder) => Promise<RuleOutcome>;
  };
  /** The Cloud client's Account pane, or absent — see the header. */
  accountSection?: ReactNode;
  /**
   * The Cloud client's Mailboxes pane, REPLACING the mirror-backed list below.
   *
   * Same seam and same reason as {@link accountSection}: connecting a mailbox means
   * `POST /mailboxes`, a step-up ceremony and `app/api-client`, none of which may exist in
   * the Desktop mirror. Absent ⇒ the shared fixture list, which is the correct pane for
   * Desktop and for `?demo=1`.
   */
  mailboxSection?: ReactNode;
  /** The Cloud client's Subscription pane — plan, the AI switch, and Stripe's portal. */
  billingSection?: ReactNode;
  /**
   * The Cloud client's Security pane — recovery codes and the authenticator.
   *
   * Same seam and same reason as {@link accountSection}: every control in it is a step-up
   * ceremony against `auth`, which the Desktop mirror does not have and `?demo=1` must never
   * reach. Absent ⇒ the pane is not offered at all, rather than offered and dead.
   */
  securitySection?: ReactNode;
}) {
  const t = useTranslations("settings");
  const toast = useToast();
  const { preference, setTheme } = useTheme();
  const [pane, setPane] = useState<PaneId>("general");
  const [channels, setChannels] = useState(NOTIFICATION_CHANNELS);
  const [vips, setVips] = useState<string[] | null>(null);
  const [learned, setLearned] = useState<"open" | "accepted" | "dismissed">("open");
  /** The mirror's list until the user changes it; `null` (and absent) on a live account. */
  const vipList = vips ?? notifications?.vips ?? [];

  const panes: Array<[PaneId, string]> = [
    ["general", t("general")],
    ["notifications", t("notifications")],
    ["mailboxes", t("mailboxes")],
    // Only where there is something to bill. Desktop is free and standalone; a Subscription
    // pane there would be offering to sell what the tier already gives away.
    ...(billingSection ? [["billing", t("billing")] as [PaneId, string]] : []),
    // BEFORE Tags. A tag is something the user chose to make; a rule is something the
    // product made on their behalf while they were deciding about a sender, and that is the
    // one that has to be findable. Present only where the shell wired it — a nav entry
    // leading to an empty list on an account that HAS rules is the defect, not the fix.
    ...(rules ? [["rules", t("rules")] as [PaneId, string]] : []),
    ["tags", t("tags")],
    // LAST, and only where there is an account to act on. Last because the pane's only
    // content is irreversible, and a destructive control at the top of a list is one
    // mis-click away from the thing above it.
    ...(securitySection ? [["security", t("security")] as [PaneId, string]] : []),
    ...(accountSection ? [["account", t("account")] as [PaneId, string]] : []),
  ];

  return (
    <section className="view col view-settings">
      <div className="vhead">
        <h1>{t("title")}</h1>
      </div>
      <div className="scroller">
        <div className="set-layout">
          <nav className="set-nav" aria-label={t("navAria")}>
            {panes.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={pane === id ? "on" : undefined}
                onClick={() => setPane(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          {pane === "general" ? (
            <SettingsSection>
              <SettingsRow
                label={t("language")}
                description={t("languageHint")}
                value={t("languageValue")}
              />
              <SettingsRow
                label={t("theme")}
                description={t("themeHint")}
                control={
                  <SegmentedControl<ThemePreference>
                    ariaLabel={t("themeAria")}
                    value={preference}
                    onChange={setTheme}
                    className="theme-seg"
                    options={[
                      { id: "light", label: t("themeLight") },
                      { id: "system", label: t("themeSystem") },
                      { id: "dark", label: t("themeDark") },
                    ]}
                  />
                }
              />
            </SettingsSection>
          ) : null}

          {pane === "notifications" ? (
            <SettingsSection>
              {channels.map((c, i) => (
                <SettingsRow
                  key={c.id}
                  label={t(`channel.${c.id}.label`)}
                  description={t(`channel.${c.id}.description`)}
                  control={
                    <Switch
                      checked={c.enabled}
                      ariaLabel={t(`channel.${c.id}.label`)}
                      onChange={(v) =>
                        setChannels((cur) =>
                          cur.map((x, xi) => (xi === i ? { ...x, enabled: v } : x)),
                        )
                      }
                    />
                  }
                />
              ))}
              {/* THE DEMO'S VIP BLOCK (U4f). Present only where the mirror carries the row,
                  which `/sync` can never do — see `NotificationsMeta`. */}
              {notifications ? (
                <>
                  <SettingsSubhead>{notifications.vipLabel}</SettingsSubhead>
                  <div className="viplist">
                    {vipList.map((v) => (
                      <VipChip
                        key={v}
                        pulse={learned === "accepted" && v === notifications.learnedSuggestion.target}
                      >
                        {v}
                      </VipChip>
                    ))}
                  </div>
                  {learned === "open" ? (
                    <div className="learned">
                      <p>{notifications.learnedSuggestion.text}</p>
                      <div style={{ display: "flex", gap: 7 }}>
                        <Button
                          variant="primary"
                          onClick={() => {
                            setLearned("accepted");
                            const target = notifications.learnedSuggestion.target;
                            setVips(vipList.includes(target) ? vipList : [...vipList, target]);
                            toast(notifications.learnedSuggestion.acceptedToast);
                          }}
                        >
                          {t("learnedYes")}
                        </Button>
                        <Button
                          onClick={() => {
                            setLearned("dismissed");
                            toast(notifications.learnedSuggestion.dismissedToast);
                          }}
                        >
                          {t("learnedNo")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
              <SettingsNote>{t("notificationPrivacy")}</SettingsNote>
            </SettingsSection>
          ) : null}

          {/* MAILBOXES. The Cloud client REPLACES this pane wholesale (`mailboxSection`),
              because the list below cannot be right for it: these are the MIRROR's mailbox
              entities, and `"mailbox"` is not an `EntityType` in the change log
              (`packages/db/src/change-log.ts`), so `/sync` never emits one. Only the
              FixturesAdapter seeds them — which is exactly right for Desktop and for the
              demo, and always empty for a real account. See
              `(product)/mailbox/MailboxSection.tsx`. */}
          {pane === "mailboxes" ? (
            mailboxSection ?? (
              <SettingsSection>
                {mailboxes.map((m) => (
                  <SettingsRow
                    key={m.id}
                    label={m.address}
                    description={`${m.provider} · ${m.protocol}`}
                    value={t("mailboxStatus")}
                  />
                ))}
                <p className="set-note-inline">{t("mailboxNote")}</p>
              </SettingsSection>
            )
          ) : null}

          {pane === "billing" ? billingSection : null}

          {pane === "rules" && rules ? (
            <RulesView rules={rules.items} onRevoke={rules.onRevoke} onRetarget={rules.onRetarget} />
          ) : null}

          {pane === "tags" ? (
            <SettingsSection>
              {tags.map((tag) => (
                <SettingsRow
                  key={tag.id}
                  leading={<TagDot hue={hueOf(tag)} />}
                  label={tag.name}
                  description={t("tagMessages", { count: tagCounts[tag.id] ?? 0 })}
                  control={
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 7 }}>
                      <Button variant="ghost" onClick={() => toast(t("toastTagEditing"))}>
                        {t("tagRename")}
                      </Button>
                      <Button variant="ghost" onClick={() => toast(t("toastTagEditing"))}>
                        {t("tagDelete")}
                      </Button>
                    </span>
                  }
                />
              ))}
              <p className="set-note-inline">{t("tagNote")}</p>
            </SettingsSection>
          ) : null}

          {pane === "security" ? securitySection : null}
          {pane === "account" ? accountSection : null}
        </div>
      </div>
    </section>
  );
}
