"use client";

/**
 * Ohbox — the two-pane accepted-mail view: grouped list (New for you /
 * Previously seen) against the engine's ohboxView selector, the Screener
 * doorbell, and the reading column. j/k moves, ↵ opens the reader,
 * t opens the tag picker.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, TagDTO } from "@mailoh/client-engine";
import {
  Doorbell,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
} from "@mailoh/ui";
import { displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { MessagePane, type MessageAction } from "../shell/MessagePane";

/** Older mail beyond the demo mirror — the prototype's "3 more collapsed". */
export const OHBOX_COLLAPSED_OLDER = 3;

export function OhboxView({
  newForYou,
  previouslySeen,
  tags,
  now,
  selectedId,
  onSelect,
  onEnterReader,
  doorbellInitials,
  doorbellCount,
  onDoorbell,
  onAction,
  onAddTag,
  onAttachment,
  typingGuard,
}: {
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  tags: TagDTO[];
  now: Date;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEnterReader: () => void;
  doorbellInitials: string[];
  doorbellCount: number;
  onDoorbell: () => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  onAttachment: () => void;
  typingGuard: (e: KeyboardEvent) => boolean;
}) {
  const t = useTranslations("ohbox");
  const [moreOpen, setMoreOpen] = useState(false);

  const all = useMemo(
    () => [...newForYou, ...previouslySeen],
    [newForYou, previouslySeen],
  );
  const selected = all.find((m) => m.id === selectedId) ?? all[0] ?? null;

  // j/k selection + ↵ reader + t tag picker (this view only — it unmounts
  // with the route, so the binding scopes itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const order = all.map((m) => m.id);
      const i = selected ? order.indexOf(selected.id) : -1;
      if (e.key === "j" && i < order.length - 1) onSelect(order[i + 1]!);
      else if (e.key === "k" && i > 0) onSelect(order[i - 1]!);
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
        onEnterReader();
      } else if (e.key === "t" && selected) {
        e.preventDefault();
        const row = document.querySelector<HTMLElement>(
          `.view-ohbox .row[data-id="${CSS.escape(selected.id)}"]`,
        );
        onAddTag(selected.id, row);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [all, selected, onSelect, onEnterReader, onAddTag, typingGuard]);

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={m.from.address}
      time={displayTime(m, now)}
      subject={m.subject}
      preview={m.protected ? t("protectedPreview") : m.snippet}
      unread={m.unread}
      seen={!m.unread}
      selected={selected?.id === m.id}
      threadCount={m.threadCount}
      hasAttachment={m.hasAttachments}
      protected={m.protected != null}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      onClick={() => {
        if (window.matchMedia("(max-width: 900px)").matches) {
          onSelect(m.id);
          onEnterReader();
        } else if (selected?.id === m.id) {
          onEnterReader();
        } else {
          onSelect(m.id);
        }
      }}
    />
  );

  return (
    <section className="view split view-ohbox">
      <ListPane
        title={t("title")}
        meta={t("meta", {
          unread: newForYou.length,
          total: all.length + OHBOX_COLLAPSED_OLDER,
        })}
        header={
          <Doorbell
            initials={doorbellInitials}
            gone={doorbellCount === 0}
            message={
              <DoorbellMessage count={doorbellCount} />
            }
            actionLabel={t("doorbellAction")}
            ariaLabel={t("doorbellAria", { count: doorbellCount })}
            onPress={onDoorbell}
          />
        }
        hints={
          <>
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintMove")}
            </span>
            <span>
              <Kbd>↵</Kbd> {t("hintRead")}
            </span>
            <span>
              <Kbd>t</Kbd> {t("hintTag")}
            </span>
            <span>
              <Kbd>esc</Kbd> {t("hintBack")}
            </span>
          </>
        }
      >
        <ListGroupLabel>{t("newForYou")}</ListGroupLabel>
        <ListRows>{newForYou.map(row)}</ListRows>
        <ListGroupLabel>{t("previouslySeen")}</ListGroupLabel>
        <ListRows>{previouslySeen.map(row)}</ListRows>
        {moreOpen ? (
          <div className="more-note">{t("moreNote")}</div>
        ) : (
          <button type="button" className="more-row" onClick={() => setMoreOpen(true)}>
            {t("moreCollapsed", { count: OHBOX_COLLAPSED_OLDER })}
          </button>
        )}
      </ListPane>
      <ReadColumn>
        {selected ? (
          <MessagePane
            message={selected}
            tags={tags}
            now={now}
            onEnterReader={onEnterReader}
            onAction={(a) => onAction(a, selected)}
            onAddTag={onAddTag}
            onAttachment={onAttachment}
          />
        ) : null}
      </ReadColumn>
    </section>
  );
}

function DoorbellMessage({ count }: { count: number }) {
  const t = useTranslations("ohbox");
  return (
    <>
      {t.rich("doorbell", {
        count,
        b: (chunks) => <b>{chunks}</b>,
      })}
    </>
  );
}
