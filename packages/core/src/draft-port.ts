/**
 * THE DRAFTING SEAM — the port and its shapes, with no implementation behind it.
 *
 * A reply drafter is optional: a deployment that injects none simply offers no drafts, and every
 * other path — rules, the Screener, filing, search — works exactly as before. So the code that
 * merely NAMES the port (the drafting service, the route table that wires it, the workflow step
 * that calls it) needs these five shapes and nothing else. None of them constructs a drafter and
 * none of them names a model.
 *
 * ── WHY THIS IS A LEAF, AND NOT UNDER `ai/` ──────────────────────────────────────────────
 *
 * They used to be declared beside the implementation, which is where the model id, the request
 * shape and the inference-residency options live. A type-only edge is erased from the emitted
 * JavaScript and perfectly visible in the source, which is where it counted: mail-half modules
 * declared a dependency on the model half in order to say what shape they accept. `ai/` is the
 * private half wholesale, and a rule about a directory is the only kind that survives a new file
 * being added to it — so the port moved out rather than the rule bending.
 *
 * `ai/draft.ts` re-exports these, so nothing that imports them from the package barrel changes.
 *
 * ── WHAT THE SHAPES THEMSELVES GUARANTEE ─────────────────────────────────────────────────
 *
 * The input carries ONLY sensitivity-safe previews — redacted snippets and knowledge-base
 * entries, never a raw body. The caller refuses to draft against a message marked as excluded
 * from AI, and excludes such messages from the surrounding context BEFORE building this input.
 * That is structural rather than a filter someone remembers to apply: the port cannot see what
 * the caller never passes, because there is no field here for it to arrive in.
 */

/** The message being replied to — subject/from/snippet only, and the snippet is redaction-safe. */
export interface DraftIncoming {
  subject: string;
  from: string;
  snippet: string;
}

/**
 * The retrieved grounding context: knowledge-base entries plus the target thread's OTHER
 * messages as snippets. No raw bodies, and nothing the user has marked as excluded from AI or
 * from the knowledge base — the caller's retrieval excludes those at the boundary.
 */
export interface DraftContext {
  kbEntries: Array<{ title: string; content: string }>;
  threadMessages: Array<{ from: string; snippet: string }>;
}

export interface DraftInput {
  incoming: DraftIncoming;
  context: DraftContext;
}

export interface DraftResult {
  subject: string;
  body: string;
  rationale: string;
}

/** Injected into the drafting dependencies; absent on a deployment that offers no drafts. */
export interface DraftPort {
  draft(input: DraftInput): Promise<DraftResult>;
}
