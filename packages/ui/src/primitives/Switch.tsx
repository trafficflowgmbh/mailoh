import "./switch.css";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/** Accessible switch — role="switch", knob on the spring easing. */
export function Switch({ checked, onChange, ariaLabel, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={className ? `switch ${className}` : "switch"}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}
