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

import { useEffect, useState } from "react";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import { apiConfigured, consent as consentApi, type ConsentStateWire } from "../api-client";

export interface ConsentState {
  /** Null until the seed review has been confirmed. Drives which onboarding step is shown. */
  seedConfirmedAt: string | null;
  /** ALWAYS a number, so a partition can always be computed. */
  dormancyDays: number;
  /** Senders still owed a decision, as the SERVER counts them. */
  activeUndecidedSenders: number;
  /** False until the first answer lands — an onboarding step must not flash before then. */
  known: boolean;
}

const RESTING: ConsentState = {
  seedConfirmedAt: null,
  dormancyDays: DEFAULT_DORMANCY_DAYS,
  activeUndecidedSenders: 0,
  known: false,
};

/**
 * @param active `false` on the demo and the desktop, which have no server. Both keep
 * {@link RESTING}, which is the same window the engine would have used unasked.
 */
export function useConsentState(active: boolean): ConsentState {
  const [state, setState] = useState<ConsentState>(RESTING);

  useEffect(() => {
    if (!active || !apiConfigured()) return;
    let live = true;
    void (async () => {
      try {
        const wire: ConsentStateWire = await consentApi.state();
        if (!live) return;
        setState({
          seedConfirmedAt: wire.seedConfirmedAt,
          // Defended anyway. The route promises a number; a stale deployment or a proxy that
          // rewrote the body must not be able to make the window `NaN`, which would put every
          // sender on one side of the cutline.
          dormancyDays:
            typeof wire.dormancyDays === "number" && Number.isFinite(wire.dormancyDays)
              ? wire.dormancyDays
              : DEFAULT_DORMANCY_DAYS,
          activeUndecidedSenders: wire.counts?.activeUndecidedSenders ?? 0,
          known: true,
        });
      } catch {
        // Deliberately silent — see the header.
      }
    })();
    return () => { live = false; };
  }, [active]);

  return state;
}
