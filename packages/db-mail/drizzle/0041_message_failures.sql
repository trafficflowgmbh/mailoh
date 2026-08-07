-- THE DURABLE PER-MESSAGE FAILURE LEDGER — the one place the sync design LOST mail.
--
-- ADDITIVE ONLY: one new table, its foreign key, one partial index. No ALTER on an existing table,
-- no backfill and no data statement.
--
-- ══ WHAT THIS FIXES ══════════════════════════════════════════════════════════════════════════
--
-- A message that cannot be ingested — the source is over the parser's ceiling, or the parser
-- refuses it — is declared CONSUMED so the rest of the batch and all later mail keep flowing. That
-- decision is right, and the alternative (refuse to skip) wedges a whole mailbox on one bad
-- message for ever. Until now the record of that decision lived in PROCESS MEMORY.
--
-- For the folders the sync loop enumerates end to end that costs nothing: the known-set diff
-- re-offers the message after a restart, so a deploy carrying a parser fix ingests it with no
-- operator involved. The SENT folder is not enumerated end to end. Its cursor is a UID WATERMARK —
-- steady state is `UID FETCH <uidNext>:*` — so once the watermark has crossed a skipped UID
-- nothing ever enumerates it again, and no row exists anywhere to notice. A message the user
-- actually sent disappears from their mail client's view, permanently, and the mailbox reports
-- healthy throughout.
--
-- Losing somebody's mail is the worst outcome this product can produce, so the record becomes
-- durable and the retry becomes TARGETED: the watermark still advances (the mailbox must never
-- wedge), and the UID is re-read BY UID rather than by re-scanning a folder. Re-scanning is not an
-- alternative here — holding the watermark below a skipped UID means it never advances, so the
-- enumeration range grows without bound and the poison body is re-fetched on every cycle for ever.
--
-- ══ THE TABLE — THE CONSTRAINTS ARE THE MODEL ════════════════════════════════════════════════
--
--   UNIQUE (mailbox_id, folder, uidvalidity, uid)
--       `message_instances_locator_uq`'s shape, for `message_instances_locator_uq`'s reason: one
--       UID inside one server epoch is ONE place. `uidvalidity` is IN the key because a UID number
--       is meaningless outside the epoch that issued it — a folder that resets its UIDVALIDITY
--       commonly re-allocates from low numbers, and a failure written off under epoch V must never
--       silence a different message that reuses that number under V′.
--
--   INDEX (mailbox_id, next_attempt_at) WHERE resolved_at IS NULL
--       The retry probe, which runs once per mailbox per cycle. PARTIAL, because a resolved row is
--       history: it is kept so it can be seen that the message eventually arrived, and it must not
--       be paged through on every cycle for the life of the account. The known-set read is served
--       by the unique index above, whose leading column is already `mailbox_id`.
--
--   CHECK message_failures_code_closed
--       `code` is the only column here whose value could conceivably come from outside, and it may
--       not. Its five members are `MessageFailureCode` (`apps/worker/src/dead-letter.ts`), the same
--       contract `mailboxes_sync_blocked_reason_closed` holds `sync_blocked_reason` to and for the
--       same reason — an account's mail must stay reachable by that account's own users and by
--       nobody else: a throw out of the ingest path can carry RFC822 header bytes and a
--       Postgres data-exception message quotes the offending row. Membership in a closed set cannot
--       be forged by a mail server; a shape test can. The CHECK lives INSIDE the CREATE TABLE and
--       not in a bare `ADD CONSTRAINT`, because replaying a journal is a supported operation and a
--       bare one raises 42710 the second time.
--
-- ══ WHAT THE TABLE DELIBERATELY DOES NOT HOLD ════════════════════════════════════════════════
--
-- No subject, no sender, no Message-ID, no byte of the message, and no free text of any kind. A
-- row is a COORDINATE plus a closed-set reason: which mailbox, which folder, which server epoch,
-- which UID, why, how often, when next. That is exactly the content-free record the in-memory
-- ledger already wrote to `audit_log`, made durable — and it is what lets the retry be targeted
-- without the table becoming a second copy of somebody's mail.
--
-- **NO STAFF GRANT, EVER.** `scripts/harden-staff-role.sql` must not name this table, and
-- `STAFF_SELECT_GRANTS` must not either. The information is in the ROW'S EXISTENCE, not in a
-- column: send a deliberately unparseable probe, poll for a new row against that `mailbox_id`, and
-- delivery is confirmed. That is the oracle that retired `public.messages` from the grant census
-- (see the block above `public.accounts` there), and no narrower column list closes it. Operator
-- visibility is served by an aggregate the worker publishes, never by a read of these rows.
--
-- ══ `next_attempt_at IS NULL`, AND WHY THE DETERMINISTIC FAILURES ARE BORN WITH IT ═══════════
--
-- NULL means "no TIME-scheduled retry" — not "never again". The due predicate is
--
--     resolved_at IS NULL AND (next_attempt_at <= now() OR attempted_version IS DISTINCT FROM $v)
--
-- and the second arm is the one that matters. `mime_too_large` and `mime_unparseable` are
-- deterministic in the raw bytes by the contract on `mime.ts`'s two typed errors, so a clock can
-- never change the answer and an hourly backoff over them is pure waste — worse than waste, since
-- each attempt would re-download the body it is about to refuse. A NEW BUILD is the only event
-- that can change the answer, so those rows are born with `next_attempt_at NULL` and are woken by
-- the version arm alone. The arm is self-disarming: the attempt writes `attempted_version`, so it
-- fires once per build and not once per cycle. `constraint_violation` and `unclassified` are not
-- deterministic and do carry a widening backoff.
--
-- That restores, for the Sent folder, the property the enumerated folders already had — a deploy
-- carrying a parser fix ingests the mail it fixes with nobody doing anything — while bounding the
-- work at one targeted probe per row per build.
--
-- NULL rather than a separate `abandoned` boolean, deliberately: SQL comparison excludes NULL, so
-- a predicate somebody forgets fails towards NOT scheduling a clock-retry (the version arm still
-- covers the row), whereas a boolean mints a contradiction state — `abandoned = false` beside a
-- NULL instant — that wedges silently. `attempts` is the escalation signal and there is no
-- `escalated` column for the same reason: a derived answer cannot disagree with itself.
--
-- **The residual, stated:** `buildVersionOf` answers `"dev"` when no build identity is present, so
-- on a developer's machine both sides of a restart carry `"dev"` and the version arm never fires.
-- That is correct rather than unfortunate — there was no new build — and it is why the arm is not
-- the only mechanism for the non-deterministic codes.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═══════════════════════════════════════════════════════════
--
-- Migration → API → worker. `["message_failures","next_attempt_at"]` joins `MAIL_SCHEMA_MARKERS`
-- in `packages/api/src/routes/health.ts` so an API deployed ahead of the migration says
-- `503 schema_incomplete` and names this file. The worker is last because it is the table's ONLY
-- reader and its only writer; a worker binary that predates this migration keeps working
-- unchanged, because the in-memory ledger it already carries IS the pre-migration behaviour.
--
-- A worker deployed AHEAD of the migration is the case worth stating: every read and write here
-- raises 42P01, and the terminal-skip path treats a failed durable write as a REFUSAL TO SKIP —
-- the folder's cursor is held and the cycle fails, so the mailbox quarantines loudly instead of
-- advancing a watermark over mail it cannot record. That is the safe direction, and it is why this
-- write is NOT best-effort the way the `audit_log` row beside it is.
--
-- ROLLBACK is `DROP TABLE message_failures`. The cost is the residual this migration removes,
-- restored: a skipped Sent UID becomes unrecoverable again. No other table is touched.

CREATE TABLE IF NOT EXISTS "message_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"uidvalidity" bigint NOT NULL,
	"uid" integer NOT NULL,
	"code" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_version" text,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "message_failures_locator_uq" UNIQUE("mailbox_id","folder","uidvalidity","uid"),
	CONSTRAINT "message_failures_code_closed" CHECK ("code" in ('mime_too_large','mime_unparseable','data_exception','constraint_violation','unclassified'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_failures" ADD CONSTRAINT "message_failures_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_failures_due_idx" ON "message_failures" USING btree ("mailbox_id","next_attempt_at") WHERE "resolved_at" IS NULL;
