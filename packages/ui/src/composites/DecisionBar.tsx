import { useEffect, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { SegmentedControl } from "../primitives/SegmentedControl.js";
import { SplitButton } from "../primitives/SplitButton.js";
import "./decision-bar.css";

export type DecisionDestination = "ohbox" | "reads" | "receipts" | "screened" | "spam";
export type DecisionScope = "sender" | "domain";

/** Button labels, done-state labels and key map — verbatim from the prototype. */
export const DECISION_LABEL: Record<DecisionDestination, string> = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
  screened: "Screen out",
  spam: "Spam",
};
export const DECISION_DONE_LABEL: Record<DecisionDestination, string> = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
  screened: "Screened out",
  spam: "Spam",
};
export const DECISION_KEY: Record<DecisionDestination, string> = {
  ohbox: "o",
  reads: "r",
  receipts: "c",
  screened: "n",
  spam: "x",
};
const DESTINATIONS: DecisionDestination[] = ["ohbox", "reads", "receipts", "screened", "spam"];
const QUIET = new Set<DecisionDestination>(["screened", "spam"]);

export interface DecisionBarProps {
  /** The AI-preselected destination: ringed, warm, accepts on "y". */
  aiDest?: DecisionDestination;
  scope: DecisionScope;
  onScopeChange: (scope: DecisionScope) => void;
  /** The rule target shown in the consequence line: address or @domain. */
  ruleTarget: string;
  /** One click files; `markRead` is true from the ✓ segment / shifted key. */
  onDecide: (dest: DecisionDestination, opts: { markRead: boolean }) => void;
  /**
   * Bind the keyboard map on document: y accepts the AI suggestion,
   * o/r/c/n/x file, ⇧+key files + marks read.
   */
  keyboard?: boolean;
  /** Mobile back affordance. */
  onBack?: () => void;
  /** Overrides the default consequence line. */
  note?: ReactNode;
  className?: string;
}

/**
 * Five split-buttons — Ohbox · Reads · Receipts · Screen out · Spam —
 * with the AI destination preselected, a sender/domain scope toggle and
 * the consequence line. Fits one line at 1280px (container query).
 *
 * ── UX11: THE KEY GOES ON THE VERB, AND THE LEGEND IS GONE ─────────────────────────────
 *
 * A live walk found this bar illegible in three ways at once. Every capsule is TWO verbs,
 * and only one of them was ever explained: the note said what the ✓ half does and nothing
 * said what pressing the label does. Four of the five keys were in a `title` attribute —
 * invisible to anyone not hovering — while a strip at the far end of the bar spelled
 * "⇧+key marks read" for keys that were not on screen, and the view under it printed a
 * second strip reading "o r c n x file". Three lists of the same five facts, none of them
 * beside the control.
 *
 * So each half wears its own cap, from `DECISION_KEY` — the same constant `ScreenerView`
 * derives its keyboard registry bindings from, so a cap and its binding cannot disagree
 * without editing the one line both read. That is `bf4eb08`'s rule for the message action
 * bar ("keys generated from the registry and attached to the verb they belong to") applied
 * to the surface it had not reached.
 *
 * ── AND TWO SHIPPED HINTS WERE FALSE ───────────────────────────────────────────────────
 *
 * The AI capsule was capped `y` and the strip read "y accept" UNCONDITIONALLY, but `y` is
 * bound only by this component's own `keyboard` listener — and the webapp deliberately
 * stopped passing `keyboard` when the keys moved into the registry (`ScreenerView`'s keymap
 * note). The product therefore shipped a keycap for a key that does nothing, twice. The cap
 * is now `y` only where `y` is really live, and the strip is deleted rather than corrected:
 * accept-on-↵ is hinted by the view, from the binding that exists.
 */
export function DecisionBar({
  aiDest,
  scope,
  onScopeChange,
  ruleTarget,
  onDecide,
  keyboard,
  onBack,
  note,
  className,
}: DecisionBarProps) {
  useEffect(() => {
    if (!keyboard) return;
    const plain: Record<string, DecisionDestination> = {
      o: "ohbox",
      r: "reads",
      c: "receipts",
      n: "screened",
      x: "spam",
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const lower = e.key.toLowerCase();
      if (lower === "y") {
        if (aiDest) {
          e.preventDefault();
          onDecide(aiDest, { markRead: e.shiftKey });
        }
        return;
      }
      const dest = plain[lower];
      if (dest) {
        e.preventDefault();
        onDecide(dest, { markRead: e.shiftKey });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keyboard, aiDest, onDecide]);

  return (
    <div className={className ? `decide ${className}` : "decide"}>
      {onBack ? (
        <button type="button" className="scn-back" onClick={onBack}>
          <Icon name="chev" className="chev" /> Screener
        </button>
      ) : null}
      <div className="d-btns">
        {DESTINATIONS.map((d) => {
          const ai = aiDest === d;
          const k = DECISION_KEY[d];
          return (
            <SplitButton
              key={d}
              label={DECISION_LABEL[d]}
              /* `y` only where `y` is bound — this component's own listener. Everywhere
                 else the capsule shows the letter that files it, which is live in both
                 modes: the registry declares o/r/c/n/x from this same `DECISION_KEY`. */
              kbdHint={keyboard && ai ? "y" : k}
              checkKbdHint={`⇧${k.toUpperCase()}`}
              ai={ai}
              quiet={QUIET.has(d)}
              title={`${DECISION_DONE_LABEL[d]} (${k})`}
              checkTitle={`${DECISION_DONE_LABEL[d]}, mark read (${k.toUpperCase()})`}
              checkLabel={`${DECISION_DONE_LABEL[d]}, mark read`}
              onPress={() => onDecide(d, { markRead: false })}
              onCheckPress={() => onDecide(d, { markRead: true })}
            />
          );
        })}
      </div>
      <div className="d-sub">
        <SegmentedControl
          variant="scope"
          className="d-scope"
          ariaLabel="Decision scope"
          value={scope}
          onChange={(s) => onScopeChange(s)}
          options={[
            { id: "sender", label: "this sender" },
            { id: "domain", label: "whole domain" },
          ]}
        />
        {/* THE CONSEQUENCE LINE, WHICH IS THE CONSENT DISCLOSURE (4a3ff4f) AND NOW SAYS
            WHAT BOTH HALVES DO. "Becomes a rule — future mail from … files automatically"
            is the sentence that has to be readable BEFORE the click, because screening a
            sender out arms auto-unsubscribe; it stays first and unchanged. What follows it
            used to explain the ✓ half only, leaving the half people actually press
            unexplained. */}
        <span className="d-note">
          {note ?? (
            <>
              Becomes a rule — future mail from {ruleTarget} files automatically. The name
              files the mail waiting here; the ✓ files it and marks it read.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
