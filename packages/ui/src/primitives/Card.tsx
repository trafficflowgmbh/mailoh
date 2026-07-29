import type { HTMLAttributes, ReactNode } from "react";
import "./card.css";

export type CardLift = 0 | 1 | 2 | 3;

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The lift ladder:
   * 0 small control · 1 resting panel · 2 raised object · 3 floating layer.
   */
  lift?: CardLift;
  /** float surface instead of panel (raised/floating things). */
  floating?: boolean;
  /** Radius step — panel 20 (default), card 22, overlay 24, reader 28. */
  radius?: "panel" | "card" | "overlay" | "reader";
  children?: ReactNode;
}

/** A Blanc surface: no border, structure read from the shadow system. */
export function Card({
  lift = 1,
  floating,
  radius = "panel",
  className,
  children,
  ...rest
}: CardProps) {
  const cls = [
    "card",
    `lift-${lift}`,
    floating ? "float" : null,
    radius !== "panel" ? `r-${radius}` : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
