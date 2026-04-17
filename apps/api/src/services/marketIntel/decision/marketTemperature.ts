// MarketTemperatureService: Classifies market temperature
import type { MarketTemperature } from "../../../types/marketDecision";

export function classifyMarketTemperature(context: any): MarketTemperature {
  // TODO: Use real trend and supply/demand data
  return {
    label: "warming",
    score: 0.7,
    explanation: ["Recent price acceleration and tightening supply."]
  };
}
