/**
 * SETTINGS → THIS INSTALL → what reaches your Ohbox, in your words.
 *
 * The bar the screening question is asked against. On a standalone install the model doing that
 * judging is one you supplied yourself, which makes this the one sentence in the app that changes
 * what your own model is told — and until now it was the one thing about screening a standalone
 * install could read and not write.
 *
 * ── IT IS THE SAME EDITOR THE HOSTED CLIENT DRAWS ───────────────────────────────────────────
 *
 * {@link OhboxWords} is the shared control, from the shared shell, exactly as every mail surface in
 * this window is. Only the transport is supplied here: the hosted client hands it its API client,
 * this hands it `local-screening.ts`, which addresses the engine on this machine over the shell's
 * pipe. Two editors over one column is how a prefill rule drifts on one tier and not the other.
 *
 * ── NO MODEL NEEDED TO WRITE IT ─────────────────────────────────────────────────────────────
 *
 * This section is NOT gated on the pane below it. Somebody who has not set up a model — which is a
 * complete, supported way to run this app — can still say what belongs in their Ohbox, and the
 * words are there waiting the day they do. Gating it would make the sentence look like a feature of
 * the model rather than a property of the mailbox.
 *
 * ── AND NOT ON THE HOSTED DOOR ──────────────────────────────────────────────────────────────
 *
 * An install pointed at a hosted account keeps its preference on that account, where the sync
 * worker that files its mail reads it. Its engine forwards this route rather than serving it, and
 * the account already has this control in the client it signs into — so the section is withheld
 * here rather than drawn twice over one value.
 */

import { useEffect, useState } from "react";
import { SettingsNote, SettingsSubhead } from "@ohmail/ui";

import { OhboxWords } from "../../webapp/app/shell/OhboxWords";
import { readScreening, saveOhboxBar, type ScreeningPreference } from "./local-screening.js";

export function DesktopScreeningWords({
  /** Which door this install came in by. The section is offered on the standalone door only. */
  door,
}: {
  door: "local" | "cloud" | null;
}) {
  const [pref, setPref] = useState<ScreeningPreference | null>(null);

  useEffect(() => {
    if (door !== "local") return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await readScreening();
        if (!cancelled) setPref(loaded);
      } catch {
        /* Leave the section undrawn rather than showing a broken box. The engine is either not
           serving yet or answered a refusal it has already logged; either way there is no editable
           value here, and an empty textarea over a mailbox that HAS words is the worse failure. */
        if (!cancelled) setPref(null);
      }
    })();
    return () => { cancelled = true; };
  }, [door]);

  if (door !== "local" || !pref) return null;

  return (
    <>
      <SettingsSubhead>What reaches your Ohbox</SettingsSubhead>
      {/* PRECISE ABOUT WHERE THE WORDS LAND, because on this tier they land in one place and not
          in the other. The Screener's suggestion path reads them at the moment somebody asks for a
          suggestion, so a sentence written here changes what the model is asked the very next time
          that button is pressed. The mail engine's own filing loop does NOT hand them to its
          classifier — a broader promise ("this changes how your mail is filed") would be false for
          exactly as long as that remains so, and copy that outlives the code is the defect. */}
      <SettingsNote>
        Used when you ask the model about the senders waiting in your Screener: it judges them
        against your sentence rather than ours. With no model set up the words simply wait — your
        mail is filed by rules either way, and nothing is sent anywhere until you choose one below.
      </SettingsNote>
      <OhboxWords
        bar={pref.ohboxBar}
        defaultBar={pref.defaultBar}
        onSave={async (next) => {
          const landed = await saveOhboxBar(next);
          setPref(landed);
          return landed.ohboxBar;
        }}
      />
    </>
  );
}
