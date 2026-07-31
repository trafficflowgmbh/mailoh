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
import { notificationSettings } from "@ohmail/fixtures";
import type { TagDTO } from "@ohmail/client-engine";
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

type PaneId = "general" | "notifications" | "mailboxes" | "tags" | "account";

export interface MailboxEntity {
  id: string;
  address: string;
  provider: string;
  protocol: string;
  status: string;
}

export function SettingsView({
  mailboxes,
  tags,
  tagCounts,
  accountSection,
}: {
  mailboxes: MailboxEntity[];
  tags: TagDTO[];
  tagCounts: Record<string, number>;
  /** The Cloud client's Account pane, or absent — see the header. */
  accountSection?: ReactNode;
}) {
  const t = useTranslations("settings");
  const toast = useToast();
  const { preference, setTheme } = useTheme();
  const [pane, setPane] = useState<PaneId>("general");
  const [channels, setChannels] = useState(notificationSettings.channels);
  const [vips, setVips] = useState(notificationSettings.vips);
  const [learned, setLearned] = useState<"open" | "accepted" | "dismissed">("open");

  const panes: Array<[PaneId, string]> = [
    ["general", t("general")],
    ["notifications", t("notifications")],
    ["mailboxes", t("mailboxes")],
    ["tags", t("tags")],
    // LAST, and only where there is an account to act on. Last because the pane's only
    // content is irreversible, and a destructive control at the top of a list is one
    // mis-click away from the thing above it.
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
                  label={c.label}
                  description={c.description}
                  control={
                    <Switch
                      checked={c.enabled}
                      ariaLabel={c.label}
                      onChange={(v) =>
                        setChannels((cur) =>
                          cur.map((x, xi) => (xi === i ? { ...x, enabled: v } : x)),
                        )
                      }
                    />
                  }
                />
              ))}
              <SettingsSubhead>{notificationSettings.vipLabel}</SettingsSubhead>
              <div className="viplist">
                {vips.map((v) => (
                  <VipChip
                    key={v}
                    pulse={
                      learned === "accepted" &&
                      v === notificationSettings.learnedSuggestion.target
                    }
                  >
                    {v}
                  </VipChip>
                ))}
              </div>
              {learned === "open" ? (
                <div className="learned">
                  <p>{notificationSettings.learnedSuggestion.text}</p>
                  <div style={{ display: "flex", gap: 7 }}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        setLearned("accepted");
                        const target = notificationSettings.learnedSuggestion.target;
                        setVips((cur) => (cur.includes(target) ? cur : [...cur, target]));
                        toast(notificationSettings.learnedSuggestion.acceptedToast);
                      }}
                    >
                      {t("learnedYes")}
                    </Button>
                    <Button
                      onClick={() => {
                        setLearned("dismissed");
                        toast(notificationSettings.learnedSuggestion.dismissedToast);
                      }}
                    >
                      {t("learnedNo")}
                    </Button>
                  </div>
                </div>
              ) : null}
              <SettingsNote>{notificationSettings.privacyNote}</SettingsNote>
            </SettingsSection>
          ) : null}

          {pane === "mailboxes" ? (
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

          {pane === "account" ? accountSection : null}
        </div>
      </div>
    </section>
  );
}
