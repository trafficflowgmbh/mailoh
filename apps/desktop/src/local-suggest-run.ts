/**
 * ASKING YOUR OWN MODEL ABOUT WAITING SENDERS — the part that talks, with nothing that draws.
 *
 * Split out from the control that renders it, and not for tidiness: this is the half that has to be
 * proven against a REAL engine, and the engine's own test suite runs where there is no browser and
 * no React. A loop that could only be exercised through a rendered component could only ever be
 * tested against a stand-in for the thing it talks to, which is how two halves end up green and
 * unable to speak to each other.
 *
 * ── WHAT ONE RUN DOES ───────────────────────────────────────────────────────────────────────
 *
 * A bounded set of senders, in the queue's own order, asked about in small requests taken ONE AT A
 * TIME. Serial is deliberate. The engine classifies serially inside a request anyway, so
 * concurrency could only be across requests — and the same process is syncing mail through the same
 * model and the same on-disk database while this runs. A burst competes with mail arriving, and
 * against a model server on this machine it competes for the machine. There is no deadline to race
 * the way a hosted request has one, so the extra pressure buys nothing.
 *
 * Chunks exist for two other reasons: answers land as they arrive rather than all at the end, and
 * stopping costs at most one chunk. The transport carries no cancellation — see `bridge-fetch.ts` —
 * so a chunk already in flight runs to completion whatever the caller does. With a key of your own
 * that is your money, which is why the chunk is small.
 *
 * A re-run is cheap: the engine answers from what it has already stored before it reaches the
 * model, so a sender answered for once is not asked about twice.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { SenderSuggestion, SuggestSkipShown } from "../../webapp/app/shell/screener-suggest";
import { toSuggestion, toSkips } from "../../webapp/app/shell/screener-suggest";

/**
 * HOW MANY SENDERS ONE REQUEST CARRIES.
 *
 * Small on purpose, and not a throughput setting. It is the granularity of two things: how often
 * answers appear, and how much work a stop cannot take back.
 */
export const CHUNK = 5;

/**
 * THE MOST ONE RUN ASKS ABOUT — one endpoint request's worth of senders, and no ladder above it.
 *
 * The endpoint refuses more than this in a single request, and a press that quietly became several
 * requests' worth would be a buy ladder without the number that made one honest. A backlog is
 * cleared by running again, which is a person choosing to, each time.
 */
export const PER_PRESS = 50;

/** How much of the stored queue one hydration reads. It reaches no model and costs nothing. */
const HYDRATE_LIMIT = 200;

/** Only what this module reads. Declared here so the desktop owes the Cloud client nothing. */
interface SuggestWire {
  suggestions: Array<{
    sender: string;
    messageId: string;
    decision: "yes" | "no" | "hold";
    destination?: string;
    spam?: boolean;
    confidence: number;
    rationale: string;
  }>;
  skipped: Array<{ sender: string; reason: SuggestSkipShown | "not_held" }>;
}

/** One overlay entry, as the rows already speak it. */
export type SuggestionRow = { address: string; suggestion: SenderSuggestion };

/** Why a run stopped, in the engine's own words. */
export interface SuggestRefusal {
  code: string;
  message: string;
  /** True when the code means "this install has no usable model" rather than "that run failed". */
  noModel: boolean;
}

/** The codes that mean there is nothing to run against, whatever the settings pane last showed. */
const NO_MODEL_CODES = new Set([
  "suggest_unconfigured",
  "ai_provider_unavailable",
  "drafter_unconfigured",
]);

async function refusalOf(res: Response): Promise<SuggestRefusal> {
  let code = "";
  let message = `the mail engine answered ${res.status}`;
  try {
    const wire = (await res.json()) as { error?: { code?: string; message?: string } };
    code = wire.error?.code ?? "";
    message = wire.error?.message ?? message;
  } catch {
    /* Not JSON. The status is all there is to say. */
  }
  return { code, message, noModel: NO_MODEL_CODES.has(code) };
}

/** A fresh idempotency key, so a lost answer is replayed rather than re-asked of the model. */
function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * What the engine already holds, read once when the Screener is first opened.
 *
 * This is what makes an answer survive a relaunch: it is stored beside the mail, and without this
 * read the chips would live only as long as the window that asked for them. A failed read answers
 * with nothing — the rows are then exactly as they already render, without chips, which claims
 * nothing untrue.
 */
export async function hydrateSuggestions(): Promise<SuggestionRow[]> {
  let res: Response;
  try {
    res = await bridgeFetch(`/screener?limit=${HYDRATE_LIMIT}`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const page = (await res.json()) as {
    items?: Array<{
      sender?: { address?: string };
      aiSuggestion?: {
        decision: "yes" | "no" | "hold"; destination?: string; confidence: number; rationale: string;
      } | null;
    }>;
  };
  const out: SuggestionRow[] = [];
  for (const item of page.items ?? []) {
    const address = item.sender?.address;
    if (!address || !item.aiSuggestion) continue;
    out.push({ address, suggestion: toSuggestion(item.aiSuggestion) });
  }
  return out;
}

export interface SuggestRun {
  /** Waiting senders with no answer yet, in queue order. Bounded by {@link PER_PRESS}. */
  senders: string[];
  /** Answers, as they arrive, for the one overlay the rows read their chips from. */
  absorb: (rows: SuggestionRow[]) => void;
  /** How many senders have been answered for so far, out of how many were asked about. */
  onProgress?: (done: number, total: number) => void;
  /**
   * FALSE ONCE SOMEBODY ELSE OWNS THE STATE — a stop, or a later run.
   *
   * Checked on the arrival of every chunk and before the next one is asked for, so a stopped run
   * paints nothing and asks for nothing more. It cannot un-ask the chunk already in flight; the
   * transport has no cancellation and the engine finishes what it was given.
   */
  alive?: () => boolean;
}

export interface SuggestOutcome {
  /** Senders answered for. Lower than the total when a chunk refused part-way. */
  done: number;
  total: number;
  /** Why it stopped early, in the engine's own words, or null when it did not. */
  refusal: SuggestRefusal | null;
  /** True when a stop or a later run took over. Nothing about this outcome should be painted. */
  abandoned: boolean;
}

export function chunksOf(senders: string[], size = CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < senders.length; i += size) out.push(senders.slice(i, i + size));
  return out;
}

/**
 * Ask about `senders`, one small request at a time, landing answers as they arrive.
 *
 * Halts on the first chunk that refuses and reports why: what earlier chunks answered stays, and
 * the engine's own sentence is carried out rather than a class of failure invented here. Every
 * refusal on this path already has a true one written by the code that made the decision, and a
 * second taxonomy is how somebody with a stopped model server gets told their mail is broken.
 */
export async function runSuggest(run: SuggestRun): Promise<SuggestOutcome> {
  const alive = run.alive ?? ((): boolean => true);
  const set = run.senders.slice(0, PER_PRESS);
  const total = set.length;
  let done = 0;
  run.onProgress?.(0, total);

  for (const chunk of chunksOf(set)) {
    if (!alive()) return { done, total, refusal: null, abandoned: true };
    const res = await bridgeFetch("/screener/suggest", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": newKey() },
      body: JSON.stringify({ senders: chunk }),
    });
    if (!alive()) return { done, total, refusal: null, abandoned: true };
    if (!res.ok) return { done, total, refusal: await refusalOf(res), abandoned: false };
    const wire = (await res.json()) as SuggestWire;
    if (!alive()) return { done, total, refusal: null, abandoned: true };
    run.absorb([
      ...wire.suggestions.map((s) => ({ address: s.sender, suggestion: toSuggestion(s) })),
      ...toSkips(wire.skipped),
    ]);
    done += wire.suggestions.length;
    run.onProgress?.(done, total);
  }
  return { done, total, refusal: null, abandoned: false };
}
