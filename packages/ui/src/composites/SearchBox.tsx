import type { ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import "./search.css";

export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Trailing keycap; defaults to ↵. */
  kbdHint?: string | null;
  autoFocus?: boolean;
  className?: string;
}

/** The search pill — a lift-1 capsule that rings accent on focus. */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  placeholder = "Search everything — typos welcome",
  ariaLabel = "Search",
  kbdHint = "↵",
  autoFocus,
  className,
}: SearchBoxProps) {
  return (
    <div className={className ? `search-box ${className}` : "search-box"}>
      <Icon name="search" />
      <input
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.(value);
        }}
      />
      {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
    </div>
  );
}

export interface FacetGroup {
  title: string;
  items: { label: string; count?: number }[];
}

export interface FacetsProps {
  groups: FacetGroup[];
  onPick?: (group: string, label: string) => void;
  className?: string;
}

/** The facet rail beside search results. */
export function Facets({ groups, onPick, className }: FacetsProps) {
  return (
    <aside className={className ? `facets ${className}` : "facets"}>
      {groups.map((g) => (
        <div key={g.title}>
          <h4>{g.title}</h4>
          <ul>
            {g.items.map((it) => (
              <li key={it.label} onClick={() => onPick?.(g.title, it.label)}>
                {it.label}
                {it.count !== undefined ? <span className="n">×{it.count}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

export interface SearchHitProps {
  who: string;
  where: string;
  /** Subject; pass rich children to include <mark> highlights. */
  subject: ReactNode;
  /** Fuzzy-match annotation capsule. */
  fuzzyNote?: string;
  onPress?: () => void;
}

/** One search result row. */
export function SearchHit({ who, where, subject, fuzzyNote, onPress }: SearchHitProps) {
  return (
    <button type="button" className="hit" onClick={onPress}>
      <span className="top" style={{ display: "flex" }}>
        <span className="who">{who}</span>
        <span className="where">{where}</span>
      </span>
      <span className="subj" style={{ display: "block" }}>
        {subject}
        {fuzzyNote ? <span className="fuzzy">{fuzzyNote}</span> : null}
      </span>
    </button>
  );
}
