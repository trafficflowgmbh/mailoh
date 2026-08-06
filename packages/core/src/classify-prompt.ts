import type { Destination } from "./types.js";
import type { ClassifierInput, ClassifierResult } from "./classifier-port.js";
import { screenOutboundText, type OutboundScreen } from "./sensitive.js";

/**
 * THE ROUTING QUESTION — what is asked, what is refused, and how an answer is made safe.
 *
 * `classifier-port.ts` next door declares the SEAM: three interfaces, so a pipeline can say it
 * may consult a model without depending on one. This file is the QUESTION, and it is deliberately
 * a third thing rather than part of either:
 *
 *  · The port carries no prompt, so code that merely names the seam carries no taxonomy.
 *  · The implementations under `ai/` carry a model id, a request shape and a vendor client.
 *  · What sits between them — the taxonomy itself, the response schema, the outbound sensitivity
 *    sink and the coercion of whatever comes back — belongs to NEITHER, because it is the same
 *    for every implementation and must stay the same for every implementation.
 *
 * That last point is the reason this file exists at all. There is more than one way to reach a
 * model now: a hosted deployment with its own account, and a standalone install running against a
 * key or a local model belonging to the person using it. Two copies of the taxonomy is how those
 * two come to file the same message into different folders — a defect nobody would see in a test,
 * because each copy passes its own. One question, asked identically, however the request travels.
 *
 * It names no model and imports only mail vocabulary, so it is mail-half code: a consumer can ask
 * the routing question and still cannot construct a client to ask it with.
 */

/**
 * The destinations a routing answer may choose, as a value.
 *
 * Typed as `Destination[]` so that adding a folder to the union without adding it here is a
 * compile error rather than a taxonomy the model is never told about.
 */
export const CLASSIFY_DESTINATIONS: Destination[] = [
  "INBOX",
  "ohmail/Screener",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * The FIXED taxonomy/policy/folder-map prefix. It is stable across every classify
 * call so it can be cached (a `system` block with `cache_control:{type:"ephemeral"}`);
 * the volatile per-message fields go in the user turn, after the cache breakpoint.
 */
export const TAXONOMY_PREFIX = [
  "You are the routing classifier for ohmail. Given one email's sender,",
  "subject, a short redacted snippet, and a headers digest, choose exactly one",
  "destination folder from this fixed taxonomy:",
  "",
  "- INBOX: correspondence the owner personally cares about (the Ohbox).",
  "- ohmail/Screener: first-contact senders awaiting owner approval.",
  "- ohmail/Reads: newsletters, marketing, bulk/list mail to skim.",
  "- ohmail/Receipts: receipts, confirmations, statements to keep but not read.",
  "- ohmail/Screened: senders the owner has previously declined.",
  "- ohmail/Quarantine: spam / unsafe mail.",
  "",
  // A GENERIC, CONDITIONAL instruction about the optional per-account field — never the field's
  // value, which is per-account and lives in the user turn (see `ClassifyUserPayload.ohboxBar`).
  // It is inert for the accounts that set no bar (the field is simply absent), so it changes no
  // routing for them, and it deliberately does NOT restate or sharpen the folder definitions
  // above: a base-taxonomy change is its own decision with its own before/after evidence.
  "If the user turn carries an \"ohboxBar\" field, it is the account owner's own statement,",
  "in their words, of who belongs in their Ohbox (INBOX). Weigh it when choosing between INBOX",
  "and the automated piles (Reads/Receipts). It never carries a first-contact sender past the",
  "Screener gate and never changes how sensitive mail is handled.",
  "",
  "Return confidence in [0,1], a one-line rationale (never echo secrets/OTP codes),",
  "and whether the message is spam. Respond ONLY with the structured JSON object.",
].join("\n");

/**
 * The routing response schema.
 *
 * No numeric min/max — structured-output implementations reject those, and a constraint one
 * endpoint silently drops is not a constraint. `confidence` is clamped in
 * {@link coerceClassifierResult} instead, where it is checked whatever the endpoint did.
 */
export const CLASSIFY_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["destination", "confidence", "rationale", "spam"],
  properties: {
    destination: { type: "string", enum: CLASSIFY_DESTINATIONS },
    confidence: { type: "number" },
    rationale: { type: "string" },
    spam: { type: "boolean" },
  },
} as const;

/**
 * The refusal {@link classifyUserPayload} raises instead of sending. A distinct type because it
 * is NOT a model fault: a caller must never treat it as retryable, and a circuit breaker must
 * never count it as an outage. It carries no message content — only which rule fired — so the
 * refusal itself cannot become the leak.
 */
export class SensitivePayloadRefusal extends Error {
  readonly screen: OutboundScreen;
  constructor(screen: OutboundScreen) {
    super(
      `classifier: refusing to send a payload screened as sensitive `
      + `(rule=${screen.reason}${screen.category ? `, category=${screen.category}` : ""}). `
      + `This is invariant #1 failing CLOSED at the sink; the upstream caller should have set no_ai.`,
    );
    this.name = "SensitivePayloadRefusal";
    this.screen = screen;
  }
}

/** What one routing request serialises, once it has passed the screen. */
export interface ClassifyUserPayload {
  from: string;
  subject: string;
  snippet: string;
  headersDigest: string;
  fewShot: Array<{ from: string; destination: Destination }>;
  /**
   * The account's own "who belongs in my Ohbox" bar. Present only when the account set one, and it
   * lives HERE — in the volatile user payload, after the cache breakpoint — never in
   * {@link TAXONOMY_PREFIX}: the prefix is cached with `cache_control:{type:"ephemeral"}` and shared
   * across accounts, so a per-account string in it would poison the cache and leak one account's
   * words onto another's request. Absent ⇒ the field is omitted from the serialised turn entirely.
   */
  ohboxBar?: string;
}

/**
 * SCREEN, THEN BUILD — the last check before a payload is serialised for any model.
 *
 * The pipeline already refuses sensitive mail before a classifier is touched, which is what keeps
 * a secret out of the spend ledger as well as off the wire. This is the second line: it re-reads
 * the payload that is about to leave, with the same local detector, and throws. It exists because
 * the first check lives a module away and cannot see a caller that builds its own input — the
 * Screener's explicit suggestion path does exactly that, from a stored row, in a package that
 * cannot see the pipeline.
 *
 * The order is the guarantee. The screen runs before `payload` exists, so there is no moment at
 * which a refused payload has been assembled and something could log it, cache it, or hand it to
 * a retry queue on the way out.
 *
 * What it screens and what it deliberately does not: see `screenOutboundText`. Recognised
 * authentication material, an unframed credential shape, and an authentication URL carrying a
 * token are refused. An unsupported script and an unrecognised language are NOT — those are
 * upstream routing decisions, and a sink that threw on every non-Latin payload would break the
 * Screener for non-Latin senders while protecting nothing.
 */
export function classifyUserPayload(input: ClassifierInput): ClassifyUserPayload {
  const screen = screenOutboundText(input.subject, input.snippet);
  if (!screen.safe) throw new SensitivePayloadRefusal(screen);
  // A blank or whitespace-only bar carries no instruction, so it is dropped rather than serialised
  // as an empty field the model would have to reason about. `undefined` ⇒ the key is omitted.
  const bar = input.ohboxBar?.trim();
  return {
    from: input.from.address,
    subject: input.subject,
    snippet: input.snippet,
    headersDigest: input.headersDigest,
    fewShot: input.fewShot ?? [],
    ...(bar ? { ohboxBar: bar } : {}),
  };
}

/**
 * A model's answer, made safe to act on.
 *
 * A label outside the taxonomy becomes `ohmail/Screener` — the gate, where a person decides —
 * rather than a guess at what was meant. Never auto-filing on a malformed answer is the point:
 * asking costs one click, and filing wrongly costs mail somebody cannot find.
 */
export function coerceClassifierResult(raw: unknown): ClassifierResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const destination = CLASSIFY_DESTINATIONS.includes(o.destination as Destination)
    ? (o.destination as Destination)
    : "ohmail/Screener";
  let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  const spam = o.spam === true;
  return { destination, confidence, rationale, spam };
}
