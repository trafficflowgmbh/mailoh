-- SPLIT FROM `0003_auth_2fa` (single-journal era, migration 0003) — the MAIL half.
--
-- The bare identity the shared HTTP app needs and nothing more: `accounts`, `users`,
-- `sessions` and `devices`. `devices` is here because `sessions.device_id` references it;
-- dropping that FK to move the table would change behaviour, so the FK decides.
--
-- The identity CEREMONY — passwords, first-factor tokens, refresh rotation, WebAuthn, TOTP,
-- recovery codes, OAuth codes, the auth event log and the throttle — is NOT here. It is the
-- Cloud journal's `0000_auth_ceremony`, split from the same original file at the same
-- statement boundaries. Every statement below is byte-for-byte as it shipped.

CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"family_id" uuid NOT NULL,
	"access_token_hash" text,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"last_twofa_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_account_id_email_unique" UNIQUE("account_id","email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");