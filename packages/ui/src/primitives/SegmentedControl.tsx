import "./seg.css";

export interface SegmentOption<T extends string = string> {
  id: T;
  label: string;
  /** Optional count rendered after the label (Screener sections). */
  count?: number | string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** tablist for view-switching segments, group for value pickers. */
  role?: "tablist" | "group";
  /** Compact scope variant (decision bar). */
  variant?: "default" | "scope";
  className?: string;
}

/** Capsule segmented control; the active segment floats on lift-0. */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  role = "group",
  variant = "default",
  className,
}: SegmentedControlProps<T>) {
  const counted = options.some((o) => o.count !== undefined);
  const cls = ["seg", counted ? "counted" : null, variant === "scope" ? "scope" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role={role} aria-label={ariaLabel}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role={role === "tablist" ? "tab" : undefined}
            aria-selected={role === "tablist" ? on : undefined}
            aria-pressed={role === "group" ? on : undefined}
            className={on ? "on" : undefined}
            onClick={() => onChange(o.id)}
          >
            {o.label}
            {o.count !== undefined ? <span className="scnt num">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
