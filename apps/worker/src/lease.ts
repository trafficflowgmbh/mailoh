import {
  DEFAULT_STALE_AFTER_MS, LeaseUnavailableError, META_FOLDER, isMalformed, parseClaim, runLeaseGate,
  type LeaseIo, type LeaseOp, type LeaseSelf, type LeaseVerdict, type OrganizerClaim,
  type TakeoverAuthorization,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { MailboxDisabledReason } from "@trafficflow/db";

/**
 * THE WORKER'S HALF OF THE ORGANIZER LEASE — composition, and nothing else.
 *
 * `packages/core/src/adapters/organizer-lease.ts` is the engine: the claim format, the decision
 * table, the IO. It shipped with a two-worlds GreenMail test beside it and **zero callers**,
 * which is this repository's own named failure pattern — built, tested, unreachable. A deployed
 * worker organized mailboxes with no claim in `ohmail/_meta` at all, because nothing on this
 * side ever asked. This module is the file that ends that, and it deliberately adds no policy the engine
 * does not already have: it resolves who we are, hands the engine its IO, and translates the
 * verdict into the two things the worker can do about it.
 *
 * The engine is NOT edited to make this wiring easier. Every awkwardness below — the structural
 * `leaseIo` probe, the per-mailbox nonce — is awkward here rather than there on purpose.
 */

/**
 * WHO CLOUD IS, AS AN ORGANIZER — and the single most dangerous constant in this file.
 *
 * The install id is what `decideLease` matches on to answer "is that claim MINE?". Get it wrong
 * in the unstable direction and every worker restart looks like a NEW organizer arriving: the
 * incoming process reads the outgoing one's fresh `cloud` claim as FOREIGN, falls through to the
 * `available` arm, and DISABLES the mailbox. A leader failover would take a customer's mail
 * offline permanently, and it would do it on the deploy that introduced the safety mechanism.
 *
 * So it is a literal, and it is stable by construction:
 *
 *  · **Never derived from `instanceId`.** That is per-process (`instanceIdFrom()`), which is the
 *    failure above exactly.
 *  · **Never derived from the database.** A cutover to a completely fresh database can happen at
 *    any time; an id keyed on the database identity would change the moment one lands, and every
 *    live mailbox would go `available` → `disabled` on the first cycle after the migration.
 *    The mailbox is the master, so the organizer's identity has to be a property of the
 *    ORGANIZER, not of whichever store it happens to be keeping notes in.
 *  · **Scoped by environment**, so staging pointed at a production mailbox is a DIFFERENT
 *    organizer. Two deployments sharing one id do not coexist gracefully: the second to write
 *    expunges the first's claim (the renew's cleanup matches on install id) and the first then
 *    reads a claim it cannot account for and stands ITSELF down. With distinct ids the incumbent
 *    simply keeps its fresh claim and the newcomer sees a live foreign `cloud` claim and stands
 *    down, which is the correct outcome and the quiet one.
 *
 * `TF_ORGANIZER_INSTALL_ID` overrides it, for the one case the default cannot serve: a
 * self-hosted Cloud organizing the same mailbox as ours.
 */
export const CLOUD_INSTALL_ID_PREFIX = "ohmail-cloud";

/** The default `X-Ohmail-Install-Id` for a Cloud worker in the given environment. */
export function cloudInstallId(environment: string): string {
  return `${CLOUD_INSTALL_ID_PREFIX}:${environment}`;
}

/**
 * How the claim names us to a human who opens `ohmail/_meta` in another mail client.
 *
 * §4's takeover prompt reads `ohmail on <machine> organizes this mailbox`, so the string has to
 * be a place and not an id. For Cloud the place is Cloud.
 */
export const CLOUD_DISPLAY_NAME = "ohmail Cloud";

/**
 * An adapter that can hand out the lease's IO.
 *
 * `MailboxAdapter` (`imap-types.ts`) has none of APPEND, FETCH-headers, STORE `\Deleted` +
 * EXPUNGE, CREATE or UNSUBSCRIBE, and they do not belong on it: they are one feature's needs,
 * not every caller's. `ImapAdapter.leaseIo()` is the additive method that hands them over bound
 * to the LIVE login, and this is that shape, probed structurally so the worker does not have to
 * widen an interface every other call site would then see.
 */
export interface LeaseCapableAdapter {
  leaseIo(): LeaseIo;
}

/** Does this adapter expose the lease's IO? */
export function hasLeaseIo(adapter: MailboxAdapter): adapter is MailboxAdapter & LeaseCapableAdapter {
  return typeof (adapter as Partial<LeaseCapableAdapter>).leaseIo === "function";
}

/**
 * The verdict, reduced to what the worker acts on.
 *
 * `organize: false` carries a reason, always — the worker's stand-down write has nowhere to put
 * "I do not know", and `organized_elsewhere:unknown` is the honest name for that case anyway.
 */
export type MailboxLeaseOutcome =
  | { organize: true; nonce: string | null; by: null }
  | { organize: false; reason: MailboxDisabledReason; by: OrganizerClaim | null };

export interface MailboxLeaseInput {
  adapter: MailboxAdapter;
  self: LeaseSelf;
  now: Date;
  takeover?: TakeoverAuthorization;
  staleAfterMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * READ THE LEASE, AND SAY WHETHER THIS PROCESS MAY ORGANIZE THIS MAILBOX.
 *
 * ── AN ADAPTER WITH NO `leaseIo` IS A LEASE WE CANNOT READ ────────────────────────────────
 *
 * It throws {@link LeaseUnavailableError} rather than defaulting to "organize". That default is
 * the whole bug this lease exists to close: a gate whose absent dependency selects the permissive
 * branch is a gate that stops existing the first time somebody composes the worker slightly
 * differently, and nothing anywhere says so. Production always gets an `ImapAdapter`, and the
 * suite's fake fleet grows a real in-memory `leaseIo` for the same reason — so the gate is
 * EXERCISED by every worker test rather than skipped by all of them.
 *
 * The cost is bounded and deliberate: `LeaseUnavailableError` is exempted BY CLASS at both call
 * sites, so a mailbox whose lease cannot be read does not sync and is NOT quarantined for it.
 */
export async function readMailboxLease(input: MailboxLeaseInput): Promise<MailboxLeaseOutcome> {
  const { adapter, self, now } = input;
  if (!hasLeaseIo(adapter)) {
    throw new LeaseUnavailableError(
      `this mailbox's adapter cannot reach ${META_FOLDER}, so the organizer lease cannot be ` +
      `read and the mailbox cannot be organized safely`,
      // No IMAP operation was attempted at all, and saying so is the point: this is a COMPOSITION
      // fault (somebody built the worker with an adapter that has no `leaseIo`), not a provider
      // fault, and an operator who sees `op: "list_claims"` would go looking at the mail server.
      { op: "no_lease_io" },
    );
  }

  const result = await runLeaseGate({
    io: adapter.leaseIo(),
    self,
    now,
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.log !== undefined ? { log: input.log } : {}),
  });

  if (result.verdict.verdict === "organize") return { organize: true, nonce: result.nonce, by: null };
  return { organize: false, reason: standDownReason(result.verdict), by: byOf(result.verdict) };
}

/**
 * The engine's verdict, as the closed set `mailboxes.disabled_reason` holds.
 *
 * ── THE TWO UNIONS MEET HERE, AND THE COMPILER IS THE PROOF ────────────────────────────────
 *
 * `StandDownReason` (`packages/core`) and `MailboxDisabledReason` (`@trafficflow/db`) are the
 * same three strings written twice, and they have to be: the engine tier may not import the
 * private half, so a single definition is not available. The argument for collapsing a taxonomy
 * into one definition still holds wherever it CAN be one — this is the case where it cannot, so
 * the reconciliation is a typed assignment at the one place the two meet (a member on either side
 * that the other lacks fails `tsc`), plus a test that asserts set equality at runtime, so a
 * widening on the DB side that TypeScript would accept still stops the suite.
 *
 * `available` is a stand-down for the worker even though the engine calls it a third verdict:
 * BECOMING an organizer always requires an explicit human action, and
 * `available` means precisely that nobody is organizing and nobody has authorized us to start.
 * The reason names whoever held it — a Cloud that stopped, a laptop that slept — because that is
 * what the row has to say for the UI to offer the right sentence.
 */
function standDownReason(verdict: Exclude<LeaseVerdict, { verdict: "organize" }>): MailboxDisabledReason {
  if (verdict.verdict === "stand_down") {
    const reason: MailboxDisabledReason = verdict.reason;
    return reason;
  }
  const kind = verdict.by?.kind;
  return kind === "cloud" ? "organized_elsewhere:cloud"
    : kind === "local" ? "organized_elsewhere:local"
      : "organized_elsewhere:unknown";
}

function byOf(verdict: Exclude<LeaseVerdict, { verdict: "organize" }>): OrganizerClaim | null {
  return verdict.by;
}

/**
 * DELETE this organizer's own claims from a mailbox it is ceasing to organize.
 *
 * Returns how many were removed. NOT a stand-down: nobody won this mailbox from us, we stopped
 * being entitled to it (the account lapsed, the user disconnected it, the cap evicted it), and
 * the claim has to go so that the user's own machine can take the mailbox over without waiting
 * out a staleness window it cannot see the end of.
 *
 * `parseClaim` rather than a header grep, so "is this ours" is answered by the same code that
 * answers it inside the gate — a second parser here is how the two come to disagree about a
 * folded header. An adapter with no `leaseIo` releases nothing and says so with a 0 rather than
 * throwing: this runs on a teardown path, and a teardown must not be abortable by bookkeeping.
 */
export async function releaseMailboxClaim(adapter: MailboxAdapter, installId: string): Promise<number> {
  if (!hasLeaseIo(adapter)) return 0;
  const io = adapter.leaseIo();
  const messages = await io.listClaims();
  const ours = messages
    .map((m) => ({ ref: m.ref, claim: parseClaim(m.raw, m.ref) }))
    .filter((c) => c.claim !== null && !isMalformed(c.claim) && c.claim.installId === installId)
    .map((c) => c.ref);
  if (ours.length === 0) return 0;
  await io.removeClaims(ours);
  return ours.length;
}

/** Re-exported so the worker's `catch` arms name one class, imported from one place. */
export { LeaseUnavailableError, DEFAULT_STALE_AFTER_MS, META_FOLDER };
export type { LeaseSelf, OrganizerClaim, LeaseOp };
