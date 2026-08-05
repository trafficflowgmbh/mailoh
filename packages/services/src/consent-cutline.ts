import { sql } from "drizzle-orm";
import type { ServiceContext } from "./context.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CUTLINE, SERVER-SIDE — how many senders are still owed a decision.

   The client computes this over its own mirror, because that is where the Screener is drawn
   from. This is the same question asked of the database, for the callers that have no mirror:
   anything that wants to know whether an account still has screening work waiting.

   The two must agree, and they are two implementations, so `consent-cutline.pg.test.ts` runs
   both over the same rows and requires the same answer. That is the only thing standing between
   them and the ordinary fate of a rule written twice.

   ── WHAT COUNTS AS A DECISION ────────────────────────────────────────────────────────────

   An enabled rule naming the sender or their domain, whose destination is not the Screener
   itself. A rule pointing AT the Screener says "keep holding this one", which is the absence of
   a decision written down, and reading it as one would exempt that sender from the cutline for
   ever.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Days of quiet before a sender stops being asked about. MUST equal the client engine's
 * `DEFAULT_DORMANCY_DAYS`; the parity test pins the two together.
 */
export const DEFAULT_DORMANCY_DAYS = 60;

/** Folders the product presents. A Sent folder, or any of the user's own, is not one of them. */
const PRESENTED_FOLDERS = [
  "INBOX", "ohmail/Screener", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];

export interface CutlineCounts {
  /** Senders with a decision behind them, whichever way it went. */
  decidedSenders: number;
  /** No decision, and either unread mail or something recent. These are the queue. */
  activeUndecidedSenders: number;
  /** No decision and nothing recent. They wait in History and are never asked about. */
  dormantUndecidedSenders: number;
}

export interface CutlineOptions {
  /** Days. Defaults to {@link DEFAULT_DORMANCY_DAYS}. */
  dormancyDays?: number;
}

/**
 * One pass over the account's senders.
 *
 * Mail the USER wrote is excluded by address rather than by folder name: a Sent folder is called
 * a dozen different things, and counting the user as one of their own correspondents would make
 * every account permanently active.
 */
export async function cutlineCounts(
  ctx: ServiceContext, opts: CutlineOptions = {},
): Promise<CutlineCounts> {
  const days = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  const cutoff = new Date(ctx.now().getTime() - days * 24 * 60 * 60 * 1000);
  const folders = sql`(${sql.join(PRESENTED_FOLDERS.map((f) => sql`${f}`), sql`, `)})`;

  const rows = await ctx.db.execute<{
    decided: string; active_undecided: string; dormant_undecided: string;
  }>(sql`
    with own as (
      select lower(address) a from mailboxes where account_id = ${ctx.accountId}::uuid
    ),
    decided_sender as (
      select lower(match) m from rules
       where account_id = ${ctx.accountId}::uuid and enabled
         and kind = 'sender' and destination <> 'ohmail/Screener'
    ),
    decided_domain as (
      select lower(match) m from rules
       where account_id = ${ctx.accountId}::uuid and enabled
         and kind = 'domain' and destination <> 'ohmail/Screener'
    ),
    inbound as (
      select lower(m.from_address) addr,
             bool_or(m.unread) any_unread,
             max(m.date) newest
        from messages m
        join folder_state fs on fs.message_id = m.id
       where m.account_id = ${ctx.accountId}::uuid
         and fs.desired_folder in ${folders}
         and lower(m.from_address) not in (select a from own)
       group by 1
    ),
    classified as (
      select i.addr,
             (exists (select 1 from decided_sender r where r.m = i.addr)
              or (position('@' in i.addr) > 0
                  and exists (select 1 from decided_domain d
                               where d.m = substring(i.addr from position('@' in i.addr) + 1)))) as decided,
             (i.any_unread or (i.newest is not null and i.newest >= ${cutoff.toISOString()}::timestamptz)) as active
        from inbound i
    )
    select count(*) filter (where decided)                        as decided,
           count(*) filter (where not decided and active)         as active_undecided,
           count(*) filter (where not decided and not active)     as dormant_undecided
      from classified
  `);

  // The two drivers behind `Db` disagree about what `execute` returns: the Postgres one hands
  // back an array subclass, PGlite an object with a `rows` property. Neither is iterable in a
  // way that covers the other, so the shape is read rather than spread.
  const list = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>)
    : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  const r = list[0] as { decided?: unknown; active_undecided?: unknown; dormant_undecided?: unknown } | undefined;
  return {
    decidedSenders: Number(r?.decided ?? 0),
    activeUndecidedSenders: Number(r?.active_undecided ?? 0),
    dormantUndecidedSenders: Number(r?.dormant_undecided ?? 0),
  };
}

/**
 * IS THERE SCREENING WORK WAITING? The honest form of "is the backlog empty".
 *
 * The predicate this replaces asked whether any mail was sitting in the Screener FOLDER, which
 * answers a different question: after a migration, a mailbox can hold thousands of messages
 * there from senders nobody will ever be asked about, because they went quiet years ago. That
 * reads as a permanent backlog and never empties.
 *
 * Dormant senders are not work. Only a sender with unread or recent mail and no decision behind
 * them is.
 */
export async function hasUndecidedActiveSenders(
  ctx: ServiceContext, opts: CutlineOptions = {},
): Promise<boolean> {
  return (await cutlineCounts(ctx, opts)).activeUndecidedSenders > 0;
}
