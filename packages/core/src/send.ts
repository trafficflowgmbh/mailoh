import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./adapters/imap-types.js";

// Surface `OutboundMessage` on the core entrypoint so the send seam is usable
// without importing the adapter subpath (it otherwise lives only on the
// `@trafficflow/core/adapters/imap` export).
export type { OutboundMessage } from "./adapters/imap-types.js";

/**
 * The crash-safe send seam. SMTP is NOT transactional: a
 * process crash between "SMTP accepted the message" and "we recorded that fact"
 * is indistinguishable, at the DB, from "SMTP never ran". The #1 risk is a
 * double-send to a recipient across such a crash. The defence is to mint the
 * Message-ID (RFC 5322) UP FRONT and make it the correlation key:
 *
 *   1. mint `<uuid@domain>` on the `pending` reservation row (before any network);
 *   2. pass that EXACT id to SMTP as `OutboundMessage.messageId` (the ImapAdapter
 *      honours a supplied id and appends it to Sent), so the delivered mail carries
 *      an id we chose, not one the transport invented;
 *   3. on a same-key retry that finds a stale `pending` row, VERIFY by searching
 *      the Sent folder for that id — FOUND ⇒ it was delivered, reconcile to `sent`
 *      with NO resend; NOT FOUND ⇒ ambiguous, move to `unverified` and surface to
 *      the user. A silent auto-resend on ambiguity is PROHIBITED.
 */

/** The lifecycle of an `outbound_sends` reservation row. */
export type OutboundSendStatus = "pending" | "sent" | "failed" | "unverified";

/**
 * Mint a globally-unique Message-ID (RFC 5322) for a send reservation. The SAME
 * string is stored on the `pending` row AND passed to SMTP, so a crashed attempt
 * is verifiable by an exact Sent-folder header search (never blindly resent).
 * `sentDomain` is the sending identity's domain; it only shapes the id — the
 * uuid guarantees uniqueness regardless of domain.
 */
export function mintMessageId(sentDomain = "trafficflow.ch"): string {
  const domain = sentDomain.trim() || "trafficflow.ch";
  return `<${randomUUID()}@${domain}>`;
}

/**
 * The minimal send seam SendService drives, INJECTED per-request (prod =
 * `makeSendAdapter` over decrypted mailbox creds; tests = a fake/GreenMail spy).
 * `send` performs SMTP + Sent-append and returns the delivered id; `messageInSent`
 * is the verify-by-Sent probe used for crash recovery; `close` tears the
 * connection down. Mirrors the attachments `AttachmentAdapter` seam.
 */
export interface SendAdapter {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  /** True iff a message with `messageId` (an `<id@host>` header) exists in Sent. */
  messageInSent(messageId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Injected factory: open a connected send adapter for a mailbox. */
export type OpenSendAdapter = (mailboxId: string) => Promise<SendAdapter>;
