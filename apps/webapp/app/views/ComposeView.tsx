"use client";

/**
 * COMPOSE — a new message, and the three things that were wrong with it.
 *
 * ── THE THIRD ONE, AND THE WORST ────────────────────────────────────────────────────────
 *
 * This form rendered To, Subject and an editor, and **no From at all**. The sender was resolved
 * behind it by `sendingMailboxId` — the mailbox holding the account's NEWEST MESSAGE — so on an
 * account with two connected addresses the From line flipped with whichever one last received
 * mail, and nothing on screen said which had won. With ONE address it was no better: a stranger
 * could not tell what they were writing from.
 *
 * The row is now the first field, the value is a mailbox id (never an address — aliases are a
 * later slice), and it renders as static text when there is nothing to choose. `AppShell`
 * resolves it and this file shows it, so the id on the wire and the line on the screen are one
 * object — see `compose-from.ts`.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Send was a PRIMARY button rendered `aria-disabled` with the title *"Sending is disabled in
 * the demo — no mail leaves this tab."* On a live account that sentence was simply false, and
 * it became sharper the day the inline reply started really sending: a customer who had
 * just answered a message found Compose inert, with an explanation about a demo they were not
 * in. Alongside it, three fields — the AI-draft tag, the editor placeholder and the note next
 * to Send — were read UNCONDITIONALLY out of `@ohmail/fixtures`, so `#/compose` showed a
 * paying customer strings written for a fictional demo world (invariant #6, and the rule that
 * a claim the product makes is a contract).
 *
 * ── WHAT IT IS NOW ──────────────────────────────────────────────────────────────────────
 *
 * A real compose over the SAME send path the reply uses — one `mail_send` mutation, one
 * Idempotency-Key, one four-outcome failure surface, one double-send lock (`mail-send.ts`).
 * Nothing here talks to the network and nothing here decides whether a send may go: this file
 * renders the form and reports what the state machine says. `AppShell` owns the fields (so a
 * half-written message survives leaving the view) and `compose.ts` owns the address parsing.
 *
 * NO import from `@ohmail/fixtures`, and `demo-zero-network.test.ts` now forbids one anywhere
 * under `app/` rather than trusting this comment.
 *
 * The AI-draft card above the editor is unchanged in spirit: it renders when the mirror holds
 * a `draft` entity with a body to review, which is the demo world today and the AI drafter
 * (Phase 3b) on a Cloud account later. Its label is app copy now, not a fixture string.
 */
import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { addressBook } from "@ohmail/client-engine";
import type { EngineDraft, OhmailEngine } from "@ohmail/client-engine";
import { Button, Chip, Icon, useToast } from "@ohmail/ui";
import { useKeyBindings } from "../shell/keymap";
import { go } from "../shell/routing";
import { canSend, type SendState } from "../shell/mail-send";
import { SendStatus } from "../shell/SendStatus";
import { RecipientField } from "../shell/RecipientField";
import type { ComposeFields, ComposePlan } from "../shell/compose";
import type { ResolvedFrom } from "../shell/compose-from";

export function ComposeView({
  engine,
  draft,
  fields,
  onFields,
  from,
  plan,
  send,
  onSend,
}: {
  engine: OhmailEngine;
  draft: EngineDraft | null;
  /** The form, owned by `AppShell` so it survives navigating away — see `compose.ts`. */
  fields: ComposeFields;
  onFields: (next: ComposeFields) => void;
  /**
   * WHICH ADDRESS THIS SENDS FROM — resolved by the shell, rendered here.
   *
   * The same object `plan.mutation.mailboxId` was built from, so the line on screen and the id
   * on the wire cannot be two different answers. This view does not choose; it shows the choice
   * and reports a new one, which is the same division of labour as the send state machine.
   */
  from: ResolvedFrom;
  /** The same object `canSend` judges and `onSend` dispatches. */
  plan: ComposePlan;
  send: SendState;
  onSend: () => void;
}) {
  const t = useTranslations("compose");
  const toast = useToast();
  const editorRef = useRef<HTMLTextAreaElement>(null);

  /**
   * EVERY ADDRESS THE MIRROR KNOWS, for the To field's suggestions.
   *
   * Built once per mount rather than per keystroke: it is a full pass over the message list,
   * and the set of people the user has corresponded with does not change while they are typing
   * a name. `from.address` is excluded because suggesting somebody their own address as a
   * recipient is noise — the selector cannot know whose mailbox it is reading, so the caller
   * says.
   */
  const book = useMemo(
    () => addressBook(engine.read(), { exclude: from.address ? [from.address] : [] }),
    [engine, from.address],
  );

  /**
   * Escape leaves. The complaint that Compose could not be left with the keyboard was
   * literally true: this view had no key bindings at all. `inInput` because the editor is a textarea and is focused
   * the moment a draft is accepted, so without it the one place you need the exit is the
   * one place it would not work.
   *
   * ⌘↩ SENDS, and it is registered HERE rather than in the shell's global map because the
   * global `mod+Enter` belongs to the open reply editor. A view-scope binding outranks a
   * global one (`keymap.tsx`), so in Compose this one wins, and the `?` sheet — generated from
   * the registry — shows "Send message" instead of the reply's disabled row. It calls the same
   * `onSend` the button does, so the lock, the empty-body guard and the recipient rule apply
   * identically; there is no second path to SMTP.
   */
  useKeyBindings([
    { chord: "Escape", group: "app", label: t("keyLeave"), inInput: true, run: () => go("ohbox") },
    {
      chord: "mod+Enter",
      group: "message",
      label: t("keySend"),
      inInput: true,
      // ONE rule, the button's. A typo'd recipient is already expressed as `to: []` inside the
      // mutation (`composePlan`), so there is deliberately no second term about it here.
      disabled: !canSend(send, plan.mutation),
      run: () => onSend(),
    },
  ]);

  const [discarded, setDiscarded] = useState(false);
  const cardVisible = draft != null && !draft.accepted && !discarded;

  const takeDraft = (withToast: boolean) => {
    if (!draft) return;
    // The AI draft fills the message the user is writing — subject and recipient included
    // where the draft carries them, because a draft the drafter addressed is a draft the user
    // should not have to re-address.
    onFields({
      ...fields,
      to: fields.to || draft.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", "),
      subject: fields.subject || draft.subject,
      body: draft.body,
      // Spread FIRST so `fromMailboxId` survives: taking a draft fills the message, it does not
      // re-decide who is sending it. Written as a spread rather than by naming the field so the
      // next field added to `ComposeFields` is not silently dropped here too.
    });
    void engine.mutate({ kind: "draft_accept", draftId: draft.id });
    if (withToast) toast(t("toastUseDraft"));
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  const locked = !canSend(send, plan.mutation);
  const inFlight = send.phase === "sending" || send.phase === "queued";

  return (
    <section className="view col view-compose">
      <div className="vhead">
        <h1>{t("title")}</h1>
      </div>
      <div className="scroller">
        <div className="compose-wrap">
          {/* FROM. Before To, because it is the question the reader asks first and
              because the answer used to be nowhere on this screen at all — compose resolved
              its sender from whichever mailbox had received the newest message, and said
              nothing, so on an account with two addresses the From flipped with the post.

              A CONTROL ONLY WHEN THERE IS SOMETHING TO CHOOSE. One address renders as static
              text: a select with a single option is a decision nobody has, and the point of
              this line with one mailbox is that a stranger can see what they are writing
              from. Nothing renders when the account's mailboxes cannot be named at all —
              `from.address` is null — because a From line is a claim and there is nothing to
              claim yet.

              THE VALUE IS A MAILBOX ID. `from.choices` holds sendable mailboxes only, so a
              disconnected address is never offered; the server refuses it too
              (`drafts-service.ts` → `validMailbox`), and a control that offers what the server
              refuses is an inert affordance with extra steps. */}
          {from.address !== null ? (
            <div className="c-field">
              <label htmlFor="compose-from">{t("from")}</label>
              {from.choices.length > 1 ? (
                <span className="c-select">
                  <select
                    id="compose-from"
                    className="c-input"
                    value={from.mailboxId ?? ""}
                    disabled={inFlight}
                    onChange={(e) => onFields({ ...fields, fromMailboxId: e.target.value })}
                  >
                    {from.choices.map((o) => (
                      <option key={o.id} value={o.id}>{o.address}</option>
                    ))}
                  </select>
                </span>
              ) : (
                <output id="compose-from" className="c-static">{from.address}</output>
              )}
            </div>
          ) : null}

          <div className="c-field">
            <label htmlFor="compose-to">{t("to")}</label>
            {/* The addresses this mailbox already knows, matched as you type. `book` is a
                pure selector over the local mirror — no request per keystroke, and nothing
                about what is being typed leaves the tab. See `RecipientField`. */}
            <RecipientField
              id="compose-to"
              value={fields.to}
              onChange={(next) => onFields({ ...fields, to: next })}
              book={book}
              disabled={inFlight}
              placeholder={t("toPlaceholder")}
              /* The error line below is the accessible name's partner: a field that is wrong
                 must SAY which entry is wrong, not merely refuse to enable Send. */
              invalid={plan.invalid.length > 0}
              describedBy={plan.invalid.length > 0 ? "compose-to-error" : undefined}
            />
          </div>
          {plan.invalid.length > 0 ? (
            <p className="c-error" id="compose-to-error">
              {t("toInvalid", { entries: plan.invalid.join(", ") })}
            </p>
          ) : null}

          <div className="c-field">
            <label htmlFor="compose-subject">{t("subject")}</label>
            <input
              id="compose-subject"
              className="c-input"
              type="text"
              value={fields.subject}
              readOnly={inFlight}
              onChange={(e) => onFields({ ...fields, subject: e.target.value })}
            />
          </div>

          {cardVisible ? (
            <div className="draft-card">
              <span className="draft-tag">
                <Icon name="spark" size={12} /> {t("draftTag")}
              </span>
              <div className="draft-body">{draft.body}</div>
              {draft.rationale ? (
                <div className="grounding">
                  <Chip variant="rationale">
                    <DraftGrounding text={draft.rationale} />
                  </Chip>
                </div>
              ) : null}
              <div className="draft-btns">
                <Button variant="primary" onClick={() => takeDraft(true)}>
                  {t("useDraft")}
                </Button>
                <Button onClick={() => takeDraft(false)}>{t("edit")}</Button>
                {/* REGENERATE IS GONE, and its removal is the same fix as the Send tooltip.
                    It bumped a `shimmerKey` and toasted "Draft regenerated from the same
                    sources." — no request, no new draft, the same text on screen afterwards.
                    A button that reports work it did not do is the inert-affordance class this
                    slice exists to close, and there is no drafting endpoint behind it to wire
                    instead. It comes back with Phase 3b's re-draft call, not before. */}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDiscarded(true);
                    toast(t("toastDiscard"));
                  }}
                >
                  {t("discard")}
                </Button>
              </div>
            </div>
          ) : null}

          <textarea
            ref={editorRef}
            className="compose-editor"
            aria-label={t("editorAria")}
            placeholder={t("editorPlaceholder")}
            value={fields.body}
            /* The text is never taken away from the author, not even mid-send: a failed send
               whose draft had been cleared would be a message the user has to write twice. */
            readOnly={inFlight}
            onChange={(e) => onFields({ ...fields, body: e.target.value })}
          />

          <div className="send-row">
            <Button
              variant="primary"
              disabled={locked}
              aria-busy={send.phase === "sending" || undefined}
              onClick={() => onSend()}
            >
              {send.phase === "sending" ? t("sending") : t("send")}
            </Button>
            {/* AN EMPTY SUBJECT SENDS — see `composePlan`. Said here, before the press, rather
                than as a modal after it. */}
            {plan.noSubject && !inFlight ? (
              <span className="send-note">{t("noSubject")}</span>
            ) : null}
            {/* The scratch buffer, stated exactly as strongly as it is true: this browser, not
                the mailbox. Drafts kept on the server are not built yet. */}
            <span className="send-note">{t("draftNote")}</span>
          </div>

          <SendStatus send={send} scope="compose" />
        </div>
      </div>
    </section>
  );
}

/** Bold the source spans of the grounding line, like the prototype. */
function DraftGrounding({ text }: { text: string }) {
  const marker = "Drafted from your ";
  if (text.startsWith(marker)) {
    const rest = text.slice(marker.length);
    const plus = rest.indexOf(" + ");
    if (plus >= 0) {
      return (
        <>
          {marker}
          <b>{rest.slice(0, plus)}</b>
          {rest.slice(plus)}
        </>
      );
    }
  }
  return <>{text}</>;
}
