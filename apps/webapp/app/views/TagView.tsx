"use client";

/**
 * Tag view — one tag, across everything. Rows carry the place badge
 * (Ohbox / Reads / Receipts); clicking one jumps to the message in its
 * home view.
 */
import { useTranslations } from "next-intl";
import {
  VIEW_OF_FOLDER,
  type EngineMessage,
  type TagDTO,
} from "@mailoh/client-engine";
import { Kbd, ListPane, ListRows, MessageRow } from "@mailoh/ui";
import { displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";

const PLACE_LABEL: Record<string, string> = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
};

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
            messages.map((m) => {
              const view = VIEW_OF_FOLDER[m.folder];
              return (
                <MessageRow
                  key={m.id}
                  id={m.id}
                  from={senderName(m)}
                  address={m.from.address}
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
                  place={PLACE_LABEL[view] ?? view}
                  onClick={() => onOpen(m)}
                />
              );
            })
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
