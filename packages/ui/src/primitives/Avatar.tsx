import "./avatar.css";

export interface AvatarProps {
  /** One or two initials. */
  initials: string;
  /** 30px default; "s" is the 26px doorbell size. */
  size?: "m" | "s";
  className?: string;
}

/** Initials avatar — float surface on lift-0, never an image in Blanc. */
export function Avatar({ initials, size = "m", className }: AvatarProps) {
  const cls = ["av", size === "s" ? "s" : null, className].filter(Boolean).join(" ");
  return (
    <span className={cls} aria-hidden="true">
      {initials}
    </span>
  );
}
