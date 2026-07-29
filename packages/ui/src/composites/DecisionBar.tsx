import { useEffect, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
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
  /** Show the right-hand key hints. */
  keysHint?: boolean;
  className?: string;
}

/**
 * Five split-buttons — Ohbox · Reads · Receipts · Screen out · Spam —
 * with the AI destination preselected, a sender/domain scope toggle and
 * the consequence line. Fits one line at 1280px (container query).
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
  keysHint = true,
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
              kbdHint={ai ? "y" : undefined}
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
        <span className="d-note">
          {note ?? (
            <>
              Becomes a rule — future mail from {ruleTarget} files automatically. The ✓ half
              also marks this mail read.
            </>
          )}
        </span>
        {keysHint ? (
          <span className="d-keys">
            <Kbd>y</Kbd> accept · <Kbd>⇧</Kbd>+key marks read
          </span>
        ) : null}
      </div>
    </div>
  );
}
