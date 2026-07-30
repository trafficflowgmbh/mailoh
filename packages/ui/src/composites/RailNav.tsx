import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import { TagDot, type TagHueName } from "../primitives/Chip.js";
import "./rail.css";

export interface RailItem {
  id: string;
  label: string;
  count?: number;
  /** Accent-colored count (actionable attention: Ohbox unread, Screener). */
  hot?: boolean;
  /** Keycap instead of a count (Search "/"). */
  kbdHint?: string;
  /** Tooltip / accessible enrichment ("4 unread of 9"). */
  title?: string;
}

export interface RailTagItem {
  id: string;
  label: string;
  hue: TagHueName;
  count?: number;
}

export interface RailGroup {
  label?: string;
  items: RailItem[];
  /** Subordinate collapsible Tags group, nested under this group. */
  tags?: {
    label?: string;
    items: RailTagItem[];
    defaultOpen?: boolean;
  };
}

export interface RailMailbox {
  name: string;
  hint: string;
}

export interface RailNavProps {
  /** Defaults to the mailoh wordmark. */
  wordmark?: ReactNode;
  composeLabel?: string;
  composeKbd?: string;
  onCompose?: () => void;
  composeActive?: boolean;
  groups: RailGroup[];
  activeId?: string;
  onNavigate?: (id: string) => void;
  activeTagId?: string;
  onNavigateTag?: (id: string) => void;
  mailboxesLabel?: string;
  mailboxes?: RailMailbox[];
  /** Bottom line — the account address. */
  footer?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

/** Animated count — ticks up on change like the prototype's counters. */
function Count({ value, hot }: { value?: number; hot?: boolean }) {
  const prev = useRef(value);
  const [tick, setTick] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setTick(true);
      const t = setTimeout(() => setTick(false), 340);
      return () => clearTimeout(t);
    }
  }, [value]);
  return (
    <span className={hot ? "cnt hot num" : "cnt num"}>
      <span key={value} className={tick ? "tick" : undefined}>
        {value && value > 0 ? value : ""}
      </span>
    </span>
  );
}

/**
 * The navigation rail: compose CTA on top, route groups with badges,
 * the collapsible Tags group subordinate to Triage, mailboxes, and the
 * account footer.
 */
export function RailNav({
  wordmark,
  composeLabel = "Compose",
  composeKbd = "c",
  onCompose,
  composeActive,
  groups,
  activeId,
  onNavigate,
  activeTagId,
  onNavigateTag,
  mailboxesLabel = "Mailboxes",
  mailboxes,
  footer,
  ariaLabel = "Main",
  className,
}: RailNavProps) {
  return (
    <nav className={className ? `rail ${className}` : "rail"} aria-label={ariaLabel}>
      <div className="wordmark">
        {/* Two elements, not one string: `.wordmark b em` paints the second
            half in accent-ink, so the rail echoes the "oh." app mark. Keep the
            split at the word boundary — mail | oh — and keep it lower-case. */}
        {wordmark ?? (
          <b>
            mail<em>oh</em>
          </b>
        )}
      </div>

      {onCompose ? (
        <button
          type="button"
          className={composeActive ? "compose-cta on" : "compose-cta"}
          onClick={onCompose}
        >
          <Icon name="pen" /> {composeLabel}
          {composeKbd ? <Kbd>{composeKbd}</Kbd> : null}
        </button>
      ) : null}

      {groups.map((group, gi) => (
        <div className="rgroup" key={group.label ?? gi}>
          {group.label ? <div className="rlabel">{group.label}</div> : null}
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeId ? "ritem on" : "ritem"}
              title={item.title}
              aria-current={item.id === activeId ? "page" : undefined}
              onClick={() => onNavigate?.(item.id)}
            >
              {item.label}
              {item.kbdHint ? (
                <span className="cnt">
                  <Kbd>{item.kbdHint}</Kbd>
                </span>
              ) : (
                <Count value={item.count} hot={item.hot} />
              )}
            </button>
          ))}
          {group.tags ? (
            <TagsGroup
              label={group.tags.label ?? "Tags"}
              items={group.tags.items}
              defaultOpen={group.tags.defaultOpen ?? true}
              activeTagId={activeTagId}
              onNavigateTag={onNavigateTag}
            />
          ) : null}
        </div>
      ))}

      {mailboxes?.length ? (
        <div className="rgroup">
          <div className="rlabel">{mailboxesLabel}</div>
          {mailboxes.map((m) => (
            <div className="mbx" key={m.name}>
              <i />
              <span className="nm">{m.name}</span>
              <small>{m.hint}</small>
            </div>
          ))}
        </div>
      ) : null}

      {footer ? <div className="rail-mail">{footer}</div> : null}
    </nav>
  );
}

function TagsGroup({
  label,
  items,
  defaultOpen,
  activeTagId,
  onNavigateTag,
}: {
  label: string;
  items: RailTagItem[];
  defaultOpen: boolean;
  activeTagId?: string;
  onNavigateTag?: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={open ? "rgroup rsub" : "rgroup rsub closed"}>
      <button
        type="button"
        className="rlabel-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <Icon name="chev" className="chev" />
      </button>
      <div className="rgroup-body">
        {items.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === activeTagId ? "ritem on" : "ritem"}
            onClick={() => onNavigateTag?.(t.id)}
          >
            <TagDot hue={t.hue} />
            {t.label}
            <span className="cnt num">{t.count ?? ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
