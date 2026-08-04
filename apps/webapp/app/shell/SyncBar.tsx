"use client";

/**
 * THE SHELL'S SYNC STRIP — everything the product has to say about a sync, said wherever you
 * are standing.
 *
 * ── P17: WHAT WAS WRONG THE FIRST TIME ──────────────────────────────────────────────────
 *
 * "Sync failed. Retrying." existed, and it rendered in exactly one place: the Ohbox's EMPTY
 * state. So the only mailbox that could ever be told its sync was broken was one that had
 * never loaded anything — and the mailbox that most needs telling is the opposite of that.
 * A list with four hundred rows in it whose drains have been failing for ten minutes looked
 * completely healthy: the rows were there, they were just from ten minutes ago, and nothing
 * anywhere said so. Reads, Receipts and the Screener had no failure surface at all.
 *
 * It has been found three times — when P16 shipped (the ruling said "and nothing more",
 * which scoped the message to the empty pane), independently by a reviewer, and again in
 * the audit — because each time the fix was written as another branch inside a view, and a
 * view can only speak about itself.
 *
 * ── A1: AND THE SAME WAS TRUE OF PROGRESS ───────────────────────────────────────────────
 *
 * The failure had a home; the FIRST IMPORT did not. `mailboxes.syncPending` — "Waiting for
 * first sync" — was one sentence for every state a first sync can be in, and it lived on a row
 * in Settings → Mailboxes, three clicks from where anybody was looking. Measured on the agent's
 * own account on 2026-08-03: thirty minutes of it while 495 messages arrived. The Ohbox's own
 * counter existed but stopped at `bootstrapping`, which goes false as soon as the first CLIENT
 * drain lands — seconds — so it was silent for the entire multi-minute WORKER import that
 * follows.
 *
 * So the strip renders the whole ladder in `mail-state.ts`, and this file decides NOTHING: it
 * is a switch over a key somebody else derived. That is the actual repair. A view cannot forget
 * it, the next view added gets it for free, and a seventh state cannot be invented here because
 * there is nowhere here to invent one.
 *
 * ── WHY A SHELL STRIP AND NOT A PER-VIEW BANNER ─────────────────────────────────────────
 *
 * Three properties the gap asks for, and one placement that has all three:
 *
 *  1. **Every view, including the ones nobody thought of.** Rendered once, by the shell,
 *     above the deck.
 *  2. **It cannot scroll away.** It is a `flex: none` row of `.shell`, a sibling of the
 *     deck, so it is outside every list's scroller by construction rather than by a
 *     `position: sticky` that a future overflow context could break.
 *  3. **Silent when healthy.** `quiet` renders `null`, so there is no permanent "everything
 *     is fine" chrome to learn to ignore. The demo and the Desktop are gated to `quiet` in the
 *     derivation and have no mailbox probe either, so they never render it at all.
 *
 * Above the mobile topbar rather than below it: the topbar is the current view's title, and
 * this is not about the current view.
 *
 * ── RETRYING IS NOT STOPPED ─────────────────────────────────────────────────────────────
 *
 * `terminal` means the server refused this session in a way no waiting fixes — a 401 or
 * 403, a revoked session, a deleted account — and the loop has stopped. Rendering "Retrying."
 * for that would be a false statement about what the app is doing, so it gets its own line
 * and the one remedy that exists. Everything else is genuinely still being retried, forever,
 * at up to a minute apart, and says so.
 *
 * ── WHY THE COUNT IS NOT ANNOUNCED, AND NOT HIDDEN EITHER ───────────────────────────────
 *
 * `importing`'s count climbs on every drain — up to once every eight seconds, for minutes.
 * Inside a `role="status"` region that is a screen reader reading out a new number seven times
 * a minute, which is not information; it is noise that makes the app unusable to listen to.
 * The existing strip got away with `aria-live="polite"` only because its text is CONSTANT.
 *
 * So each sentence is split. The stable half is live and announces once when the strip appears;
 * the volatile half carries `aria-live="off"`, which suppresses announcements for changes to
 * that node while leaving the text present and readable by browsing. Deliberately NOT
 * `aria-hidden`: the count is the information, and removing it from the accessibility tree
 * would be a second defect dressed as a fix for the first.
 */
import { useTranslations } from "next-intl";
import { useMailState } from "./MailStateProvider";
import { stripSpeaks } from "./mail-state";

export function SyncBar() {
  const t = useTranslations("sync");
  // The error TAXONOMY lives with the Settings rows that already own it (`mailboxes.err_*`,
  // mail 0023). Two copies of seven sentences is how they drift, and one of them then describes
  // a failure mode the other has renamed.
  const tm = useTranslations("mailboxes");
  const { state } = useMailState();

  if (!stripSpeaks(state.key)) return null;

  switch (state.key) {
    case "stopped":
      return (
        // `role="alert"` and not `status`: the loop has stopped and will not restart itself,
        // so this is the one sync state that is worth interrupting a screen reader for. It is
        // `terminal` is NO LONGER set-once. A wake now issues one bounded probe, and a
        // drain that succeeds withdraws the claim, so this bar can appear, disappear and reappear.
        // `role="alert"` re-announcing on a re-latch is correct: the server re-made the claim.
        <div className="sync-bar stopped" role="alert">
          <Glyph warn />
          <b>{t("stopped")}</b>
          {/* Cloud-only by construction: a fixtures engine is permanently settled, so the
              desktop bundle compiles this branch and can never reach it. */}
          <a href="/login">{t("signIn")}</a>
        </div>
      );

    case "failing":
      return (
        // Polite, and deliberately not re-announced: the text is constant for as long as the
        // outage lasts, so the region updates once when it appears and once when it goes.
        <div className="sync-bar" role="status" aria-live="polite">
          <Glyph warn />
          <b>{t("failing")}</b>
        </div>
      );

    case "blocked":
      return (
        <div className="sync-bar warn" role="status" aria-live="polite">
          <Glyph warn />
          {/* A reason this build does not recognise still gets a sentence. The server owns a
              CLOSED set (mail 0029) and this client re-declares it, so a fourth member is a
              real possibility during a deploy — and answering it with silence would restore
              precisely the invisibility that migration exists to end. */}
          <b>{state.reason ? t(`blocked_${state.reason}`) : t("blockedUnknown")}</b>
          <span className="num" aria-live="off">
            {state.address}
            <Since minutes={state.minutes} t={t} />
          </span>
          {/* `awaiting_credentials` is the one arm a user can act on — the mailbox needs its
              password stored again. The other two are ours, and the link is still right: that
              pane is where the mailbox and its state live. */}
          <a href="#/settings">{t("settings")}</a>
        </div>
      );

    case "mailboxError":
      return (
        <div className="sync-bar warn" role="status" aria-live="polite">
          <Glyph warn />
          <b>{tm(`err_${state.errorCode}`)}</b>
          <span className="num" aria-live="off">{state.address}</span>
          <a href="#/settings">{t("settings")}</a>
        </div>
      );

    case "noMailbox":
      return (
        // Reachable only when `GET /mailboxes` ANSWERED and answered zero. A probe that failed
        // leaves the facts unknown and this strip silent — see `MailStateProvider`.
        <div className="sync-bar" role="status" aria-live="polite">
          <Glyph />
          <b>{t("noMailbox")}</b>
          <a href="#/settings">{t("settings")}</a>
        </div>
      );

    case "importing":
      return (
        <div className="sync-bar busy" role="status" aria-live="polite">
          <Glyph />
          {/* "Syncing", not "Importing your mailbox". The client can see its own mirror
              growing; it cannot see a worker, so a sentence that claims one is asserting
              something this code does not know. The count is the largest TRUE thing here. */}
          <b>{t("importing")}</b>
          {/* Never a percentage: `/sync` answers `hasMore` as a boolean, so the TOTAL is
              unknowable until the drain ends. A count is available, and it MOVES, which is the
              part that distinguishes working from hung. */}
          <span className="num" aria-live="off">
            {t("importingCount", { count: state.count })}
          </span>
        </div>
      );

    default:
      // `awaiting` — connected, no cycle has completed, and the mirror is empty. Often the
      // CORRECT thing to say: a first attach was measured at ~6 minutes. What was wrong before
      // was saying it alone, for ever, with no elapsed time and while the mirror grew.
      return (
        <div className="sync-bar busy" role="status" aria-live="polite">
          <Glyph />
          {/* Two sentences rather than one with a clause: "a first sync takes a few minutes" is
              true and useful at four minutes and misleading at forty. The escalated one drops
              the explanation and states the elapsed time — and claims no failure, because at
              this point nothing has failed. */}
          <b>{state.slow ? t("awaitingSlow") : t("awaiting")}</b>
          <span className="num" aria-live="off">
            {state.address
              ? t("awaitingWhere", { address: state.address, minutes: state.minutes ?? 0 })
              : t("awaitingFor", { minutes: state.minutes ?? 0 })}
          </span>
          {state.slow ? <a href="#/settings">{t("settings")}</a> : null}
        </div>
      );
  }
}

function Glyph({ warn = false }: { warn?: boolean }) {
  return (
    <span className="glyph" aria-hidden="true">
      {warn ? "⚠" : "✉"}
    </span>
  );
}

/**
 * How long a block has been in force.
 *
 * Minutes below an hour and hours above it, as two keys rather than one — "Since 187 minutes
 * ago" is a true sentence nobody can read, and an organizer lease that cannot be read stays
 * unreadable for as long as the server stays broken. Rendered only once there is a whole minute
 * to report: `syncBlockedSince` is written after the 120 s grace, so a zero here means the
 * clock and the row disagree by a beat, and "Since 0 minutes ago" is worse than silence.
 */
function Since({
  minutes,
  t,
}: {
  minutes: number | null;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  if (minutes === null || minutes < 1) return null;
  return (
    <>
      {" · "}
      {minutes < 60
        ? t("sinceMinutes", { minutes })
        : t("sinceHours", { hours: Math.floor(minutes / 60) })}
    </>
  );
}
