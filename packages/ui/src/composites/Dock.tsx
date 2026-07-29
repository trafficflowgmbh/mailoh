import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import "./dock.css";

export interface DockProps {
  children: ReactNode;
  className?: string;
}

/** The floating bottom dock (lift-3). Compose with DockKey / DockIcon / DockSep. */
export function Dock({ children, className }: DockProps) {
  return <div className={className ? `dock ${className}` : "dock"}>{children}</div>;
}

export interface DockKeyProps {
  label: ReactNode;
  kbdHint?: string;
  onPress: () => void;
}

/** Labeled dock action with a keycap hint ("Command ⌘K"). */
export function DockKey({ label, kbdHint, onPress }: DockKeyProps) {
  return (
    <button type="button" className="dock-k" onClick={onPress}>
      {label}
      {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
    </button>
  );
}

export interface DockIconProps {
  icon: IconName;
  /** Accessible name — the button is icon-only. */
  label: string;
  onPress: () => void;
  title?: string;
}

/** Icon-only dock action (theme toggle, about). */
export function DockIcon({ icon, label, onPress, title }: DockIconProps) {
  return (
    <button
      type="button"
      className="dock-ic"
      aria-label={label}
      title={title ?? label}
      onClick={onPress}
    >
      <Icon name={icon} />
    </button>
  );
}

/** Hairline separator between dock groups. */
export function DockSep() {
  return <span className="dock-sep" />;
}
