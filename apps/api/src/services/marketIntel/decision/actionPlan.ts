// ActionPlanService: Produces concise action plan summary
import type { ActionPlan } from "../../../types/marketDecision";

export function buildActionPlan(context: any): ActionPlan {
  // TODO: Use real context and recommendations
  return {
    bestBuyNow: "Gold Auto Raw",
    bestHold: "Base Auto PSA 10",
    bestSellOrTrim: "Base Auto Raw",
    why: ["Gold auto is undervalued vs FMV.", "Base auto PSA 10 is a stable hold."],
    risk: ["Thin market for gold parallels."],
    nextCatalystToWatch: "Possible MLB call-up",
    summary: "Gold auto is the best buy now due to FMV discount and catalyst timing."
  };
}
