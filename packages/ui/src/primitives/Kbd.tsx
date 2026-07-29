import type { ReactNode } from "react";

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

/** Keycap — one of Blanc's few deliberate hairlines (styled in base.css). */
export function Kbd({ children, className }: KbdProps) {
  return <kbd className={className}>{children}</kbd>;
}
