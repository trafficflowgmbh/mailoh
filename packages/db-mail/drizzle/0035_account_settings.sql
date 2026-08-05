-- ACCOUNT-LEVEL SETTINGS — the first durable home for a per-account preference.
--
-- ══ WHY A TABLE AND NOT COLUMNS ON `accounts` ════════════════════════════════════════════
--
-- `accounts` is an IDENTITY row: who this is, and what they are billed as. It is read on every
-- authenticated request and it is one of the few rows that must survive account deletion (the
-- billing ledger's FK is `ON DELETE no action`, so the account persists as a pseudonymous
-- billing subject — see `account-deletion-service.ts`). Preferences have the opposite
-- lifecycle: they are written rarely, read by one feature each, and they are exactly the thing
-- a "reset me to factory" action should be allowed to drop on the floor. Mixing the two puts a
-- preference column inside the erasure blast radius and makes every settings addition an
-- `ALTER TABLE` on the hottest row in the schema.
--
-- So: one row per account, created lazily on first write, absent for every account that has
-- never changed anything. Absence is a legal, expected state and every reader below must treat
-- a missing row as "all defaults" rather than as an error. That is the whole reason there is no
-- backfill statement in this migration.
--
-- ══ WHY THIS IS DELIBERATELY GENERAL ═════════════════════════════════════════════════════
--
-- Two features want per-account settings within days of each other: the consent cutline (this
-- slice) and an auto-work opt-in flag (queued). Landing those as two separate tables a week
-- apart is how a schema grows `account_settings` AND `account_prefs` AND `account_flags`, none
-- of which anybody can name from memory afterwards. This table is the one place, and the second
-- feature is `ALTER TABLE account_settings ADD COLUMN …` — additive, no data motion, no
-- conflict with anything written here.
--
-- The corollary, stated so it is not rediscovered as a surprise: a column here is NOT
-- automatically visible to the staff console. `ohmail_admin` gets no grant on this table, so
-- The operator role and its grants are untouched by this
-- migration. A later column that the console genuinely must read has to say so in that script,
-- which is the right place for that decision to be argued.
--
-- ══ THE COLUMNS ══════════════════════════════════════════════════════════════════════════
--
--   dormancy_days         The cutline dial. NULL means "use the product default"
--                         (`DEFAULT_DORMANCY_DAYS`, 60), which is NOT stored here on purpose:
--                         storing the default would freeze every existing account at whatever
--                         the default happened to be on the day their row was created, and the
--                         spec calls this "a dial, not a constant to hard-code". A row exists
--                         only when somebody moved the dial off the default.
--
--                         CHECK (dormancy_days > 0): a zero or negative window makes every
--                         sender dormant, which silently empties the Screener queue and demands
--                         no decisions ever. That is not a setting, it is an outage, and the
--                         database is the only layer that can refuse it for every writer at
--                         once.
--
--   seed_confirmed_at     When the user confirmed the sent-mail seed review list. This is THE
--                         consent event of onboarding — the moment the product was told which
--                         people the user has written to and may hear from. It is a timestamp
--                         and not a boolean because "when" is the only form of this fact that
--                         can be reasoned about later ("was this before or after the reset?").
--
--                         Deliberately NOT derived from "does a rule with provenance
--                         'seeded-from-sent' exist". A user who unchecks every row and confirms
--                         has given a real answer — "none of these" — and derivation reads that
--                         answer as "never asked", so onboarding would ask again forever.
--
--   seed_confirmed_count  How many senders that confirm covered, and
--   seed_declined_count   how many the user unchecked before confirming. Reported, not read by
--                         any decision. They exist because the seed is the one step of
--                         onboarding that acts on the user's behalf, and "it wrote 38 rules and
--                         you removed 3" has to be answerable a month later without replaying
--                         the mailbox.
--
--   screening_reset_at    When the account's screening state was last wiped by the reset
--                         action. The reset is a supported operation, not only a development
--                         convenience — re-running the seed after a big change of life is the
--                         same button — so the fact that it happened is account state, not a log
--                         line.
--
-- ROLLBACK is `DROP TABLE account_settings`. The cost is that every account returns to the
-- default dial and onboarding re-offers the seed review once. Nothing about the mail moves, and
-- no consent is lost: consent lives in `rules`, which this table does not touch.

CREATE TABLE IF NOT EXISTS "account_settings" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"dormancy_days" integer,
	"seed_confirmed_at" timestamp with time zone,
	"seed_confirmed_count" integer DEFAULT 0 NOT NULL,
	"seed_declined_count" integer DEFAULT 0 NOT NULL,
	"screening_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_settings_dormancy_days_positive" CHECK ("dormancy_days" IS NULL OR "dormancy_days" > 0)
);
