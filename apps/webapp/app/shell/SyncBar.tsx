"use client";

/**
 * P17 — A FAILING SYNC, SAID OUT LOUD, WHEREVER YOU ARE STANDING.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
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
 * ── WHY A SHELL STRIP AND NOT A PER-VIEW BANNER ─────────────────────────────────────────
 *
 * Three properties the gap asks for, and one placement that has all three:
 *
 *  1. **Every view, including the ones nobody thought of.** Rendered once, by the shell,
 *     above the deck. A view cannot forget it, and the next view added gets it for free —
 *     which is the actual defect being repaired, not the missing sentence.
 *  2. **It cannot scroll away.** It is a `flex: none` row of `.shell`, a sibling of the
 *     deck, so it is outside every list's scroller by construction rather than by a
 *     `position: sticky` that a future overflow context could break.
 *  3. **Silent when healthy.** It returns `null` unless the loop is actually failing, so
 *     there is no permanent "everything is fine" chrome to learn to ignore. The demo and
 *     the desktop hold a permanently settled status and never render it at all.
 *
 * Above the mobile topbar rather than below it: the topbar is the current view's title, and
 * this is not about the current view.
 *
 * ── RETRYING IS NOT STOPPED ─────────────────────────────────────────────────────────────
 *
 * `terminal` (X6) means the server refused this session in a way no waiting fixes — a 401 or
 * 403, a revoked session, a deleted account — and the loop has stopped. Rendering "Retrying."
 * for that would be a false statement about what the app is doing, so it gets its own line
 * and the one remedy that exists. Everything else is genuinely still being retried, forever,
 * at up to a minute apart, and says so.
 */
import { useTranslations } from "next-intl";
import { useSyncStatus } from "./engine";
import { SYNC_FAILURE_STREAK } from "./sync-scheduler";

export function SyncBar() {
  const t = useTranslations("sync");
  const { failures, terminal } = useSyncStatus();

  if (terminal) {
    return (
      // `role="alert"` and not `status`: the loop has stopped and will not restart itself,
      // so this is the one sync state that is worth interrupting a screen reader for. It is
      // also the one that cannot repeat — `terminal` is set once and never cleared.
      <div className="sync-bar stopped" role="alert">
        <span className="glyph" aria-hidden="true">
          ⚠
        </span>
        <b>{t("stopped")}</b>
        {/* Cloud-only by construction: a fixtures engine is permanently settled, so the
            desktop bundle compiles this branch and can never reach it. */}
        <a href="/login">{t("signIn")}</a>
      </div>
    );
  }

  if (failures < SYNC_FAILURE_STREAK) return null;

  return (
    // Polite, and deliberately not re-announced: the text is constant for as long as the
    // outage lasts, so the region updates once when it appears and once when it goes.
    <div className="sync-bar" role="status" aria-live="polite">
      <span className="glyph" aria-hidden="true">
        ⚠
      </span>
      <b>{t("failing")}</b>
    </div>
  );
}
