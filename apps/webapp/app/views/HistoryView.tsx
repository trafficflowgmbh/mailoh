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
 *
 * ── TWO WAYS TO READ IT ─────────────────────────────────────────────────────────────────────
 *
 * The solo list is the resting shape and stays the default: a centred column, and opening a
 * message raises the reader sheet over it (the shell's `onOpen`, which hydrates the body
 * through the same `readerFor`-keyed effect every sheet uses). The `Split` toggle swaps that
 * for the Ohbox's own composition — a list beside a reading column — so a long look through
 * old mail does not cost a sheet per message. The two are the same rows and the same reader;
 * only WHERE the message renders changes, so the toggle is a preference and never a mode with
 * its own rules. It resets to the list each visit, because "default = the list" is the claim.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { physicalFolderOf, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { ListPane, ListRows, MessageRow, ReadColumn, SegmentedControl } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { avatarOf, displayTime, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";

type Layout = "list" | "split";

/** Below this the reading column is `display:none` (app.css), so a tap must open the sheet. */
function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches === true
  );
}

export function HistoryView({
  messages,
  tags,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
}: {
  messages: readonly EngineMessage[];
  tags: TagDTO[];
  now: Date;
  /** The reader sheet, in place — solo mode, and the mobile tap in split mode. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the split reading column's message, exactly as ReadsView hydrates `current`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /** The reading column's message verbs — the shell's `onMessageAction`. */
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("history");
  const [layout, setLayout] = useState<Layout>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The message the reading column shows — the user's pick, or the first row so the column is
   * never blank beside a list that has rows. `?? messages[0]` is safe here where it was fatal in
   * the Ohbox: History is all-read and static, so the list never re-partitions under the
   * fallback and it cannot silently re-point at a message nobody chose.
   */
  const shown =
    layout === "split" ? (messages.find((m) => m.id === selectedId) ?? messages[0] ?? null) : null;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: EngineMessage) => {
    // Solo, or the mobile split where the column is hidden: the sheet is the only reading
    // surface. A desktop split reads in the column, so a click is a selection there.
    if (layout === "split" && !readColumnHidden()) setSelectedId(m.id);
    else onOpen(m);
  };

  return (
    <section className={layout === "split" ? "view split view-history" : "view center view-history"}>
      <ListPane
        solo={layout === "list"}
        title={t("title")}
        meta={messages.length ? t("metaCount", { count: messages.length }) : undefined}
        header={
          <div className="view-mode">
            <SegmentedControl<Layout>
              role="group"
              ariaLabel={t("layoutAria")}
              value={layout}
              onChange={setLayout}
              options={[
                { id: "list", label: t("layoutList") },
                { id: "split", label: t("layoutSplit") },
              ]}
            />
          </div>
        }
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
                /* Only in the split, where a reading column makes "which one is open" a real
                   question. The solo list has no such column and highlights nothing. */
                selected={shown?.id === m.id}
                threadCount={m.threadCount}
                hasAttachment={m.hasAttachments}
                protected={m.protected != null}
                tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                /* WHERE IT ACTUALLY IS. Not a pile label: History is not a folder, and the
                   only honest badge is the server's own. */
                place={physicalFolderOf(m)}
                onClick={() => openRow(m)}
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
      {/* THE READING COLUMN — the Ohbox's own, minus the dwell it does not need: History is
          all-read, so there is no read-state to commit and nothing to arm a timer for. No
          `onEnterReader` on the pane, for the reason the Ohbox omits it — the "open reading
          mode" button it renders would sit at exactly the widths where the sheet duplicates
          this column. */}
      {layout === "split" ? (
        <ReadColumn>
          {shown ? (
            <MessagePane
              message={shown}
              tags={tags}
              now={now}
              onAction={(a) => onAction(a, shown)}
              onAddTag={onAddTag}
            />
          ) : null}
        </ReadColumn>
      ) : null}
    </section>
  );
}
