"use client";

/**
 * "IN YOUR WORDS, WHAT BELONGS IN YOUR OHBOX" — the bar editor, once, for both tiers.
 *
 * The account's own sentence about what deserves the Ohbox. It is not decoration: it travels in the
 * USER turn of the screening question the classifier is asked about a first-contact sender, where
 * it is binding criteria rather than one input among several — asserted on the wire, under both of
 * the model providers a standalone install can use, by the mail engine's own end-to-end checks.
 *
 * ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────────────────────
 *
 * Two surfaces edit the same column and must not become two editors. The hosted client reaches
 * `PATCH /account/screening` over `app/api-client`; a standalone desktop install reaches the SAME
 * route on the engine running on its own machine, over the shell's pipe. Those two transports have
 * nothing in common and the control has everything in common — the prefill rule, the inert Save,
 * what "clear the box" means — so the transport is a prop (`onSave`) and the rest lives here.
 *
 * That is also what keeps this file compilable in a browser tab AND in the desktop bundle: it names
 * no client, no bridge and no route. It takes a value and a function.
 *
 * ── THE PREFILL RULE, WHICH IS THE WHOLE DESIGN ─────────────────────────────────────────────
 *
 * When the account has never set a bar, the box is PREFILLED with the product default as editable
 * text rather than showing it greyed as a placeholder — you tweak words you can see instead of
 * staring at an empty box and guessing what saving it would do. "Save" therefore stays inert until
 * the text differs from the EFFECTIVE value (the stored bar, or the default when there is none), so
 * an untouched prefill writes nothing. Clearing the box entirely saves `null`, which is the
 * instruction "go back to the default" and not the instruction "screen against an empty sentence".
 *
 * ── IT SHOWS WHAT THE SERVER CONFIRMED ──────────────────────────────────────────────────────
 *
 * `onSave` answers with the bar that was actually stored, and that answer — not the hoped-for
 * value — is what re-seeds the box. A failed write leaves the words where they were and shows one
 * plain sentence; there is no gate in front of this route with a more useful reason to offer.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

export function OhboxWords({
  /** The stored bar, or `null` while this account has never set one. */
  bar,
  /** The product default. The prefill when there is no stored bar, and the placeholder always. */
  defaultBar,
  /**
   * Write it. `null` means "revert to the default". Resolves with the bar the server confirmed
   * (`null` when it reverted); REJECTS to show the failure line — the reason is never invented here.
   */
  onSave,
  /** A sibling control on the same surface is mid-write. Disables this one; not a state of its own. */
  busy = false,
}: {
  bar: string | null;
  defaultBar: string;
  onSave: (next: string | null) => Promise<string | null>;
  busy?: boolean;
}) {
  const t = useTranslations("settings");
  /* Seeded once, then owned here and re-seeded only from what a write CONFIRMED. A `useEffect` on
     the prop would fight the person typing: the parent re-renders for reasons that have nothing to
     do with this box, and each one would throw the draft away. */
  const [stored, setStored] = useState<string | null>(bar);
  const [draft, setDraft] = useState<string>(bar ?? defaultBar);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<"none" | "saved" | "failed">("none");

  const effective = stored ?? defaultBar;
  const changed = draft.trim() !== effective.trim();
  const disabled = pending || busy;

  const save = (next: string | null): void => {
    if (disabled) return;
    setPending(true);
    setNote("none");
    void (async () => {
      try {
        const landed = await onSave(next);
        setStored(landed);
        setDraft(landed ?? defaultBar);
        setNote("saved");
      } catch {
        setNote("failed");
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <div className="set-screening-bar">
      <label className="set-note-inline" htmlFor="ohbox-bar">{t("screening.barLabel")}</label>
      <textarea
        id="ohbox-bar"
        className="set-screening-textarea"
        rows={4}
        value={draft}
        placeholder={defaultBar}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="gate-actions">
        <Button
          variant="primary"
          disabled={disabled || !changed}
          onClick={() => save(draft.trim() ? draft.trim() : null)}
        >
          {t("screening.save")}
        </Button>
        {/* Offered only when there is something to revert FROM — an account still on the default
            has nothing this button would change, and a control that does nothing is worse than
            no control. */}
        {stored !== null ? (
          <Button disabled={disabled} onClick={() => save(null)}>
            {t("screening.reset")}
          </Button>
        ) : null}
      </div>
      <p className="set-note-inline">{t("screening.microcopy")}</p>
      {note === "saved" ? <span className="scn-sg-note">{t("screening.saved")}</span> : null}
      {note === "failed" ? <span className="scn-sg-note">{t("screening.failed")}</span> : null}
    </div>
  );
}
