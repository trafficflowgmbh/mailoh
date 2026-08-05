import { WATCHED_FOLDERS } from "./imap-types.js";

/**
 * THE ORGANIZER LEASE — how two databases that can never see each other agree on who organizes
 * a mailbox.
 *
 * A LOCAL desktop install runs on its own on-disk PGlite and structurally cannot query the hosted
 * cloud database; Cloud runs on that database and cannot see the desktop's PGlite. The mailbox is
 * the only medium they share, so the claim lives **in the mailbox**: one message per organizer in
 * an unsubscribed `ohmail/_meta` folder.
 *
 * ── IT IS A LEASE, NOT A MUTEX, AND THAT IS NOT A HEDGE ───────────────────────────────────
 *
 * IMAP has no compare-and-swap. Two installs can APPEND in the same instant and both succeed.
 * What this buys is conflict DETECTION with every-cycle re-verification, and that is enough for
 * the actual requirement: a transient one-cycle overlap is idempotent-safe, while steady-state dual
 * organizing becomes impossible because the loser's next gate refuses. Do not upgrade the naming or
 * the comments to "lock" — the word would be a claim the mechanism cannot make.
 *
 * **The REASON for that idempotence changed under this comment.** It used
 * to read "the pipeline dedups by Message-ID"; that is no longer true — `dedup_key` is
 * `fp1:<sha256>` over every field a sender chooses, and the Message-ID is one input among ten. The
 * conclusion survives for a BETTER reason: the fingerprint is a strictly finer identity, so two
 * engines ingesting the same bytes still resolve to the same row, and the second engine's
 * observation of a locator the first already recorded is now an `external_copy` — which writes one
 * instance row and changes no placement — rather than an adoption. A transient overlap therefore
 * costs a duplicate fetch, not a fought-over `desired_folder`.
 *
 * Why two organizers must never coexist, concretely: `runSyncCycle` ingests *through* the
 * pipeline, so syncing and organizing are one loop. Two organizers means two engines classifying
 * the same new message and issuing competing moves — and `adopt_external` ("reality changed in a
 * way we did not cause, so the user wins") was written for a HUMAN in another mail client, not
 * for a second ohmail fighting the first. `adopt_external` is explicitly
 * NOT load-bearing here.
 *
 * ── THREE LAYERS, AND THE SPLIT IS THE POINT ──────────────────────────────────────────────
 *
 *   1. FORMAT  — {@link formatClaim} / {@link parseClaim}. Pure string work.
 *   2. DECISION — {@link decideLease}. A pure function over parsed claims, so the whole table is
 *      unit-testable without a server and every arm can be watched fail.
 *   3. IO — {@link LeaseIo} and {@link runLeaseGate}. The only part that needs a connection.
 *
 * The decision layer never touches IO and the IO layer never decides. That is what makes the
 * priority table checkable at all: a decision function that could also fail to read is a
 * function whose "stand down" and "could not look" are the same code path, and §3.4 exists
 * because those two must never be reachable from one another.
 */

/**
 * The folder holding the claims. **No leading dot**, so it survives both `/` and `.` hierarchy
 * delimiters when mapped through the adapter's `toServerPath`.
 *
 * It must stay OUT of {@link WATCHED_FOLDERS} — that constant is the input to `changesSince`, so
 * a watched `_meta` would ingest the lease's own bookkeeping as mail, classify it, and file it.
 * {@link META_FOLDER_IS_UNWATCHED} is that assertion rather than a comment, and it is evaluated
 * at module load so the two constants cannot drift apart unnoticed.
 */
export const META_FOLDER = "ohmail/_meta";

/** `true` iff {@link META_FOLDER} is absent from the watched set. Asserted by the suite. */
export const META_FOLDER_IS_UNWATCHED: boolean = !(WATCHED_FOLDERS as readonly string[]).includes(META_FOLDER);

/** The claim format this build writes and understands. */
export const CLAIM_PROTOCOL = 1;

/**
 * How long a claim stays fresh without a renew.
 *
 * Generous relative to plausible clock skew between two machines, and generous relative to a
 * poll interval measured in seconds. The failure this window guards is a real one in both
 * directions: too short and a laptop that slept through a renew is treated as gone while it is
 * still organizing; too long and a genuinely dead install holds a mailbox hostage. Ten minutes
 * against a renew every cycle means roughly forty missed renews before anyone is declared stale.
 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/** Who is holding a claim. A closed set — an unrecognised value is foreign-and-unknown. */
export type OrganizerKind = "local" | "cloud";

/** Whether a human has authorized THIS organizer to become the organizer of this mailbox. */
export type TakeoverAuthorization = "authorized" | "none";

/** A claim message, parsed. */
export interface OrganizerClaim {
  installId: string;
  kind: OrganizerKind | "unknown";
  protocol: number;
  /** ISO instant of the last renew. NOT IMAP INTERNALDATE — that is the server's clock. */
  heartbeat: Date;
  /** ISO instant this install BECAME organizer, as distinct from last seen. */
  claimedAt: Date;
  displayName: string;
  /** Per-write nonce. See the clone defence on {@link LeaseSelf}. */
  nonce: string;
  /** Whatever the IO layer needs to expunge this exact message. */
  ref?: unknown;
}

/**
 * A message that says it is a claim and then is not parseable as one.
 *
 * Distinct from "not a claim" on purpose. A message in `ohmail/_meta` WITHOUT
 * `X-Ohmail-Lease: 1` is a stray or a future meta record type and is invisible to this module —
 * that is what makes the discriminator header worth having. A message WITH it whose fields are
 * unreadable is EVIDENCE THAT SOMEBODY CLAIMED, and evidence is not nothing: it produces
 * `available`, never `organize`. Reading it as "no claim, so organize" is the dual-organizer bug
 * through the back door.
 */
export interface MalformedClaim {
  malformed: true;
  /** Why, for the log. Never surfaced to a user. */
  reason: string;
  ref?: unknown;
}

export type ClaimRecord = OrganizerClaim | MalformedClaim;

export function isMalformed(c: ClaimRecord): c is MalformedClaim {
  return (c as MalformedClaim).malformed === true;
}

/**
 * Who we are, for the gate.
 *
 * ── THE CLONE DEFENCE, AND WHY `lastNonce` IS MEMORY-ONLY ─────────────────────────────────
 *
 * Restore-from-backup clones the install id. Two machines then both believe every claim carrying
 * that id is their own, and identity matching — which is what makes own-role resumption work —
 * silently permits exactly the dual organizing it was written to prevent.
 *
 * So every write carries a fresh nonce and the writer remembers the last one it wrote. An "own"
 * claim whose nonce is NOT the one we wrote, and whose heartbeat is NEWER than ours, is somebody
 * else with our id: treat it as foreign.
 *
 * `lastNonce` is held IN MEMORY ONLY and deliberately forgotten on restart. Persisting it would
 * break own-role resumption — after a crash we would not recognise our own claim and would stand
 * down from a mailbox nobody else wants. Forgetting it means a fresh process trusts any claim
 * bearing its id exactly once, which is the correct trade: the clone case needs two LIVE writers
 * to be dangerous, and two live writers is exactly the case a null nonce cannot reach.
 */
export interface LeaseSelf {
  installId: string;
  kind: OrganizerKind;
  displayName: string;
  /** The nonce of our last write this process, or `null` on a fresh start. */
  lastNonce: string | null;
  protocol?: number;
}

export type StandDownReason =
  | "organized_elsewhere:cloud"
  | "organized_elsewhere:local"
  | "organized_elsewhere:unknown";

/** Organize this mailbox, and renew our claim while doing so. */
export interface OrganizeVerdict {
  verdict: "organize";
  renew: true;
}

/** Somebody else is organizing this mailbox right now. Stop, and release our own claim. */
export interface StandDownVerdict {
  verdict: "stand_down";
  reason: StandDownReason;
  /** The winning claim, so a UI can name the machine. `null` when it was malformed. */
  by: OrganizerClaim | null;
}

/**
 * Nobody is organizing this mailbox, but somebody WAS.
 *
 * The third verdict, and the one a two-verdict table gets wrong. "No fresh foreign claim ⇒
 * organize" is precisely §4's forbidden auto-resume: a Cloud subscription lapses, and a
 * forgotten install on an office machine silently becomes the thing that moves someone's mail,
 * triggered by a billing event, with a rules store frozen at stand-down.
 *
 * §4's governing principle is that **ceasing to organize is always automatic; BECOMING an
 * organizer always requires an explicit human action** — including for Cloud. `available` is
 * that principle with a name. It converts to `organize` only when the caller passes
 * `takeover: "authorized"`, which means a human clicked something.
 *
 * Zero claims is NOT this. A mailbox nobody has ever organized has nobody to take over from.
 */
export interface AvailableVerdict {
  verdict: "available";
  /** The stale claim we would be taking over from, or `null` if it was malformed. */
  by: OrganizerClaim | null;
}

export type LeaseVerdict = OrganizeVerdict | StandDownVerdict | AvailableVerdict;

// ── LAYER 1: FORMAT ─────────────────────────────────────────────────────────────────────────

const H = {
  lease: "X-Ohmail-Lease",
  kind: "X-Ohmail-Organizer-Kind",
  installId: "X-Ohmail-Install-Id",
  protocol: "X-Ohmail-Protocol",
  heartbeat: "X-Ohmail-Heartbeat",
  claimedAt: "X-Ohmail-Claimed-At",
  displayName: "X-Ohmail-Display-Name",
  nonce: "X-Ohmail-Nonce",
} as const;

/** Strip CR/LF so a display name can never inject a header. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export interface ClaimInput {
  installId: string;
  kind: OrganizerKind;
  displayName: string;
  heartbeat: Date;
  claimedAt: Date;
  nonce: string;
  protocol?: number;
}

/**
 * One RFC822 message per organizer.
 *
 * The body is a sentence for a human who opens `ohmail/_meta` in Apple Mail and wonders what
 * this is. It carries no information the headers do not — a reader that parses the body would be
 * a second format.
 */
export function formatClaim(c: ClaimInput): string {
  const protocol = c.protocol ?? CLAIM_PROTOCOL;
  const lines = [
    `${H.lease}: 1`,
    `${H.kind}: ${c.kind}`,
    `${H.installId}: ${headerSafe(c.installId)}`,
    `${H.protocol}: ${protocol}`,
    `${H.heartbeat}: ${c.heartbeat.toISOString()}`,
    `${H.claimedAt}: ${c.claimedAt.toISOString()}`,
    `${H.displayName}: ${headerSafe(c.displayName)}`,
    `${H.nonce}: ${headerSafe(c.nonce)}`,
    `Subject: ohmail organizer claim`,
    `Date: ${c.heartbeat.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    `ohmail is organizing this mailbox from ${headerSafe(c.displayName)}.`,
    "This message is bookkeeping. Deleting it is safe; ohmail writes a new one on its next cycle.",
    "",
  ];
  return lines.join("\r\n");
}

/** Read the headers of one message. Returns `null` when it is not a claim at all. */
export function parseClaim(raw: string, ref?: unknown): ClaimRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  // Unfold continuation lines before splitting: a long display name may be wrapped by the
  // server, and a folded header read line-by-line loses everything after the first line.
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }

  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  if (get(H.lease) !== "1") return null; // not a claim — a stray, or a future meta record type

  const malformed = (reason: string): MalformedClaim =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  const installId = get(H.installId);
  if (!installId) return malformed("no install id");

  const protocolRaw = get(H.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return malformed("unreadable protocol");

  const heartbeat = new Date(get(H.heartbeat) ?? "");
  if (Number.isNaN(heartbeat.getTime())) return malformed("unreadable heartbeat");

  // A claim with no `claimedAt` is still a claim; it just cannot win the local-vs-local
  // incumbent comparison. Defaulting to the heartbeat makes it the NEWEST possible incumbent,
  // which is the losing side of §3.2 rule 4 — the fail-safe direction.
  const claimedAtRaw = get(H.claimedAt);
  const claimedAt = claimedAtRaw ? new Date(claimedAtRaw) : heartbeat;

  const kindRaw = (get(H.kind) ?? "").toLowerCase();
  const kind: OrganizerKind | "unknown" = kindRaw === "local" || kindRaw === "cloud" ? kindRaw : "unknown";

  const claim: OrganizerClaim = {
    installId,
    kind,
    protocol,
    heartbeat,
    claimedAt: Number.isNaN(claimedAt.getTime()) ? heartbeat : claimedAt,
    displayName: get(H.displayName) ?? "",
    nonce: get(H.nonce) ?? "",
  };
  return ref === undefined ? claim : { ...claim, ref };
}

// ── LAYER 2: THE DECISION ───────────────────────────────────────────────────────────────────

export interface DecideLeaseInput {
  self: LeaseSelf;
  claims: readonly ClaimRecord[];
  now: Date;
  staleAfterMs?: number;
  /** `"authorized"` iff a human explicitly asked THIS organizer to take this mailbox. */
  takeover?: TakeoverAuthorization;
}

/**
 * A heartbeat in the FUTURE counts as fresh.
 *
 * Two machines, two wall clocks. A peer whose clock runs ahead is still alive, and the fail-safe
 * direction is to believe it — treating a skewed peer as stale is how both sides decide they are
 * the organizer.
 */
function isFresh(heartbeat: Date, now: Date, staleAfterMs: number): boolean {
  return now.getTime() - heartbeat.getTime() < staleAfterMs;
}

/**
 * Coalesce to one claim per install id, newest heartbeat wins.
 *
 * §3.3: renewing is append-then-expunge, because IMAP has no in-place update. A crash between
 * the two steps therefore leaves TWO of our own claims in the folder, and that is a state to
 * handle rather than to hope against. Readers coalesce; the writer cleans up the extras on its
 * next renew.
 */
function coalesce(claims: readonly ClaimRecord[]): { valid: OrganizerClaim[]; malformed: MalformedClaim[] } {
  const malformed: MalformedClaim[] = [];
  const newest = new Map<string, OrganizerClaim>();
  for (const c of claims) {
    if (isMalformed(c)) {
      malformed.push(c);
      continue;
    }
    const prior = newest.get(c.installId);
    if (!prior || c.heartbeat.getTime() > prior.heartbeat.getTime()) newest.set(c.installId, c);
  }
  return { valid: [...newest.values()], malformed };
}

/**
 * THE DECISION TABLE. Pure — no clock of its own, no IO, no side effects.
 *
 * Priority, and every arm traces to a ruling rather than to a preference:
 *
 *  1. A fresh foreign claim with a protocol HIGHER than ours ⇒ stand down (`:unknown`). Never
 *     "unparseable, so ignore": a future format that older installs ignored would silently
 *     re-enable dual organizing against every one of them.
 *  2. We are `local`, a fresh foreign `cloud` claim exists ⇒ stand down (`:cloud`). §4's "a fresh
 *     cloud lease outranks local for CONTINUING coverage".
 *  3. We are `cloud` and hold our OWN fresh claim ⇒ organize, even against a fresh foreign local.
 *     Without this arm both sides stand down and nobody organizes at all — an entitled, actively
 *     covering Cloud is never preempted.
 *  4. We are `cloud`, a fresh foreign `local` claim exists, we hold no fresh claim of our own ⇒
 *     organize ONLY with `takeover: "authorized"`. That is exactly §4's split: adding a mailbox
 *     to Cloud IS the explicit human action, so the connect flow informs and proceeds; whereas a
 *     lapse-then-resubscribe must not let the worker resume over a deliberate local choice.
 *     Without the flag those two are indistinguishable to the gate.
 *  5. `local` vs a fresh foreign `local` ⇒ the OLDEST `claimedAt` wins (the incumbent); ties
 *     break lexicographically on install id. Both sides compute the same winner from the same
 *     folder contents, so exactly one continues and nobody self-promotes. Mutual stand-down
 *     would also be safe and would needlessly stop a mailbox nobody was contending for.
 *  6. No fresh foreign claim, and we hold a claim of our own — fresh or stale ⇒ organize.
 *     Own-role resumption after a crash, a restore or a long sleep. §4: "Continuing is not
 *     becoming."
 *  7. No claims at all ⇒ organize. Nobody has ever organized this mailbox; there is nobody to
 *     take over from.
 *  8. Otherwise a stale or malformed foreign claim exists and we hold none ⇒ `available`, or
 *     `organize` with explicit authorization. This is the Cloud-lapsed case and the
 *     no-seize-back case, and it is the arm a two-verdict table gets wrong.
 */
export function decideLease(input: DecideLeaseInput): LeaseVerdict {
  const { self, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const takeover = input.takeover ?? "none";
  const ourProtocol = self.protocol ?? CLAIM_PROTOCOL;

  const { valid, malformed } = coalesce(input.claims);

  const own: OrganizerClaim[] = [];
  const foreign: OrganizerClaim[] = [];
  for (const c of valid) {
    // The clone defence. Only armed once we have written this process — a fresh start has no
    // nonce to compare and must trust its own id, or own-role resumption breaks.
    const clonedUs =
      c.installId === self.installId &&
      self.lastNonce !== null &&
      c.nonce !== self.lastNonce &&
      c.heartbeat.getTime() > now.getTime() - staleAfterMs;
    if (c.installId === self.installId && !clonedUs) own.push(c);
    else foreign.push(c);
  }

  const freshForeign = foreign.filter((c) => isFresh(c.heartbeat, now, staleAfterMs));

  // 1 — a protocol we do not understand, held by someone alive.
  const ahead = freshForeign.find((c) => c.protocol > ourProtocol);
  if (ahead) return { verdict: "stand_down", reason: "organized_elsewhere:unknown", by: ahead };

  const freshCloud = freshForeign.filter((c) => c.kind === "cloud");
  const freshLocal = freshForeign.filter((c) => c.kind === "local");
  const freshUnknown = freshForeign.filter((c) => c.kind === "unknown");

  // An unrecognised kind held by a live peer: refuse. Same reasoning as the protocol arm — the
  // one thing we know is that something is organizing this mailbox and we cannot rank it.
  if (freshUnknown.length > 0) {
    return { verdict: "stand_down", reason: "organized_elsewhere:unknown", by: freshUnknown[0]! };
  }

  const ownFresh = own.find((c) => isFresh(c.heartbeat, now, staleAfterMs));

  if (self.kind === "local") {
    // 2 — a live Cloud outranks us for continuation.
    if (freshCloud.length > 0) return { verdict: "stand_down", reason: "organized_elsewhere:cloud", by: freshCloud[0]! };

    // 5 — local vs local: the incumbent wins, deterministically, from both sides.
    if (freshLocal.length > 0) {
      const ours = own[0];
      const winner = [...freshLocal, ...(ours ? [ours] : [])].sort(compareIncumbency)[0]!;
      if (!ours || winner.installId !== self.installId) {
        return { verdict: "stand_down", reason: "organized_elsewhere:local", by: winner };
      }
      return { verdict: "organize", renew: true };
    }
  } else {
    // 3 — the Cloud continuation arm. Checked BEFORE the foreign-local arm, or a fresh local
    // claim would stand a covering Cloud down and nobody would organize.
    if (ownFresh) return { verdict: "organize", renew: true };

    // 4 — becoming the organizer over a live local install needs a human.
    if (freshLocal.length > 0) {
      if (takeover === "authorized") return { verdict: "organize", renew: true };
      return { verdict: "stand_down", reason: "organized_elsewhere:local", by: freshLocal[0]! };
    }
  }

  // 6 — own-role resumption. Continuing is not becoming.
  if (own.length > 0) return { verdict: "organize", renew: true };

  // 7 — nobody has ever organized this mailbox.
  if (foreign.length === 0 && malformed.length === 0) return { verdict: "organize", renew: true };

  // 8 — somebody WAS organizing and is not now. Explicit action only.
  if (takeover === "authorized") return { verdict: "organize", renew: true };
  const staleBy = foreign.sort((a, b) => b.heartbeat.getTime() - a.heartbeat.getTime())[0] ?? null;
  return { verdict: "available", by: staleBy };
}

/** Oldest `claimedAt` first; ties break lexicographically on install id, so both sides agree. */
function compareIncumbency(a: OrganizerClaim, b: OrganizerClaim): number {
  const d = a.claimedAt.getTime() - b.claimedAt.getTime();
  return d !== 0 ? d : a.installId < b.installId ? -1 : a.installId > b.installId ? 1 : 0;
}

// ── LAYER 3: IO ─────────────────────────────────────────────────────────────────────────────

/**
 * A LEASE IO FAILURE IS A MAILBOX FAULT, NEVER A STAND-DOWN.
 *
 * §3.4: a mailbox whose `_meta` cannot be read is a mailbox we cannot safely organize, and
 * reading that as "no claim, so organize" is the dual-organizer bug through the back door.
 * Reading it as "stand down" would be almost as wrong in the other direction: stand-down is
 * sticky caller-side, so a transient network error would permanently disable a mailbox nobody
 * else wants.
 *
 * So it is its own class, and callers exempt it BY CLASS — the pattern the worker's sync loop
 * already uses for `ClassifierFaultError`, where exempting by class
 * rather than by threshold arithmetic is what keeps "a model outage can never quarantine a
 * mailbox" true at every tuning of `maxSyncFailures`.
 */
/**
 * WHICH LEASE OPERATION FAILED. A closed set of literals, chosen at COMPILE TIME.
 *
 * ── THE GENERAL RULE THIS EXISTS TO STATE ──────────────────────────────────────────────────
 *
 * **A catch that wraps more than one operation must name which one threw.** `runLeaseGate` used to
 * wrap `ensureMetaFolder()` and `listClaims()` in ONE try and report neither, and on 2026-08-03
 * that cost 32 minutes: "the organizer lease could not be read" is the same sentence whether the
 * folder could not be CREATED (a permissions or namespace problem — our path is wrong) or could not
 * be LISTED (the folder exists and the FETCH was refused — which is what actually happened, a
 * `FETCH 1:*` against an empty mailbox that Dovecot rejects and GreenMail tolerates). One literal
 * collapses that ambiguity to one line.
 *
 * ── AND WHY IT COSTS NOTHING TO LOG ────────────────────────────────────────────────────────
 *
 * Every member is a string WE wrote in THIS file. No server, no mailbox and no user chooses it,
 * so it carries exactly zero privacy cost — which is what makes it emittable where the thing an
 * operator actually wants (`err.message`, `responseText`) is not. The same rule governs
 * `serverResponseCode` in the worker's mailbox-error classifier: a value the server chose is a
 * value the server chose, whatever grammar it happens to satisfy.
 */
export type LeaseOp =
  /** CREATE + UNSUBSCRIBE `ohmail/_meta`. */
  | "ensure_meta"
  /** FETCH the claim messages out of it. */
  | "list_claims"
  /** APPEND our renewed claim. */
  | "renew_claim"
  /** STORE `\Deleted` + EXPUNGE our older claims. */
  | "remove_claims"
  /** The adapter has no `leaseIo()` at all, so no operation was even attempted. */
  | "no_lease_io";

export class LeaseUnavailableError extends Error {
  /**
   * Which operation threw. REQUIRED, so a construction site cannot forget it — the alternative
   * (an optional field) is a field that is absent at the one call site nobody thought about, which
   * is the call site that fires during the incident.
   */
  readonly op: LeaseOp;
  constructor(message: string, options: { op: LeaseOp; cause?: unknown }) {
    super(message, options);
    this.name = "LeaseUnavailableError";
    this.op = options.op;
  }
}

/** One message in the meta folder, as the IO layer sees it. */
export interface RawClaimMessage {
  /** Whatever the implementation needs to delete this exact message. */
  ref: unknown;
  /** The headers (a full source is fine too — only the header block is read). */
  raw: string;
}

/**
 * The narrow IO the lease needs, and nothing else.
 *
 * None of these operations is on `MailboxAdapter` — the lease needs APPEND, SEARCH,
 * FETCH-headers, STORE `\Deleted` + EXPUNGE, CREATE and UNSUBSCRIBE, and that interface has none
 * of them. Rather than widening the adapter surface every caller sees, `ImapAdapter.leaseIo()`
 * hands back this object bound to the LIVE login. A lease that opened its own connection would
 * mean a second login per mailbox per cycle, which is how a provider decides to throttle a user.
 */
export interface LeaseIo {
  /** Create `ohmail/_meta` if absent and unsubscribe it. Idempotent. */
  ensureMetaFolder(): Promise<void>;
  /** Every message in the meta folder. */
  listClaims(): Promise<RawClaimMessage[]>;
  /** APPEND one claim. */
  appendClaim(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages. */
  removeClaims(refs: readonly unknown[]): Promise<void>;
}

/**
 * The minimum an IMAP client has to be for {@link makeLeaseIo} to drive it.
 *
 * Structural, not `ImapFlow`, so the whole IO layer is testable against a fake without a server
 * and so this module does not import the client library at all — `organizer-lease.ts` needs only
 * `imap-types.ts`, which is what keeps `imap.ts → organizer-lease.ts` a one-way edge with no
 * cycle.
 */
export interface LeaseImapClient {
  /**
   * The SELECTED mailbox, which `getMailboxLock` sets, and whose `exists` is its message count.
   *
   * Optional, and read defensively in {@link makeLeaseIo}, because it is the one field here that
   * is a client-library convenience rather than a command: a fake that omits it must behave
   * exactly as before, so absence means "unknown", never "empty".
   */
  readonly mailbox?: { exists?: number } | false;
  list(): Promise<Array<{ path: string; subscribed?: boolean }>>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxUnsubscribe(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(
    range: string,
    query: { uid?: boolean; headers?: boolean | string[] },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{ uid: number; headers?: Buffer }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
}

/**
 * A {@link LeaseIo} bound to a LIVE connection.
 *
 * `toServerPath` is passed in rather than recomputed, because the delimiter is discovered at
 * login and is private to the adapter. `ohmail/_meta` has to survive a server whose delimiter is
 * `.` (GreenMail) as well as one whose delimiter is `/` (Dovecot), and hand-writing that mapping
 * a second time here is how the two spellings drift.
 *
 * The claim is APPENDED with `\Seen` so a user who does subscribe to the folder in another
 * client is not shown an unread count for our bookkeeping.
 */
export function makeLeaseIo(client: LeaseImapClient, toServerPath: (canonical: string) => string): LeaseIo {
  const path = (): string => toServerPath(META_FOLDER);

  return {
    async ensureMetaFolder(): Promise<void> {
      const p = path();
      const list = await client.list();
      const found = list.find((f) => f.path === p);
      if (!found) {
        try {
          await client.mailboxCreate(p);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      // UNSUBSCRIBED, always — a subscribed `_meta` shows up in every other mail client the user
      // owns, as a folder of machine bookkeeping they did not ask for. `ListResponse.subscribed`
      // means this is assertable against a real server rather than merely requested.
      if (!found || found.subscribed) await client.mailboxUnsubscribe(p);
    },

    async listClaims(): Promise<RawClaimMessage[]> {
      const lock = await client.getMailboxLock(path());
      try {
        const out: RawClaimMessage[] = [];
        // AN EMPTY `_meta` IS THE NORMAL STATE OF A FRESH MAILBOX, AND `1:*` IS NOT A VALID
        // MESSAGESET WHEN A MAILBOX HOLDS NOTHING.
        //
        // The failure: every genuinely fresh mailbox was unorganizable, and the product showed
        // "waiting for first sync" for ever. `ensureMetaFolder()` creates the folder one line
        // earlier, so on a first attach this FETCH always ran against zero messages. GreenMail
        // tolerates that and answers an empty set; Dovecot refuses the command outright —
        // measured against a real Dovecot server:
        //
        //     Error in IMAP command FETCH: Invalid messageset
        //
        // which `runLeaseGate` turns into `LeaseUnavailableError`, which the worker exempts BY
        // CLASS from `maxSyncFailures` — so it retried every thirty seconds for ever, wrote
        // nothing to the mailbox row, and quarantined nothing. Correct behaviour at every layer,
        // composing into a mailbox that can never be adopted. The whole test suite was green
        // because the only server it ever ran against was the tolerant one.
        //
        // Read DEFENSIVELY: only a POSITIVELY KNOWN zero skips the fetch. An `exists` we cannot
        // see means "unknown", so the fetch still runs and every existing caller — including
        // every fake in the tests — behaves exactly as it did before.
        const selected = client.mailbox;
        const count = typeof selected === "object" && selected !== null ? selected.exists : undefined;
        if (count === 0) return out;
        // HEADERS ONLY. A claim's body is one sentence for a human, and fetching sources here
        // would make the gate's cost scale with whatever else ends up in this folder.
        for await (const m of client.fetch("1:*", { uid: true, headers: true }, { uid: false })) {
          if (!m.headers) continue;
          out.push({ ref: m.uid, raw: m.headers.toString("utf8") });
        }
        return out;
      } finally {
        lock.release();
      }
    },

    async appendClaim(raw: string): Promise<void> {
      await client.append(path(), raw, ["\\Seen"]);
    },

    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(path());
      try {
        await client.messageDelete(uids, { uid: true });
      } finally {
        lock.release();
      }
    },
  };
}

export interface LeaseGateInput {
  io: LeaseIo;
  self: LeaseSelf;
  now: Date;
  staleAfterMs?: number;
  takeover?: TakeoverAuthorization;
  /** Injected for tests; production uses `crypto.randomUUID()`. */
  newNonce?: () => string;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface LeaseGateResult {
  verdict: LeaseVerdict;
  /** The nonce written this cycle, to be held in memory as the next `self.lastNonce`. */
  nonce: string | null;
}

/**
 * READ, DECIDE, THEN WRITE — the whole gate, in that order.
 *
 * Reconnect is learn-then-act: the LOCAL sidecar reads the organizer lease BEFORE its
 * first move. Reconnect-after-sleep is exactly when a mailbox is
 * most likely to have changed hands, so writing first — even a renew — would be self-promotion
 * dressed as bookkeeping.
 *
 * On `organize` it renews: append the new claim, then expunge our older ones. **That order is
 * load-bearing.** IMAP has no in-place update, and expunging first means a crash in between
 * leaves the mailbox with NO claim of ours at all — which reads to every other install as a
 * mailbox that became available. Appending first leaves two, which is the harmless direction
 * and which {@link decideLease} coalesces.
 *
 * On `stand_down` it RELEASES: our own claims are expunged. Otherwise the winner has to wait out
 * the whole staleness window before its own gate is clean, and a released claim is what makes
 * "Cloud lapsed" legible to a desktop install at all.
 *
 * Every IO failure becomes {@link LeaseUnavailableError}. There is exactly one place a
 * `stand_down` can be constructed and it is {@link decideLease}, from a parsed fresh foreign
 * claim — §3.4's "exactly one path to stand-down".
 */
export async function runLeaseGate(input: LeaseGateInput): Promise<LeaseGateResult> {
  const { io, self, now } = input;
  const log = input.log ?? ((): void => undefined);
  const newNonce = input.newNonce ?? ((): string => crypto.randomUUID());

  // ── ONE OPERATION PER TRY, AND THAT IS THE RULE RATHER THAN A STYLE ────────────────────────
  //
  // These two used to share a single try that reported neither. They fail for completely different
  // reasons — CREATE against a namespace we have no rights in, versus a FETCH the server refuses —
  // and telling them apart is the difference between "our folder path is wrong for this provider"
  // and "the folder is there and empty and this server will not FETCH an empty mailbox", which is
  // the 2026-08-03 bug exactly. Splitting the try is what makes `op` a fact instead of a guess:
  // there is no arithmetic deciding which literal to use, only two blocks that each know.
  try {
    await io.ensureMetaFolder();
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer lease folder ${META_FOLDER} could not be created; this mailbox cannot be ` +
      `organized safely`,
      { op: "ensure_meta", cause: err },
    );
  }
  let messages: RawClaimMessage[];
  try {
    messages = await io.listClaims();
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be read; this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
    );
  }

  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref))
    .filter((c): c is ClaimRecord => c !== null);

  const verdict = decideLease({
    self,
    claims,
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
  });

  const ourRefs = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .map((c) => c.ref)
    .filter((r): r is unknown => r !== undefined);

  if (verdict.verdict !== "organize") {
    if (ourRefs.length > 0) {
      try {
        await io.removeClaims(ourRefs);
      } catch (err) {
        // Failing to release is not failing to stand down. We are already not organizing; the
        // only cost is that the winner waits out the staleness window. Logged, never thrown —
        // throwing here would turn a clean stand-down into a mailbox fault.
        //
        // ── A BARE STRING UNDER `err` IS SAFE HERE, AND NOT BY ACCIDENT. DO NOT "FIX" IT. ──
        //
        // `log` is an injected `(event, detail) => void`, and the worker routes it into
        // `packages/core/src/log.ts`, whose redactor SPECIAL-CASES the `err` key: it hands the
        // value to `describeError` and emits only `errorClass` + `errorCode`. `describeError`
        // reads `name` and `code`, and a `string` has neither — so this reduces to
        // `errorClass: "String"` and the message is DISCARDED before anything is written. That
        // is the same guarantee an `Error` gets, reached by the same code path.
        //
        // The tempting edit is to pass `err` whole "so the class survives". It does not survive
        // any better, and it costs the one property this line has: an IMAP driver's error object
        // carries the failing command and, on a login path, the credential — `log.ts`'s header
        // records a driver message with `host=…&user=…` reaching a log drain. Reducing to a
        // string HERE means there is no object for a future redactor bug to walk.
        //
        // `op` rides along for the reason the throwing sites carry it: this catch wraps ONE
        // operation today, and the literal is what keeps that true — a second call added inside
        // this try would have to choose between two ops and the choice would be visible.
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("lease_stand_down", { verdict: verdict.verdict });
    return { verdict, nonce: null };
  }

  // The incumbency clock. Renewing must NOT restart it, or two installs that both renew every
  // cycle would each keep looking like the newest arrival and rule 5 would never settle.
  const priorOwn = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())[0];
  const claimedAt = priorOwn?.claimedAt ?? now;

  const nonce = newNonce();
  try {
    await io.appendClaim(
      formatClaim({
        installId: self.installId,
        kind: self.kind,
        displayName: self.displayName,
        heartbeat: now,
        claimedAt,
        nonce,
        protocol: self.protocol ?? CLAIM_PROTOCOL,
      }),
    );
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer claim in ${META_FOLDER} could not be renewed`,
      { op: "renew_claim", cause: err },
    );
  }

  if (ourRefs.length > 0) {
    try {
      await io.removeClaims(ourRefs);
    } catch (err) {
      // Harmless: the folder now holds our new claim plus one or more older ones, and readers
      // coalesce by newest heartbeat. The next renew tries again.
      //
      // The bare string under `err` is deliberate, for the reason spelled out at
      // `lease_release_failed` above: `log.ts` special-cases `err` into `describeError`, a string
      // has no `name`/`code`, so this emits `errorClass: "String"` and nothing else. Passing the
      // error object instead would hand a redactor an IMAP driver error that can carry the
      // failing command and the credential.
      log("lease_cleanup_failed", {
        op: "remove_claims" satisfies LeaseOp,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { verdict, nonce };
}
