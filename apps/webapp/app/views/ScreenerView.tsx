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
import { screenerEmptyStates } from "@mailoh/fixtures";
import type { ScreenerSenderDTO } from "@mailoh/client-engine";
import {
  Button,
  DecisionBar,
  DECISION_DONE_LABEL,
  Icon,
  Kbd,
  ListPane,
  ListRows,
  MessageRow,
  SegmentedControl,
  type DecisionScope,
} from "@mailoh/ui";
import { goScreener, type ScreenerSegmentId } from "../shell/routing";
import type { ScreenerState, SpamRow } from "../shell/screener-state";

function Empty({ segment }: { segment: ScreenerSegmentId }) {
  const key = segment === "screened" ? "screened" : segment;
  const e = screenerEmptyStates[key];
  return (
    <div className="empty">
      <span className="glyph">{e.glyph}</span>
      <b>{e.title}</b>
      {e.hint}
    </div>
  );
}

export function ScreenerView({
  state,
  segment,
  selection,
  onSelect,
  full,
  onFull,
  typingGuard,
}: {
  state: ScreenerState;
  segment: ScreenerSegmentId;
  selection: Record<ScreenerSegmentId, string | null>;
  onSelect: (segment: ScreenerSegmentId, id: string | null) => void;
  full: boolean;
  onFull: (full: boolean) => void;
  typingGuard: (e: KeyboardEvent) => boolean;
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

  const decideCurrent = (dest: Parameters<ScreenerState["decide"]>[1], read: boolean) => {
    if (!current || "pinned" in current) return;
    const next = ids.filter((id) => id !== current.id && !state.isExiting(id));
    state.decide(current, dest, { read, scope: scopeOf(current) });
    onSelect("waiting", next[0] ?? null);
  };

  // j/k selection · a/s bulk · ↵ accepts the AI suggestion · esc leaves
  // the mobile full-screen preview. y/o/r/c/n/x live on the DecisionBar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && full) {
        onFull(false);
        return;
      }
      if (typingGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "k") {
        const selectable =
          segment === "waiting" ? ids.filter((id) => !state.isExiting(id)) : ids;
        if (!selectable.length) return;
        let i = activeId ? selectable.indexOf(activeId) : 0;
        if (i < 0) i = 0;
        i = e.key === "j" ? Math.min(i + 1, selectable.length - 1) : Math.max(i - 1, 0);
        onSelect(segment, selectable[i]!);
        document
          .querySelector(`.view-screener .row[data-id="${CSS.escape(selectable[i]!)}"]`)
          ?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (segment === "waiting") {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
          if (current && !("pinned" in current)) {
            decideCurrent((current.ai?.dest ?? "ohbox") as never, e.shiftKey);
          }
          return;
        }
        if (e.key === "a") state.applyAll(scopeOf);
        if (e.key === "s") state.markAllSpam(scopeOf);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, ids.join(","), activeId, full, state, typingGuard]);

  const selectRow = (id: string) => {
    onSelect(segment, id);
    if (window.matchMedia("(max-width: 900px)").matches) onFull(true);
  };

  const row = (x: ScreenerSenderDTO | SpamRow) => {
    if (segment === "waiting") {
      const w = x as ScreenerSenderDTO;
      const first = w.held[0];
      return (
        <MessageRow
          key={w.id}
          id={w.id}
          from={w.from.name || w.from.address}
          address={w.from.name ? w.from.address : undefined}
          time={w.time}
          subject={first?.subject ?? ""}
          avatarInitial={w.initial}
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
          from={w.from.address}
          time={screenedDate(w, t("today"))}
          subject={w.lastSubject ?? ""}
          avatarInitial={w.initial}
          selected={w.id === activeId}
          heldCount={w.heldCount}
          onClick={() => selectRow(w.id)}
        />
      );
    }
    const r = x as SpamRow;
    return (
      <MessageRow
        key={r.sender.id}
        id={r.sender.id}
        from={r.sender.from.address}
        time={r.sender.time}
        subject={r.sender.held[0]?.subject ?? ""}
        avatarInitial={r.sender.initial}
        dull
        selected={r.sender.id === activeId}
        detection={r.pinned ? t("markedByYou") : r.sender.detection?.label}
        onClick={() => selectRow(r.sender.id)}
      />
    );
  };

  return (
    <section className={full ? "view split view-screener scn-full" : "view split view-screener"}>
      <ListPane
        title={t("title")}
        meta={t("metaWaiting", { count: state.waitingCount })}
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
                <Button kbdHint="a" onClick={() => state.applyAll(scopeOf)}>
                  {t("applyAll")}
                </Button>
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
              <span>
                <Kbd>y</Kbd> {t("hintAccept")}
              </span>
              <span>
                <Kbd>o</Kbd> <Kbd>r</Kbd> <Kbd>c</Kbd> <Kbd>n</Kbd> <Kbd>x</Kbd> {t("hintFile")}
              </span>
              <span>
                <Kbd>⇧</Kbd>
                {t("hintShiftRead")}
              </span>
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
          {items.length ? items.map(row) : <Empty segment={segment} />}
        </ListRows>
      </ListPane>

      <div className="read-col scn-read">
        {!current ? (
          <Empty segment={segment} />
        ) : segment === "waiting" ? (
          <WaitingPreview
            sender={current as ScreenerSenderDTO}
            scope={scopeOf(current as ScreenerSenderDTO)}
            onScopeChange={(scope) => {
              const id = (current as ScreenerSenderDTO).id;
              setScopes((m) => new Map(m).set(id, scope));
            }}
            onDecide={(dest, opts) => decideCurrent(dest, opts.markRead)}
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

function HeldMail({
  from,
  address,
  subject,
  time,
  body,
  trackerNote,
  dull,
}: {
  from: string;
  address?: string;
  subject: string;
  time?: string;
  body: string;
  trackerNote?: string;
  dull?: boolean;
}) {
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
    </article>
  );
}

function WaitingPreview({
  sender,
  scope,
  onScopeChange,
  onDecide,
  onBack,
}: {
  sender: ScreenerSenderDTO;
  scope: DecisionScope;
  onScopeChange: (scope: DecisionScope) => void;
  onDecide: Parameters<typeof DecisionBar>[0]["onDecide"];
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
        keyboard
        onBack={onBack}
      />
      <div className="scn-mails">
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
        ) : null}
        {sender.held.length > 1 ? (
          <div className="scn-caption num">
            {t("heldCaption", {
              count: sender.held.length,
              time: sender.held[0]?.time ?? "",
            })}
          </div>
        ) : null}
        {sender.held.map((h, i) => (
          <HeldMail
            key={i}
            from={sender.from.name || sender.from.address}
            address={sender.from.name ? sender.from.address : undefined}
            subject={h.subject}
            time={h.time}
            body={h.body}
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
  onBack,
}: {
  sender: ScreenerSenderDTO;
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onAllow: (dest: "ohbox" | "reads") => void;
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
              count: sender.heldCount ?? sender.held.length,
            })}
          </span>
        </div>
      </div>
      <div className="scn-mails">
        <div className="scn-caption num">
          {t("screenedCaption", { count: sender.heldCount ?? sender.held.length })}
        </div>
        <HeldMail
          from={sender.from.address}
          subject={sender.lastSubject ?? sender.held[sender.held.length - 1]?.subject ?? ""}
          time={screenedDate(sender, t("today"))}
          body={sender.lastBody ?? sender.held[sender.held.length - 1]?.body ?? ""}
          dull
        />
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
  onBack,
}: {
  row: SpamRow;
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onToWaiting: () => void;
  onToOhbox: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  const held = row.sender.held[0];
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
              <Button variant="ghost" onClick={onDelete}>
                {t("delete")}
              </Button>
            </>
          )}
        </div>
        <div className="d-sub">
          <span className="d-note">{t("spamNote")}</span>
        </div>
      </div>
      <div className="scn-mails">
        {detection ? <div className="scn-caption">{detection}</div> : null}
        {held ? (
          <HeldMail
            from={row.sender.from.address}
            subject={held.subject}
            time={held.time}
            body={held.body}
            trackerNote={held.trackerNote}
            dull
          />
        ) : null}
      </div>
    </>
  );
}
