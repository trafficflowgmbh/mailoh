import type { Destination, EmailAddress } from "./types.js";

/**
 * THE CLASSIFIER SEAM — the port only, with no implementation behind it.
 *
 * `pipeline.ts` and `ports.ts` describe a pipeline that MAY consult a model: the port is optional
 * on `PipelineDeps`, and a deployment that supplies none routes on rules alone, which is the
 * product's floor. Both files therefore need these three shapes and nothing else — they never
 * construct a classifier and never name a model.
 *
 * They used to take them from `classify.ts`, which is also where the model implementation lives:
 * the fixed taxonomy prompt, the model id, the response schema and the outbound sensitivity sink.
 * A type-only edge is invisible in the source but not in the module graph, so every consumer of
 * the pipeline — including a local engine that configures no model at all — carried the prompts.
 *
 * ── WHY THIS IS A LEAF, AND NOT UNDER `ai/` ──────────────────────────────────────────────
 *
 * Splitting the port from the implementation is what lets the mail half of this package be
 * described without the model half, and where the file SITS is half of that split. `ai/` is the
 * model half wholesale — prompts, model ids, response schemas — and the rule that keeps it
 * private is a rule about the directory, because a rule about individual files inside it is one
 * forgotten entry away from shipping a prompt.
 *
 * This file names no model and carries no prompt: three interfaces, and the only thing it
 * imports is the mail vocabulary next door. It lived under `ai/` while the only consumers that
 * mattered were the classifier's own, and a directory-wide rule then could not tell a port from
 * an implementation — so `pipeline.ts` and `ports.ts`, which are mail-half code, reached across
 * the boundary in a type position on every build. It is a leaf here so that `ai/` is, without
 * exception, the private half.
 *
 * `classify.ts` re-exports these, so the surface of `@trafficflow/core` is unchanged and no
 * existing import outside this package has to move.
 */

export interface ClassifierInput {
  from: EmailAddress;
  subject: string;
  snippet: string;                                       // NEVER the full body of a sensitive message
  headersDigest: string;                                 // small, sensitivity-safe
  fewShot?: Array<{ from: string; destination: Destination }>;  // learned few-shot (spec §7, §11)
  /**
   * The account's plain-language "who belongs in my Ohbox" bar, in their own words. OPTIONAL,
   * and it reaches the model's USER turn only — never the cached taxonomy prefix, which is shared
   * across accounts. It refines the model's proposal for this one message; it is not routing
   * itself. Absent ⇒ the model classifies on the taxonomy alone, exactly as before.
   */
  ohboxBar?: string;
}

export interface ClassifierResult {
  destination: Destination;
  confidence: number;                                    // 0..1
  rationale: string;
  spam: boolean;
}

export interface ClassifierPort {                        // added to PipelineDeps (optional)
  classify(input: ClassifierInput): Promise<ClassifierResult>;
}
