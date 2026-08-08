/**
 * THE OHBOX BAR ON A STANDALONE INSTALL — the window's half of the engine's screening preference.
 *
 * Two facts about how this mailbox wants its Ohbox kept live on `account_settings`: the POSTURE,
 * and the BAR — your own sentence about what deserves the Ohbox. Both columns are mail-half,
 * so every standalone install's database has held them since it was created, and the engine has
 * always READ them: the bar travels in the user turn of the screening question a first-contact
 * sender is judged by, which on this tier is asked of a model you supplied yourself.
 *
 * What was missing was a way to WRITE one. `GET/PATCH /account/screening` was mounted in the hosted
 * route table only, so the words that steer this install's own model were readable and unwritable
 * on the one tier where the person reading them is the one paying for the model. The local engine
 * serves that route now, and this module is what addresses it — over {@link bridgeFetch}, the same
 * pipe every other request in this window goes down. No account, no server, no socket.
 *
 * ── IT READS AND WRITES ONE AXIS ────────────────────────────────────────────────────────────
 *
 * The route takes three (`ohboxPolicy`, `ohboxBar`, `screenerAutoApply`) and this module names one.
 * That is deliberate and not an oversight of the other two:
 *
 *  · the POSTURE is honoured here — `runSyncCycle` resolves it per account and the pipeline files
 *    against it — so it could be offered, and is simply not part of this surface yet;
 *  · AUTO-APPLY is NOT. Its only consumer is the hosted worker's scheduled pass, which no
 *    standalone install runs. A switch for it in this window would be a control that does nothing,
 *    which is worse than an absent one.
 *
 * A PATCH body that names one axis leaves the others untouched — the route tests presence with
 * `in`, so an omitted key is "leave this alone" and an explicit `null` is "revert this one".
 *
 * ── AND IT GOES DOWN THE BRIDGE, NOT THROUGH THE SYNC CLIENT ────────────────────────────────
 *
 * `bridgeFetch` directly, the way `local-ai.ts` addresses its own route — never the sync client's
 * own request method. That is load-bearing rather than stylistic: the engine's route-coverage check
 * DERIVES the client's call list from that client's source and holds it against both of the
 * surfaces the engine serves, so a settings call routed through it would join the list and land in
 * the hosted-mirror half of it, where this route has no local handler and would have to be declared
 * a forward. A preference is not sync traffic and has no place in the protocol that carries mail;
 * keeping it here keeps that check about mail.
 */

import { bridgeFetch } from "./bridge-fetch.js";

/** Where the engine serves it. Root-relative, like every path in this window. */
const SCREENING_PATH = "/account/screening";

/**
 * `404` MEANS "NOT ON THIS DOOR", and it is a state rather than a fault.
 *
 * The same shape `local-ai.ts` uses, for a closely related reason: an engine that does not serve this
 * route is an engine this pane has nothing to show for, and an error card would be a lie about a
 * mailbox that is working perfectly well.
 */
const NOT_SERVED_HERE = 404;

/** What `GET /account/screening` answers. The wire shape, as the hosted client sees it too. */
export interface ScreeningPreference {
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  /** The stored words, or `null` while this mailbox has never set any. */
  ohboxBar: string | null;
  /** The product default — what the editor prefills with, and what `null` resolves to. */
  defaultBar: string;
  screenerAutoApply: boolean;
}

interface WireError {
  error?: { code?: string; message?: string };
}

/** The engine's own sentence for a refusal, or a plain one when it did not compose one. */
async function refusal(res: Response): Promise<Error> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as WireError).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new Error(said ?? `the mail engine answered ${res.status}`);
}

async function readPreference(res: Response): Promise<ScreeningPreference> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as ScreeningPreference;
}

/** This mailbox's screening preference, or `null` when this engine does not serve one. */
export async function readScreening(): Promise<ScreeningPreference | null> {
  const res = await bridgeFetch(SCREENING_PATH);
  if (res.status === NOT_SERVED_HERE) return null;
  return readPreference(res);
}

/**
 * Write the bar, and nothing else. `null` reverts it to the product default.
 *
 * Answers with the preference now in force, so the editor renders what was stored rather than what
 * was typed — the same discipline the hosted client's copy of this control follows.
 */
export async function saveOhboxBar(bar: string | null): Promise<ScreeningPreference> {
  return readPreference(
    await bridgeFetch(SCREENING_PATH, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ohboxBar: bar }),
    }),
  );
}
