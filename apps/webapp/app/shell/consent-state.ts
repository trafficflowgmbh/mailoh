"use client";

/**
 * WHERE THIS ACCOUNT STANDS IN ONBOARDING, and the dormancy window it is counted with.
 *
 * One `GET /consent` per tab. Everything the shell needs from it is a scalar: has the seed
 * review been confirmed, and how many days of quiet make a sender dormant.
 *
 * ── WHY THE DIAL COMES OVER REST AND NOT THROUGH `/sync` ─────────────────────────────────
 *
 * The mirror carries mail. A per-account integer with no history and no delete is not a
 * change to mail, and giving it an entity type would grow the change-log writers, the wire
 * union and the mirror's vocabulary for a value that moves once a year. The schema already
 * documents this shape for per-account settings tables — REST, and the client refetches.
 *
 * The accepted cost is stated rather than hidden: a second tab that is open while the dial
 * moves keeps partitioning with the old window until it reloads. The window decides which
 * senders are ASKED about, not what is stored or searchable, so the worst case is a Screener
 * queue that is briefly the wrong length in one tab.
 *
 * ── AND WHY A FAILURE IS SILENT ──────────────────────────────────────────────────────────
 *
 * The default is the product default, which is what the client engine uses anyway. A tab that
 * could not reach this endpoint partitions exactly as it would have before the endpoint
 * existed, so a network blip must not produce an error anybody has to read.
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import { apiConfigured, consent as consentApi, type ConsentStateWire } from "../api-client";

export interface ConsentState {
  /** Null until the seed review has been confirmed. Drives which onboarding step is shown. */
  seedConfirmedAt: string | null;
  /** ALWAYS a number, so a partition can always be computed. */
  dormancyDays: number;
  /** Senders still owed a decision, as the SERVER counts them. */
  activeUndecidedSenders: number;
  /**
   * IS AUTO-SUGGEST ON — the one field on this object that authorises spending.
   *
   * A boolean and not the instant, because the only consumer asks a yes/no question. It starts
   * FALSE and stays false unless the server said otherwise, which is the direction that matters:
   * `RESTING` is false, a failed fetch leaves `RESTING` in place, an API too old to carry the
   * field sends `undefined`, and all three read as off. There is no path here from "I do not
   * know" to "buy something".
   */
  autoSuggest: boolean;
  /**
   * WHEN it was turned on, for the settings row that says so. Null whenever it is off.
   *
   * Kept beside {@link autoSuggest} rather than replacing it, because the two answer different
   * questions and only one of them authorises spending. Nothing may branch on this field: it is
   * display only, and `autoSuggest` stays the single boolean the spender reads — a second
   * derivation of "is it on" is how the two get to disagree.
   */
  autoSuggestAt: string | null;
  /** False until the first answer lands — an onboarding step must not flash before then. */
  known: boolean;
  /**
   * THERE IS NO CONSENT ENDPOINT BEHIND THIS BUILD, AND THERE NEVER WILL BE — the desktop.
   *
   * {@link known} answers "has the server told us the window yet?", and everything gated on it
   * is gated for one reason: partitioning on a GUESSED window would move mail into History on
   * the strength of a default the account may not be using, and a request that merely failed
   * would silently hide somebody's mail. Both halves of that reason presuppose a stored window
   * this client has not yet read.
   *
   * On a standalone install there is no stored window. `apiConfigured()` is false, the fetch
   * never runs, `known` is false for the life of the process — and the shell read that as "the
   * answer has not arrived", switched the cutline off, and drew the Screener over the raw
   * mirror. No History pile at all, and every sender whose mail had already been filed into the
   * Screener folder sat in the queue for ever. `DEFAULT_DORMANCY_DAYS` is not a guess here: it
   * is the only window this build has, the one the engine uses unasked, and the one the dial
   * would have to be turned away from — but there is no dial, because there is nowhere to
   * store the number.
   *
   * NOT reachable on the web. A live browser tab with no API base never renders this shell at
   * all: `createEngine` throws `EngineUnarmedError` rather than fall back to fixtures. So this
   * is true exactly where an engine was handed in — the desktop's seam — and the known-gate
   * still governs everywhere a server exists.
   *
   * False on the demo, which is `active: false`: the demo is a fixture world with no decisions
   * in it, and `AppShell` refuses to partition it for reasons of its own.
   */
  standalone: boolean;
}

const RESTING: ConsentState = {
  seedConfirmedAt: null,
  dormancyDays: DEFAULT_DORMANCY_DAYS,
  activeUndecidedSenders: 0,
  autoSuggest: false,
  autoSuggestAt: null,
  known: false,
  standalone: false,
};

/**
 * @param active `false` on the demo and the desktop, which have no server. Both keep
 * {@link RESTING}, which is the same window the engine would have used unasked.
 */
export function useConsentState(active: boolean): ConsentState & {
  /**
   * Flip auto-suggest and keep the local answer in step with the stored one.
   *
   * Resolves to what the DATABASE holds, and the local state is set from that rather than from
   * the argument — so a refused write leaves the flag showing its real value instead of the one
   * the click hoped for. It rethrows, because a settings toggle that silently did nothing is the
   * failure the caller has to be able to tell the user about.
   */
  setAutoSuggest: (enabled: boolean) => Promise<boolean>;
  /**
   * Move the dormancy dial and keep the local window in step with the stored one.
   *
   * Resolves to the EFFECTIVE window the server counted with, and `state.dormancyDays` is set from
   * THAT echo, not from the argument — so passing the product default (which the server stores as
   * NULL) leaves the state showing the real number, and a refused write is never mistaken for a
   * move. The control MUST write through here rather than calling `consentApi` directly: the memo
   * that partitions the mirror (`consentPartition` in `AppShell`) is keyed on `consent.dormancyDays`,
   * so setting it from the echo re-partitions the same render — a component with its own fetch would
   * leave the open tab counting with the stale window.
   */
  setDormancyDays: (days: number | null) => Promise<number>;
} {
  const [state, setState] = useState<ConsentState>(RESTING);

  useEffect(() => {
    if (!active || !apiConfigured()) return;
    let live = true;
    void (async () => {
      try {
        const wire: ConsentStateWire = await consentApi.state();
        if (!live) return;
        // KNOWN MEANS THE SERVER ANSWERED THIS QUESTION, not that a request returned 200.
        //
        // The window is the one field that cannot be absent from a real answer — the route
        // substitutes the product default rather than ever sending null — so its presence and
        // its type ARE the check. A body that does not carry one is a stale deployment, a
        // proxy that rewrote it, or a harness answering every url alike, and none of those
        // are grounds to re-present somebody's whole mailbox. `known: false` leaves every
        // message in the pile its folder names, which is the safe direction.
        if (typeof wire.dormancyDays !== "number" || !Number.isFinite(wire.dormancyDays)) return;
        setState({
          // Normalised: absent and null both mean "nobody has answered the review yet".
          seedConfirmedAt: wire.seedConfirmedAt ?? null,
          dormancyDays: wire.dormancyDays,
          activeUndecidedSenders: wire.counts?.activeUndecidedSenders ?? 0,
          // `== null` covers BOTH null (off) and undefined (an API from before mail 0040).
          // Written as one comparison because the two are the same answer to the only question
          // asked of this field, and splitting them would invite a branch where one of them
          // becomes true.
          autoSuggest: wire.autoSuggestAt != null,
          // Normalised to null so `undefined` (an API from before mail 0040) cannot reach a view.
          autoSuggestAt: wire.autoSuggestAt ?? null,
          known: true,
          standalone: false,
        });
      } catch {
        // Deliberately silent — see the header.
      }
    })();
    return () => { live = false; };
  }, [active]);

  const setAutoSuggest = useCallback(async (enabled: boolean): Promise<boolean> => {
    const res = await consentApi.setAutoSuggest(enabled);
    const on = res.autoSuggestAt != null;
    // BOTH FIELDS FROM THE SAME ECHO. Setting the boolean from the server and the instant from
    // the argument (or leaving it stale) is how a row reads "On since <yesterday>" about a write
    // that was refused — the two must move together or not at all.
    setState((prev) => ({ ...prev, autoSuggest: on, autoSuggestAt: res.autoSuggestAt ?? null }));
    return on;
  }, []);

  const setDormancyDays = useCallback(async (days: number | null): Promise<number> => {
    const res = await consentApi.setDormancyDays(days);
    // FROM THE SERVER ECHO, never the argument — the server stores the default as NULL and reads it
    // back as the default number, so this is the window the partition memo must re-key on.
    setState((prev) => ({ ...prev, dormancyDays: res.dormancyDays }));
    return res.dormancyDays;
  }, []);

  // Derived rather than stored, so it cannot be left behind by a `setState` that forgot it: it
  // is a fact about the BUILD and the mode, and both are settled before the first render.
  // `active` is `!demo`; see {@link ConsentState.standalone}.
  return { ...state, standalone: active && !apiConfigured(), setAutoSuggest, setDormancyDays };
}
