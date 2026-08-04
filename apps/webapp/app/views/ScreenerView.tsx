"use client";

/**
 * Screener — the fourth two-pane view: waiting senders as rows on the
 * left, the sender's actual held mail on the right under the sticky
 * decision bar. One click files; each ✓ half files and marks read; the
 * AI destination is preselected so y accepts it. Screened-out senders
 * stay reversible; auto-detected spam is held viewable, never deleted
 * silently. On mobile the preview opens full-screen.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { BodyState, ScreenerSenderDTO } from "@ohmail/client-engine";
import {
  Button,
  DecisionBar,
  DECISION_DONE_LABEL,
  DECISION_KEY,
  Icon,
  Kbd,
  ListPane,
  ListRows,
  MessageRow,
  SegmentedControl,
  type DecisionDestination,
  type DecisionScope,
} from "@ohmail/ui";
import { avatarHue } from "../shell/format";
import { useLoadingGrace } from "../shell/loading-grace";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { goScreener, type ScreenerSegmentId } from "../shell/routing";
import type { ScreenerState, SpamRow } from "../shell/screener-state";

/**
 * The three empty states.
 *
 * The copy used to be read from `@ohmail/fixtures` and rendered on every account, demo or not.
 * It happened to be brand-neutral English, so nobody noticed — but the defect is the import,
 * not the wording: the fixtures package is Mila's world, it is the ONE place in this repo where
 * invented people and invented brands are allowed to live, and a live surface reading strings
 * out of it has no way to stay honest as those strings change. It is app copy, so it lives with
 * the app's copy. `demo-zero-network.test.ts` now forbids the import class outright.
 */
function Empty({ segment, settled }: { segment: ScreenerSegmentId; settled: boolean }) {
  const t = useTranslations("screener");
  const speak = useLoadingGrace(!settled);
  /**
   * ── "No one's waiting." IS A FACT ABOUT SENDERS, NOT ABOUT THIS LIST ──────────────────
   *
   * The live truth suite caught this pane on a real account: *"the Screener is empty — 0 rows,
   * meta 'all clear' — on a mailbox seeded with dozens of unique first-contact senders"*, while
   * the database held 323 messages in that pile. The rows come from the mirror
   * (`shell/screener-state.ts` reads `engine.read()`), and before the mirror has been read there
   * are no senders to have an opinion about. Every sentence below asserts one.
   *
   * So the three settled states are held back until {@link MailState.settled}, and what is shown
   * instead names the situation and nothing else — no invented sender, no placeholder row. See
   * `OhboxView`'s `SyncState`, which this mirrors deliberately: one defect, one shape of answer.
   */
  if (!settled) {
    return (
      <div className="empty" role="status" aria-busy="true">
        {/* `.mbx-wait` and not a bare span: `.mbx-spin` sizes itself with `width`/`height` and
            is a `<span>`, so it needs a flex parent or the border collapses to a dot. That
            pairing — spinner beside one muted line — is exactly what `.mbx-wait` already is
            (`app.css`, beside the Settings rows), and reusing it adds no CSS and inherits the
            `prefers-reduced-motion` answer the ring already has. Same reuse `SyncBar` makes,
            for the same reason and with the same note about the `mbx-` prefix. */}
        <span className="mbx-wait">
          <span className="mbx-spin" aria-hidden="true" />
          {speak ? <b>{t("loading")}</b> : null}
        </span>
      </div>
    );
  }
  const key = segment === "screened" ? "screened" : segment;
  return (
    <div className="empty">
      <span className="glyph">{t(`empty.${key}.glyph`)}</span>
      <b>{t(`empty.${key}.title`)}</b>
      {t(`empty.${key}.hint`)}
    </div>
  );
}

export function ScreenerView({
  state,
  segment,
  selection,
  settled,
  onSelect,
  hydrateBody,
  full,
  onFull,
}: {
  state: ScreenerState;
  segment: ScreenerSegmentId;
  selection: Record<ScreenerSegmentId, string | null>;
  /**
   * May this view state its emptiness as a fact yet? Derived once in `shell/mail-state.ts`; a
   * prop for the reason it is one on `OhboxView`. See {@link Empty}.
   */
  settled: boolean;
  onSelect: (segment: ScreenerSegmentId, id: string | null) => void;
  /** Ask for one held message's body. `retry` marks a human asking again (slice U5-BODY). */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  full: boolean;
  onFull: (full: boolean) => void;
}) {
  const t = useTranslations("screener");
  const [scopes, setScopes] = useState<Map<string, DecisionScope>>(() => new Map());
  const [choosing, setChoosing] = useState<"allow" | "notspam" | null>(null);

  const items: Array<ScreenerSenderDTO | SpamRow> =
    segment === "waiting"
      ? state.waiting
      : segment === "screened"
        ? state.screenedOut
        : state.spam;

  const idOf = (x: ScreenerSenderDTO | SpamRow) =>
    "pinned" in x ? x.sender.id : x.id;
  const ids = items.map(idOf);
  const activeId = (() => {
    const sel = selection[segment];
    // Exiting rows stay visible but are no longer selectable targets.
    const selectable =
      segment === "waiting" ? ids.filter((id) => !state.isExiting(id)) : ids;
    if (sel && selectable.includes(sel)) return sel;
    return selectable[0] ?? null;
  })();

  const current = items.find((x) => idOf(x) === activeId) ?? null;
  const scopeOf = (s: ScreenerSenderDTO): DecisionScope =>
    scopes.get(s.id) ?? s.scope ?? "sender";

  // Preview scrolls back to top whenever the subject changes.
  useEffect(() => {
    setChoosing(null);
    document.querySelector(".view-screener .scn-read")?.scrollTo({ top: 0 });
  }, [activeId, segment]);

  // Mobile full-screen preview hides the dock (prototype scn-full).
  useEffect(() => {
    document.body.classList.toggle("scn-full-open", full);
    return () => document.body.classList.remove("scn-full-open");
  }, [full]);

  /**
   * THE SELECTED SENDER'S HELD MAIL, IN FULL (slice U5-BODY).
   *
   * `ScreenerSenderDTO.held` has claimed "every held message, in full" since it was written,
   * and on a live account the claim was false: every row is derived, so every body was the
   * snippet and the consent decision was being taken on one line of text. Hydrating the
   * selected sender's held list is what makes the claim true — and it reduces the chance of
   * deciding WRONGLY, which is the only reason this pile gets its bodies by default while
   * Reads and Receipts stay collapsed.
   *
   * ── BOUNDED BY `held.length`, AND BY THE SELECTION ─────────────────────────────────────
   *
   * One sender at a time, never the queue. A waiting Screener holds one sender per stranger
   * and typically one to three messages each; the whole segment could be hundreds. The
   * `.join` in the dep list keys on the exact ids, so the effect re-runs when the selection
   * moves and not when a body lands — the record write bumps the mirror version, and a
   * dependency on that would re-enter this loop once per arriving body.
   *
   * ── AND IT IS THE ONLY THING SELECTION DOES ────────────────────────────────────────────
   *
   * Reading held mail stays SIDE-EFFECT-FREE: no `mark_seen`, no dwell timer, no waterline.
   * `hydrateBody` is a GET and writes nothing but a client-local record. The ⇧-twins in the
   * decision keys exist precisely because plain filing does not mark held mail read, and a
   * preview that marked it read on sight would make that distinction meaningless.
   */
  const heldIds = current && !("pinned" in current)
    ? current.held.map((h) => h.id)
    : current
      ? current.sender.held.map((h) => h.id)
      : [];
  const heldKey = heldIds.join(",");
  useEffect(() => {
    for (const id of heldKey ? heldKey.split(",") : []) hydrateBody(id);
  }, [heldKey, hydrateBody]);
  /** A human asking again — the only path allowed to re-ask a server that refused. */
  const retryBody = (id: string) => hydrateBody(id, { retry: true });

  const decideCurrent = (dest: Parameters<ScreenerState["decide"]>[1], read: boolean) => {
    if (!current || "pinned" in current) return;
    const next = ids.filter((id) => id !== current.id && !state.isExiting(id));
    state.decide(current, dest, { read, scope: scopeOf(current) });
    onSelect("waiting", next[0] ?? null);
  };

  /**
   * The Screener's keys, DECLARED (slice U2).
   *
   * y/o/r/c/n/x used to live inside `DecisionBar`'s own `document` listener, which meant
   * the shell could not know that `c` is Receipts here and Compose everywhere else — it
   * carried a `screenerOwnsC` special case that reached into this view's state to guess.
   * The bar keeps its `keyboard` prop for other consumers; this view no longer passes it,
   * and the same six keys are a view layer that wins by the registry's own precedence
   * rule. They are also, for the first time, in the `?` sheet.
   */
  const waiting = segment === "waiting";
  const selectable = waiting ? ids.filter((id) => !state.isExiting(id)) : ids;
  const at = activeId ? Math.max(0, selectable.indexOf(activeId)) : 0;
  const step = (next: number) => {
    const id = selectable[next];
    if (!id) return;
    onSelect(segment, id);
    document
      .querySelector(`.view-screener .row[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  const decidable = waiting && current != null && !("pinned" in current);
  /**
   * Enter means "accept THE SUGGESTION", so it exists only when there is one.
   *
   * It read `current.ai?.dest ?? "ohbox"`, which on a live account made Enter a silent
   * "file to Ohbox" wearing the label "accept the suggested destination". The five
   * destination keys (o/r/c/n/x) are unaffected — those name what they do.
   */
  const suggested = decidable ? (current as ScreenerSenderDTO).ai : null;

  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: at >= selectable.length - 1,
      run: () => step(at + 1),
    },
    {
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: at <= 0,
      run: () => step(at - 1),
    },
    {
      chord: "Escape",
      group: "screener",
      label: t("keyLeaveFull"),
      disabled: !full,
      run: () => onFull(false),
    },
    {
      chord: "Enter",
      group: "screener",
      label: t("keyAccept"),
      disabled: !suggested,
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      run: (e) => suggested && decideCurrent(suggested.dest as never, e.shiftKey),
    },
    {
      chord: "a",
      group: "screener",
      label: t("keyApplyAll"),
      // Same gate as the button, so the `?` sheet stops listing a key that would decide
      // 1 045 senders by falling back to a destination nobody suggested.
      disabled: !waiting || state.suggestedCount === 0,
      run: () => state.applyAll(scopeOf),
    },
    {
      chord: "s",
      group: "screener",
      label: t("keyAllSpam"),
      disabled: !waiting || state.waitingCount === 0,
      run: () => state.markAllSpam(scopeOf),
    },
    // The five destinations, and their ⇧ twins that also mark the held mail read.
    ...(["ohbox", "reads", "receipts", "screened", "spam"] as DecisionDestination[]).flatMap(
      (dest): KeyBinding[] => [
        {
          chord: DECISION_KEY[dest],
          group: "screener",
          label: t("keyFile", { dest: DECISION_DONE_LABEL[dest] }),
          disabled: !decidable,
          run: () => decideCurrent(dest as never, false),
        },
        {
          chord: `shift+${DECISION_KEY[dest]}`,
          group: "screener",
          label: t("keyFileRead", { dest: DECISION_DONE_LABEL[dest] }),
          disabled: !decidable,
          run: () => decideCurrent(dest as never, true),
        },
      ],
    ),
  ];
  useKeyBindings(keys);

  const selectRow = (id: string) => {
    onSelect(segment, id);
    if (window.matchMedia("(max-width: 900px)").matches) onFull(true);
  };

  const row = (x: ScreenerSenderDTO | SpamRow) => {
    if (segment === "waiting") {
      const w = x as ScreenerSenderDTO;
      // Both fields come from the SAME message — the newest one, which is what
      // `w.time` already is. Pairing `w.time` with `held[0].subject` described a
      // message that does not exist (Lena's 08:40 stamp over her 08:12 subject).
      // Screened and spam rows already summarise the newest held message.
      const newest = newestHeld(w);
      return (
        <MessageRow
          key={w.id}
          id={w.id}
          from={w.from.name || w.from.address}
          address={w.from.name ? w.from.address : undefined}
          time={newest?.time ?? w.time}
          subject={newest?.subject ?? ""}
          avatarInitial={w.initial}
          avatarHue={avatarHue(w.from.address)}
          dull={w.dull}
          selected={w.id === activeId}
          className={state.isExiting(w.id) ? "out" : undefined}
          aiSuggestion={
            w.ai
              ? {
                  destLabel: DECISION_DONE_LABEL[w.ai.dest as keyof typeof DECISION_DONE_LABEL] ?? w.ai.dest,
                  confidence: w.ai.confidence,
                }
              : undefined
          }
          heldCount={w.held.length}
          onClick={() => selectRow(w.id)}
        />
      );
    }
    if (segment === "screened") {
      const w = x as ScreenerSenderDTO;
      return (
        <MessageRow
          key={w.id}
          id={w.id}
          /* NAME AND ADDRESS, AS IN `waiting` (gap UX11). These two segments printed the
             ADDRESS ALONE, which in the demo world is invisible — every screened and spam
             fixture is an address with no display name — and on a live account throws away
             the half a human recognises. Both are needed and for different reasons: the
             name is the screening signal, the address is what keeps the judgement
             spoof-safe. `MessageRow` renders the second only when there is a first, so a
             genuinely nameless sender still shows exactly one line. */
          from={w.from.name || w.from.address}
          address={w.from.name ? w.from.address : undefined}
          time={screenedDate(w, t("today"))}
          subject={newestHeld(w)?.subject ?? ""}
          avatarInitial={w.initial}
          avatarHue={avatarHue(w.from.address)}
          selected={w.id === activeId}
          heldCount={w.held.length}
          onClick={() => selectRow(w.id)}
        />
      );
    }
    const r = x as SpamRow;
    return (
      <MessageRow
        key={r.sender.id}
        id={r.sender.id}
        from={r.sender.from.name || r.sender.from.address}
        address={r.sender.from.name ? r.sender.from.address : undefined}
        time={newestHeld(r.sender)?.time ?? r.sender.time}
        subject={newestHeld(r.sender)?.subject ?? ""}
        avatarInitial={r.sender.initial}
        avatarHue={avatarHue(r.sender.from.address)}
        dull
        selected={r.sender.id === activeId}
        heldCount={r.sender.held.length}
        detection={r.pinned ? t("markedByYou") : r.sender.detection?.label}
        onClick={() => selectRow(r.sender.id)}
      />
    );
  };

  return (
    <section className={full ? "view split view-screener scn-full" : "view split view-screener"}>
      <ListPane
        title={t("title")}
        /* "all clear" is the `=0` arm of this meta, and it is the same claim `Empty` makes:
           nobody is waiting at the gate. Before the mirror has been read nobody is KNOWN to be
           waiting. Any non-zero count is a real observation whatever the drain is doing, so
           only the zero is withheld — and it returns the moment there is one to state. */
        meta={
          !settled && state.waitingCount === 0
            ? undefined
            : t("metaWaiting", { count: state.waitingCount })
        }
        header={
          <div className="scn-head">
            <SegmentedControl<ScreenerSegmentId>
              className="scn-seg"
              role="tablist"
              ariaLabel={t("segAria")}
              value={segment}
              onChange={(seg) => goScreener(seg)}
              options={[
                {
                  id: "waiting",
                  label: t("segWaiting"),
                  count: state.waitingCount > 0 ? state.waitingCount : "",
                },
                {
                  id: "screened",
                  label: t("segScreened"),
                  count: state.screenedOut.length > 0 ? state.screenedOut.length : "",
                },
                {
                  id: "spam",
                  label: t("segSpam"),
                  count: state.spam.length > 0 ? state.spam.length : "",
                },
              ]}
            />
            {segment === "waiting" && state.waitingCount > 0 ? (
              <div className="scn-bulk">
                {/* A BULK CONTROL MAY NOT OUTLIVE THE THING IT ACTS ON (slice U6-SUGGEST).
                    Gated on `suggestedCount`, never on `waitingCount`: with no suggestions
                    this button used to file every waiting stranger into the Ohbox and
                    promote a rule for each, while its label said it was applying
                    suggestions the user was never shown. `markAllSpam` says exactly what it
                    does and needs no such gate. */}
                {state.suggestedCount > 0 ? (
                  <Button kbdHint="a" onClick={() => state.applyAll(scopeOf)}>
                    {t("applyAll", { count: state.suggestedCount })}
                  </Button>
                ) : null}
                <Button variant="ghost" kbdHint="s" onClick={() => state.markAllSpam(scopeOf)}>
                  {t("markAllSpam")}
                </Button>
              </div>
            ) : null}
          </div>
        }
        hints={
          segment === "waiting" ? (
            <>
              <span>
                <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintMove")}
              </span>
              {/* TWO FALSEHOODS IN ONE HINT, both fixed here (slice U6-SUGGEST). It read
                  `y accept suggestion` unconditionally. `y` is bound NOWHERE in the webapp
                  — `DecisionBar` owns that chord behind its `keyboard` prop and this view
                  deliberately stopped passing it (see the keymap note above), so the only
                  bound accept is Enter. And "accept suggestion" was offered on accounts
                  that have none. Now: the real key, shown only when there is something to
                  accept. */}
              {state.suggestedCount > 0 ? (
                <span>
                  <Kbd>↵</Kbd> {t("hintAccept")}
                </span>
              ) : null}
              {/* THE FILING LEGEND IS GONE, NOT MOVED (gap UX11). It read
                  `o r c n x file` and `⇧+key marks read` — five keycaps in the bottom
                  corner of the LIST, naming five destinations that live in the bar at the
                  top of the other pane, with nothing on screen to attach them to. Each key
                  is now on the capsule it fires, which is `bf4eb08`'s rule for the message
                  action bar; a legend as well as the caps would be the second list U2
                  deleted from the (i) panel. `j`/`k` and `↵` stay: they act on the LIST,
                  which is the pane this strip belongs to. */}
            </>
          ) : (
            <>
              <span>
                <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintMove")}
              </span>
              <span>{t("hintPreview")}</span>
            </>
          )
        }
      >
        <ListRows>
          {items.length ? items.map(row) : <Empty segment={segment} settled={settled} />}
        </ListRows>
      </ListPane>

      <div className="read-col scn-read">
        {!current ? (
          <Empty segment={segment} settled={settled} />
        ) : segment === "waiting" ? (
          <WaitingPreview
            sender={current as ScreenerSenderDTO}
            scope={scopeOf(current as ScreenerSenderDTO)}
            onScopeChange={(scope) => {
              const id = (current as ScreenerSenderDTO).id;
              setScopes((m) => new Map(m).set(id, scope));
            }}
            onDecide={(dest, opts) => decideCurrent(dest, opts.markRead)}
            onRetryBody={retryBody}
            onBack={() => onFull(false)}
          />
        ) : segment === "screened" ? (
          <ScreenedPreview
            sender={current as ScreenerSenderDTO}
            choosing={choosing === "allow"}
            onChoose={() => setChoosing("allow")}
            onCancel={() => setChoosing(null)}
            onAllow={(dest) => {
              state.allowScreened(current as ScreenerSenderDTO, dest);
              setChoosing(null);
            }}
            onRetryBody={retryBody}
            onBack={() => onFull(false)}
          />
        ) : (
          <SpamPreview
            row={current as SpamRow}
            choosing={choosing === "notspam"}
            onChoose={() => setChoosing("notspam")}
            onCancel={() => setChoosing(null)}
            onToWaiting={() => {
              state.notSpamToWaiting(current as SpamRow);
              setChoosing(null);
            }}
            onToOhbox={() => {
              state.notSpamToOhbox(current as SpamRow);
              setChoosing(null);
            }}
            onDelete={() => state.deleteSpam(current as SpamRow)}
            onRetryBody={retryBody}
            onBack={() => onFull(false)}
          />
        )}
      </div>
    </section>
  );
}

function screenedDate(w: ScreenerSenderDTO, today: string): string {
  const d = w.screenedOn ?? w.time;
  return /^\d{4}-/.test(d) ? today : d;
}

/** Rows summarise the newest held message; previews render every one of them. */
function newestHeld(w: ScreenerSenderDTO) {
  return w.held[w.held.length - 1];
}

function HeldMail({
  from,
  address,
  subject,
  time,
  body,
  bodyState,
  onRetry,
  trackerNote,
  dull,
}: {
  from: string;
  address?: string;
  subject: string;
  time?: string;
  body: string;
  /** Absent ⇒ full, which is a fixture row. See `ScreenerHeldMail.bodyState`. */
  bodyState?: BodyState;
  /** Ask for this held message's body again. Rendered only in the `failed` state. */
  onRetry?: () => void;
  trackerNote?: string;
  dull?: boolean;
}) {
  const t = useTranslations("body");
  /**
   * A CONSENT DECISION MUST NOT BE TAKEN ON TEXT THAT SILENTLY ISN'T THE MAIL.
   *
   * Every other pile can afford to say nothing while a body is in flight — the reader has a
   * pill and can ask again. Here the reader is about to decide whether a stranger may write
   * to them, and the difference between "this is all they said" and "this is the first line
   * of what they said" is the whole basis of that decision. `snippet` is included for that
   * reason, where the stream cards leave it silent: in this preview there is no pill standing
   * in for the same fact.
   *
   * AND IT CARRIES A CONTROL, for the reason the reading pane's does: the selection effect
   * above is an AUTOMATIC trigger, and `hydrateBody` deliberately refuses to re-ask a server
   * that already refused unless a human says so — otherwise a failing endpoint under an open
   * view is a request loop billed per attempt (invariant #10). Reselecting the sender
   * therefore does NOT retry, so without this button a held message whose body 500'd could
   * only be recovered by reloading the tab. In the one pile where the text is the basis of a
   * consent decision, that is not an acceptable dead end.
   */
  const note =
    bodyState === undefined || bodyState === "full"
      ? null
      : bodyState === "failed"
        ? t("failed")
        // `snippet` says "loading" and not "this is a preview", because in THIS view it is a
        // sub-frame state: selecting a sender hydrates its whole held list unconditionally,
        // so a snippet on screen is a body already on its way. Elsewhere `snippet` can mean
        // "nobody has asked", which is why the mapping is per-surface and not in `bodyOf`.
        : t("loading");
  return (
    <article className={dull ? "hmail dull" : "hmail"}>
      <div className="hm-line">
        <b>{from}</b>
        {address ? <span className="addr">{address}</span> : null}
        <span className="t num">{time ?? ""}</span>
      </div>
      <h3>{subject}</h3>
      {trackerNote ? (
        <div className="hm-chips">
          <span className="badge shield">
            <Icon name="shield" size={10} /> {trackerNote}
          </span>
        </div>
      ) : null}
      <div className="hm-body">{body}</div>
      {note ? (
        <p className={bodyState === "failed" ? "hm-state warn" : "hm-state"} role="status">
          {note}{" "}
          {bodyState === "failed" && onRetry ? (
            <Button variant="ghost" onClick={onRetry}>
              {t("retry")}
            </Button>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

function WaitingPreview({
  sender,
  scope,
  onScopeChange,
  onDecide,
  onRetryBody,
  onBack,
}: {
  sender: ScreenerSenderDTO;
  scope: DecisionScope;
  onScopeChange: (scope: DecisionScope) => void;
  onDecide: Parameters<typeof DecisionBar>[0]["onDecide"];
  /** Ask for one held message's body again (slice U5-BODY). */
  onRetryBody: (id: string) => void;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  const ruleTarget =
    scope === "domain"
      ? "@" + (sender.from.address.split("@")[1] ?? sender.from.address)
      : sender.from.address;
  const aiDest = sender.ai?.dest as Parameters<typeof DecisionBar>[0]["aiDest"];
  return (
    <>
      <DecisionBar
        aiDest={aiDest}
        scope={scope}
        onScopeChange={onScopeChange}
        ruleTarget={ruleTarget}
        onDecide={onDecide}
        onBack={onBack}
      />
      <div className="scn-mails">
        {/**
          * THE ABSENCE OF A SUGGESTION IS ITSELF SOMETHING TO SAY (slice U6-SUGGEST).
          *
          * This block used to render only in the `ai` branch, so on a live account — where
          * `ai` is null for every derived row — the preview said nothing at all, and the
          * owner was left looking for a suggestion the surface had never admitted it did
          * not have. "Every mail says why" is published copy; silence does not satisfy it.
          *
          * The FACT is shared with `AiSection`'s `status` line ("no live model is connected
          * yet") and both change together the day a classifier is wired into the server's
          * dependencies — the same trigger `AiSection.tsx` already names.
          *
          * THE WORDING IS NO LONGER SHARED, and that is the correction UX11 makes. This
          * used to end *"Pick a door."*, borrowed from the marketing page's AI-off row.
          * There the metaphor is established one screen earlier — `hero.door` is the
          * landing's own paragraph — and here nothing has ever been called a door: the
          * capsules beside this sentence say Ohbox, Reads, Receipts, Screen out, Spam. A
          * word the surface never defines is not shorthand, it is a second vocabulary. The
          * marketing line keeps its own.
          */}
        {sender.ai ? (
          <div className="scn-why">
            <Icon name="spark" />
            <span>
              {t("aiSuggests")}{" "}
              <b>
                {DECISION_DONE_LABEL[sender.ai.dest as keyof typeof DECISION_DONE_LABEL] ??
                  sender.ai.dest}
              </b>{" "}
              <span className="conf num">{sender.ai.confidence.toFixed(2)}</span> —{" "}
              <span className="why">{t("aiWhy", { why: sender.ai.rationale })}</span>
            </span>
          </div>
        ) : (
          <div className="scn-why scn-why-none">
            <span>{t("noSuggestion")}</span>
          </div>
        )}
        {sender.held.length > 1 ? (
          <div className="scn-caption num">
            {t("heldCaption", {
              count: sender.held.length,
              time: sender.held[0]?.time ?? "",
            })}
          </div>
        ) : null}
        {sender.held.map((h) => (
          <HeldMail
            key={h.id}
            from={sender.from.name || sender.from.address}
            address={sender.from.name ? sender.from.address : undefined}
            subject={h.subject}
            time={h.time}
            body={h.body}
            bodyState={h.bodyState}
            onRetry={() => onRetryBody(h.id)}
            trackerNote={h.trackerNote}
            dull={sender.dull}
          />
        ))}
      </div>
    </>
  );
}

function ScreenedPreview({
  sender,
  choosing,
  onChoose,
  onCancel,
  onAllow,
  onRetryBody,
  onBack,
}: {
  sender: ScreenerSenderDTO;
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onAllow: (dest: "ohbox" | "reads") => void;
  onRetryBody: (id: string) => void;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  return (
    <>
      <div className="decide">
        <button type="button" className="scn-back" onClick={onBack}>
          <Icon name="chev" className="chev" /> {t("back")}
        </button>
        <div className="d-btns">
          {choosing ? (
            <>
              <span className="choose-lab">{t("allowLabel")}</span>
              <Button onClick={() => onAllow("ohbox")}>{t("allowOhbox")}</Button>
              <Button onClick={() => onAllow("reads")}>{t("allowReads")}</Button>
              <Button variant="ghost" onClick={onCancel}>
                {t("cancel")}
              </Button>
            </>
          ) : (
            <Button onClick={onChoose}>{t("allow")}</Button>
          )}
        </div>
        <div className="d-sub">
          <span className="d-note num">
            {t("screenedNote", {
              date: screenedDate(sender, t("today")),
              count: sender.held.length,
            })}
          </span>
        </div>
      </div>
      {/* NO-COLLAPSE: every held message renders, oldest first. */}
      <div className="scn-mails">
        <div className="scn-caption num">
          {t("heldCaptionAll", { count: sender.held.length })}
        </div>
        {/* Name AND address, matching the waiting preview — see the screened row. */}
        {sender.held.map((h) => (
          <HeldMail
            key={h.id}
            from={sender.from.name || sender.from.address}
            address={sender.from.name ? sender.from.address : undefined}
            subject={h.subject}
            time={h.time}
            body={h.body}
            bodyState={h.bodyState}
            onRetry={() => onRetryBody(h.id)}
            trackerNote={h.trackerNote}
            dull
          />
        ))}
      </div>
    </>
  );
}

function SpamPreview({
  row,
  choosing,
  onChoose,
  onCancel,
  onToWaiting,
  onToOhbox,
  onDelete,
  onRetryBody,
  onBack,
}: {
  row: SpamRow;
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onToWaiting: () => void;
  onToOhbox: () => void;
  onDelete: () => void;
  onRetryBody: (id: string) => void;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  const held = row.sender.held;
  const detection = row.pinned ? t("markedByYou") : row.sender.detection?.label;
  return (
    <>
      <div className="decide">
        <button type="button" className="scn-back" onClick={onBack}>
          <Icon name="chev" className="chev" /> {t("back")}
        </button>
        <div className="d-btns">
          {choosing ? (
            <>
              <span className="choose-lab">{t("notSpamLabel")}</span>
              {!row.pinned ? (
                <Button onClick={onToWaiting}>{t("notSpamScreener")}</Button>
              ) : null}
              <Button onClick={onToOhbox}>{t("notSpamOhbox")}</Button>
              <Button variant="ghost" onClick={onCancel}>
                {t("cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onChoose}>{t("notSpam")}</Button>
              {/* Delete is a DEMO affordance: it hides the row and nothing else. There
                  is no delete endpoint, so on a live account (every row derived) the
                  button would lie until the next reload brought the mail back. It is
                  not offered there. */}
              {row.sender.derived ? null : (
                <Button variant="ghost" onClick={onDelete}>
                  {t("delete")}
                </Button>
              )}
            </>
          )}
        </div>
        <div className="d-sub">
          <span className="d-note">{t("spamNote")}</span>
        </div>
      </div>
      {/* NO-COLLAPSE: spam is held viewable — all of it, not the newest of it. */}
      <div className="scn-mails">
        {detection ? <div className="scn-caption">{detection}</div> : null}
        {held.length > 1 ? (
          <div className="scn-caption num">{t("heldCaptionAll", { count: held.length })}</div>
        ) : null}
        {held.map((h) => (
          <HeldMail
            key={h.id}
            from={row.sender.from.name || row.sender.from.address}
            address={row.sender.from.name ? row.sender.from.address : undefined}
            subject={h.subject}
            time={h.time}
            body={h.body}
            bodyState={h.bodyState}
            onRetry={() => onRetryBody(h.id)}
            trackerNote={h.trackerNote}
            dull
          />
        ))}
      </div>
    </>
  );
}
