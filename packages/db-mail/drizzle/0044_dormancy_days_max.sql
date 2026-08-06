-- CAP THE DORMANCY DIAL AT ONE YEAR — the upper bound `0035_account_settings.sql` left open, and
-- the one that keeps a value legal under the old floor from crashing a read.
--
-- ══ WHY A CEILING, AND WHY 365 ═══════════════════════════════════════════════════════════════
--
-- `dormancy_days` (0035) has carried `CHECK (> 0)` since it was created and nothing more — a floor
-- with no ceiling. The floor exists because a zero or negative window makes every sender dormant and
-- silently empties the Screener queue (0035's header). This is the matching ceiling, and it is NOT
-- cosmetic: `cutlineCounts` builds the cutoff as a JS `Date` and serialises it with `toISOString()`
-- (`packages/services/src/consent-cutline.ts`), and `new Date(now - days*86_400_000)` for a large
-- enough `days` is an Invalid Date whose `toISOString()` throws `RangeError: Invalid time value`. A
-- value like 200 000 000 is legal under `> 0` alone and, once stored, makes `GET /consent` — which
-- every tab fetches once — a PERSISTENT 500 for that account, because the throw is on the READ. The
-- database is the one layer that can refuse the value for every writer at once, exactly as the floor
-- does.
--
-- 365 is a year: the longest "recent" anyone reasonably means, and an order of magnitude below the
-- boundary where the Date arithmetic first overflows, so no value inside the bound can reach the
-- RangeError. The service (`setDormancyDays`) restates the same 1–365 as a 400, so a caller gets a
-- readable refusal rather than the raw 23514 — the pattern `OHBOX_BAR_MAX_BYTES` uses for the 2 KiB
-- bar cap one migration over.
--
-- ══ VALIDATES INSTANTLY, NO BACKFILL ════════════════════════════════════════════════════════
--
-- A plain validating `ADD CONSTRAINT`, no `NOT VALID` needed: `dormancy_days` has had ZERO writers
-- since 0035, so no row holds a non-NULL value and the validation scan finds nothing to check. There
-- is NO data statement and there must not be — the floor and the ceiling both describe what a value
-- may be, never what any account's value IS, and an account that legitimately set 400 before this
-- bound existed does not exist to repair.
--
-- ══ IDEMPOTENT REPLAY — THE 0037 PATTERN ════════════════════════════════════════════════════
--
-- `ADD CONSTRAINT` has no `IF NOT EXISTS`, and replaying the journal is a supported operation
-- (`setup-prod.ts` replays it; `mailbox-dedup.pg.test.ts` rewinds a migrated database and
-- re-migrates; `openLocalDb` re-runs both journals on every launch). A bare form raises 42710
-- (`constraint "…" already exists`) the second time and takes the whole pass down — the trap 0037's
-- `drafts_html_cap` hit first. The `DO … WHEN duplicate_object` wrapper is the pattern 0027, 0029 and
-- 0037 already use, and it is REQUIRED here rather than the `ADD COLUMN IF NOT EXISTS … CONSTRAINT`
-- shape 0042 uses, because the CHECK is added to a column that already exists.
--
-- ══ NO LOCKDOWN, NO OPERATOR GRANT ══════════════════════════════════════════════════════════
--
-- `ADD CONSTRAINT` on an existing table inherits `account_settings`'s grants (0035, tightened), so no
-- privilege lockdown pass is owed and the content-blind operator role gains nothing — a dormancy
-- bound is not something an operator needs.
--
-- ROLLBACK is `ALTER TABLE account_settings DROP CONSTRAINT account_settings_dormancy_days_max`. The
-- cost is that a value above 365 becomes storable again and can re-introduce the read-time
-- RangeError — which is the whole reason this exists, so the direction is safe. No mail moves and no
-- consent is lost: consent lives in `rules`, which this constraint does not touch.

DO $$ BEGIN
  ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_dormancy_days_max" CHECK ("dormancy_days" IS NULL OR "dormancy_days" <= 365);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
