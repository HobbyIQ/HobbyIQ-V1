// CatalystTrackerService: Tracks catalysts for player cards
import type { CatalystTracker } from "../../../types/marketDecision";

export function buildCatalystTracker(context: any): CatalystTracker {
  // TODO: Use real catalyst data
  return {
    nextCatalysts: [
      {
        category: "promotion",
        label: "Possible MLB call-up",
        direction: "positive",
        importance: 9,
        timeframe: "near_term",
        note: "Player is performing well in AAA."
      }
    ],
    overallCatalystOutlook: "positive",
    summary: "Strong promotion and performance catalysts in the near term."
  };
}
