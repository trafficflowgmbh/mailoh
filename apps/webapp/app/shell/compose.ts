/**
 * COMPOSING A NEW MESSAGE (slice U4f) — the three fields, and the address parser.
 *
 * A reply inherits its recipient, its subject, its mailbox and its thread from the message
 * being answered. A compose has none of that, so this module owns the part of the send that
 * a reply never needed: turning a line of typed text into recipients, and refusing to guess.
 *
 * It deliberately knows nothing about React and nothing about send phases — `mail-send.ts`
 * owns the state machine and `canSend` — so the parsing below is testable one row at a time
 * and cannot drift into a second copy of the send rule.
 */
import type { EmailAddress, EngineMutation } from "@ohmail/client-engine";

/** The compose form, verbatim as typed. `to` is TEXT; `plan()` is what turns it into addresses. */
export interface ComposeFields {
  to: string;
  subject: string;
  body: string;
}

export const EMPTY_COMPOSE: ComposeFields = { to: "", subject: "", body: "" };

/** `localStorage` key for the compose scratch buffer — one, because there is one compose. */
export const COMPOSE_DRAFT_KEY = "ohmail.ui.compose";

/**
 * The scratch buffer, and what it is NOT.
 *
 * This is the client's own draft, in this browser, exactly like the per-message reply buffer.
 * It is not an IMAP draft and it is not a `drafts` row on the server: nothing is written to
 * the account until Send is pressed, because a draft-per-keystroke is a write storm and an
 * orphan-row factory (`POST /drafts` has no delete-on-abandon path the client drives). Server
 * drafts on the mailbox are P3 and the owner has ruled they must live there; the compose
 * surface therefore says "kept in this browser" and nothing stronger.
 *
 * Storage can refuse — Safari private mode throws on write — and a refusal must never break
 * composing, so every access is wrapped and a failure simply means the draft lives for as
 * long as the tab does.
 */
export function readComposeDraft(): ComposeFields {
  try {
    const raw = window.localStorage.getItem(COMPOSE_DRAFT_KEY);
    if (!raw) return EMPTY_COMPOSE;
    const parsed = JSON.parse(raw) as Partial<ComposeFields>;
    return {
      to: typeof parsed.to === "string" ? parsed.to : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    // Blocked storage, or a value some earlier version wrote in another shape. Either way an
    // empty form beats throwing inside a render.
    return EMPTY_COMPOSE;
  }
}

export function writeComposeDraft(f: ComposeFields): void {
  try {
    if (f.to === "" && f.subject === "" && f.body === "") {
      window.localStorage.removeItem(COMPOSE_DRAFT_KEY);
      return;
    }
    window.localStorage.setItem(COMPOSE_DRAFT_KEY, JSON.stringify(f));
  } catch {
    /* private mode refuses writes; the draft lives in React state only */
  }
}

export function clearComposeDraft(): void {
  try {
    window.localStorage.removeItem(COMPOSE_DRAFT_KEY);
  } catch {
    /* nothing was stored, so there is nothing to remove */
  }
}

/**
 * IS THIS AN ADDRESS? — checked HERE, before Send lights up, and not by the SMTP server.
 *
 * "An SMTP rejection after the fact is a bad way to learn about a typo": the send path is two
 * requests and a reservation, and a 550 arrives as `unverified` — the one outcome the product
 * cannot resolve for the user. A local check costs nothing and turns "we couldn't confirm
 * this send" back into "that address has no dot in it".
 *
 * ── CONSERVATIVE ON PURPOSE ─────────────────────────────────────────────────────────────
 *
 * The rule is not RFC 5322 and does not try to be — the grammar admits quoted local parts,
 * comments and bare IP-literal domains, and a validator that implemented it would reject
 * nothing anyone types by hand while adding a page of code. What it DOES do is refuse the
 * four things a human actually mistypes: no `@`, two `@`, no dot in the domain, and a stray
 * space. Anything past that is the server's business, which is where a genuinely exotic but
 * legal address is still accepted — this gate only decides whether Send is offered.
 *
 * It must never reject a valid ordinary address, so `+` tags, dots, dashes, apostrophes and
 * underscores in the local part all pass, and so do multi-label domains and long TLDs.
 */
export function isEmailAddress(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0 || s.length > 254) return false;
  if (/[\s<>,;"()[\]\\]/.test(s)) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[a-z0-9-]+$/i.test(label)) return false;
  }
  // A TLD is letters. `user@host.1` is a typo every time, and an IP-literal domain would need
  // the bracket form this parser refuses above.
  return /^[a-z]{2,}$/i.test(labels[labels.length - 1]!);
}

export interface RecipientParse {
  /** Everything that parsed, in the order typed, de-duplicated by address. */
  addresses: EmailAddress[];
  /** Entries that did not parse, verbatim, for the error line under the field. */
  invalid: string[];
}

/**
 * One line of typed text → recipients.
 *
 * Commas and semicolons both separate, because every mail client accepts both and a user who
 * pastes a list from elsewhere has no idea which one they got. `Name <addr>` is accepted
 * because that is what copying a recipient out of another client yields; the display name is
 * kept, so the person's name survives into `drafts.to` and out onto the wire's To header.
 *
 * De-duplicated case-insensitively on the address: a list pasted twice must not mail anyone
 * twice, and the SMTP envelope is built straight from this array (`SendService` →
 * `to.map(a => a.address)`).
 */
export function parseRecipients(raw: string): RecipientParse {
  const addresses: EmailAddress[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(/[,;]/)) {
    const entry = part.trim();
    if (entry === "") continue;
    const angled = /^(.*?)<([^<>]*)>$/.exec(entry);
    const address = (angled ? angled[2]! : entry).trim();
    const name = angled ? angled[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
    if (!isEmailAddress(address)) {
      invalid.push(entry);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ name: name === "" ? null : name, address });
  }

  return { addresses, invalid };
}

export type MailSend = Extract<EngineMutation, { kind: "mail_send" }>;

export interface ComposePlan extends RecipientParse {
  /** The mutation as it would go out right now. `canSend` judges THIS. */
  mutation: MailSend;
  /** True when the subject is blank — a warning on screen, never a refusal. See below. */
  noSubject: boolean;
}

/**
 * The compose form as a send, or as the reason it is not one yet.
 *
 * ── A TYPO BLOCKS THE WHOLE SEND, IT DOES NOT SILENTLY DROP ONE RECIPIENT ──────────────
 *
 * `to` is `[]` whenever ANYTHING failed to parse, even if three of four entries were fine.
 * That is the load-bearing line in this function: it means the refusal is expressed in the
 * MUTATION rather than as a second predicate beside `canSend`, so every caller — the button's
 * `disabled`, the state machine's own guard, a keyboard shortcut, a future Reply Run — is
 * stopped by the same rule with no way around it. Dropping the bad entry and mailing the rest
 * would be the worst option available: the user would learn about the typo from the person who
 * never answered.
 *
 * ── AN EMPTY SUBJECT SENDS ──────────────────────────────────────────────────────────────
 *
 * It does not block and it does not open a confirm dialog. Blocking would be wrong — a
 * subjectless message is legitimate mail and every client sends one — and a modal
 * confirmation is the exact shape the owner objected to in Compose to begin with (*"cant even
 * esc out of it with key"*). So `noSubject` is surfaced as a factual note in the send row,
 * BEFORE the press rather than as a dialog after it, which is the same warning arriving early
 * enough to be useful.
 *
 * `mailboxId` is omitted rather than nulled when the mirror cannot name one, so `canSend`
 * refuses and `Engine.enrich` has nothing to disagree with.
 */
export function composePlan(fields: ComposeFields, mailboxId: string | null): ComposePlan {
  const parsed = parseRecipients(fields.to);
  return {
    ...parsed,
    noSubject: fields.subject.trim().length === 0,
    mutation: {
      kind: "mail_send",
      // THE COMPOSE FORK. Null is not a default here — it is what keeps `In-Reply-To` and
      // `References` off a message that is not answering anyone (see `types.ts`).
      inReplyTo: null,
      body: fields.body,
      subject: fields.subject,
      to: parsed.invalid.length === 0 ? parsed.addresses : [],
      ...(mailboxId ? { mailboxId } : {}),
      threadId: null,
    },
  };
}
