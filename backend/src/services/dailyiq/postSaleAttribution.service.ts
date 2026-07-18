// CF-POST-SALE-ATTRIBUTION (Drew, 2026-07-17). Pure math + Cosmos glue
// for classifying a confirmed sale against the most recent action-
// plan verdict for the same holding. Feeds the credibility loop:
// SELL_NOW that matched a real sale → hit; SELL_NOW that didn't →
// miss; HOLD followed by a sale anyway → hold_sold (engine probably
// missed something).

import type { ActionVerdict } from "./dailyIqActionPlanCompute.service.js";
import type { ActionPlanSnapshotDoc, SaleOutcomeClass } from "./actionPlanSnapshotStore.service.js";

const VERDICT_HIT_TOLERANCE = 0.05;   // sale within 5% below target still counts as hit

export interface AttributionInputs {
  holdingId: string;
  userId: string;
  cardId: string | null;
  soldAt: string;                 // ISO
  salePrice: number;
  snapshots: ActionPlanSnapshotDoc[];   // ordered newest first
}

export interface AttributionResult {
  holdingId: string;
  userId: string;
  cardId: string | null;
  soldAt: string;
  salePrice: number;
  verdictAtSaleTime: ActionVerdict | null;
  verdictSnapshotDate: string | null;
  priceTargetAtSnapshot: number | null;
  daysSinceVerdict: number | null;
  outcomeClass: SaleOutcomeClass;
}

/** Classify a sale against the latest verdict snapshot for the same
 *  holding. Pure — no I/O. Callers pull `snapshots` via
 *  readRecentSnapshots(holdingId) first. */
export function classifySale(inputs: AttributionInputs): AttributionResult {
  const latest = inputs.snapshots.length > 0 ? inputs.snapshots[0] : null;

  const base = {
    holdingId: inputs.holdingId,
    userId: inputs.userId,
    cardId: inputs.cardId,
    soldAt: inputs.soldAt,
    salePrice: inputs.salePrice,
  };

  if (!latest) {
    return {
      ...base,
      verdictAtSaleTime: null,
      verdictSnapshotDate: null,
      priceTargetAtSnapshot: null,
      daysSinceVerdict: null,
      outcomeClass: "no_verdict",
    };
  }

  const soldMs = new Date(inputs.soldAt).getTime();
  const snapMs = new Date(`${latest.date}T00:00:00Z`).getTime();
  const daysSinceVerdict = Math.max(0, Math.floor((soldMs - snapMs) / (24 * 3600 * 1000)));

  const outcomeClass: SaleOutcomeClass = classifyOutcome(
    latest.verdict,
    latest.priceTarget,
    inputs.salePrice,
  );

  return {
    ...base,
    verdictAtSaleTime: latest.verdict,
    verdictSnapshotDate: latest.date,
    priceTargetAtSnapshot: latest.priceTarget,
    daysSinceVerdict,
    outcomeClass,
  };
}

function classifyOutcome(
  verdict: ActionVerdict,
  priceTarget: number | null,
  salePrice: number,
): SaleOutcomeClass {
  switch (verdict) {
    case "SELL_NOW":
    case "LIST_HIGHER": {
      if (priceTarget === null || priceTarget <= 0) return "verdict_hit";
      const cutoff = priceTarget * (1 - VERDICT_HIT_TOLERANCE);
      return salePrice >= cutoff ? "verdict_hit" : "verdict_miss";
    }
    case "GRADE_UP":
      // If the user sold the raw card despite our GRADE_UP verdict,
      // that's data — treat as verdict_miss (we said "grade first").
      return "verdict_miss";
    case "WAIT_TO_LIST":
      // We said wait, they didn't — engine probably missed a signal.
      return "hold_sold";
    case "HOLD":
      return "hold_sold";
  }
}

export const _VERDICT_HIT_TOLERANCE = VERDICT_HIT_TOLERANCE;
