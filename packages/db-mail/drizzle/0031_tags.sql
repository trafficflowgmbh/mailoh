-- TAGS — ours, keyed by message, and never an IMAP folder.
--
-- ══ THE DECISION, AND WHY IT IS NOT A FOLDER ═════════════════════════════════════════════
--
-- ohmail organizes the mailbox IN PLACE with a fixed folder set — `INBOX` plus
-- `ohmail/Screener|Reads|Receipts|Screened|Quarantine` — and the IMAP mailbox is the master:
-- organization lands in real folders on the real server, so the mailbox stays organized whether
-- or not this app is still running. A tag is a CROSS-CUTTING dimension over those places:
-- "invoices" is not a
-- seventh pile a message sits in, it is a word about a message that is already sitting in the
-- Ohbox. Modelling it as a folder would have three costs, and the third is disqualifying:
--
--   1. It grows the fixed set, which the reconciler and `placeLabel` both treat as closed.
--   2. IMAP has no many-to-many. A message with three tags is three folders, and a message in
--      two folders is a per-tag COPY — the mailbox rewrite that leave-anytime exists to refuse.
--   3. It would make our vocabulary permanent in someone else's mailbox. A user who cancels
--      would be left with `ohmail/invoices` directories they now have to clean up by hand.
--
-- So tags are two tables here and nothing at all over IMAP.
--
-- ══ THE HONEST CONSEQUENCE, WHICH THE UI STATES ══════════════════════════════════════════
--
-- Because a tag lives only in this database, it is not in the mailbox, and the product says so
-- rather than letting someone find out later. What is TRUE is narrower than "does not survive
-- disconnection", and the copy in `apps/webapp/messages/en.json` is worded to what actually
-- happens:
--
--   · A DISCONNECT KEEPS TAGS. `delete` on a mailbox is a soft delete to `status='disabled'`
--     (see `mailboxes_active_address_uq`, which is partial precisely so a disconnected address
--     can be reconnected), the `messages` rows persist, and re-enabling is supported. Deleting
--     tags there would destroy data on a reversible action, for no gain.
--   · ERASING THE ACCOUNT TAKES THEM. `AccountDeletionService` deletes these two tables, and
--     it must do so BEFORE `messages` or the FK below refuses — that ordering is part of this
--     slice, not an afterthought.
--   · A TAG NEVER OUTLIVES ITS MESSAGE, by the same FK.
--
-- The folders survive a cancellation because they are real IMAP folders. The tags do not,
-- because they are ours. Both halves of that sentence are in the UI.
--
-- ══ `message_tags` IS PK `(message_id, tag_id)`, WHICH IS THE CONCURRENCY DESIGN ══════════
--
-- The wire verb is a DELTA — `POST /messages/:id/tags {tagId, assigned}` — and not the "full
-- next labels array" the client engine's type comment originally proposed. That distinction is
-- the reason this PK is the natural key rather than a synthetic `id`:
--
--   · An array PATCH is a read-modify-write. Two concurrent toggles of DIFFERENT tags on one
--     message both read the same starting array and the second write silently drops the first
--     one's tag. That is mail-adjacent data loss with no error surface.
--   · A delta needs no read. Assign is `INSERT … ON CONFLICT DO NOTHING` against this PK and
--     unassign is a `DELETE`; both are idempotent, and two concurrent toggles of the same tag
--     on the same message settle to one row with no lost update and no unique violation.
--
-- The one race the PK does NOT carry is `DELETE /tags/:id` interleaved with an assign of that
-- same tag: the deleter clears `message_tags` while a concurrent inserter adds a row, and the
-- parent `DELETE FROM tags` then fails the FK. `TagsService.remove` therefore takes the `tags`
-- row `FOR UPDATE` first, so the inserter blocks on the parent row until the delete commits and
-- then fails its own FK — which the service maps to a 404, the truthful answer for a tag that
-- no longer exists. `tags.pg.test.ts` drives that interleaving on real Postgres; PGlite cannot
-- observe lock behaviour and has been blind to exactly this class of bug three times.
--
-- ══ NO CASCADES, NO `class_name`, NO BACKFILL ════════════════════════════════════════════
--
-- `ON DELETE no action` on both FKs, matching every other FK in this schema (there is not one
-- cascade in it): deletion order is explicit and lives in `account-deletion-service.ts`, where
-- it can be counted and audited, rather than implicit in the catalog.
--
-- No `class_name` column though `TagDTO` has the field — a CSS class is presentation, not
-- account data, and the client already derives it from `hue` (`format.ts:hueOf`). The DTO field
-- is optional as of this slice so the fixture adapter keeps compiling.
--
-- Purely additive: two new tables, no column added to an existing one, no data statement. Every
-- existing row stays valid and there is nothing to backfill — an account that has never tagged
-- anything correctly has no rows here.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═══════════════════════════════════════════════════════
--
-- Deploy order is MIGRATION → API. `TagsService` selects whole rows through the drizzle schema
-- and `materializeMessage` now reads `message_tags` on the sync path, so an API deployed ahead
-- of this migration answers Postgres 42P01 on every message list — not a tag-shaped failure, a
-- total one. `["tags","id"]` and `["message_tags","tag_id"]` therefore join `MAIL_SCHEMA_MARKERS`
-- in `packages/api/src/routes/health.ts` and `MAIL_SCHEMA_MARKER_JOURNAL_TAG` moves to this tag
-- in the same diff, so that mistake reports `503 schema_incomplete` naming this migration
-- instead of a 500 nobody can attribute.
--
-- ROLLBACK is `DROP TABLE "message_tags"; DROP TABLE "tags";` — in that order, same FK. It
-- loses every tag, which is data loss and not a no-op, so it is a decision and not a retry.

CREATE TABLE IF NOT EXISTS "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hue" text DEFAULT 'moss' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_tags" (
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_tags_message_id_tag_id_pk" PRIMARY KEY("message_id","tag_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_tags" ADD CONSTRAINT "message_tags_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_tags" ADD CONSTRAINT "message_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tags_account_name_uq" ON "tags" USING btree ("account_id",lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_tags_account_message_idx" ON "message_tags" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_tags_tag_idx" ON "message_tags" USING btree ("tag_id");
