"use client";

/**
 * MAKE A TAG FROM THE SIDEBAR.
 *
 * Reported as: the sidebar should let you add tags. It could not — the only way to mint one
 * was `TagPicker`'s "Create …" row, which requires a message to put it on, so building a
 * taxonomy meant finding a message for each name you wanted. There was no standalone verb at
 * all until `tag_create`.
 *
 * ── WHY A SMALL DIALOG RATHER THAN AN INPUT IN THE RAIL ──────────────────────────────────
 *
 * The rail's Tags group is rendered by `RailNav` in `packages/ui`, which is shared with the
 * desktop shell and exposes no slot inside that group — its only `ReactNode` seams are the
 * wordmark and the footer, at the two ends of the rail. Growing one would be a design-system
 * change made to serve one host, which is the shape `RailNav`'s own header argues against for
 * the collapse state. So the rail carries the AFFORDANCE (a row, intercepted by id — see
 * `AppShell`) and the shell owns the input.
 *
 * It is a centred card and not an anchored popover deliberately: the same control has to work
 * from the docked rail at 1440 and from the drawer at 390, where the anchor row is inside an
 * overlay that is about to close.
 *
 * ── THE DUPLICATE CHECK IS THE PICKER'S, FOR THE PICKER'S REASON ─────────────────────────
 *
 * Case-insensitive against the whole set, because the server's unique index is on
 * `lower(name)`: offering to create "Invoices" while "invoices" exists promises a tag the
 * server answers 409 for. Here it is stated as a message rather than by hiding the button —
 * the user typed a name and is owed the reason it cannot be used.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { TagDTO } from "@ohmail/client-engine";
import { Button } from "@ohmail/ui";

/** The rail row that opens this. Intercepted by id in `onNavigateTag`; never a real tag. */
export const TAG_CREATE_ROW_ID = "__ohmail_new_tag";

export function TagCreate({
  tags,
  onCreate,
  onClose,
}: {
  tags: TagDTO[];
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("tag");
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const typed = name.trim();
  const taken = typed.length > 0 && tags.some((tag) => tag.name.toLowerCase() === typed.toLowerCase());
  const canCreate = typed.length > 0 && !taken;

  const create = () => {
    if (!canCreate) return;
    onCreate(typed);
  };

  return (
    <>
      <div className="tagn-bg" onClick={onClose} />
      <div className="tagn" role="dialog" aria-modal="true" aria-label={t("newAria")}>
        <h3>{t("newTitle")}</h3>
        <input
          ref={inputRef}
          className="join-input"
          value={name}
          placeholder={t("newPlaceholder")}
          aria-label={t("newAria")}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); create(); }
            // Escape is handled here and stopped, so the shell's ladder does not also act on
            // it — this input is the innermost thing open.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
          }}
        />
        {taken ? <p className="tagn-warn" role="alert">{t("newTaken", { name: typed })}</p> : null}
        <div className="tagn-acts">
          <Button variant="primary" disabled={!canCreate} onClick={create}>{t("newCreate")}</Button>
          <Button variant="ghost" onClick={onClose}>{t("newCancel")}</Button>
        </div>
        {/* Said here as well as in Settings, because this is the moment somebody decides to
            start keeping tags. `tag.notOnServer` verbatim — one wording, three surfaces. */}
        <p className="tagn-note">{t("notOnServer")}</p>
      </div>
    </>
  );
}
