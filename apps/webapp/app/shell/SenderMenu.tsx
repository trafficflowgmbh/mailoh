"use client";

/**
 * The sender's screening, as a popover you can reach from any list or any open message
 * (slice U3). Anchored like the tag picker; Escape and an outside click dismiss.
 *
 * It states the consequence BEFORE the click, and the two consequences are genuinely
 * different: from the Screener the change becomes a rule, from anywhere else it moves the
 * mail and future mail is unaffected. See `sender-screening.ts` for why.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { DECISION_DONE_LABEL } from "@ohmail/ui";
import { Avatar } from "@ohmail/ui";
import { avatarHue, initialsOf } from "./format";
import {
  SCREENING_DESTS,
  type ScreeningDest,
  type SenderScreening,
} from "./sender-screening";

export interface SenderMenuState {
  /** Any message from the sender — the mirror resolves the rest. */
  messageId: string;
  x: number;
  y: number;
}

export function SenderMenu({
  state,
  sender,
  onChoose,
  onClose,
}: {
  state: SenderMenuState;
  sender: SenderScreening;
  onChoose: (dest: ScreeningDest) => void;
  onClose: () => void;
}) {
  const t = useTranslations("screening");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    // `mousedown` on the document, matching the tag picker: a `click` listener would race
    // the very click that opened this.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const label = sender.name || sender.address;
  return (
    <div
      ref={rootRef}
      className="senderm"
      role="dialog"
      aria-label={t("aria", { sender: sender.address })}
      style={{ left: state.x, top: state.y }}
    >
      <div className="sm-head">
        <Avatar initials={initialsOf(label)} hue={avatarHue(sender.address)} size="s" />
        <span className="sm-who">
          <b>{label}</b>
          {sender.name ? <small>{sender.address}</small> : null}
        </span>
      </div>
      <div className="sm-now">
        {sender.current
          ? t("nowIn", {
              place: sender.current === "screener" ? t("placeScreener") : DECISION_DONE_LABEL[sender.current],
              count: sender.messages.length,
            })
          : t("nowSpread", { count: sender.messages.length })}
      </div>
      <ul role="listbox">
        {SCREENING_DESTS.map((dest) => (
          <li
            key={dest}
            role="option"
            aria-selected={sender.current === dest}
            className={sender.current === dest ? "sel" : undefined}
            onClick={() => onChoose(dest)}
          >
            {DECISION_DONE_LABEL[dest]}
            {sender.current === dest ? <span className="ck">✓</span> : null}
          </li>
        ))}
      </ul>
      {/* The honest half. A Screener-held sender goes through the endpoint that promotes a
          rule; everyone else gets moves, and moves do not remember anything. */}
      <div className="sm-foot">
        {sender.waiting ? t("footRule", { sender: sender.address }) : t("footNoRule")}
      </div>
    </div>
  );
}
