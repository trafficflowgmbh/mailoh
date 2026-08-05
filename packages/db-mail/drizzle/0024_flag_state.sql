-- READ-STATE DESIRED STATE — the `\Seen` half of organize-in-place.
--
-- ══ WHAT THIS FIXES, MEASURED ════════════════════════════════════════════════════════════
--
-- Read-state never reached IMAP in either direction. Three facts, each verified against the
-- code before this migration was written:
--
--   · `PATCH /messages/:id { unread }` wrote `messages.unread` and nothing else
--     (`packages/services/src/message-service.ts`). There was no desired-state row, so the
--     worker had nothing to push and the user's own mailbox never learned the message was read.
--   · `MailboxAdapter` had no flag-setting method at all (`imap-types.ts`) — only `move`.
--   · Ingest DROPPED the adapter's `seen` field (`packages/core/src/pipeline.ts`), so the
--     schema default `unread = true` filed mail the user read years ago under "New" on the
--     first sync of a real mailbox.
--
-- Read/seen flags are said to "survive everything" because
-- they live on the user's own server. That claim is only true if we write them there. Claims
-- are contracts, so the table and the sentence land together.
--
-- ══ WHY IT MIRRORS `folder_state` COLUMN FOR COLUMN ══════════════════════════════════════
--
-- Because it is the same problem. GOALS #3: the API never opens IMAP to apply organization —
-- a serverless function that dies mid-flight would leave a mailbox half-written — so a
-- mutation records INTENT and the always-on worker performs the network write on its next
-- reconcile pass. `folder_state` is that pattern for placement; this is that pattern for the
-- one other piece of state IMAP owns. A second, differently-shaped mechanism for the same
-- deferral would be two things to reason about at every crash boundary.
--
--   desired_seen      what the USER asked for. Written by the API (`PATCH /messages`) and by
--                     ingest, which now maps the adapter's `\Seen` into it at create.
--   observed_seen     what the SERVER last said. Written by the WORKER only.
--   last_set_by       'us' | 'external'. `reconcileMailbox` skips any row it did not author,
--                     which is what stops us reverting an unread-again performed in Apple
--                     Mail — the same user-wins rule the folder reconciler already applies.
--   reconcile_status  'pending' | 'reconciled', DERIVED from desired vs observed at every
--                     write and never set by hand, so a row cannot claim a convergence it
--                     does not have.
--   conflict          reserved, mirroring `folder_state`. Nothing sets it true yet; it is
--                     here so the two tables stay diffable rather than nearly-alike.
--
-- ONE ROW PER MESSAGE (`flag_state_message_id_unique`). There is one flag and the last writer
-- wins; the unique constraint is what makes the API's `ON CONFLICT DO UPDATE` an upsert
-- instead of an unbounded row-per-click log, and it is what makes the worker's observed write
-- and the API's desired write meet on the same row instead of racing to create two.
--
-- `messages.unread` STAYS. It is the read model every view partition and every DTO projects
-- (`new_for_you`/`previously_seen` are literally `unread = true/false`), and it is what the
-- delta feed carries. This table is the write intent behind it, exactly as
-- `folder_state.desired_folder` sits behind `MessageDTO.folder`. Collapsing the two would put
-- a join on the hottest list query in the product to save one boolean.
--
-- ══ COMPATIBILITY ════════════════════════════════════════════════════════════════════════
--
-- A NEW TABLE, so every existing row stays valid and there is no backfill: an absent row means
-- "nobody has expressed an intent about this message's read state", which is the truth for all
-- mail ingested before this deploy, and every reader treats it that way (the API falls back to
-- `messages.unread` for `observed_seen` when it creates the row).
--
-- `desired_seen` and `observed_seen` are NOT NULL with no default, deliberately. There is no
-- honest default: a row exists precisely because somebody decided something, and a `false`
-- default would let a half-written insert read as "the user wants this unread".
--
-- Deploy order is migration → API → worker, as always. `["flag_state","desired_seen"]` joins
-- `MAIL_SCHEMA_MARKERS` in `packages/api/src/routes/health.ts`, so an API deployed ahead of
-- this migration answers `503 schema_incomplete` naming it, instead of 42703 on every
-- read-state write.
--
-- ROLLBACK is `DROP TABLE flag_state`. Nothing else references it, and the cost is only that
-- pending intents are lost — `messages.unread` is unaffected and the next external flag change
-- re-converges the row.

CREATE TABLE IF NOT EXISTS "flag_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"desired_seen" boolean NOT NULL,
	"observed_seen" boolean NOT NULL,
	"last_set_by" text NOT NULL,
	"reconcile_status" text DEFAULT 'pending' NOT NULL,
	"conflict" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flag_state_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flag_state" ADD CONSTRAINT "flag_state_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
