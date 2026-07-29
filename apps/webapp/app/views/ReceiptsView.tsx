"use client";

/**
 * Receipts — the same two-pane pattern as Reads with amounts on the
 * right and day-grouped rows over the engine's receiptsByDay selector.
 * Seen-marking is a client overlay in Stage 1: the mutation vocabulary
 * covers the Reads feed only, so receipts keep their seen state per tab
 * until the Stage 2 wire lands.
 */
import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, ReceiptsDayGroup, TagDTO } from "@mailoh/client-engine";
import { Kbd, ListGroupLabel, ListPane, ListRows, MessageRow, StreamCard } from "@mailoh/ui";
import { displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { StreamShell, type StreamHandle } from "../shell/StreamShell";

export function ReceiptsView({
  groups,
  tags,
  now,
  cur,
  onCur,
  unreadCount,
  isUnread,
  markSeen,
  jumpTo,
  onJumped,
  typingGuard,
}: {
  groups: ReceiptsDayGroup[];
  tags: TagDTO[];
  now: Date;
  cur: string | null;
  onCur: (id: string) => void;
  /** Engine unread minus the client seen-overlay. */
  unreadCount: number;
  isUnread: (m: EngineMessage) => boolean;
  markSeen: (id: string) => void;
  jumpTo: string | null;
  onJumped: () => void;
  typingGuard: (e: KeyboardEvent) => boolean;
}) {
  const t = useTranslations("receipts");
  const tr = useTranslations("reads");
  const streamRef = useRef<StreamHandle>(null);
  const [justSeen, setJustSeen] = useState<Set<string>>(() => new Set());

  const all = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = cur ?? all.find(isUnread)?.id ?? all[0]?.id ?? null;

  const seenMark = (id: string) => {
    const m = all.find((x) => x.id === id);
    if (!m || !isUnread(m) || justSeen.has(id)) return;
    setJustSeen((s) => new Set(s).add(id));
    markSeen(id);
  };

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

  useEffect(() => {
    if (!current) return;
    document
      .querySelector(`.view-receipts .row[data-id="${CSS.escape(current)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

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
            `.view-receipts .scast[data-sid="${CSS.escape(current)}"] .sc-x`,
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
      amount={m.amount}
      unread={isUnread(m) || justSeen.has(m.id)}
      justSeen={justSeen.has(m.id)}
      seen={!isUnread(m) && !justSeen.has(m.id)}
      selected={current === m.id}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      onClick={() => jump(m.id)}
    />
  );

  return (
    <section className="view split view-receipts">
      <ListPane
        title={t("title")}
        meta={t("meta", { count: unreadCount })}
        onSeen={seenMark}
        hints={
          <>
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> {tr("hintMove")}
            </span>
            <span>
              <Kbd>↵</Kbd> {tr("hintExpand")}
            </span>
            <span>{tr("hintRowJump")}</span>
          </>
        }
      >
        {groups.map((g) => (
          <Fragment key={g.label}>
            <ListGroupLabel>{g.label}</ListGroupLabel>
            <ListRows>
              {g.items.map((m, i) => (
                <Fragment key={m.id}>
                  {i > 0 ? <div className="receipts-rule" /> : null}
                  {row(m)}
                </Fragment>
              ))}
            </ListRows>
          </Fragment>
        ))}
        {/* No-collapse rule: every receipt is a real row above. */}
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
            <Kbd>j</Kbd> <Kbd>k</Kbd> {tr("hintNextPrev")}
          </span>
          <span>
            <Kbd>↵</Kbd> {tr("hintExpand")}
          </span>
          <span>{tr("hintSeen")}</span>
        </div>
        {all.map((m) => (
          <StreamCard
            key={m.id}
            id={m.id}
            from={senderName(m)}
            address={m.from.address}
            amount={m.amount}
            time={displayTime(m, now)}
            subject={m.subject}
            body={m.body ?? m.snippet}
            unread={isUnread(m) || justSeen.has(m.id)}
            justSeen={justSeen.has(m.id)}
            current={current === m.id}
            onSelect={(id) => onCur(id)}
          />
        ))}
        <div className="tail-row">{t("tail")}</div>
      </StreamShell>
    </section>
  );
}
