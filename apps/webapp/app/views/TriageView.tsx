"use client";

/**
 * Triage — the three piles as stacked sheets over the engine's
 * triagePiles selector, plus the Reply Run entry point. Completing
 * a message in a Reply Run clears its reply_later state through the
 * engine, so pile counts stay live everywhere.
 */
import { useTranslations } from "next-intl";
import type { TriagePiles } from "@ohmail/client-engine";
import { Button, PilesStack } from "@ohmail/ui";
import { resurfaceLabel } from "../shell/format";
import { useKeyBindings } from "../shell/keymap";

export function TriageView({
  piles,
  frDone,
  onStartFR,
}: {
  piles: TriagePiles;
  /** Message ids / titles completed in the Reply Run this session. */
  frDone: Set<string>;
  onStartFR: () => void;
}) {
  const t = useTranslations("triage");
  const total =
    piles.replyLater.length + piles.setAside.length + piles.resurface.length;

  // `f` starts the Reply Run from here without the shell's "go to Triage first" hop.
  useKeyBindings([
    {
      chord: "f",
      group: "message",
      label: t("keyReplyRun"),
      disabled: piles.replyLater.length === 0,
      run: onStartFR,
    },
  ]);

  return (
    <section className="view col view-triage">
      <div className="vhead">
        <h1>{t("title")}</h1>
        <span className="meta num">{t("meta", { count: total })}</span>
      </div>
      <div className="scroller">
        <PilesStack
          piles={[
            {
              id: "reply",
              icon: "clock",
              title: t("replyLater"),
              count: piles.replyLater.length,
              items: piles.replyLater.map((item) => ({
                title: item.title,
                subtitle: item.subtitle,
                done: frDone.has(item.messageId ?? item.title),
              })),
              hint: t("hintReply"),
            },
            {
              id: "aside",
              icon: "pause",
              title: t("setAside"),
              count: piles.setAside.length,
              items: piles.setAside.map((item) => ({
                title: item.title,
                subtitle: item.subtitle,
              })),
              hint: t("hintAside"),
            },
            {
              id: "resurface",
              icon: "up",
              title: t("resurface"),
              count: piles.resurface.length,
              items: piles.resurface.map((item) => ({
                title: item.title,
                subtitle: item.subtitle,
                when: item.resurfaceAt ? resurfaceLabel(item.resurfaceAt) : undefined,
              })),
              hint: t("hintResurface"),
            },
          ]}
        />
        <div className="triage-cta">
          <Button variant="primary" icon="spark" kbdHint="f" onClick={onStartFR}>
            {t("cta")}
          </Button>
          <span>{t("ctaNote")}</span>
        </div>
      </div>
    </section>
  );
}
