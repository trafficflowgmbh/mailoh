import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountSettings, contacts, mailboxes, messageBodies, messages, recordChanges, rules, type Tx,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SENT-MAIL SEED — consent, read off what the user has already done.

   The strongest thing anybody does towards a correspondent is WRITE TO THEM. So the first
   question a new mailbox is asked is not "who do you want to hear from" — an impossible
   question against fifteen thousand messages — but "here are the people you have written to;
   shall we let them through?". The list is shown BEFORE anything acts on it, and confirming it
   is the consent event.

   Three deliberate narrowings, each of which was easy to get wrong:

     · ADDRESS-LEVEL ONLY, NEVER DOMAIN. Writing to one person at a large mail provider says
       nothing about the rest of it, and writing to one colleague is indistinguishable from
       that without knowing which domains are companies. Domain-wide consent stays available
       where it belongs — as an explicit rule the user writes themselves.
     · TO AND CC BOTH COUNT. Copying somebody in is addressing them.
     · NO RETRO. A seeded rule routes future mail and moves nothing that already exists. One
       confirmation must never turn into thousands of moves inside somebody's mailbox.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How many of the user's own messages the seed reads.
 *
 * A bound rather than a promise: the review list says how many were scanned, and a mailbox
 * with more than this many sent messages gets its most recent ones. Recency is the right end
 * to keep — the people someone wrote to this year matter more than the ones they wrote to
 * once, a decade ago, and those old correspondents are exactly who the dormancy cutline is
 * designed to leave alone.
 */
export const SEED_SCAN_LIMIT = 5000;

export type SeedExclusionReason =
  /** The recipient address is a machine: bounces, daemons, no-reply, calendar servers. */
  | "robot-recipient"
  /** The message it was harvested from was itself automatic — an out-of-office, a bulk send. */
  | "machine-sent"
  /** One of the account's own addresses. */
  | "own-address";

export interface SeedCandidate {
  address: string;
  /**
   * How the user most recently addressed them, when it was readable.
   *
   * Most recent rather than first-seen or longest: a person's name in somebody's address book
   * changes, and the newest spelling is the one they will recognise. The scan runs newest
   * first, so the first readable name encountered is that one.
   */
  name: string | null;
  /** How many of the user's own messages named this person. */
  messages: number;
  /** The most recent time the user wrote to them. */
  lastWrittenAt: string | null;
  /** True when a rule for this sender already exists — shown, but not written again. */
  alreadyDecided: boolean;
}

export interface SeedReview {
  candidates: SeedCandidate[];
  /** What the robot filter removed, so the review list can disclose it rather than hide it. */
  excluded: Array<{ address: string; reason: SeedExclusionReason }>;
  /** How many of the user's own messages were read. */
  scannedMessages: number;
  /** True when this account has more sent mail than {@link SEED_SCAN_LIMIT}. */
  truncated: boolean;
}

export interface SeedConfirmResult {
  rulesCreated: number;
  contactsCreated: number;
  /** Candidates the user unchecked. Recorded because the seed acts on the user's behalf. */
  declined: number;
  /** Already had a rule, so nothing was written for them. */
  skipped: number;
  lastSeq: number | null;
}

/* ── the robot filter ─────────────────────────────────────────────────────────────────── */

/**
 * Local parts that are a machine talking, not a person.
 *
 * Matched after stripping punctuation, so one entry covers `no-reply`, `no_reply` and
 * `noreply` — the same normalisation the routing engine uses for the same family.
 */
const ROBOT_LOCAL_PREFIXES = [
  "noreply", "donotreply", "nreply", "mailerdaemon", "postmaster", "bounce",
  "unsubscribe", "notification", "notifications", "automailer", "autoreply",
  "calendarserver", "nopreply",
];

/** Domains whose entire purpose is automated delivery. */
const ROBOT_DOMAIN_HINTS = ["bounce", "bounces", "mailer", "sendgrid.net", "amazonses.com"];

/** `no-reply@`, `bounces+tag@`, `calendar-server@` — punctuation-insensitive, like the router. */
export function isRobotAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return true;
  const local = addr.slice(0, at).replace(/[^a-z0-9]/g, "");
  const domain = addr.slice(at + 1);
  if (ROBOT_LOCAL_PREFIXES.some((p) => local.startsWith(p))) return true;
  // VERP: `bounces+user=example.com@…` and the `+bounce`/`+unsub` tag family.
  if (/\+(bounce|unsub|remove|reject)/.test(addr.slice(0, at))) return true;
  return ROBOT_DOMAIN_HINTS.some((d) => domain === d || domain.endsWith(`.${d}`) || domain.startsWith(`${d}.`));
}

/** Subject shapes an auto-responder writes. Deliberately conservative — a false positive drops a real person. */
const OUT_OF_OFFICE = /^\s*(re:\s*)?(out of (the )?office|automatic(al)? reply|auto(matic)?[- ]?reply|abwesenheit|absence du bureau|autoreply|ferienabwesenheit)/i;

/**
 * Was this message generated rather than typed?
 *
 * Harvesting recipients out of the user's own out-of-office replies would read a machine's
 * address book as the user's. `Auto-Submitted: no` is RFC 3834's way of saying a human wrote
 * it, so presence alone is the wrong test.
 */
export function isMachineSent(headers: Readonly<Record<string, unknown>>, subject: string): boolean {
  const values = (name: string): string[] => {
    if (!Object.prototype.hasOwnProperty.call(headers, name)) return [];
    const v = headers[name];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  if (values("auto-submitted").some((v) => !/^no$/i.test(v.trim()))) return true;
  if (values("precedence").some((v) => /bulk|auto_?reply|junk|list/i.test(v))) return true;
  if (values("x-auto-response-suppress").length > 0) return true;
  return OUT_OF_OFFICE.test(subject);
}

/* ── header address parsing ───────────────────────────────────────────────────────────── */

const EMAIL_SHAPE = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,".]+$/;

/**
 * Addresses out of a raw `To:`/`Cc:` header line.
 *
 * Split on commas that are outside quotes and angle brackets — a display name is allowed to
 * contain both a comma and an at-sign (`"Roth, Lena" <lena@example.com>`), and a naive
 * `match(/\S+@\S+/g)` reads the quoted part as a second recipient.
 */
export function parseAddressList(line: string): Array<{ address: string; name: string | null }> {
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of line) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);

  const out: Array<{ address: string; name: string | null }> = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const lt = part.lastIndexOf("<");
    const gt = part.lastIndexOf(">");
    let address: string;
    let name: string | null = null;
    if (lt >= 0 && gt > lt) {
      address = part.slice(lt + 1, gt).trim();
      name = displayName(part.slice(0, lt));
    } else {
      address = part.replace(/^<|>$/g, "").trim();
    }
    address = address.toLowerCase();
    if (!EMAIL_SHAPE.test(address)) continue;
    out.push({ address, name });
  }
  return out;
}

/**
 * A readable display name, or nothing.
 *
 * ── WHY THIS DECODES RATHER THAN DROPS ────────────────────────────────────────────────────
 *
 * It used to return `null` for anything starting with `=?`, on the theory that "a half-decoded
 * name is worse than none". In real mail that theory dropped the display name of every
 * correspondent whose name carries an accent: a `To:`/`Cc:` display name with any non-ASCII
 * letter is transmitted as an RFC 2047 encoded-word (an `=?utf-8?Q?...?=` token that spells the
 * accented bytes back in ASCII), which is ASCII on the wire, so the drop-rule turned a name like
 * "Sébastien" into a bare address on the screen whose whole job is to help someone recognise who
 * they wrote to. Encoded-words are the COMMON case for a non-English address book, not an edge
 * one, and decoding them is the fix.
 *
 * ── AND WHY IT ALSO REPAIRS MOJIBAKE ──────────────────────────────────────────────────────
 *
 * A second, rarer corruption is a display name that reached storage as raw 8-bit UTF-8 in a
 * header (non-conformant, but real senders do it) and was folded through Latin-1 somewhere on
 * the way in, so `ø` (`0xC3 0xB8`) is stored as `Ã¸`. `repairLatin1Mojibake` reverses exactly
 * that, and only that — its round-trip guard leaves a correctly-decoded name untouched.
 */
function displayName(raw: string): string | null {
  const decoded = repairLatin1Mojibake(decodeEncodedWords(raw.trim()));
  const s = decoded.trim().replace(/^"|"$/g, "").trim();
  return s || null;
}

/**
 * RFC 2047 encoded-words → text. Handles `B` (base64) and `Q` (quoted-printable-ish) with any
 * charset, decoding UTF-8 exactly and treating everything else as Latin-1 (the only other
 * charset that appears in practice, and a safe superset of US-ASCII for the rest).
 *
 * Adjacent encoded-words separated by only whitespace are joined with the whitespace removed,
 * per §6.2 — that is how a long name is split across two words, and printing the fold as a space
 * would insert one that was never in the name. A `=?` that is not a well-formed encoded-word is
 * left exactly as it was, which is the whole difference from the predecessor that treated the
 * prefix alone as a reason to give up.
 */
export function decodeEncodedWords(input: string): string {
  const WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(input)) !== null) {
    const between = input.slice(last, m.index);
    // Whitespace between two encoded-words is a fold, not part of the name (RFC 2047 §6.2).
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    out += decodeWord(m[1]!, m[2]!.toUpperCase(), m[3]!);
    last = m.index + m[0].length;
    prevWasWord = true;
  }
  out += input.slice(last);
  return out;
}

function decodeWord(charset: string, enc: string, text: string): string {
  let bytes: Buffer;
  if (enc === "B") {
    bytes = Buffer.from(text, "base64");
  } else {
    // Q: `_` is a space, `=XX` is a byte, everything else is itself. `latin1` turns the
    // resulting code points back into the bytes they stand for before the charset decode.
    const q = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
    bytes = Buffer.from(q, "latin1");
  }
  const cs = charset.toLowerCase();
  return cs === "utf-8" || cs === "utf8" ? bytes.toString("utf8") : bytes.toString("latin1");
}

/**
 * Reverse a UTF-8 string that was mis-decoded as Latin-1, and NOTHING else.
 *
 * The signature of that corruption is that every code point is ≤ 0xFF (so the string is a
 * sequence of bytes pretending to be characters) and those bytes are themselves valid UTF-8.
 * A correctly-decoded name fails the test: `Sébastien` read as Latin-1 bytes is `53 e9 62…`,
 * and `0xE9` alone is not a legal UTF-8 lead, so the re-decode introduces a replacement
 * character and the lossless round-trip check below rejects it. Only genuine mojibake survives.
 */
export function repairLatin1Mojibake(s: string): string {
  // Cheap reject: no plausible UTF-8 lead byte in the Latin-1 range means nothing to repair.
  if (!/[Â-ô]/.test(s)) return s;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return s;
  const bytes = Buffer.from(s, "latin1");
  const decoded = bytes.toString("utf8");
  // Accept only when re-encoding reproduces the exact bytes — i.e. the re-decode was clean,
  // with no U+FFFD manufactured. That is what keeps a legitimately Latin-1 name intact.
  if (decoded !== s && Buffer.from(decoded, "utf8").equals(bytes)) return decoded;
  return s;
}

/* ── the review list ──────────────────────────────────────────────────────────────────── */

/**
 * Everyone this account has written to, robot-filtered, newest correspondence first.
 *
 * "Written by the user" is `from_address` matching one of the account's own mailbox
 * addresses, NOT "sits in a folder called Sent". Sent folders are named a dozen different ways
 * across providers, and — more importantly — a folder-shaped test would also sweep up an
 * Archive folder, whose messages were RECEIVED. Harvesting their `To`/`Cc` would seed consent
 * for everyone the user was once copied alongside, which is not consent at all.
 *
 * The known limitation of that choice: mail sent from an alias the account does not list as a
 * mailbox address is not read. It is the safe direction to be wrong in — a missing candidate
 * is one row the user does not see, an extra one is consent nobody gave.
 */
export async function buildSeedReview(ctx: ServiceContext, limit = SEED_SCAN_LIMIT): Promise<SeedReview> {
  const own = await ownAddresses(ctx);
  if (own.size === 0) return { candidates: [], excluded: [], scannedMessages: 0, truncated: false };

  const rows = await ctx.db
    .select({
      id: messages.id,
      date: messages.date,
      subject: messages.subject,
      // FIVE KEYS, NOT THE WHOLE HEADER BLOB.
      //
      // The scan reads `To`/`Cc` and the three headers that mark a message as machine-written,
      // and nothing else. Selecting `headers` whole ships every stored header of up to
      // SEED_SCAN_LIMIT messages — Received chains included — across the wire and into memory
      // for a function that discards all of it. Projecting server-side turns the dominant cost
      // of this read into a few kilobytes. `jsonb_strip_nulls` keeps the shape a caller would
      // have got from the real column: a header that is absent stays absent, rather than
      // arriving as an explicit null that `hasOwnProperty` would answer yes to.
      headers: sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(
        'to', ${messageBodies.headers} -> 'to',
        'cc', ${messageBodies.headers} -> 'cc',
        'auto-submitted', ${messageBodies.headers} -> 'auto-submitted',
        'precedence', ${messageBodies.headers} -> 'precedence',
        'x-auto-response-suppress', ${messageBodies.headers} -> 'x-auto-response-suppress'
      ))`,
    })
    .from(messages)
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(
      eq(messages.accountId, ctx.accountId),
      sql`lower(${messages.fromAddress}) in ${ownList(own)}`,
    ))
    .orderBy(desc(messages.date))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const scanned = truncated ? rows.slice(0, limit) : rows;

  const found = new Map<string, SeedCandidate>();
  const excluded = new Map<string, SeedExclusionReason>();

  for (const r of scanned) {
    const headers = (r.headers as Record<string, unknown> | null) ?? {};
    if (isMachineSent(headers, r.subject ?? "")) {
      for (const rec of recipientsOf(headers)) {
        if (!found.has(rec.address)) excluded.set(rec.address, excluded.get(rec.address) ?? "machine-sent");
      }
      continue;
    }
    for (const rec of recipientsOf(headers)) {
      if (own.has(rec.address)) { excluded.set(rec.address, "own-address"); continue; }
      if (isRobotAddress(rec.address)) { excluded.set(rec.address, "robot-recipient"); continue; }
      excluded.delete(rec.address);
      const held = found.get(rec.address);
      const when = r.date ? r.date.toISOString() : null;
      if (held) {
        held.messages += 1;
        if (!held.name && rec.name) held.name = rec.name;
        if (when && (!held.lastWrittenAt || when > held.lastWrittenAt)) held.lastWrittenAt = when;
      } else {
        found.set(rec.address, {
          address: rec.address, name: rec.name, messages: 1, lastWrittenAt: when, alreadyDecided: false,
        });
      }
    }
  }

  const decided = await decidedSenders(ctx.db, ctx.accountId, [...found.keys()]);
  for (const c of found.values()) c.alreadyDecided = decided.has(c.address);

  const candidates = [...found.values()].sort((a, b) =>
    b.messages - a.messages || (b.lastWrittenAt ?? "").localeCompare(a.lastWrittenAt ?? "") || a.address.localeCompare(b.address));

  return {
    candidates,
    excluded: [...excluded.entries()].map(([address, reason]) => ({ address, reason })).sort((a, b) => a.address.localeCompare(b.address)),
    scannedMessages: scanned.length,
    truncated,
  };
}

function recipientsOf(headers: Record<string, unknown>): Array<{ address: string; name: string | null }> {
  const out: Array<{ address: string; name: string | null }> = [];
  for (const field of ["to", "cc"]) {
    if (!Object.prototype.hasOwnProperty.call(headers, field)) continue;
    const v = headers[field];
    const lines = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    for (const line of lines) if (typeof line === "string") out.push(...parseAddressList(line));
  }
  return out;
}

async function ownAddresses(ctx: ServiceContext): Promise<Set<string>> {
  const rows = await ctx.db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, ctx.accountId));
  return new Set(rows.map((r) => r.address.trim().toLowerCase()));
}

const ownList = (own: Set<string>) => sql`(${sql.join([...own].map((a) => sql`${a}`), sql`, `)})`;

/**
 * Addresses that already carry an enabled sender rule — a decision the seed must not overwrite.
 *
 * Takes a query runner rather than a `ServiceContext` because it is asked twice and the second
 * time it MUST run on the confirmation's own transaction handle: the answer it gives outside a
 * transaction is a snapshot that a concurrent confirm can invalidate before either commits.
 */
async function decidedSenders(
  db: ServiceContext["db"] | Tx, accountId: string, addresses: string[],
): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const rows = await db.select({ match: rules.match }).from(rules)
    .where(and(
      eq(rules.accountId, accountId),
      eq(rules.kind, "sender"),
      eq(rules.enabled, true),
      inArray(sql`lower(${rules.match})`, addresses),
    ));
  return new Set(rows.map((r) => r.match.trim().toLowerCase()));
}

/**
 * How many rows one INSERT carries.
 *
 * Postgres refuses a statement with more than 65 535 bind parameters, and a `rules` row binds
 * eight columns, so the ceiling is real rather than theoretical for an account with thousands
 * of correspondents. Five hundred keeps every statement an order of magnitude clear of it and
 * bounds the memory one round trip has to hold, while still collapsing a two-thousand-person
 * confirmation from ten thousand round trips into a dozen.
 */
const WRITE_CHUNK = 500;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ── the confirmation ─────────────────────────────────────────────────────────────────── */

/**
 * Write the consent the user just gave. One transaction, no mail moved.
 *
 * The addresses the caller asks for are INTERSECTED with a freshly computed review list rather
 * than trusted. The list is the offer; a confirmation can only ever be a subset of it. Without
 * the intersection this endpoint would write a rule for any address a caller cared to name.
 *
 * `retroRequestedAt` stays NULL and no `folder_state` row is touched, which is the whole
 * difference between this and a Screener decision. A Screener decision is about one sender the
 * user is looking at; this is a bulk import of consent they gave by writing, and turning it
 * into thousands of server-side moves is precisely what the model exists to avoid.
 *
 * ── ONE EFFECT PER PERSON, ENFORCED BY A ROW LOCK AND A RE-READ — NOT BY A ONE-SHOT CLAIM ──
 *
 * Sequentially, running this twice is already harmless: the second `buildSeedReview` marks
 * every rule the first run wrote `alreadyDecided`, and those are skipped. CONCURRENTLY it was
 * not. Two submits of the same review — a double-click, a retry on a slow link — both computed
 * their list before either committed, so both saw `alreadyDecided: false` and both inserted a
 * rule per candidate. `rules` has no unique constraint on `(account_id, kind, match)`, and
 * deliberately so (two rules may legitimately name one sender; `consentIndex` resolves them),
 * which means nothing downstream would have rejected the duplicates either.
 *
 * The transaction therefore opens by taking the account's `account_settings` row — an upsert
 * that always fires, so it locks whether or not the row existed — and only THEN asks which of
 * the accepted addresses already carry a rule. That second question is the one that matters: a
 * concurrent confirm that got there first has committed by the time this one holds the lock,
 * so its rules are visible and every one of them drops out of the write set. Two simultaneous
 * confirmations produce one rule per person and two honest answers, the second reporting its
 * work as `skipped`.
 *
 * ── AND THE REVIEW CAN BE RUN AGAIN, WHICH IS WHY THE CLAIM HAD TO GO ──────────────────────
 *
 * The earlier design guarded the stamp — the upsert only fired while `seed_confirmed_at` was
 * NULL — so the second confirmation of an account's life was a 409 no matter how far apart the
 * two were. That made "the seed has been offered" and "the seed may never be offered again"
 * the same fact, and it is wrong in the ordinary case rather than an edge one: connecting a
 * second mailbox brings a second address book of people the user has written to, and the only
 * way to consent to them was to reset every screening decision on the account. The stamp now
 * records WHEN the review was last confirmed and nothing more. Re-running it writes rules for
 * whoever is new and skips whoever already has one, which is the same guarantee the race above
 * needs and is why one mechanism serves both.
 */
export async function confirmSeed(
  ctx: ServiceContext, addresses: readonly string[],
): Promise<SeedConfirmResult> {
  const review = await buildSeedReview(ctx);
  const own = await ownAddresses(ctx);
  const offered = new Map(review.candidates.map((c) => [c.address, c]));
  const asked = new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0));

  const accept: SeedCandidate[] = [];
  for (const address of asked) {
    const c = offered.get(address);
    if (!c) continue;            // never offered, or already decided — not this endpoint's business
    if (c.alreadyDecided) continue;
    accept.push(c);
  }
  const declined = review.candidates.filter((c) => !c.alreadyDecided && !asked.has(c.address)).length;
  const skippedOffered = review.candidates.filter((c) => c.alreadyDecided && asked.has(c.address)).length;

  return asTx(ctx).transaction(async (tx) => {
    // ── THE LOCK. FIRST STATEMENT, AND THE ONLY THING STANDING BETWEEN A DOUBLE-CLICK AND
    //    TWO RULES PER PERSON. See the note above.
    //
    // An upsert with no `setWhere`, so it always fires and therefore always locks: on a virgin
    // account the INSERT takes the primary key, on an established one the DO UPDATE takes the
    // row. Either way a concurrent confirmation blocks here rather than racing past, and reads
    // the winner's rules when it is let through.
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { updatedAt: ctx.now() },
      });

    // The question the lock was taken for. `alreadyDecided` above was computed BEFORE the
    // transaction opened and is stale by definition; this is the same question asked where the
    // answer cannot change under us.
    const decidedNow = await decidedSenders(tx, ctx.accountId, accept.map((c) => c.address));
    const write = accept.filter((c) => !decidedNow.has(c.address));
    const skipped = skippedOffered + (accept.length - write.length);

    // THE USER'S OWN ADDRESSES ARE CONTACTS, and so is everyone consented to here. `contacts`
    // is what the routing layer reads as "senders this account knows", and mail somebody sends
    // to themselves — a note, a forward from another account — is not a first contact. The
    // connect-time pass this seed replaces wrote the own-address rows on every attach; the seed
    // is now their only writer, so dropping the line would look like nothing at all until
    // somebody mailed themselves and found it screened.
    const contactAddresses = [...new Set([...own, ...write.map((c) => c.address)])];
    let contactsCreated = 0;
    for (const part of chunked(contactAddresses, WRITE_CHUNK)) {
      const inserted = await tx.insert(contacts)
        .values(part.map((address) => ({ accountId: ctx.accountId, address })))
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      contactsCreated += inserted.length;
    }

    let lastSeq: bigint | null = null;
    for (const part of chunked(write, WRITE_CHUNK)) {
      const rows = await tx.insert(rules).values(part.map((c) => ({
        accountId: ctx.accountId,
        kind: "sender",
        match: c.address,
        destination: "INBOX",
        priority: 0,
        enabled: true,
        provenance: "seeded-from-sent",
        // NULL, always. See the note above: consent granted in bulk must not move the past.
        retroRequestedAt: null,
      }))).returning({ id: rules.id });
      const seqs = await recordChanges(tx, rows.map((r) => ({
        accountId: ctx.accountId, entityType: "rule" as const, entityId: r.id, op: "create" as const, meta: null,
      })));
      lastSeq = seqs[seqs.length - 1] ?? lastSeq;
    }

    // The stamp, written LAST and describing the run that just happened rather than the first
    // one that ever did. `seed_confirmed_at` is a date the client reads to decide whether the
    // review is still owed; the two counters beside it are diagnostics, and they describe THIS
    // confirmation so that they cannot disagree with the timestamp they sit next to.
    await tx.insert(accountSettings).values({
      accountId: ctx.accountId,
      seedConfirmedAt: ctx.now(),
      seedConfirmedCount: write.length,
      seedDeclinedCount: declined,
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: {
        seedConfirmedAt: ctx.now(),
        seedConfirmedCount: write.length,
        seedDeclinedCount: declined,
        updatedAt: ctx.now(),
      },
    });

    return {
      rulesCreated: write.length,
      contactsCreated,
      declined,
      skipped,
      lastSeq: lastSeq === null ? null : Number(lastSeq),
    };
  });
}

/** Whether this account has been through the seed review, and the window it uses. */
export async function consentSettings(
  ctx: ServiceContext,
): Promise<{ seedConfirmedAt: string | null; dormancyDays: number | null; screeningResetAt: string | null }> {
  const [row] = await ctx.db.select().from(accountSettings)
    .where(eq(accountSettings.accountId, ctx.accountId)).limit(1);
  // An absent row is every account that has never changed anything. Defaults, not an error.
  return {
    seedConfirmedAt: row?.seedConfirmedAt ? row.seedConfirmedAt.toISOString() : null,
    dormancyDays: row?.dormancyDays ?? null,
    screeningResetAt: row?.screeningResetAt ? row.screeningResetAt.toISOString() : null,
  };
}

/* `assertNotConfirmed` used to live here: a helper that turned a non-null `seed_confirmed_at`
   into a 409. It is gone because the fact it asserted is no longer a refusal — a confirmed
   account may be shown the review again, and `confirmSeed` writes only what is new. A guard
   whose condition has stopped meaning "refuse" is worse than no guard: the next caller to
   reach for it would reintroduce the wall by name. */
