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

/* ── THE SCREENING QUESTION ───────────────────────────────────────────────────────────────────
 *
 * A SECOND question, for the Screener's suggestion path only. Live mail keeps asking the routing
 * question above, unchanged.
 *
 * ## Why a second question rather than a second copy of the first
 *
 * The docblock at the top of this file argues for ONE question asked identically however the
 * request travels. That invariant is about one question per PURPOSE — two copies of the SAME
 * taxonomy is how two hosts file the same message differently — and it is preserved here: this
 * question is defined once, in this file, beside the one it is not.
 *
 * ## The tautology it replaces
 *
 * The Screener's suggestion path used to ask the routing question of mail that is already sitting
 * in `ohmail/Screener`. But `ohmail/Screener` is what the routing taxonomy DEFINES as the correct
 * answer for a first-contact sender, and every row the Screener reasons about is a first-contact
 * sender. So the model was being asked a question whose own rules made one answer correct in
 * advance, and it gave that answer: measured on a live account with no stated bar, 66 of 74 stored
 * suggestions (89%) came back `ohmail/Screener`. The user had paid for advice and been told, at
 * high confidence, that the mail was where it already was.
 *
 * The fix is not a better prompt for the same question. It is a different question: the user is
 * not asking "where does this belong in a mailbox that has a gate" — they are standing AT the
 * gate, and the decision in front of them is what to do with this stranger. So `ohmail/Screener`
 * is removed from the answer set. It is the question being asked; it cannot also be an answer.
 *
 * ## The user's words are BINDING here, not advisory
 *
 * On the routing path the account's bar is one input among several and is explicitly forbidden
 * from carrying a first-contact sender past the gate. Here the bar is the whole point: the person
 * wrote down who they want to hear from, and this question is "does this sender meet what they
 * wrote". The instruction below therefore names the bar as the criteria to judge against rather
 * than something to weigh.
 *
 * **The words themselves still travel in the USER turn, never in this prefix.** The prefix is sent
 * with `cache_control:{type:"ephemeral"}` and that cache is shared across accounts, so one
 * account's sentence embedded here would be served to another's request. What this constant may
 * contain is the INSTRUCTION about the field; what it may never contain is the field's value.
 */
export const SCREEN_DESTINATIONS: Destination[] = [
  "INBOX",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * The screening instruction. Cacheable and account-independent, exactly like
 * {@link TAXONOMY_PREFIX}.
 *
 * Each outcome carries its own criteria, and two of them are written the way they are because of
 * what was measured without them:
 *
 *  · **Receipts** had to be named with a concrete first-contact example. An order confirmation from
 *    a shop the user has never mailed is the canonical case, and it is the one a "do I know this
 *    sender" reading gets wrong.
 *  · **Quarantine** had to be given criteria that separate junk from mere automation. Left
 *    undefined, "spam" collapses into "automated", and every newsletter becomes spam — or, as
 *    actually happened, nothing does.
 */
export const SCREENING_PREFIX = [
  "You are helping someone screen a first-contact sender for ohmail. This sender is waiting at",
  "the gate: their mail is held, and the person has to decide what happens to it. Your job is to",
  "recommend that decision. Choose exactly one:",
  "",
  "- INBOX: their Ohbox. A real person writing to them, or service mail they personally have to",
  "  act on — a delivery, a security alert, something with a consequence if ignored.",
  "- ohmail/Reads: newsletters, marketing, announcements, bulk or list mail worth skimming later.",
  "  Legitimate mail they may want, but never urgent.",
  "- ohmail/Receipts: order confirmations, invoices, payment and shipping notices, statements,",
  "  booking confirmations. Keep, do not read. A shop the person has never written to still files",
  "  here when the mail is a receipt for something they bought.",
  "- ohmail/Screened: legitimate mail from a sender this person does not want to hear from —",
  "  cold sales approaches, unrequested promotions, automated notification floods they never",
  "  asked for. Not junk; just unwanted.",
  "- ohmail/Quarantine: junk. Unsolicited bulk mail with no relationship of any kind, a forged or",
  "  deceptive sender, phishing, or a message whose purpose is to trick the reader. Being",
  "  automated, promotional or unwanted is NOT enough — that is ohmail/Screened. Quarantine is for",
  "  mail that should not have been sent at all.",
  "",
  "Set \"spam\" true only for ohmail/Quarantine, and false for every other destination.",
  "",
  // GENERIC and CONDITIONAL — never the value, which is per-account and lives in the user turn.
  "If the user turn carries an \"ohboxBar\" field, it is this person's own written statement of who",
  "belongs in their Ohbox. Treat it as the binding criteria for this decision: a sender who meets",
  "what it says belongs in INBOX, and a sender it excludes does not, whatever else is true of the",
  "mail. Where it is silent, use the definitions above.",
  "",
  "You are recommending, not filing. Nothing moves until the person agrees, so give the decision",
  "you would defend rather than the safest one. Return confidence in [0,1] and a one-line reason",
  "in plain language, addressed to the person deciding (never echo secrets or one-time codes).",
  "Respond ONLY with the structured JSON object.",
].join("\n");

/** The screening response schema. Same shape as the routing one, over the five-pile answer set. */
export const SCREENING_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["destination", "confidence", "rationale", "spam"],
  properties: {
    destination: { type: "string", enum: SCREEN_DESTINATIONS },
    confidence: { type: "number" },
    rationale: { type: "string" },
    spam: { type: "boolean" },
  },
} as const;

/**
 * A screening answer, made safe to act on.
 *
 * A label outside {@link SCREEN_DESTINATIONS} becomes `ohmail/Screener`, which every consumer
 * reads as "hold — the person decides". The safe answer does not have to be OFFERED to the model
 * to remain the fallback, and leaving it out of the enum is what removes the tautology.
 *
 * This is also what makes the change degrade safely rather than dangerously: an implementation
 * that has not been taught the screening question and answers the routing taxonomy anyway returns
 * `ohmail/Screener`, which lands here and coerces to a hold. It never coerces to an admission.
 *
 * `spam` is forced to agree with the destination rather than trusted alongside it. The two are one
 * fact in the prompt, and a reply that names `ohmail/Quarantine` with `spam:false` is not a third
 * verdict to preserve — it is the same verdict, said twice, once wrongly.
 */
export function coerceScreeningResult(raw: unknown): ClassifierResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const destination = SCREEN_DESTINATIONS.includes(o.destination as Destination)
    ? (o.destination as Destination)
    : "ohmail/Screener";
  let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  return { destination, confidence, rationale, spam: destination === "ohmail/Quarantine" };
}

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
      + `Sensitive mail never reaches a model; this is that rule failing CLOSED at the sink, and `
      + `the upstream caller should have set no_ai.`,
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
 * ── THE GATE-CONTRADICTION CHECK ─────────────────────────────────────────────────────────────
 *
 * True when the prose CONCLUDES "hold this at the Screener". It exists because a routing answer
 * has two channels — the structured `destination` and the one-line `rationale` — and only the
 * first is machine-checked. A reply whose rationale reasons its way to the gate while the field
 * names a folder past it is not advice anybody should act on; it is a coin toss with a sentence
 * attached.
 *
 * **The asymmetry is deliberate and it is the whole design.** A false positive here costs a
 * suggestion that reads "this one needs you" — which, for a queue whose every row is a
 * first-contact stranger, is the status quo and costs one human glance. A false negative admits
 * a stranger to the Ohbox and writes them an allow rule. So the check fires on the plain
 * presence of the gate's own name, and buys its narrowness back with a negation guard rather
 * than by hedging: "not a Screener case" and "no Screener hold needed" are the shapes an INBOX
 * verdict actually uses to mention the gate, and they do not fire.
 *
 * `screener` is the one word in this taxonomy with no ordinary mail meaning — nothing else in a
 * rationale is called a screener — which is why this is a keyword check and not a family
 * classifier over all six labels. `reads` is a verb, `inbox` appears in half the sentences a
 * model writes about mail, and a check built on those would fire on prose that agrees with its
 * own field.
 *
 * **It is NOT applied to routing**, and that is a decision rather than an oversight: routing
 * files live mail, and a prose heuristic that moved a message out of somebody's Ohbox would be
 * changing where real mail lands on the strength of a regex. Its one consumer is the Screener's
 * suggestion path, where the only thing it can change is which of three words a chip shows.
 */
const GATE_NAMED = /\bscreener\b/i;
/**
 * The gate's name, NEGATED — "not a Screener case", "never past the Screener", "no Screener hold".
 * Bounded at 40 characters and stopped at a clause break so a negation in one sentence cannot
 * cancel the gate named in the next.
 */
const GATE_NEGATED = /\b(?:not|never|beyond|past|outside|no|without)\b[^.;:]{0,40}?\bscreener\b/i;

/** True ⇒ the rationale's own conclusion is "hold at the gate". See the block above. */
export function rationaleHoldsAtGate(rationale: string): boolean {
  if (typeof rationale !== "string") return false;
  if (!GATE_NAMED.test(rationale)) return false;
  return !GATE_NEGATED.test(rationale);
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
