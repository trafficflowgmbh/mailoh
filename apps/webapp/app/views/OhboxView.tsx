"use client";

/**
 * Ohbox — the two-pane accepted-mail view: grouped list (New / Earlier)
 * against the engine's ohboxView selector, the Screener
 * doorbell, and the reading column. j/k moves, ↵ opens the reader,
 * t opens the tag picker.
 */
import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import {
  Doorbell,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
} from "@ohmail/ui";
import { displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useEngineVersion, useReader, useSyncStatus } from "../shell/engine";
import { MessagePane, type MessageAction } from "../shell/MessagePane";

export function OhboxView({
  demo,
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
  /** Fixture world or a real mailbox — decides the "older mail" tail. See its use below. */
  demo: boolean;
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
          total: all.length,
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
        {all.length === 0 ? <SyncState /> : null}
        {/* DEMO ONLY, and it was not. "Older mail stays on your server — find it in Search."
            is true of Mila's fixture world, which holds a hand-made slice of a mailbox. It is
            FALSE of a live account: the worker syncs every folder from cursor zero, so what is
            on the server is what is in the mirror, and telling a paying customer their old
            mail is somewhere else is the kind of claim CLAUDE.md forbids shipping. The
            no-collapse rule (invariant #6) is satisfied either way — every message is a real
            row above. */}
        {demo ? <div className="tail-row">{t("tail")}</div> : null}
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

/**
 * WHY AN EMPTY OHBOX IS EMPTY — a count, and never a percentage.
 *
 * P16. A first drain is thirty-odd pages and twelve to fifteen seconds on a real mailbox, and
 * for all of it this pane said "0 unread of 0" with no rows and no explanation, which is what
 * a broken account looks like. The engine already calls `notify()` once per page, so the
 * mirror's size is live here with no extra plumbing.
 *
 * A progress bar is impossible and would have to be invented: `/sync` answers `hasMore` as a
 * boolean, so the total is unknowable until the drain ends. A count is the largest true thing
 * available, and it moves, which is the part that distinguishes working from hung. It counts
 * every message in the MIRROR — Screener, Reads and Receipts included — not the ohbox rows
 * above, so the wording says "messages", not "in your Ohbox".
 *
 * Three consecutive failures replaces it with the failure, because by then the count has
 * stopped moving and a frozen counter is the same lie in a new font. It says the loop is still
 * retrying because it is: the scheduler backs off to a minute and never gives up while the tab
 * is visible.
 *
 * The demo and the desktop never reach either branch — `useSyncStatus()` is permanently
 * settled for a fixtures engine.
 */
function SyncState() {
  const t = useTranslations("ohbox");
  const { bootstrapping, failures } = useSyncStatus();
  const reader = useReader();
  const version = useEngineVersion();
  const mirrored = useMemo(() => reader.list("message").length, [reader, version]);

  if (failures >= 3) {
    return (
      <div className="empty" role="status">
        <span className="glyph" aria-hidden="true">⚠</span>
        <b>{t("syncFailed")}</b>
      </div>
    );
  }
  if (!bootstrapping) return null;
  return (
    <div className="empty" role="status">
      <span className="glyph" aria-hidden="true">✉</span>
      <b>{t("syncingTitle")}</b>
      {t("syncingCount", { count: mirrored })}
    </div>
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
