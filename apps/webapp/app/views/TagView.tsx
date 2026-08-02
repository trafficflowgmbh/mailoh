"use client";

/**
 * Tag view — one tag, across everything. Rows carry the place badge
 * (Ohbox / Reads / Receipts); clicking one jumps to the message in its
 * home view.
 */
import { useTranslations } from "next-intl";
import { type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { Kbd, ListPane, ListRows, MessageRow } from "@ohmail/ui";
import { avatarOf, displayTime, placeLabel, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";

export function TagView({
  tag,
  messages,
  tags,
  now,
  onOpen,
}: {
  tag: TagDTO;
  messages: EngineMessage[];
  tags: TagDTO[];
  now: Date;
  onOpen: (m: EngineMessage) => void;
}) {
  const t = useTranslations("tag");
  return (
    <section className="view center view-tag">
      <ListPane solo title={tag.name} meta={t("metaCount", { count: messages.length })}>
        <ListRows>
          {messages.length ? (
            messages.map((m) => (
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
                unread={m.unread}
                seen={!m.unread}
                threadCount={m.threadCount}
                hasAttachment={m.hasAttachments}
                protected={m.protected != null}
                tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                place={placeLabel(m.folder)}
                onClick={() => onOpen(m)}
              />
            ))
          ) : (
            <div className="empty">
              <span className="glyph">🏷</span>
              <b>{t("emptyTitle")}</b>
              {t.rich("emptyHint", { kbd: (chunks) => <Kbd>{chunks}</Kbd> })}
            </div>
          )}
        </ListRows>
      </ListPane>
    </section>
  );
}
