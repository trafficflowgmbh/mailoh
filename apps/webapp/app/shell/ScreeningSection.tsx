"use client";

/**
 * "WHAT DESERVES MY OHBOX" — the editable screening preference, injected into the general pane.
 *
 * Two controls over one account setting (`GET/PATCH /account/screening`):
 *
 *  · a POSTURE switch. ON = keep the Ohbox for what is relevant (real people, plus the service
 *    mail you act on) and file obvious bulk — newsletters, promotions — to Reads/Receipts. OFF =
 *    everything from a sender you have written to reaches the Ohbox (today's behaviour, and the
 *    default). It is framed around RELEVANCE, never "only real people", because the mechanism keeps
 *    relevant service mail — a receipt goes to Receipts, an alert can stay in the Ohbox.
 *  · a free-text BAR, in your own words, that reaches the AI's judgement of the ambiguous
 *    middle. When the account has never set one, the box is PREFILLED with the product default as
 *    editable text — you tweak the words you can see, rather than staring at a greyed placeholder
 *    and guessing what a blank box will do. "Save" stays inert until the text differs from the
 *    effective value (the stored bar, or the default when there is none), so an untouched prefill
 *    writes nothing; clearing the box entirely saves NULL, which reverts to that same default.
 *
 * ── IT RE-FILES FUTURE MAIL, AND SAYS SO ────────────────────────────────────────────────────
 *
 * The honest microcopy: changing the posture changes how the NEXT messages are filed; it does not
 * reach back into mail already in the Ohbox. (A one-click "tidy my Ohbox now" backlog pass is a
 * separate, later control — until it ships, the setting must not imply it moves the past.)
 *
 * ── THE SWITCH SHOWS THE STORED VALUE ───────────────────────────────────────────────────────
 *
 * Like `AutoSuggestRow`, it renders what the server answered, not the hoped-for value: the write
 * is confirmed by re-reading the response. A failed write leaves the control where it was and shows
 * one plain sentence — there is no gate in front of this route to carry a more useful reason.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSubhead, Switch } from "@ohmail/ui";
import { screeningSettings, type ScreeningPreferenceWire } from "../api-client";

type Loaded = { pref: ScreeningPreferenceWire; draft: string };

export function ScreeningSection() {
  const t = useTranslations("settings");
  const [state, setState] = useState<Loaded | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const pref = await screeningSettings.get();
        if (alive.current) setState({ pref, draft: pref.ohboxBar ?? pref.defaultBar });
      } catch {
        // Leave the section unrendered on a read fault rather than showing a broken control.
        if (alive.current) setState(null);
      }
    })();
    return () => { alive.current = false; };
  }, []);

  if (!state) return null;
  const { pref, draft } = state;
  const relevanceOn = pref.ohboxPolicy === "people_only";

  const apply = (next: Partial<{ ohboxPolicy: ScreeningPreferenceWire["ohboxPolicy"]; ohboxBar: string | null }>) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    setSaved(false);
    void (async () => {
      try {
        const pref = await screeningSettings.set(next);
        if (!alive.current) return;
        setState({ pref, draft: pref.ohboxBar ?? pref.defaultBar });
        setSaved(true);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  // The baseline is the EFFECTIVE bar — the stored words, or the default the box was prefilled
  // with when there are none. So an untouched prefill reads as unchanged and "Save" stays inert.
  const barChanged = draft.trim() !== (pref.ohboxBar ?? pref.defaultBar).trim();

  return (
    <>
      <SettingsSubhead>{t("screening.title")}</SettingsSubhead>

      <SettingsRow
        label={t("screening.postureTitle")}
        description={relevanceOn ? t("screening.postureOn") : t("screening.postureOff")}
        control={
          <Switch
            checked={relevanceOn}
            disabled={pending}
            ariaLabel={t("screening.postureTitle")}
            onChange={(next) => apply({ ohboxPolicy: next ? "people_only" : "people_and_replied" })}
          />
        }
      />

      <div className="set-screening-bar">
        <label className="set-note-inline" htmlFor="ohbox-bar">{t("screening.barLabel")}</label>
        <textarea
          id="ohbox-bar"
          className="set-screening-textarea"
          rows={4}
          value={draft}
          placeholder={pref.defaultBar}
          disabled={pending}
          onChange={(e) => setState({ pref, draft: e.target.value })}
        />
        <div className="gate-actions">
          <Button
            variant="primary"
            disabled={pending || !barChanged}
            onClick={() => apply({ ohboxBar: draft.trim() ? draft.trim() : null })}
          >
            {t("screening.save")}
          </Button>
          {draft.trim() && (pref.ohboxBar ?? "") !== "" ? (
            <Button
              disabled={pending}
              onClick={() => { setState({ pref, draft: pref.defaultBar }); apply({ ohboxBar: null }); }}
            >
              {t("screening.reset")}
            </Button>
          ) : null}
        </div>
        <p className="set-note-inline">{t("screening.microcopy")}</p>
        {saved ? <span className="scn-sg-note">{t("screening.saved")}</span> : null}
        {failed ? <span className="scn-sg-note">{t("screening.failed")}</span> : null}
      </div>
    </>
  );
}
