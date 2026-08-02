"use client";

/**
 * Receipts — the same two-pane pattern as Reads with amounts on the
 * right and day-grouped rows over the engine's receiptsByDay selector.
 * Seen-marking goes through the shell's `mark_seen` mutation (slice U1),
 * so it reaches `\Seen` on the user's own IMAP server; the local
 * `justSeen` set below is only the fade, not the state.
 */
import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, ReceiptsDayGroup, TagDTO } from "@ohmail/client-engine";
import { Kbd, ListGroupLabel, ListPane, ListRows, MessageRow, StreamCard } from "@ohmail/ui";
import { avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
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

  const order = all.map((m) => m.id);
  const at = current ? order.indexOf(current) : -1;
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: tr("keyNext"),
      disabled: at >= order.length - 1,
      run: () => at < order.length - 1 && jump(order[at + 1]!),
    },
    {
      chord: "k",
      group: "navigate",
      label: tr("keyPrev"),
      disabled: at <= 0,
      run: () => at > 0 && jump(order[at - 1]!),
    },
    {
      chord: "Enter",
      group: "message",
      label: tr("keyExpand"),
      disabled: current == null,
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      run: () =>
        current &&
        document
          .querySelector<HTMLButtonElement>(
            `.view-receipts .scast[data-sid="${CSS.escape(current)}"] .sc-x`,
          )
          ?.click(),
    },
  ];
  useKeyBindings(keys);

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={rowAddress(m)}
      {...avatarOf(m)}
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
