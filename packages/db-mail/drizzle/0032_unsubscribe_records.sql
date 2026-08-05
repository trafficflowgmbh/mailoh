-- AUTO-UNSUBSCRIBE — THE RECORD THAT MAKES IT AT-MOST-ONCE.
--
-- ══ WHAT THIS TABLE IS FOR ═══════════════════════════════════════════════════════════════
--
-- `UnsubscribeService` could already perform an RFC 8058 one-click request, but only when a
-- human asked for one, one message at a time. Making it AUTOMATIC — fire on a screen-out —
-- turns a deliberate act into a repeatable one, and a repeatable outbound request with no
-- record is a request that runs again on every retry, every re-screen and every concurrent
-- worker. A mailing list that receives four identical one-click POSTs from us learns that this
-- address is read by something automated; that is the opposite of the product.
--
-- So this table is not bookkeeping added afterwards. It IS the feature's safety property: at
-- most one outbound request per (mailbox, list), for ever, enforced by the database and not by
-- a service remembering to check.
--
-- ══ THE IDEMPOTENCY KEY IS `(mailbox_id, list_key)` — AND WHY EACH HALF ═══════════════════
--
-- `unsubscribe_records_mailbox_list_uq` is the whole concurrency design. The claim is
--
--     INSERT … ON CONFLICT DO NOTHING RETURNING id
--
-- so two workers racing the same list both attempt the insert, exactly one gets a row back,
-- and the loser does nothing. No `SELECT … FOR UPDATE`, no advisory lock, no read-modify-write
-- — the unique index is the mutual exclusion, which is the one form of it that cannot be
-- removed by a refactor without the constraint itself disappearing.
--
-- `list_key` — NOT the unsubscribe URL, and NOT the From address alone.
--
--   · NOT THE URL. A one-click URL normally carries a PER-MESSAGE opaque token
--     (`…/u?t=<random>`), so keying on it would mint a fresh key for every message and produce
--     one POST per message — precisely the defect this table exists to prevent. Keying on the
--     URL looks like the most specific choice available and is in fact no key at all.
--
--   · NOT `from_address` ALONE. This repository already carries the counter-example in its own
--     seen in the field: `no-reply-kbdtwjmegmd_he…@x.com`, a per-recipient or per-send address from a
--     sender the user experiences as one list. A From-keyed record would treat every message
--     as a new list and send again each time.
--
--   · SO: the RFC 2919 `List-ID` when the sender publishes one — that is the sender's OWN
--     stable name for the list the user is leaving — and `lower(from_address)` only as the
--     fallback for a bulk sender that publishes no `List-ID`. This is the correct behaviour in
--     both directions: one address carrying several lists yields several keys (they are
--     genuinely different subscriptions), and several addresses carrying one list collapse to
--     one key (it is genuinely one subscription).
--
-- `mailbox_id` and not `account_id` — the scope is the MAILBOX because the subscription is.
-- Two mailboxes on one account subscribed to the same newsletter are two subscriptions at the
-- sender, with two different tokens; unsubscribing one does not unsubscribe the other, and
-- collapsing them to one key would silently leave the second mailbox subscribed while the
-- record claimed otherwise. `account_id` is carried alongside for account-scoped reads and for
-- erasure, never as part of the key.
--
-- ══ THE ROW IS WRITTEN BEFORE THE REQUEST, NOT AFTER ═════════════════════════════════════
--
-- The claim commits first; the POST happens after, outside any transaction. That ordering is
-- deliberate and it is the pessimistic one: a process that dies between the claim and the POST
-- leaves a `claimed` row that blocks this list for ever, so the list is never unsubscribed.
--
-- That is the correct direction to fail. The alternative — record after a successful send —
-- makes the window a DOUBLE-SEND window instead, and the requirement here is at-most-once, not
-- at-least-once. A missed unsubscribe costs the user one more newsletter, which the screen-out
-- has already filed away out of sight. A duplicated one is an unrecoverable act performed at a
-- third party on the user's behalf. Recovering a stuck claim is a deliberate operator delete of
-- one row, which is the right amount of friction for re-sending something to a stranger.
--
-- ══ `state` IS CLOSED, AND `refused` IS NOT A FAILURE ════════════════════════════════════
--
--   claimed   the insert won the race; the outcome is not yet known.
--   sent      a request was made. `http_status` carries whatever the sender answered, INCLUDING
--             a non-2xx: we do not retry and we do not follow redirects, so a 500 from the
--             sender is a completed attempt, not a pending one.
--   refused   we claimed and then declined to send — the SSRF gate rejected the URL, or the URL
--             failed to re-parse. `refusal` names which. NO REQUEST WAS MADE.
--   failed    the request was attempted and the transport itself raised (DNS, TLS, timeout).
--             Distinct from `refused` because "we tried and could not tell" is a different fact
--             from "we decided not to", and only the first one leaves the sender possibly having
--             received it. Neither is retried.
--
-- The CHECK is closed rather than free text for the reason `mailboxes_sync_blocked_reason_closed`
-- is: a state nobody enumerated is a state no reader handles.
--
-- ══ NO ROW IS WRITTEN FOR MAIL THAT WAS NEVER ELIGIBLE ═══════════════════════════════════
--
-- A message with no `List-Unsubscribe`, a `mailto:`-only sender, or no `List-Unsubscribe-Post`
-- produces NOTHING here — not a row, not a request. This is the "absent evidence must not
-- select the acting branch" rule applied to the record as well as to the send: writing a
-- `refused` row for a message that merely lacked the header would poison the key, so a LATER
-- message from the same list that DOES publish one-click could never be acted on. The absence
-- of a row means "not yet considered", and that is the only thing it may mean.
--
-- ══ NO BACKFILL, AND THAT IS THE POINT ═══════════════════════════════════════════════════
--
-- A long-lived mailbox holds many thousands of senders screened out before this existed. This migration
-- seeds NOTHING and deliberately does not pre-claim them, because seeding would be a decision
-- about thousands of outbound requests taken inside a schema change where nobody would see it.
-- The drain refuses to run without an explicit cutoff for the same reason. Whether that backlog
-- is ever swept is an owner decision with a count in front of it, not a default.
--
-- ══ ERASURE — THIS MIGRATION IS NOT SAFE TO APPLY ALONE ══════════════════════════════════
--
-- The two foreign keys are `ON DELETE no action`, like every other FK in this schema: deletion
-- order is explicit in `account-deletion-service.ts` where it can be counted and audited. That
-- makes `AccountDeletionService` REQUIRED to delete this table before `messages` and before
-- `mailboxes`, and until it does, erasing an account that has any row here fails on its foreign
-- key. That failure is intentional and is better than the alternative: without the FKs the rows
-- would simply survive erasure, carrying a sender address and a mailbox id — personal data —
-- with the catalog sweep in `account-deletion.test.ts` unable to see it, because that sweep only
-- checks tables the hand-written seed helper populates. A loud refusal beats a silent retention.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═══════════════════════════════════════════════════════
--
-- Purely additive: one new table, no column added to an existing one, no data statement. Every
-- existing row stays valid.
--
-- Deploy order is MIGRATION → API. `UnsubscribeService` selects whole rows through the drizzle
-- schema, so an API deployed ahead of this migration answers Postgres 42P01 the first time an
-- unsubscribe is attempted. `["unsubscribe_records","list_key"]` therefore joins
-- `MAIL_SCHEMA_MARKERS` in `packages/api/src/routes/health.ts` and
-- `MAIL_SCHEMA_MARKER_JOURNAL_TAG` moves to this tag in the same diff, so that mistake reports
-- `503 schema_incomplete` naming this migration instead of a 500 nobody can attribute.
--
-- There is NO worker half. The worker's dependency-direction test forbids every file under
-- `apps/worker/src` from importing `@trafficflow/services`, and this table is only ever read or
-- written by `UnsubscribeService`, so no worker binary touches it and no worker-first deploy can
-- get it wrong.
--
-- ROLLBACK is `DROP TABLE "unsubscribe_records";`. It loses the record of every request already
-- made, which means a re-created table would send them all again — so it is a decision about
-- outbound mail, not a retry.

CREATE TABLE IF NOT EXISTS "unsubscribe_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"list_key" text NOT NULL,
	"state" text NOT NULL,
	"refusal" text,
	"http_status" integer,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unsubscribe_records_state_closed" CHECK ("state" in ('claimed','sent','refused','failed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unsubscribe_records" ADD CONSTRAINT "unsubscribe_records_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unsubscribe_records" ADD CONSTRAINT "unsubscribe_records_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unsubscribe_records_mailbox_list_uq" ON "unsubscribe_records" USING btree ("mailbox_id","list_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unsubscribe_records_account_idx" ON "unsubscribe_records" USING btree ("account_id");
