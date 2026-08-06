"use client";

/**
 * THE DORMANCY DIAL — how long a sender may go quiet before the Screener stops asking about them.
 *
 * A sender the account has never decided about, with no unread mail and nothing inside this window,
 * waits in History instead of the Screener queue. Moving the dial only changes what the Screener
 * SHOWS: it never moves a message, never hides unread mail (unread always wins), and never touches a
 * decided or placed sender. So there is nothing to undo and nothing to confirm — it is a plain
 * settings write, unlike {@link AutoSuggestRow}, which spends money.
 *
 * ── PRESETS, NOT A FREE FIELD ────────────────────────────────────────────────────────────────
 *
 * The window is bounded 1–365 by the column's CHECK, and a free integer field invites both ends of
 * that band — a 0 that empties the queue, a 2e8 that crashes the `GET /consent` read. Five presets
 * cover the choices anybody actually means (a month to a year) and cannot express an illegal one.
 * "60 days" is the product default; picking it stores NULL server-side, so the account tracks the
 * default rather than freezing at a snapshot of it — see `setDormancyDays`.
 *
 * ── IT WRITES THROUGH THE HOOK, AND SHOWS THE STORED VALUE ───────────────────────────────────
 *
 * `setDormancyDays` is `useConsentState().setDormancyDays`, not `consentApi` directly, for the
 * reason `AutoSuggestRow` names: the partition memo in `AppShell` is keyed on `consent.dormancyDays`,
 * so the hook setting it from the server echo re-partitions the same render. The control renders the
 * window the server last answered with — `days` is that echo — never the optimistic pick, so a
 * refused write leaves it where it was.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";

/** The choices the dial offers, in days. 60 is the product default (`DEFAULT_DORMANCY_DAYS`). */
const PRESETS = [30, 60, 90, 180, 365] as const;

export function DormancyRow({
  days,
  setDormancyDays,
}: {
  /** The EFFECTIVE window as the server answered it — always a number. */
  days: number;
  /**
   * `useConsentState().setDormancyDays` — and it must be THAT one, not `consentApi`, or the open
   * tab keeps partitioning with the stale window. Resolves to the effective window it stored.
   */
  setDormancyDays: (days: number | null) => Promise<number>;
}) {
  const t = useTranslations("settings");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const choose = (next: number) => {
    if (pending || next === days) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        // The preset value itself — `setDormancyDays` coerces the default to a NULL store, so the
        // component never has to know which number is the default.
        await setDormancyDays(next);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  return (
    <>
      <SettingsRow
        label={t("dormancy.title")}
        description={t("dormancy.description")}
        control={
          <SegmentedControl<string>
            ariaLabel={t("dormancy.ariaLabel")}
            value={String(days)}
            onChange={(id) => choose(Number(id))}
            className="dormancy-seg"
            options={PRESETS.map((d) => ({ id: String(d), label: t("dormancy.dayLabel", { days: d }) }))}
          />
        }
      />
      <p className="set-note-inline">{t("dormancy.microcopy")}</p>
      {failed ? <span className="scn-sg-note">{t("dormancy.failed")}</span> : null}
    </>
  );
}
