/**
 * ═══ THE ADDRESS BOOK, DERIVED FROM THE MIRROR ═══════════════════════════════════════════
 *
 * Reported as: composing a message, the To field *"won't give me addresses from my actual
 * mailboxes I can fast-select on my typing"*. There was no address book at all — the field was
 * a bare text input, so every recipient had to be typed in full and remembered exactly.
 *
 * ── WHY THIS IS A SELECTOR AND NOT AN ENDPOINT ──────────────────────────────────────────
 *
 * There is no contacts table and this does not need one. Every address the user has ever
 * corresponded with is already in the local mirror, on the messages themselves, and the mirror
 * is on the same machine as the keystroke. A server round trip per keystroke would be slower,
 * would leak what is being typed before it is sent, and would need an endpoint, a rate limit
 * and a cache — for data the client already holds. So this is a pure function over the reader,
 * exactly like `tagsCrossView` or `triagePiles`, and it works offline, in the demo and on the
 * desktop shell for free.
 *
 * ── WHERE THE ADDRESSES COME FROM ───────────────────────────────────────────────────────
 *
 * Three places, and the third is the one that matters most:
 *
 *   · the FROM of every message — everyone who has written to the user;
 *   · the TO and CC of every message — everyone the user is in a thread with, including
 *     people who have never written to them directly;
 *   · the TO and CC of the user's own SENT drafts (`status: "sent"`), which is the only
 *     record of outbound correspondence the mirror holds. `Folder` is a closed six-member
 *     union with no Sent in it, so sent MESSAGES never reach the mirror at all — the draft
 *     rows are it, and leaving them out would rank the people the user writes to below the
 *     newsletters that write to them.
 *
 * ── THE ROBOTS ARE EXCLUDED, AND ONLY THE OBVIOUS ONES ──────────────────────────────────
 *
 * `noreply@`, `mailer-daemon@` and friends are addresses no reply can reach, so offering them
 * as recipients is offering to send mail into a hole. The list is deliberately short and
 * matched on the LOCAL PART only: a heuristic that guessed harder would eventually hide a real
 * person, and the cost of that is far worse than the cost of one dead suggestion. `no-reply`
 * and `donotreply` are the same word with punctuation, so punctuation is stripped before the
 * comparison rather than each spelling being listed.
 */
import type { EntityReader } from "./store.js";
import type { EmailAddress, EngineDraft, EngineMessage } from "./types.js";

export interface AddressBookEntry {
  /** Lower-cased — the identity. Two spellings of one address are one entry. */
  address: string;
  /**
   * The best display name seen for this address, or `""`.
   *
   * "Best" is the LONGEST non-empty one, which is a proxy for the most complete: senders
   * routinely appear as both "Lena" and "Lena Eichspan", and the fuller form is the one worth
   * showing and the one more likely to match what the user starts typing.
   */
  name: string;
  /** How many messages and drafts this address appears on. */
  count: number;
  /** The most recent appearance as epoch ms; `0` when nothing carrying it was dated. */
  lastAt: number;
}

/** Local parts that no reply can reach. Compared after stripping non-letters. */
const ROBOT_LOCALS = [
  "noreply",
  "donotreply",
  "mailerdaemon",
  "bounce",
  "bounces",
  "postmaster",
  "nobody",
];

/**
 * Is this an address a person reads?
 *
 * Exported because the compose surface needs the same answer when deciding whether something
 * the user typed by hand is worth remembering, and two copies of this list would drift.
 */
export function isRobotAddress(address: string): boolean {
  const local = address.slice(0, address.indexOf("@")).toLowerCase().replace(/[^a-z]/g, "");
  if (local === "") return false;
  return ROBOT_LOCALS.includes(local);
}

function addTo(
  into: Map<string, AddressBookEntry>,
  who: EmailAddress | null | undefined,
  at: number,
): void {
  const raw = who?.address?.trim();
  if (!raw || !raw.includes("@")) return;
  const address = raw.toLowerCase();
  if (isRobotAddress(address)) return;

  const name = (who?.name ?? "").trim();
  const prev = into.get(address);
  if (!prev) {
    into.set(address, { address, name, count: 1, lastAt: at });
    return;
  }
  prev.count += 1;
  if (at > prev.lastAt) prev.lastAt = at;
  // The longest name seen — see `AddressBookEntry.name`.
  if (name.length > prev.name.length) prev.name = name;
}

const stamp = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Every address the mirror knows, ranked. Newest-and-most-frequent first.
 *
 * @param exclude addresses that must never be offered — the account's own, above all. The
 *   caller supplies them because this module has no way to know whose mailbox it is reading,
 *   and suggesting somebody their own address as a recipient is noise at best.
 */
export function addressBook(
  reader: EntityReader,
  opts: { exclude?: readonly string[] } = {},
): AddressBookEntry[] {
  const into = new Map<string, AddressBookEntry>();

  for (const m of reader.list<EngineMessage>("message")) {
    const at = stamp(m.date);
    addTo(into, m.from, at);
    for (const who of m.to ?? []) addTo(into, who, at);
    for (const who of m.cc ?? []) addTo(into, who, at);
  }

  for (const d of reader.list<EngineDraft>("draft")) {
    // SENT only. A draft still being written names somebody the user has not decided to
    // write to yet, and an abandoned one names somebody they decided not to.
    if (d.status !== "sent") continue;
    const at = stamp(d.updatedAt ?? d.createdAt);
    for (const who of d.to ?? []) addTo(into, who, at);
    for (const who of d.cc ?? []) addTo(into, who, at);
  }

  const blocked = new Set((opts.exclude ?? []).map((a) => a.trim().toLowerCase()));
  return [...into.values()]
    .filter((e) => !blocked.has(e.address))
    .sort(byRank);
}

/**
 * RECENCY AND FREQUENCY, both, and the weighting is stated rather than tuned.
 *
 * Frequency alone ranks a mailing list above the colleague written to twice this week;
 * recency alone ranks whoever happened to send something an hour ago above the person written
 * to every day for a year. So the score is `count` plus a small recency bonus — frequency
 * leads, and recency only reorders addresses of comparable weight. The bonus is capped at 3,
 * which is deliberately less than the difference a handful of extra messages makes: it breaks
 * ties, it does not overturn them.
 *
 * `lastAt` then `address` are the tiebreaks, so the order is TOTAL. A comparator that can
 * return 0 for two different entries gives an order that depends on the engine's sort
 * stability, which is how a suggestion list flickers between two candidates as unrelated mail
 * arrives.
 */
const DAY = 86_400_000;

export function rankOf(entry: AddressBookEntry, now: number): number {
  const age = now - entry.lastAt;
  const bonus = entry.lastAt === 0 ? 0 : age < 7 * DAY ? 3 : age < 30 * DAY ? 2 : age < 90 * DAY ? 1 : 0;
  return entry.count + bonus;
}

function byRank(a: AddressBookEntry, b: AddressBookEntry): number {
  const now = Date.now();
  const d = rankOf(b, now) - rankOf(a, now);
  if (d !== 0) return d;
  if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/**
 * PREFIX MATCHING, on the address and on every word of the name.
 *
 * Prefix and not substring, and that is the whole difference between a useful list and a
 * confusing one: typing `an` should offer "Anna" and "andreas@…", not every address with the
 * letters `an` somewhere inside it. The name is split on whitespace so a surname is reachable
 * — somebody typing `eich` expects "Lena Eichspan" — and the address is matched both whole and
 * from its local part, so `example.com` finds people at that domain while `lena` finds
 * `lena@example.com`.
 *
 * An empty query returns nothing rather than everything. The field is not a browsable
 * directory; suggestions appear because the user started typing a name.
 */
export function matchAddresses(
  book: readonly AddressBookEntry[],
  query: string,
  limit = 6,
): AddressBookEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];

  const hit = (e: AddressBookEntry): boolean => {
    if (e.address.startsWith(q)) return true;
    const at = e.address.indexOf("@");
    if (at > 0 && e.address.slice(at + 1).startsWith(q)) return true;
    return e.name
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word !== "" && word.startsWith(q));
  };

  const out: AddressBookEntry[] = [];
  for (const e of book) {
    if (!hit(e)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** "Lena Eichspan <lena@example.com>", or the bare address when no name is known. */
export function formatRecipient(entry: AddressBookEntry): string {
  return entry.name === "" ? entry.address : `${entry.name} <${entry.address}>`;
}
