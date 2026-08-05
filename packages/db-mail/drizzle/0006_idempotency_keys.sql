-- SPLIT FROM `0006_swift_skrulls` (single-journal era, migration 0006) — the MAIL half.
--
-- The atomic idempotency store: the response DTO and this row commit in the SAME mutation
-- transaction, so a commit-then-crash replays the stored response verbatim instead of
-- re-executing the handler. It is shared because pending mutations plus their
-- Idempotency-Keys ARE the offline intent queue — a local engine needs exactly this table.
--
-- The other half of the original file registers browsers for push delivery. That is Cloud's
-- always-on path, so it lives in the Cloud journal instead.

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"account_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_json" jsonb NOT NULL,
	"seq" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_account_id_key_pk" PRIMARY KEY("account_id","key")
);
