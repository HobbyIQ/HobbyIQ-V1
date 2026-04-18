
import { validateCompIQRequest } from "../../shared/validation";
import { getParallelMultiplier, normalizeParallel } from "../../shared/parallels";
import { generateConfidenceScore, getConfidenceLabel } from "../../shared/confidence";
import { generateExplanation } from "../../shared/explanation";
import type { CompIQRequest, CompIQResponse } from "../../shared/types";
import { getEbaySupplySnapshot } from "../../shared/ebaySupply";

import { computePriceBands } from "../../services/marketIntel/pricingZone";
import { computeSupplyDemandTrends } from "../../services/marketIntel/supplyDemandTrend";
import { buildMarketLadder } from "../../services/marketIntel/marketLadder";
import { findBuyOpportunities } from "../../services/marketIntel/buyOpportunity";
import type { MarketPriceBands, SupplyDemandWindow, MarketLadderRung, BuyOpportunity, RecentComp, MarketSignals, CompCalculationContext } from "../../types/marketIntel";
import { generateAiThesis } from "../../services/marketIntel/decision/thesisEngine";
import { assessRisks } from "../../services/marketIntel/decision/riskAssessment";
import { buildEntryExitPlan } from "../../services/marketIntel/decision/entryExitPlan";
import { gradeCompQuality } from "../../services/marketIntel/decision/compQuality";
import { buildTimeHorizonViews } from "../../services/marketIntel/decision/timeHorizon";
import { buildLiquidityProfile, buildLiquidityLadder } from "../../services/marketIntel/decision/liquidityAnalysis";
import { classifyMarketTemperature } from "../../services/marketIntel/decision/marketTemperature";
import { validateGuardrails } from "../../services/marketIntel/decision/guardrails";
import { assessListingQuality } from "../../services/marketIntel/decision/listingQuality";
import { buildActionPlan } from "../../services/marketIntel/decision/actionPlan";
import type { CompIQDecisionExtension } from "../../types/marketDecision";


export async function handleCompIQLiveEstimate(input: CompIQRequest): Promise<any> {
  validateCompIQRequest(input);
  // parseCardQuery is not available; use input.query directly or provide a stub
  const parsed = { player: '', cardSet: '', parallel: '', isAuto: false, productFamily: '' };
  const parallelMultiplier = getParallelMultiplier(parsed.parallel);
  const normalizedParallel = normalizeParallel(parsed.parallel);
  // Simulate price logic (replace with real data source)
  const basePrice = 100; // fallback base price
  const rawPrice = basePrice * parallelMultiplier;
  const adjustedRaw = rawPrice * (parsed.isAuto ? 1.2 : 1);
  const estimatedPsa9 = adjustedRaw * 1.5;
  const estimatedPsa10 = adjustedRaw * 2.2;
  const confidenceScore = generateConfidenceScore(parsed, rawPrice);
  const confidenceLabel = getConfidenceLabel(confidenceScore);
  const explanation = generateExplanation(parsed, confidenceScore);
  const warnings: string[] = [];
  if (!parsed.player) warnings.push("Player not detected");
  if (!parsed.cardSet) warnings.push("Set not detected");
  const nextActions = ["Verify card details", "Check recent sales"];

  // eBay supply intelligence for this card/parallel
  const ebaySupply = await getEbaySupplySnapshot(parsed.player, parsed.cardSet, parsed.parallel);

  // Compose calculation context for market intelligence
  const calcContext: CompCalculationContext = {
    weightedMedian: rawPrice,
    weightedAverage: rawPrice,
    compCount: 5,
    minComp: rawPrice * 0.9,
    maxComp: rawPrice * 1.1,
    liquidityScore: 0.7,
    confidenceScore,
    marketTrend: "flat",
    listings: [
      { title: "Sample Comp 1", price: rawPrice * 0.95, url: "#" },
      { title: "Sample Comp 2", price: rawPrice * 1.05, url: "#" }
    ],
    priceBands: {
      quickExitPrice: rawPrice * 0.9,
      fairMarketValue: rawPrice,
      buyZoneLow: rawPrice * 0.85,
      buyZoneHigh: rawPrice * 0.97,
      holdZoneLow: rawPrice * 0.97,
      holdZoneHigh: rawPrice * 1.07,
      sellZoneLow: rawPrice * 1.07,
      sellZoneHigh: rawPrice * 1.18,
      stretchAsk: rawPrice * 1.25
    },
    cardKey: `${parsed.player || "unknown"}-${parsed.cardSet || "unknown"}-${parsed.parallel || "base"}`
  };

  // Compute market intelligence
  const pricingBands: MarketPriceBands = computePriceBands(calcContext);
  const supplyDemandTrends: SupplyDemandWindow[] = computeSupplyDemandTrends(calcContext);
  const marketLadder: MarketLadderRung[] = buildMarketLadder(calcContext);
  const goodBuys: BuyOpportunity[] = findBuyOpportunities({ ...calcContext, priceBands: pricingBands });
  const recentComps: RecentComp[] = [
    {
      date: new Date().toISOString(),
      title: "Sample Comp 1",
      price: rawPrice * 0.95,
      grade: "Raw",
      source: "eBay",
      listingType: "auction",
      acceptedOfferKnown: false,
      weight: 1,
      normalized: true
    },
    {
      date: new Date().toISOString(),
      title: "Sample Comp 2",
      price: rawPrice * 1.05,
      grade: "Raw",
      source: "eBay",
      listingType: "bin",
      acceptedOfferKnown: false,
      weight: 1,
      normalized: true
    }
  ];
  const calculation = {
    weightedMedian: rawPrice,
    weightedAverage: rawPrice,
    compCount: 5,
    minComp: rawPrice * 0.9,
    maxComp: rawPrice * 1.1,
    methodologyNotes: ["Demo calculation. Replace with real comp logic."]
  };
  const marketSignals: MarketSignals = {
    liquidityScore: 0.7,
    confidenceScore,
    marketTrend: "flat",
    supplyTrend2Weeks: "flat",
    supplyTrend4Weeks: "flat",
    supplyTrend3Months: "flat",
    demandTrend2Weeks: "flat",
    demandTrend4Weeks: "flat",
    demandTrend3Months: "flat",
    explanation: ["Demo signals. Replace with real logic."]
  };

  // Advanced decision intelligence extension
  const decisionExtension: CompIQDecisionExtension = {
    aiThesis: generateAiThesis(calcContext),
    riskPanel: assessRisks(calcContext),
    entryExitPlan: buildEntryExitPlan({ ...calcContext, priceBands: pricingBands }),
    compQuality: gradeCompQuality(calcContext),
    timeHorizonViews: buildTimeHorizonViews({ ...calcContext, priceBands: pricingBands }),
    liquidityProfile: buildLiquidityProfile(calcContext),
    liquidityLadder: buildLiquidityLadder(calcContext),
    marketTemperature: classifyMarketTemperature(calcContext),
    guardrailFlags: validateGuardrails(calcContext),
    listingQualityAssessments: (goodBuys || []).map(l => assessListingQuality(l)),
    actionPlan: buildActionPlan(calcContext)
  };

  return {
    success: true,
    player: parsed.player || null,
    cardSet: parsed.cardSet || null,
    productFamily: parsed.productFamily || null,
    parallel: parsed.parallel || null,
    normalizedParallel,
    isAuto: parsed.isAuto,
    rawPrice,
    adjustedRaw,
    estimatedPsa9,
    estimatedPsa10,
    confidenceScore,
    confidenceLabel,
    explanation,
    warnings,
    nextActions,
    ebaySupply,
    pricingBands,
    marketSignals,
    marketLadder,
    supplyDemandTrends,
    goodBuys,
    recentComps,
    calculation,
    ...decisionExtension
  };
}
