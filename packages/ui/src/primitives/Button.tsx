import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { Kbd } from "./Kbd.js";
import "./button.css";

export type ButtonVariant = "default" | "primary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Leading icon from the geometric set. */
  icon?: IconName;
  /** Trailing keyboard hint, rendered as a keycap. */
  kbdHint?: string;
  children?: ReactNode;
}

/** Capsule button held up by light — lift-0 resting, lift-2 on hover. */
export function Button({
  variant = "default",
  icon,
  kbdHint,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = ["btn", variant !== "default" ? variant : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
      {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
    </button>
  );
}
