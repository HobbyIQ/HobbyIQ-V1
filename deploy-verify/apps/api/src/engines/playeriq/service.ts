
import { validatePlayerIQRequest } from "../../shared/validation";
import type { PlayerIQRequest, PlayerIQResponse, CardMarketSnapshot, GemRateCard, TopParallelToBuy, BuyOpportunity } from "../../shared/types";
import { handleCompIQLiveEstimate } from "../compiq/service";
import { getEbaySupplySnapshot } from "../../shared/ebaySupply";

import { computePriceBands } from "../../services/marketIntel/pricingZone";
import { computeSupplyDemandTrends } from "../../services/marketIntel/supplyDemandTrend";
import { buildMarketLadder } from "../../services/marketIntel/marketLadder";
import { findBuyOpportunities } from "../../services/marketIntel/buyOpportunity";
import type { MarketPriceBands, SupplyDemandWindow, MarketLadderRung, BuyOpportunity as MarketBuyOpportunity, RecentComp, MarketSignals, CompCalculationContext } from "../../types/marketIntel";
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
import { buildCatalystTracker } from "../../services/marketIntel/decision/catalystTracker";
import { assessPortfolioFit } from "../../services/marketIntel/decision/portfolioFit";
import { buildPlayerRecommendationSet } from "../../services/marketIntel/decision/playerRecommendation";
import { classifyMarketMaturity } from "../../services/marketIntel/decision/marketMaturity";
import type { PlayerIQDecisionExtension } from "../../types/marketDecision";


export async function handlePlayerIQEvaluate(input: PlayerIQRequest): Promise<any> {
  validatePlayerIQRequest(input);
  const player = input.player.trim();
  const organization = "Sample Org";
  const level = "AAA";
  const overallScore = 82;
  const talentScore = 85;
  const marketScore = 78;
  const riskScore = 40;
  const riskLabel = riskScore > 60 ? "High" : riskScore > 30 ? "Medium" : "Low";
  const summary = `Player ${player} is a top prospect with strong market signals.`;
  const strengths = ["Power", "Plate Discipline"];
  const risks = ["Injury History"];
  const recommendation = "Buy and hold";
  const confidence = 88;

  // Compose market intelligence section
  // Example: Use CompIQ for best cards to buy, ladder, supply/demand, etc.
  const candidateCards = [
    { cardName: `${player} 1st Bowman Chrome Auto`, parallel: "Gold", isAuto: true, grade: "Raw" },
    { cardName: `${player} 1st Bowman Chrome Auto`, parallel: "Base", isAuto: true, grade: "Raw" },
    { cardName: `${player} 1st Bowman Chrome Auto`, parallel: "Gold", isAuto: true, grade: "PSA 10" },
    { cardName: `${player} 1st Bowman Chrome`, parallel: "Base", isAuto: false, grade: "Raw" }
  ];

  const topParallelsToBuy: TopParallelToBuy[] = [];
  const marketLadder: MarketLadderRung[] = [];
  const supplyDemandTrends: SupplyDemandWindow[] = [];
  const recentComps: RecentComp[] = [];
  let calculation: any = {};
  let marketSignals: MarketSignals = {
    liquidityScore: 0.7,
    confidenceScore: 0.8,
    marketTrend: "flat",
    supplyTrend2Weeks: "flat",
    supplyTrend4Weeks: "flat",
    supplyTrend3Months: "flat",
    demandTrend2Weeks: "flat",
    demandTrend4Weeks: "flat",
    demandTrend3Months: "flat",
    explanation: ["Demo signals. Replace with real logic."]
  };

  for (const card of candidateCards) {
    const query = [player, card.cardName, card.parallel, card.isAuto ? "Auto" : "", card.grade].filter(Boolean).join(" ");
    const comp = await handleCompIQLiveEstimate({ query });
    // Compose calculation context
    const calcContext: CompCalculationContext = {
      weightedMedian: comp.rawPrice,
      weightedAverage: comp.rawPrice,
      compCount: 5,
      minComp: comp.rawPrice * 0.9,
      maxComp: comp.rawPrice * 1.1,
      liquidityScore: 0.7,
      confidenceScore: comp.confidenceScore,
      marketTrend: "flat",
      listings: [
        { title: "Sample Comp 1", price: comp.rawPrice * 0.95, url: "#" },
        { title: "Sample Comp 2", price: comp.rawPrice * 1.05, url: "#" }
      ],
      priceBands: {
        quickExitPrice: comp.rawPrice * 0.9,
        fairMarketValue: comp.rawPrice,
        buyZoneLow: comp.rawPrice * 0.85,
        buyZoneHigh: comp.rawPrice * 0.97,
        holdZoneLow: comp.rawPrice * 0.97,
        holdZoneHigh: comp.rawPrice * 1.07,
        sellZoneLow: comp.rawPrice * 1.07,
        sellZoneHigh: comp.rawPrice * 1.18,
        stretchAsk: comp.rawPrice * 1.25
      },
      cardKey: `${player}-${card.cardName}-${card.parallel}`
    };
    // Market ladder, supply/demand, etc. (aggregate for player)
    marketLadder.push(...buildMarketLadder(calcContext));
    supplyDemandTrends.push(...computeSupplyDemandTrends(calcContext));
    recentComps.push({
      date: new Date().toISOString(),
      title: card.cardName,
      price: comp.rawPrice,
      grade: card.grade,
      source: "eBay",
      listingType: "auction",
      acceptedOfferKnown: false,
      weight: 1,
      normalized: true
    });
    calculation = {
      weightedMedian: comp.rawPrice,
      weightedAverage: comp.rawPrice,
      compCount: 5,
      minComp: comp.rawPrice * 0.9,
      maxComp: comp.rawPrice * 1.1,
      methodologyNotes: ["Demo calculation. Replace with real comp logic."]
    };
    // Buy opportunity logic
    let buyRating: TopParallelToBuy["buyRating"] = "Buy";
    const estimatedMarketPrice = comp.rawPrice * (1 + Math.random() * 0.15 - 0.05);
    const estimatedFairValue = comp.rawPrice;
    const valueGap = estimatedFairValue - estimatedMarketPrice;
    if (valueGap > 20) buyRating = "Strong Buy";
    else if (valueGap < -10) buyRating = "Avoid";
    else if (valueGap < 5) buyRating = "Watch";
    const liquiditySignal = "Active";
    const scarcitySignal = comp.normalizedParallel === "gold" ? "Scarce" : "Common";
    const gemRateSignal = card.grade === "PSA 10" ? "High" : "Moderate";
    const whyItsABuy = buyRating === "Strong Buy" ? "Significant value gap vs market." : buyRating === "Buy" ? "Fair value exceeds market price." : buyRating === "Watch" ? "Monitor for better entry." : "Overvalued, avoid.";
    const buyUnder = estimatedFairValue * 1.05;
    const confidence = comp.confidenceScore;
    let supply = await getEbaySupplySnapshot(player, card.cardName, card.parallel);
    let supplyPressure = supply.supplySignal;
    if (supplyPressure === "Tightening" && (buyRating === "Buy" || buyRating === "Strong Buy")) {
      buyRating = "Strong Buy";
    } else if ((supplyPressure === "Flooded" || supplyPressure === "Expanding") && buyRating === "Buy") {
      buyRating = "Watch";
    }
    if (buyRating !== "Avoid") {
      topParallelsToBuy.push({
        cardName: card.cardName,
        parallel: card.parallel,
        estimatedMarketPrice,
        estimatedFairValue,
        buyRating,
        valueGap,
        liquiditySignal,
        scarcitySignal,
        gemRateSignal,
        whyItsABuy,
        buyUnder,
        confidence,
        activeListings: supply.currentActiveListings,
        twoWeekSupplyChangePercent: supply.twoWeekSupplyChangePercent,
        supplyTrend: supply.twoWeekSupplyTrend,
        supplyPressure
      });
    }
  }

  // Player-level eBay supply snapshot
  let ebaySupplySnapshot = await getEbaySupplySnapshot(player);

  // Compose enhanced market section
  const playerMarketSection = {
    playerMarketZone: {
      action: "buy",
      buyZoneDescription: "Below FMV, strong buy zone.",
      holdZoneDescription: "Near FMV, hold zone.",
      sellZoneDescription: "Above FMV, consider selling."
    },
    bestCardsToBuyNow: topParallelsToBuy,
    playerMarketLadder: marketLadder,
    playerMarketHealth: {
      marketTrend: "flat",
      liquidity: "Good",
      supply: "Stable",
      demand: "Stable",
      downsideRisk: "Moderate",
      confidence: 0.8,
      notes: ["Demo health. Replace with real logic."]
    },
    recentCompsSupportingView: recentComps
  };

  // Advanced decision intelligence extension
  const decisionExtension: PlayerIQDecisionExtension = {
    aiThesis: generateAiThesis({ player }),
    riskPanel: assessRisks({ player }),
    catalystTracker: buildCatalystTracker({ player }),
    portfolioFit: assessPortfolioFit({ player }),
    timeHorizonViews: buildTimeHorizonViews({ player }),
    marketTemperature: classifyMarketTemperature({ player }),
    marketMaturityStage: classifyMarketMaturity({ player }),
    recommendationSet: buildPlayerRecommendationSet({ player }),
    actionPlan: buildActionPlan({ player })
  };

  return {
    success: true,
    player,
    organization,
    level,
    overallScore,
    talentScore,
    marketScore,
    riskScore,
    riskLabel,
    summary,
    strengths,
    risks,
    recommendation,
    confidence,
    ebaySupplySnapshot,
    playerMarketSection,
    ...decisionExtension
  };
}
