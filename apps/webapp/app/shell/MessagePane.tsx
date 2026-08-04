"use client";

/**
 * One message anatomy for the Ohbox read column AND the reader overlay:
 * from-line, subject, chips (routing rationale, tracker shield, tags,
 * add-affordance), body or the protected-OTP block, attachment, actions.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FOLDER_OF_VIEW, type EngineMessage, type OhmailView, type TagDTO } from "@ohmail/client-engine";
import { Button, Chip, Icon, Kbd, ProtectedBlock, ReadingPane } from "@ohmail/ui";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { MessageBody } from "../components/MessageBody";
import { ConversationEntries, ConversationHead } from "./Conversation";
import { PLACE_LABEL, avatarHue, displayTime, hueOf, initialsOf, metaLine, rowAddress, senderName, tagsOfMessage } from "./format";
import { InlineReply } from "./InlineReply";
import { chordKeys, useBinding, useKeyPress } from "./keymap";
import { useMessageChrome } from "./message-chrome";
import "./action-bar.css";

/**
 * MOVE CARRIES ITS DESTINATION (gap C4).
 *
 * It used to be a bare `"move"` that AppShell answered with a toast reading "Demo — Move
 * isn't wired yet." — on live, paying accounts. The mutation it needed has been on the
 * wire the whole time (`POST /messages/:id/move`, contract-tested), and the only thing
 * missing was a destination, so the action carries one. A template member rather than a
 * second callback argument: every pass-through of `onAction` keeps compiling unchanged.
 */
export type MoveTarget = Extract<OhmailView, "ohbox" | "reads" | "receipts" | "screened" | "spam">;
/**
 * `"unread"` is the FALLBACK arm of the read toggle, not its normal path — see
 * {@link ActionBar}. The shell answers it by dispatching the same `mark_seen` the `u` key
 * dispatches; it is reached only where `u` is not bound (the desktop shell, a test with no
 * keymap provider), and it is deliberately a toggle rather than a direction so that no
 * caller has to know the current state to use it correctly.
 */
export type MessageAction =
  | "reply"
  | "later"
  | "aside"
  | "resurface"
  | "draft"
  | "unread"
  | `move:${MoveTarget}`;

/** The DecisionBar's vocabulary, so filing means the same thing everywhere. */
export const MOVE_TARGETS: MoveTarget[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * THE SAME VERBS, OVER A SELECTION (slice U5-BULK, gap U5d).
 *
 * Declared beside {@link MessageAction} rather than in the view that renders the bulk bar,
 * because the point of the slice is that there is ONE vocabulary. The owner's selection
 * offered ⇧U and Escape; what it gets is the action bar's own grouping minus the one verb
 * that cannot mean anything over a set.
 *
 *   · `later` / `aside` / `resurface` — the three horizons, unchanged in meaning.
 *   · `move:<view>` — this message, relocated. Per message, no rule.
 *   · `read` / `unread` — DIRECTIONS, not a toggle, and that is the one deliberate
 *     divergence from the single-message bar. `MessageAction["unread"]` is a flip because
 *     one message has a read state to flip; a selection has a MIXED one, and "toggle eleven
 *     messages" would mark six read and five unread in a gesture that reads as one decision.
 *
 * Screening is NOT in this union. It is a decision about senders with a consent ceremony of
 * its own (a confirm row stating what will persist), so it travels as its own callback —
 * folding it in here would be the design error the ruling names by name.
 */
export type BulkAction =
  | "later"
  | "aside"
  | "resurface"
  | "read"
  | "unread"
  | `move:${MoveTarget}`;

/**
 * Which sub-row has taken the bar's place, if any. `null` is the resting bar.
 *
 * It was a `moving` boolean until O13. A second disclosure (More) made two booleans able to
 * be true at once, which is a state the bar has no rendering for — a union cannot express it.
 */
type BarPanel = "move" | "more";

/**
 * A verb's keycap, READ FROM THE LIVE REGISTRY (slice O13).
 *
 * Renders nothing when nothing is bound to `chord` here, which is the whole point: the bar
 * cannot advertise a key that does not work, and it cannot go stale when a chord moves.
 * `chordKeys` is the same notation the `?` sheet prints, so `⌘`/`⇧`/`↵` would render
 * identically in both places if a bar verb ever took a modifier.
 *
 * This replaces `kbdHint="s"` — one hand-typed hint on one of eight buttons, which is what
 * the owner saw as a stray `s` in the label row.
 */
function Key({ chord }: { chord: string }) {
  const binding = useBinding(chord);
  if (!binding) return null;
  return <Kbd>{chordKeys(chord).join(" ")}</Kbd>;
}

/**
 * ═══ THE ACTION BAR (slice O13) ═══════════════════════════════════════════════════════
 *
 * Owner, reading their own mail: *"it breaks a line and doesn't show shortcuts and my
 * feedback already given, allow mark read / unread in it intelligently"*.
 *
 * ── THE GROUPING, WHICH IS THE ACTUAL FIX ─────────────────────────────────────────────
 *
 * The eight buttons this replaces were eight peers in one wrapping row, and they are not
 * eight peers. They answer three different questions, and one of the three was being asked
 * three times:
 *
 *   · ANSWER IT      — Reply (the accent verb), Draft reply (the AI variant, in More).
 *   · NOT NOW        — Answer Later, Park, Resurface. **The same idea at three horizons**,
 *                      so they are ONE segmented control with hairlines between the
 *                      segments, not three siblings competing with Reply for weight.
 *   · FILE IT        — Screening (this SENDER's future mail) and Move (THIS message).
 *                      One control, two scopes, which is exactly why they belong adjacent
 *                      and exactly why they must stay two buttons: U3 put Screening here
 *                      because "where does this sender's mail go" had no control outside
 *                      the Screener, and folding it into Move would undo that.
 *
 * and beside them, not among them, the READ SWITCH — a state, not a decision about where
 * mail goes, so it is separated by `margin-left:auto` rather than by a divider.
 *
 * Layout is in `action-bar.css`; the rule that matters is that a group is atomic, so the
 * row cannot break mid-group at any width. What a narrow container drops is whole groups,
 * into More.
 *
 * ── EVERY VERB SHOWS ITS KEY, AND NOT BY BEING TOLD ───────────────────────────────────
 *
 * Each `<Key chord>` asks the registry. Before this the bar carried exactly one hint —
 * `kbdHint="s"`, typed at the call site — while `r`, `a`, `e`, `b` and `u` were all live
 * and silent. That single hint is the stray `s` in the owner's report: not a bug in the
 * label, a bug in the label row having only one keycap in it.
 *
 * ── AND THE READ SWITCH DOES NOT FIGHT THE READER (gap O9, and U1's dwell) ────────────
 *
 * `u` is already bound, in `OhboxView`, and marking unread there sets a `pinnedUnread` ref
 * that the 2 s dwell checks WHEN ITS TIMER FIRES — the guard
 * `ohbox-read-state.test.ts` calls *"`u` is not undone by a dwell that is already
 * ticking"*. A button that dispatched `mark_seen` on its own would have no way to set that
 * pin, so a click on it inside the dwell window would be reverted two seconds later by the
 * heuristic: the exact defect that test exists to prevent, reintroduced through a new door.
 *
 * So the switch does not re-implement the verb — **it presses the key**. One handler, one
 * pin, one place where "reading has happened" is decided. `onAction("unread")` is the
 * fallback for surfaces where `u` is not bound at all (the desktop shell, a pane mounted
 * with no keymap provider), and it is the only arm that can drift, which is why it is the
 * arm that is never taken in the product.
 */
function ActionBar({
  message,
  panel,
  onPanel,
  onAction,
  onScreen,
}: {
  message: EngineMessage;
  panel: BarPanel | null;
  onPanel: (next: BarPanel | null) => void;
  onAction: (action: MessageAction) => void;
  onScreen: (anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");
  const press = useKeyPress();

  /**
   * A label whose key is not in `messages/en.json` yet.
   *
   * This slice may not edit that file — another executor holds it — so the new copy is
   * reported for the owner to apply and read through `t.has` until it lands. The fallback
   * is the SAME wording that was reported, and en.json wins the moment the key exists, so
   * this cannot become a second source of copy: it is a shim with one exit, not a default.
   */
  const copy = (key: string, reported: string): string => (t.has(key) ? t(key) : reported);

  /**
   * Marking read/unread — the key's own handler wherever the key exists. See the header.
   *
   * `press` and NOT `useBinding("u")?.run()`. The second is what this was, and it was wrong
   * in a way only a browser showed: two presses in a row marked the message read twice,
   * because the memoised binding array holds closures from the last SHAPE change and `u`'s
   * shape does not change when read-state does. `press` resolves the handler when it is
   * called, exactly as the keydown dispatcher does. See `Registry.press`.
   */
  const toggleRead = () => {
    if (!press("u")) onAction("unread");
  };

  const defer = (
    <>
      {/* "Later", not "Answer Later". Inside a control whose own name is "Not now", each
          segment need only carry its HORIZON — the shared idea is said once, by the group,
          instead of three times by its members. It is also the 45px that decides whether
          filing fits on the row at the 569px the reading measure allows. */}
      <button type="button" className="abar-b" onClick={() => onAction("later")}>
        {copy("actionLater", "Later")}
        <Key chord="a" />
      </button>
      <button type="button" className="abar-b" onClick={() => onAction("aside")}>
        {t("actionSetAside")}
        <Key chord="e" />
      </button>
      <button type="button" className="abar-b" onClick={() => onAction("resurface")}>
        {t("actionResurface")}
        <Key chord="b" />
      </button>
    </>
  );

  /* U3. "Move" relocates THIS message; screening decides where this SENDER's mail goes,
     which is a different question and had no control anywhere outside the Screener.
     The anchor is the BUTTON — not a list row found by selector — because in the reader
     sheet the row is behind the overlay and a popover would open under it. */
  const file = (
    <>
      <button
        type="button"
        className="abar-b"
        onClick={(e) => onScreen((e.currentTarget as HTMLElement | null) ?? null)}
      >
        {tr("action")}
        <Key chord="s" />
      </button>
      <button type="button" className="abar-b" onClick={() => onPanel("move")}>
        {t("actionMove")}
      </button>
    </>
  );

  if (panel === "move") {
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{t("moveLabel")}</span>
          {MOVE_TARGETS.filter((v) => FOLDER_OF_VIEW[v] !== message.folder).map((v) => (
            <button
              key={v}
              type="button"
              className="abar-b abar-solo"
              onClick={() => {
                onPanel(null);
                onAction(`move:${v}`);
              }}
            >
              → {PLACE_LABEL[v] ?? v}
            </button>
          ))}
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  if (panel === "more") {
    /* The panel REPLACES the bar rather than growing it, which is the pattern Move already
       used. Its members are hidden by the same container queries that put them in the row,
       from the other side — so a verb is in the row or in this panel and never in both. */
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{copy("actionMore", "More")}</span>
          <span className="abar-pg abar-p-defer">{defer}</span>
          <span className="abar-pg abar-p-file">{file}</span>
          <button type="button" className="abar-b abar-solo" onClick={() => onAction("draft")}>
            <Icon name="spark" size={13} />
            {t("actionDraftReply")}
          </button>
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  const read = !message.unread;
  return (
    <div className="abar">
      <div className="abar-row">
        <div className="abar-g">
          <button
            type="button"
            className="abar-b abar-solo primary"
            onClick={() => onAction("reply")}
          >
            {t("actionReply")}
            <Key chord="r" />
          </button>
        </div>

        <div
          className="abar-g abar-seg abar-defer"
          role="group"
          aria-label={copy("groupDefer", "Not now")}
        >
          {defer}
        </div>

        <div
          className="abar-g abar-seg abar-file"
          role="group"
          aria-label={copy("groupFile", "File it")}
        >
          {file}
        </div>

        <div className="abar-g abar-read-g">
          {/*
           * `role="switch"` and not a pair of buttons: O9 ruled the control must "state the
           * current state", because a one-way "Mark read" leaves no way back and mislabels
           * itself the moment it has been pressed. A switch labelled "Read" reports the
           * state in its label AND in `aria-checked`, and what pressing it does is in the
           * title — which is the only wording that has to change with the state.
           */}
          <button
            type="button"
            role="switch"
            aria-checked={read}
            className="abar-b abar-solo abar-read"
            title={read ? copy("actionMarkUnread", "Mark unread") : copy("actionMarkRead", "Mark read")}
            onClick={toggleRead}
          >
            <span className="abar-dot" aria-hidden="true" />
            {copy("actionRead", "Read")}
            <Key chord="u" />
          </button>

          {/*
           * ICON-ONLY, and that is a measurement rather than a preference: dropping the word
           * "More" is 35px, and 35px is the difference between filing standing on the row at
           * the 569px reading measure and being pushed into this menu itself. A disclosure is
           * the one control here whose meaning survives without a label — pressing it is the
           * only thing it can do — so it is the right 35px to spend. The name is not lost,
           * it moves to `aria-label` and the tooltip.
           */}
          <button
            type="button"
            className="abar-b abar-solo abar-more"
            aria-haspopup="true"
            aria-expanded={false}
            aria-label={copy("actionMore", "More")}
            title={copy("actionMore", "More")}
            onClick={() => onPanel("more")}
          >
            <Icon name="chev" size={12} className="abar-chev" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Protected — …" renders with the leading word bolded, like the prototype. */
function ProtectedPolicy({ text }: { text: string }) {
  const dash = text.indexOf(" — ");
  if (dash < 0) return <>{text}</>;
  return (
    <>
      <b>{text.slice(0, dash)}</b>
      {text.slice(dash)}
    </>
  );
}

export function MessagePane({
  message,
  tags,
  now,
  onEnterReader,
  onAction,
  onAddTag,
}: {
  message: EngineMessage;
  tags: TagDTO[];
  now: Date;
  onEnterReader?: () => void;
  onAction: (action: MessageAction) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");
  /** The conversation's copy lives with the reply's — one namespace owns the thread. */
  const tc = useTranslations("reply");
  /** Hydration state copy, shared with the Reads/Receipts cards and the Screener preview. */
  const tb = useTranslations("body");
  const addRef = useRef<HTMLSpanElement>(null);
  const isProtected = message.protected != null;
  const mine = tagsOfMessage(message, tags);
  const [panel, setPanel] = useState<BarPanel | null>(null);
  const chrome = useMessageChrome();

  // A half-open destination row must not carry over to the next message.
  useEffect(() => setPanel(null), [message.id]);

  /**
   * THE CONVERSATION (slice P6b) — oldest first, empty when there is no conversation.
   *
   * Computed on every render rather than memoised: the value it derives from is the engine
   * mirror, which has no signal reachable from here (this pane deliberately holds no engine
   * hook — see `message-chrome.tsx`). The shell re-renders this pane on every version bump,
   * so an inline call is always fresh and a `useMemo` with no version dep would go stale
   * the first time a delta landed.
   */
  const conversation = chrome.conversationOf(message.id);
  const replying = chrome.replyTo === message.id;
  /**
   * ONE COPY OF THE CONVERSATION ON SCREEN, EVER — AND IT IS THIS ONE (slice U5-REPLY).
   *
   * Owner, verbatim: *"replying repeats the message which is already visible, this is
   * redundant.."*
   *
   * This read `conversation.length > 0 && !replying` until U5-REPLY, because the editor
   * below carried its own `.reply-context` scroller over the same list. The two copies of
   * the LIST were never up at once — but the copy that mattered was the focused message's
   * body, and that one was: once here as `.msg-body`, once again inside the editor's quote,
   * in one scrolling column, with the textarea pushed below a duplicate of the text the
   * reader had just finished. Redundant is exactly the word.
   *
   * The ownership is inverted now. The pane keeps the conversation, in full message anatomy,
   * whether or not the editor is open; `InlineReply` renders no mail at all. So "scroll
   * through the actual email conversation" is answered by the actual conversation instead of
   * by a 190px quote of it.
   *
   * NOTHING HERE TOUCHES THE WIRE. The payload is still `{inReplyTo, body}` with `body`
   * exactly what was typed (`http-adapter.ts` `mailSend`); quoting the parent would put its
   * text into outgoing mail, and a sensitive parent carries `no_forward` with a redacted
   * stored body (invariant #1). This slice changed what the SCREEN shows and nothing else.
   */
  const showConversation = conversation.length > 0;
  /**
   * The from-line count. Real on Cloud now; the fixture fallback stays because the demo
   * world sets `threadId: null` on every row (`fixtures-adapter.ts`) and carries a curated
   * `threadCount` instead — dropping it would delete chrome the demo ships today.
   */
  const threadCount = conversation.length >= 2 ? conversation.length : message.threadCount;

  /**
   * THE BODY, HYDRATED (slice U5-BODY).
   *
   * This pane used to render `message.body ?? message.snippet` — and it was the surface that
   * made the defect hardest to see, because a snippet inside full message anatomy LOOKS like
   * a short email rather than like a truncation. `bodyOf` reaches the `message_body` record
   * the shell hydrated on selection, and carries the state so the two failure modes can say
   * so beneath the text instead of passing as the mail.
   */
  const body = chrome.bodyOf(message);

  /**
   * INVARIANT #1, AND IT IS THIS BRANCH.
   *
   * `isProtected` is checked FIRST and `body` is not consulted inside it: a protected
   * message renders the block and no text at all, whatever the mirror or a hydration
   * happens to hold for it. The endpoint's own text is already redacted server-side
   * (`message-service.ts` `getBody`), so hydration cannot introduce a secret here — but
   * "the text we were given is safe" and "this pane does not render a protected message's
   * text" are two different guarantees, and the second is the one a reader can see.
   *
   * AND SINCE O11 IT IS THE ONLY EXPRESSION THAT RENDERS THE MAIL HERE. This pane used to hand
   * `ReadingPane` a `body` STRING whenever there was no conversation — a third render path, and
   * the one most messages took, which `ReadingPane` drew as its own `<p className="msg-body">`.
   * A body fix that only reached `focusedBody` would have been invisible on exactly the common
   * case. `children` replaces `body` in `ReadingPane`, so the pane composes that slot itself
   * now, always, and the `body` prop is not passed in any case.
   */
  const focusedBody = isProtected ? (
    <ProtectedBlock
      label={message.protected!.label}
      redactedNote={message.protected!.redactedNote}
      policy={<ProtectedPolicy text={message.protected!.policy} />}
    />
  ) : (
    /* O11 — a `<div>` rather than the `<p>` this was, because `BodyText` emits the paragraphs
       now and a `<p>` may not contain one. `.msg-body` is unchanged and stays the one element
       that holds the mail and nothing else, which is what `conversation.test.ts` and
       `inline-reply.test.ts` select on and what a reader is entitled to assume. */
    <div className="msg-body">
      <MessageBody text={body.text} html={body.html} remoteLoaded={body.loadedRemoteContent} />
    </div>
  );

  /*
   * O18 — the strip travels WITH the body, so every place that renders the focused message
   * gets it and none of them has to remember. `isProtected` gates it for the same reason the
   * body is gated above: invariant #1 says this pane renders no protected content, and a file
   * a sender attached is content.
   */
  const attachments = isProtected ? undefined : chrome.attachments;
  const focusedMessage = (
    <>
      {focusedBody}
      {attachments ? (
        <AttachmentStrip
          items={attachments.itemsOf(message.id)}
          onOpen={(attachmentId) => attachments.open(message.id, attachmentId)}
          onDownloadAll={() => attachments.downloadAll(message.id)}
          downloadingAll={attachments.downloadingAll(message.id)}
        />
      ) : null}
    </>
  );

  /**
   * Said only for the two states that are not the mail. `snippet` — asked for nothing yet —
   * is a sub-frame state in this pane, because the shell hydrates on selection; and a
   * protected message has no body to be waiting for.
   *
   * THE FAILURE CARRIES A CONTROL, not only a sentence. The stream cards recover on their
   * own (re-expand, or scroll back and become current again); this pane's hydration is keyed
   * on the selected id, so without a button a single 500 leaves the body unreachable until
   * the user selects away and returns — a dead end nobody would guess the exit from.
   */
  const bodyNote =
    isProtected || body.state === "full" || body.state === "snippet" ? undefined : body.state ===
      "loading" ? (
      tb("loading")
    ) : (
      <>
        {tb("failed")}{" "}
        {/* `retry` because this IS a human asking again. An automatic trigger deliberately
            does not re-ask a server that already refused — see `hydrateBody`. */}
        <Button variant="ghost" onClick={() => chrome.hydrateBody(message.id, { retry: true })}>
          {tb("retry")}
        </Button>
      </>
    );

  return (
    <ReadingPane
      from={senderName(message)}
      address={rowAddress(message)}
      avatarInitial={initialsOf(senderName(message))}
      avatarHue={avatarHue(message.from.address)}
      onSender={(anchor) => chrome.openSenderMenu(message.id, anchor)}
      senderTitle={tr("openFor", { sender: message.from.address })}
      /* UX9 — `threadMeta` used to be the literal "thread ({count}) · " and this was a
         concatenation, so a message with no `Date:` header rendered "thread (3) · " with
         nothing after the separator, and a threadless one rendered an empty stamp. The key no
         longer carries the punctuation and `metaLine` prints a separator only between two
         values that exist. */
      time={metaLine(threadCount ? t("threadMeta", { count: threadCount }) : null, displayTime(message, now))}
      subject={message.subject}
      onEnterReader={onEnterReader}
      chips={
        <>
          {message.rationale ? <Chip variant="rationale">{message.rationale}</Chip> : null}
          {message.trackerNote ? <Chip variant="tracker">{message.trackerNote}</Chip> : null}
          {mine.map((tag) => (
            <Chip key={tag.id} variant="tag" hue={hueOf(tag)} big>
              {tag.name}
            </Chip>
          ))}
          <span ref={addRef} style={{ display: "inline-flex" }}>
            <Chip
              variant="add"
              kbdHint="t"
              onPress={() => onAddTag(message.id, addRef.current)}
            >
              {t("tagChip")}
            </Chip>
          </span>
        </>
      }
      bodyNote={bodyNote}
      bodyNoteFailed={body.state === "failed"}
      actions={
        <ActionBar
          message={message}
          panel={panel}
          onPanel={setPanel}
          onAction={onAction}
          onScreen={(anchor) => chrome.openSenderMenu(message.id, anchor)}
        />
      }
      reply={
        replying ? (
          <InlineReply
            /* NO `context` AND NO `now` SINCE U5-REPLY. The editor was handed the whole
               conversation (or `[message]`) to render in its own scroller; the pane above
               owns that job now, so the editor takes the message it is answering and
               nothing else — the `to` line, the draft key and `canSend` are all it needs
               a message FOR. */
            message={message}
            value={chrome.replyBody}
            send={chrome.replySendState(message.id)}
            onChange={chrome.onReplyBody}
            onClose={chrome.closeReply}
            onSend={() => chrome.sendReply(message.id)}
          />
        ) : undefined
      }
    >
      {/* THE CONVERSATION IN THE MESSAGE (P6b).
          Oldest first, and the message you opened keeps the full anatomy — plain prose
          between carded siblings — so which one is focused needs no legend. Siblings older
          than it sit above and newer ones below, which means the stack reads in order
          whichever message was opened, not only the newest. */}
      {showConversation ? (
        // `role="group"` because `aria-label` on a bare div is ignored, and a landmark
        // (`<section>`) would be too loud for one part of one message.
        <div className="conv" role="group" aria-label={tc("conversationAria")}>
          <ConversationHead count={conversation.length} />
          <ConversationEntries
            messages={conversation.filter((m) => before(m, message))}
            threadSubject={message.subject}
            now={now}
          />
          <div className="conv-focus" data-conv-id={message.id} aria-current="true">
            {focusedMessage}
          </div>
          <ConversationEntries
            messages={conversation.filter((m) => m.id !== message.id && !before(m, message))}
            threadSubject={message.subject}
            now={now}
          />
        </div>
      ) : (
        // O11: `focusedBody`, not `isProtected ? focusedBody : undefined`. The `undefined` arm
        // was what fell through to `ReadingPane`'s own `body` string; `focusedBody` already
        // answers both cases, and invariant #1 is unmoved — it is decided where it always was,
        // by the `isProtected` branch at the top of this component, which is still first and
        // still never consults `body`.
        focusedMessage
      )}
    </ReadingPane>
  );
}

/**
 * Is `m` earlier in the conversation than the opened message?
 *
 * The comparison is on the ORDER `threadOf` already sorted by — date, id as the tiebreak —
 * rather than on dates alone, so a thread whose messages share a timestamp (a seeded or
 * imported chain) still splits at exactly one place and never renders a message twice or
 * not at all. The opened message itself is never "before" itself.
 */
function before(m: EngineMessage, focused: EngineMessage): boolean {
  const tm = m.date ? Date.parse(m.date) : 0;
  const tf = focused.date ? Date.parse(focused.date) : 0;
  if (tm !== tf) return tm < tf;
  return m.id < focused.id;
}
