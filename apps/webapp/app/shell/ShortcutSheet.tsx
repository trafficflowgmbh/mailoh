"use client";

/**
 * The `?` sheet (slice U2) — every binding that is live right now, and nothing else.
 *
 * It renders `groupedBindings(useKeymap().bindings)` and holds no list of its own. That is
 * the property worth protecting: the previous "documentation" was a sentence in the (i)
 * panel that somebody typed once, and by the time this was written it named keys that had
 * moved and omitted the ones that had arrived. A sheet built from the dispatcher's own
 * table cannot do either. `keymap.test.ts` mutates the generation to watch it fail.
 *
 * A peek, not a mode: ANY key dismisses it and then does its normal job, so `?` `j` reads
 * the map and moves the cursor in two keystrokes.
 */
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Icon, Kbd } from "@ohmail/ui";
import { chordKeys, groupedBindings, useKeymap, type BindingGroup } from "./keymap";

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("shortcuts");
  const { bindings } = useKeymap();

  useEffect(() => {
    if (!open) return;
    // Any keypress dismisses. The registry's own listener still runs the binding for that
    // key — the sheet is in the way of nothing.
    const onKey = () => onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const groups = groupedBindings(bindings);
  const groupLabel = (g: BindingGroup) => t(`group.${g}` as "group.navigate");

  return (
    <>
      <div className="ks-bg" onClick={onClose} />
      <div className="ks" role="dialog" aria-modal="true" aria-label={t("title")}>
        <div className="ks-head">
          <h3>
            <Icon name="open" /> {t("title")}
          </h3>
          <button type="button" className="x" aria-label={t("close")} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ks-cols">
          {groups.map((g) => (
            <section key={g.group}>
              <h4>{groupLabel(g.group)}</h4>
              <ul>
                {g.items.map((b) => (
                  <li key={b.chord} className={b.disabled ? "off" : undefined}>
                    <span className="ks-keys">
                      {chordKeys(b.chord).map((k, i) => (
                        <Kbd key={`${k}-${i}`}>{k}</Kbd>
                      ))}
                    </span>
                    <span className="ks-lab">{b.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="ks-foot">{t("foot")}</p>
      </div>
    </>
  );
}
