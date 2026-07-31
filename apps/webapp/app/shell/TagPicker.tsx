"use client";

/**
 * The tag picker popover: filter, ↵ toggles the highlighted tag, Escape
 * closes, outside click dismisses. Position is computed from the anchor
 * exactly like the prototype (below, clamped to the viewport).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { TagDTO } from "@ohmail/client-engine";
import { TagDot } from "@ohmail/ui";
import { hueOf } from "./format";

export interface TagPickerState {
  forId: string;
  x: number;
  y: number;
}

export function placePicker(anchor: HTMLElement | null): { x: number; y: number } {
  const r = anchor?.getBoundingClientRect() ?? {
    left: window.innerWidth / 2 - 120,
    bottom: window.innerHeight / 3,
    top: window.innerHeight / 3,
  };
  const w = 240;
  const pad = 10;
  const h = 190;
  const x = Math.min(Math.max(r.left, pad), window.innerWidth - w - pad);
  let y = r.bottom + 8;
  if (y + h > window.innerHeight - pad) y = Math.max(pad, r.top - h - 8);
  return { x, y };
}

export function TagPicker({
  state,
  tags,
  assigned,
  onToggle,
  onClose,
}: {
  state: TagPickerState;
  tags: TagDTO[];
  /** Tag ids currently on the target message. */
  assigned: string[];
  onToggle: (tagId: string, assigned: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations("tag");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useMemo(
    () => tags.filter((tag) => tag.name.toLowerCase().includes(query.trim().toLowerCase())),
    [tags, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const toggle = (tag: TagDTO) => {
    onToggle(tag.id, !assigned.includes(tag.id));
  };

  return (
    <div
      ref={rootRef}
      className="tagp"
      role="dialog"
      aria-label={t("pickerAria")}
      style={{ left: state.x, top: state.y }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder={t("pickerPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && list[0]) toggle(list[0]);
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <ul role="listbox">
        {list.length ? (
          list.map((tag, i) => (
            <li
              key={tag.id}
              role="option"
              aria-selected={i === 0}
              className={i === 0 ? "sel" : undefined}
              onClick={() => toggle(tag)}
            >
              <TagDot hue={hueOf(tag)} />
              {tag.name}
              {assigned.includes(tag.id) ? <span className="ck">✓</span> : null}
            </li>
          ))
        ) : (
          <li className="none">{t("pickerNone")}</li>
        )}
      </ul>
      <div className="tagp-foot">{t("pickerFoot")}</div>
    </div>
  );
}
