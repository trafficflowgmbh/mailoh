"use client";

/**
 * Reads — list left, skim stream right. Scroll-marks-seen runs through
 * the engine (`feed_mark_seen`, preserving the waterline anchor), the
 * scroll-spy keeps list and stream in step, and the pending-AI chip
 * carries the classification approval flow.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  EngineMessage,
  ReadsPartition,
  TagDTO,
} from "@ohmail/client-engine";
import {
  Chip,
  Kbd,
  ListPane,
  ListRows,
  MessageRow,
  StreamArt,
  StreamCard,
  Waterline,
} from "@ohmail/ui";
import { displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { FoldTableArt, StreamShell, type StreamHandle } from "../shell/StreamShell";

export type ReadsChipState = null | "approved" | "corrected";

interface ReadsAiChipMeta {
  afterId: string;
  label: string;
  approvedLabel: string;
  correctedLabel: string;
}

export function ReadsView({
  partition,
  tags,
  now,
  cur,
  onCur,
  aiChip,
  chipState,
  onChipState,
  markSeen,
  isSeen,
  jumpTo,
  onJumped,
  typingGuard,
}: {
  partition: ReadsPartition;
  tags: TagDTO[];
  now: Date;
  cur: string | null;
  onCur: (id: string) => void;
  aiChip: ReadsAiChipMeta | null;
  chipState: ReadsChipState;
  onChipState: (s: Exclude<ReadsChipState, null>) => void;
  /** Mark one Reads message seen through the engine. */
  markSeen: (id: string) => void;
  isSeen: (m: EngineMessage) => boolean;
  jumpTo: string | null;
  onJumped: () => void;
  typingGuard: (e: KeyboardEvent) => boolean;
}) {
  const t = useTranslations("reads");
  const streamRef = useRef<StreamHandle>(null);
  const [justSeen, setJustSeen] = useState<Set<string>>(() => new Set());

  const all = useMemo(
    () => [...partition.fresh, ...partition.seen],
    [partition.fresh, partition.seen],
  );
  const unreadCount = all.filter((m) => m.unread).length;
  const current = cur ?? all.find((m) => m.unread)?.id ?? all[0]?.id ?? null;

  const seenMark = (id: string) => {
    const m = all.find((x) => x.id === id);
    if (!m || !m.unread || justSeen.has(id)) return;
    setJustSeen((s) => new Set(s).add(id));
    markSeen(id);
  };

  // Row click / tag-view jump: the stream scrolls to the card.
  const jump = (id: string) => {
    seenMark(id);
    onCur(id);
    streamRef.current?.scrollTo(id);
  };

  useEffect(() => {
    if (!jumpTo) return;
    const timer = requestAnimationFrame(() => {
      onCur(jumpTo);
      streamRef.current?.scrollTo(jumpTo);
      onJumped();
    });
    return () => cancelAnimationFrame(timer);
  }, [jumpTo, onCur, onJumped]);

  // Keep the selected row in view when the stream drives the selection.
  useEffect(() => {
    if (!current) return;
    document
      .querySelector(`.view-reads .row[data-id="${CSS.escape(current)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // j/k step cards; ↵ toggles the current card's clamp.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const order = all.map((m) => m.id);
      const i = current ? order.indexOf(current) : -1;
      if (e.key === "j" && i < order.length - 1) jump(order[i + 1]!);
      else if (e.key === "k" && i > 0) jump(order[i - 1]!);
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON" && current) {
        document
          .querySelector<HTMLButtonElement>(
            `.view-reads .scast[data-sid="${CSS.escape(current)}"] .sc-x`,
          )
          ?.click();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, current, typingGuard]);

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={m.from.address}
      time={displayTime(m, now)}
      subject={m.subject}
      preview={m.snippet}
      unread={m.unread || justSeen.has(m.id)}
      justSeen={justSeen.has(m.id)}
      seen={isSeen(m) && !justSeen.has(m.id)}
      selected={current === m.id}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      onClick={() => jump(m.id)}
    />
  );

  const card = (m: EngineMessage) => (
    <StreamCard
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={m.from.address}
      time={displayTime(m, now)}
      subject={m.subject}
      body={m.body ?? m.snippet}
      unread={m.unread || justSeen.has(m.id)}
      justSeen={justSeen.has(m.id)}
      current={current === m.id}
      onSelect={(id) => onCur(id)}
      art={
        m.art ? (
          <StreamArt ariaLabel={m.art.ariaLabel} caption={m.art.caption}>
            <FoldTableArt />
          </StreamArt>
        ) : undefined
      }
    />
  );

  const chipRow =
    aiChip && partition.fresh.some((m) => m.id === aiChip.afterId) ? (
      <div className="reads-chip-row">
        {chipState === "approved" ? (
          <Chip icon="check">{aiChip.approvedLabel}</Chip>
        ) : chipState === "corrected" ? (
          <Chip icon="route">{aiChip.correctedLabel}</Chip>
        ) : (
          <Chip
            variant="ai"
            actions={[
              { label: t("aiApprove"), onPress: () => onChipState("approved") },
              { label: t("aiCorrect"), onPress: () => onChipState("corrected") },
            ]}
          >
            {aiChip.label}
          </Chip>
        )}
      </div>
    ) : null;

  return (
    <section className="view split view-reads">
      <ListPane
        title={t("title")}
        meta={t("meta", { count: unreadCount })}
        onSeen={seenMark}
        hints={
          <>
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintMove")}
            </span>
            <span>
              <Kbd>↵</Kbd> {t("hintExpand")}
            </span>
            <span>{t("hintRowJump")}</span>
          </>
        }
      >
        <ListRows>
          {partition.fresh.map((m) => (
            <span key={m.id} style={{ display: "contents" }}>
              {row(m)}
              {aiChip?.afterId === m.id ? chipRow : null}
            </span>
          ))}
        </ListRows>
        {partition.waterline ? <Waterline meta={partition.waterline.meta} /> : null}
        <ListRows>{partition.seen.map(row)}</ListRows>
        <div className="tail-row">{t("tail")}</div>
      </ListPane>

      <StreamShell
        ref={streamRef}
        ariaLabel={t("streamAria")}
        onCurrentChange={onCur}
        onSeen={seenMark}
        contentKey={all.map((m) => m.id).join(",")}
      >
        <div className="stream-top">
          <h1>{t("title")}</h1>
          <span className="meta num">{t("meta", { count: unreadCount })}</span>
        </div>
        <div className="stream-hints">
          <span>
            <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintNextPrev")}
          </span>
          <span>
            <Kbd>↵</Kbd> {t("hintExpand")}
          </span>
          <span>{t("hintSeen")}</span>
        </div>
        {partition.fresh.map(card)}
        {partition.waterline ? <Waterline meta={partition.waterline.meta} /> : null}
        {partition.seen.map(card)}
        <div className="tail-row">{t("streamTail")}</div>
      </StreamShell>
    </section>
  );
}
