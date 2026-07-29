import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import "./settings.css";

export interface SettingsSectionProps {
  children: ReactNode;
  className?: string;
}

/** A settings pane — lift-1 panel holding SettingsRows. */
export function SettingsSection({ children, className }: SettingsSectionProps) {
  return <div className={className ? `set-pane ${className}` : "set-pane"}>{children}</div>;
}

export interface SettingsSubheadProps {
  children: ReactNode;
}

/** Sub-heading inside a section ("VIP — always notifies"). */
export function SettingsSubhead({ children }: SettingsSubheadProps) {
  return <div className="set-sub">{children}</div>;
}

export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Static right-aligned value ("English", "Connected"). */
  value?: ReactNode;
  /** Interactive control at the right (Switch, SegmentedControl, buttons). */
  control?: ReactNode;
  /** Leading decoration (tag dot). */
  leading?: ReactNode;
}

/** One settings row: label block left, value or control right. */
export function SettingsRow({ label, description, value, control, leading }: SettingsRowProps) {
  return (
    <div className="set-row">
      {leading}
      <div className="lab">
        <b>{label}</b>
        {description ? <span>{description}</span> : null}
      </div>
      {value !== undefined ? <span className="set-val">{value}</span> : null}
      {control}
    </div>
  );
}

export interface SettingsNoteProps {
  icon?: IconName;
  children: ReactNode;
}

/** The privacy/assurance note with its shield. */
export function SettingsNote({ icon = "shield", children }: SettingsNoteProps) {
  return (
    <p className="set-note">
      <Icon name={icon} />
      {children}
    </p>
  );
}

export interface VipChipProps {
  children: ReactNode;
  /** Plays the accept pulse. */
  pulse?: boolean;
}

/** A VIP capsule with the accent dot. */
export function VipChip({ children, pulse }: VipChipProps) {
  return (
    <span className={pulse ? "vip pulse" : "vip"}>
      <span className="vdot" /> {children}
    </span>
  );
}
