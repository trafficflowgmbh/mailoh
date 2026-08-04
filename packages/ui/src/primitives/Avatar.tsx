import type { CSSProperties } from "react";
import "./avatar.css";

export interface AvatarProps {
  /** One or two initials. */
  initials: string;
  /** 30px default; "s" is the 26px doorbell size. */
  size?: "m" | "s";
  /**
   * OKLCH hue angle in degrees for a deterministic per-sender tint.
   *
   * The CALLER derives it — from the address, so the same person is the same colour in
   * every list and on every device — and this component only renders it. Lightness and
   * chroma are pinned in `avatar.css` per theme, so a hue can never produce an illegible
   * circle: the only free variable is the angle. Omit it for the neutral float surface
   * the Screener and the doorbell shipped with.
   */
  hue?: number;
  className?: string;
}

/** Initials avatar — float surface on lift-0, never an image in Blanc. */
export function Avatar({ initials, size = "m", hue, className }: AvatarProps) {
  const cls = ["av", size === "s" ? "s" : null, hue === undefined ? null : "tinted", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={cls}
      aria-hidden="true"
      style={hue === undefined ? undefined : ({ "--av-h": String(hue) } as CSSProperties)}
    >
      {initials}
    </span>
  );
}
