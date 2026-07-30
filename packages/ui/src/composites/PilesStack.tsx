import { Icon, type IconName } from "../icons.js";
import "./piles.css";

export interface PileItem {
  title: string;
  subtitle?: string;
  /** Resurface time — rendered with the small clock ("resurfaces Fri 09:00"). */
  when?: string;
  /** Dimmed once handled (Reply Run). */
  done?: boolean;
}

export interface Pile {
  id: string;
  icon: IconName;
  title: string;
  count: number;
  items: PileItem[];
  hint?: string;
}

export interface PilesStackProps {
  piles: Pile[];
  className?: string;
}

/**
 * The triage piles — Answer Later · Parked · Resurface — as stacked
 * sheets: two receding panel layers behind a lift-2 top sheet that
 * rises to lift-3 on hover.
 */
export function PilesStack({ piles, className }: PilesStackProps) {
  return (
    <div className={className ? `piles ${className}` : "piles"}>
      {piles.map((pile) => (
        <div className="pile" key={pile.id}>
          <div className="pile-stack">
            <h3>
              <Icon name={pile.icon} /> {pile.title}{" "}
              <span className="cnt num">{pile.count}</span>
            </h3>
            {pile.items.map((item) => (
              <div
                className="pile-item"
                key={item.title}
                style={item.done ? { opacity: 0.38 } : undefined}
              >
                <b>{item.title}</b>
                {item.subtitle ? <span>{item.subtitle}</span> : null}
                {item.when ? (
                  <span className="when">
                    <Icon name="clock" size={11} /> resurfaces {item.when}
                  </span>
                ) : null}
              </div>
            ))}
            {pile.hint ? <p className="pile-hint">{pile.hint}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
