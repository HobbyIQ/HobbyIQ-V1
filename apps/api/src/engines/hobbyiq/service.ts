// Orchestration service for unified HobbyIQ analysis
import { runDecisionEngine } from "../decision/service";
import { runSellIQ } from "../selliq/service";
// Import other engines as needed

export interface HobbyIQAnalysisInput {
  player?: string;
  cardDetails?: any;
  compData?: any;
  playerScoreData?: any;
  dailyPerformanceData?: any;
  supplyScarcityData?: any;
  costBasis?: number;
  // Add more as needed
}

export interface HobbyIQAnalysisOutput {
  pricingOutput?: any;
  negativePressureOutput?: any;
  decisionOutput?: any;
  sellOutput?: any;
  summary: string;
}

export async function runHobbyIQAnalysis(input: HobbyIQAnalysisInput): Promise<HobbyIQAnalysisOutput> {
  // 1. Run pricing engine (CompIQ)
  let pricingOutput: any = null;
  try {
    // pricingOutput = await runCompIQ(input.compData); // Placeholder
    pricingOutput = { fmv: 120, trend: 0.1, details: "Sample pricing output" };
  } catch (e) {
    pricingOutput = { error: "Pricing unavailable" };
  }

  // 2. Run negative pressure engine
  let negativePressureOutput: any = null;
  try {
    // negativePressureOutput = await runNegativePressure(input);
    negativePressureOutput = { score: 18, details: "Sample negative pressure output" };
  } catch (e) {
    negativePressureOutput = { error: "Negative pressure unavailable" };
  }

  // 3. Run decision engine
  let decisionOutput: any = null;
  try {
    decisionOutput = runDecisionEngine({
      compIQ: pricingOutput?.fmv || 0,
      playerIQ: input.playerScoreData?.playerIQ || 50,
      dailyIQ: input.dailyPerformanceData?.dailyIQ || 50,
      supplyScore: input.supplyScarcityData?.supplyScore || 50,
      scarcityScore: input.supplyScarcityData?.scarcityScore || 50,
      liquidityScore: pricingOutput?.liquidityScore || 50,
      negativePressureScore: negativePressureOutput?.score || 0,
      pricingTrend: pricingOutput?.trend || 0
    });
  } catch (e) {
    decisionOutput = { error: "Decision engine unavailable" };
  }

  // 4. Run SellIQ
  let sellOutput: any = null;
  try {
    sellOutput = runSellIQ({
      currentFMV: pricingOutput?.fmv || 0,
      riskAdjustedFMV: pricingOutput?.fmv || 0,
      quickExitFMV: pricingOutput?.fmv ? pricingOutput.fmv * 0.9 : 0,
      compTrendPercent: (pricingOutput?.trend || 0) * 100,
      liquidityScore: pricingOutput?.liquidityScore || 50,
      activeListingCount: input.supplyScarcityData?.activeListingCount || 0,
      soldCountRecent: input.compData?.soldCountRecent || 0,
      cardTier: input.cardDetails?.tier || "mid",
      marketMomentumScore: input.compData?.marketMomentumScore || 0,
      urgencyScore: decisionOutput?.urgencyScore || 50,
      costBasis: input.costBasis,
      decisionRecommendation: decisionOutput?.recommendation,
      negativePressureScore: negativePressureOutput?.score || 0
    });
  } catch (e) {
    sellOutput = { error: "SellIQ unavailable" };
  }

  // 5. Build summary
  let summary = "";
  if (decisionOutput?.recommendation) {
    summary = `Recommended action: ${decisionOutput.recommendation.toUpperCase()}. Sell signal: ${sellOutput?.sellSignal || "-"}.`;
  } else {
    summary = "Analysis incomplete. Some modules unavailable.";
  }

  return {
    pricingOutput,
    negativePressureOutput,
    decisionOutput,
    sellOutput,
    summary
  };
}
