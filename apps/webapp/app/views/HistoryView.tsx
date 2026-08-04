"use client";

/**
 * HISTORY — mail from people nobody ever decided about, who then went quiet.
 *
 * Every message in this list is READ, and that is guaranteed rather than arranged: a sender
 * with any unread mail is ACTIVE whatever its age, so an unread message pulls its sender into
 * the Screener queue instead. History therefore cannot contain anything that wants attention,
 * which is why the rail entry beside it carries no count and this pane shows no unread state.
 *
 * It is not called Archive. "Archive" is a verb in every other mail client — an action this
 * mail never received — and a mailbox with a real server-side Archive folder would be shown a
 * view by that name whose contents are not that folder's.
 *
 * ── NOTHING HERE HAS MOVED ─────────────────────────────────────────────────────────────────
 *
 * This is a presentation, not a location. Every message in the list is sitting exactly where
 * the mail server has it — usually the INBOX — and every other mail client the person owns
 * still shows it there. The row states the server folder for that reason: a place the product
 * invented must not be mistaken for a place mail was put.
 */
import { useTranslations } from "next-intl";
import { physicalFolderOf, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { ListPane, ListRows, MessageRow } from "@ohmail/ui";
import { avatarOf, displayTime, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";

export function HistoryView({
  messages,
  tags,
  now,
  onOpen,
}: {
  messages: readonly EngineMessage[];
  tags: TagDTO[];
  now: Date;
  onOpen: (m: EngineMessage) => void;
}) {
  const t = useTranslations("history");
  return (
    <section className="view center view-history">
      <ListPane
        solo
        title={t("title")}
        meta={messages.length ? t("metaCount", { count: messages.length }) : undefined}
      >
        {/* ONE SENTENCE, ALWAYS PRESENT, AND ABOVE THE LIST.
            "History" is a word this product is using in a way no other mail client does, and a
            list of a thousand old messages under an unexplained heading is a list somebody has
            to guess the meaning of. It is not a dismissible first-run tip: the explanation is
            as true on the hundredth visit as the first, and a hint that disappears is a hint
            nobody can go back to. */}
        <p className="view-note">{t("explainer")}</p>
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
                /* Never unread, by construction — stated rather than passed through, so that a
                   regression in the cutline shows up here as mail that stops looking read. */
                unread={false}
                seen
                threadCount={m.threadCount}
                hasAttachment={m.hasAttachments}
                protected={m.protected != null}
                tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                /* WHERE IT ACTUALLY IS. Not a pile label: History is not a folder, and the
                   only honest badge is the server's own. */
                place={physicalFolderOf(m)}
                onClick={() => onOpen(m)}
              />
            ))
          ) : (
            <div className="empty">
              <span className="glyph">🕰</span>
              <b>{t("emptyTitle")}</b>
              {/* An empty History says what History IS, not that it is empty. Somebody
                  arriving at an empty one has learned nothing from the word alone. */}
              {t("emptyHint")}
            </div>
          )}
        </ListRows>
      </ListPane>
    </section>
  );
}
