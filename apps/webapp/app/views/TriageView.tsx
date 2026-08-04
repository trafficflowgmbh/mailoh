"use client";

/**
 * Triage — the three piles as stacked sheets over the engine's
 * triagePiles selector, plus the Reply Run entry point. Completing
 * a message in a Reply Run clears its reply_later state through the
 * engine, so pile counts stay live everywhere.
 */
import { useTranslations } from "next-intl";
import type { TriagePiles } from "@ohmail/client-engine";
import { Button, PilesStack, SegmentedControl } from "@ohmail/ui";
import { resurfaceLabel } from "../shell/format";
import { useKeyBindings } from "../shell/keymap";
import { TRIAGE_PILES, type TriagePileId } from "../shell/routing";

/**
 * ONE HORIZON AT A TIME, SELECTED BY THE ROUTE.
 *
 * Reported as: the triage horizons cannot be selected individually, only Answer Later opens,
 * on all three. This view rendered all three stacks unconditionally as equal peers, and the
 * three rail rows all navigated to the same pile-less `#/triage`, so there was nothing for it
 * to select — see `routing.ts` for the half of the defect that was in the URL.
 *
 * The control is a `SegmentedControl` and not three tabs, for the reason the action bar gives
 * about the same three verbs: Answer Later, Park and Resurface are ONE idea at three horizons,
 * so they read as one control with three positions rather than three siblings. The counts are
 * in the segment labels because "which of these has anything in it" is the question somebody
 * is asking when they look at this screen.
 */
type T = ReturnType<typeof useTranslations<"triage">>;

/** The pile's own name, for the segment label. */
const PILE_KEY: Record<TriagePileId, "replyLater" | "setAside" | "resurface"> = {
  reply: "replyLater",
  aside: "setAside",
  resurface: "resurface",
};

const PILE_COUNT: Record<TriagePileId, (p: TriagePiles) => number> = {
  reply: (p) => p.replyLater.length,
  aside: (p) => p.setAside.length,
  resurface: (p) => p.resurface.length,
};

/**
 * The one open pile, as `PilesStack` wants it. A table rather than a switch so the segment
 * list, the counts and the rendered stack are three reads of the SAME three-member union —
 * adding a horizon would fail to compile in all three places at once rather than in one.
 */
const PILE_OF: Record<
  TriagePileId,
  (p: TriagePiles, t: T, frDone: Set<string>) => Parameters<typeof PilesStack>[0]["piles"][number]
> = {
  reply: (p, t, frDone) => ({
    id: "reply",
    icon: "clock",
    title: t("replyLater"),
    count: p.replyLater.length,
    items: p.replyLater.map((item) => ({
      title: item.title,
      subtitle: item.subtitle,
      done: frDone.has(item.messageId ?? item.title),
    })),
    hint: t("hintReply"),
  }),
  aside: (p, t) => ({
    id: "aside",
    icon: "pause",
    title: t("setAside"),
    count: p.setAside.length,
    items: p.setAside.map((item) => ({ title: item.title, subtitle: item.subtitle })),
    hint: t("hintAside"),
  }),
  resurface: (p, t) => ({
    id: "resurface",
    icon: "up",
    title: t("resurface"),
    count: p.resurface.length,
    items: p.resurface.map((item) => ({
      title: item.title,
      subtitle: item.subtitle,
      when: item.resurfaceAt ? resurfaceLabel(item.resurfaceAt) : undefined,
    })),
    hint: t("hintResurface"),
  }),
};

export function TriageView({
  piles,
  pile,
  onPile,
  frDone,
  onStartFR,
}: {
  piles: TriagePiles;
  /** Which horizon is open — `route.triagePile`. */
  pile: TriagePileId;
  onPile: (next: TriagePileId) => void;
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
        <SegmentedControl<TriagePileId>
          ariaLabel={t("pilesAria")}
          value={pile}
          onChange={onPile}
          className="triage-seg"
          options={TRIAGE_PILES.map((id) => ({
            id,
            label: t("segLabel", { name: t(PILE_KEY[id]), count: PILE_COUNT[id](piles) }),
          }))}
        />
        {/* ONE pile. `PilesStack` takes a list and this hands it a list of one — no change in
            `packages/ui`, which is shared with the desktop shell and has no business knowing
            that this host routes by pile. */}
        <PilesStack piles={[PILE_OF[pile](piles, t, frDone)]} />
        {/* THE REPLY RUN BELONGS TO ONE PILE, SO IT IS ON ONE PANE.
            It was under all three, saying "Steps through the Answer Later pile, one message
            per screen" while Parked was on screen — a primary action that operates on a
            different pile than the one being looked at reads as misplacement, and it is: the
            run's items are `piles.replyLater` whichever pane you start it from. Scoped rather
            than re-worded, because no wording makes a button that acts elsewhere belong here. */}
        {pile === "reply" ? (
          <div className="triage-cta">
            <Button variant="primary" icon="spark" kbdHint="f" onClick={onStartFR}>
              {t("cta")}
            </Button>
            <span>{t("ctaNote")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
