# `packages/db-mail/drizzle` — the SHARED mail-domain migration journal

Migrations here are **hand-written**. `drizzle-kit` was removed in stage 3
when this journal was split out: its snapshots were already five migrations stale, and
leaving them would have made the first post-split `generate` emit `DROP TABLE` for the other
half of the schema. A missing snapshot is loud; a wrong one is silent.

## Adding a migration

1. Write the `.sql` by hand, separating statements with `--> statement-breakpoint`.
2. Append an entry to `meta/_journal.json` with `when` = a fresh `Date.now()` that is
   **STRICTLY GREATER than this journal's current maximum**. drizzle applies an entry only if
   `max(created_at) < when`, so an entry at or below the maximum is skipped FOREVER, silently.
   This journal's own test suite asserts the ordering; adoption's unique index on
   `created_at` turns a collision into a loud failure instead of a silent skip.
3. Keep the seam: no statement here may name a private table (billing, credits, invites, waitlist, the identity ceremony, ops). This journal must build a complete, working mail database on its own, first, against an empty database — that is what a local engine does.
   `journal-split.test.ts` enforces this over the folder's current contents on every run.
4. Prove it — `makeMailTestDb()/makeTestDb()` replays the journal, and one real-Postgres run
   through `journal-split.pg.test.ts` checks the catalog.

## A migration in here is DESTRUCTIVE-BY-DEFAULT the moment it carries DML

`0021_mailbox_address_unique` opens with a dedup prelude, and the review of it produced two
rules that are general rather than specific to that file:

- **A corrective migration cannot correct an earlier one for a database that has not applied
  it yet.** drizzle applies entries in `when` order, so anything appended here runs *after*
  `0021`, including on the database that still has the data `0021`'s prelude would destroy. A
  data-loss rule shipped in the journal is therefore not fixable by a later journal entry —
  only by something that runs BEFORE the migrator. That is
  `assertNoActiveAddressDuplicates` in `packages/db/src/mailbox-dedup.ts`, called by
  `runMigrations` before the mail pass.
- **A migration that resolves ambiguous data must not guess.** `0021` keeps the OLDEST
  duplicate, which is not evidence of health: an old row with dead credentials outranks the
  working replacement whose credentials the same statement then deletes. Prefer refusing and
  making a human look. `pnpm db:mailboxes:dedup` is that human's tool.

`0021`'s `lower(address)` key is also worth reading correctly: it is collation-dependent and
is not RFC canonicalization. `packages/services/src/mailbox-service.ts:canonicalAddress`
states both limits in full.
