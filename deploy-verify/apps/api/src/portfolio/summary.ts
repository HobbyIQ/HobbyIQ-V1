import { PortfolioCardDTO, PortfolioSummary } from "./types";
import { Recommendation } from "@prisma/client";

export function buildPortfolioSummary(cards: PortfolioCardDTO[]): PortfolioSummary {
  if (!cards || !Array.isArray(cards) || cards.length === 0) {
    return {
      totalMarketValue: 0,
      totalCostBasis: 0,
      totalGainLossDollar: 0,
      totalGainLossPercent: 0,
      numCards: 0,
      recommendationCounts: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
      topGainers: [],
      highestRisk: [],
      highestConviction: [],
      allocation: {}
    };
  }
  const totalMarketValue = cards.reduce((sum, c) => sum + (c.currentEstimatedValue || 0), 0);
  const totalCostBasis = cards.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);
  const totalGainLossDollar = totalMarketValue - totalCostBasis;
  const totalGainLossPercent = totalCostBasis ? (totalGainLossDollar / totalCostBasis) * 100 : 0;
  const numCards = cards.length;
  const recommendationCounts = {
    strongBuy: cards.filter(c => c.currentRecommendation === Recommendation.STRONG_BUY).length,
    buy: cards.filter(c => c.currentRecommendation === Recommendation.BUY).length,
    hold: cards.filter(c => c.currentRecommendation === Recommendation.HOLD).length,
    sell: cards.filter(c => c.currentRecommendation === Recommendation.SELL).length,
    strongSell: cards.filter(c => c.currentRecommendation === Recommendation.STRONG_SELL).length
  };
  // Top gainers: top 3 by gainLossDollar
  const topGainers = [...cards].sort((a, b) => (b.gainLossDollar || 0) - (a.gainLossDollar || 0)).slice(0, 3);
  // Highest risk: top 3 by negativePressureScore
  const highestRisk = [...cards].sort((a, b) => (b.negativePressureScore || 0) - (a.negativePressureScore || 0)).slice(0, 3);
  // Highest conviction: top 3 by currentConfidenceScore
  const highestConviction = [...cards].sort((a, b) => (b.currentConfidenceScore || 0) - (a.currentConfidenceScore || 0)).slice(0, 3);
  // Allocation breakdowns (by player, risk tier, auto, graded)
  const allocation: Record<string, any> = {
    byPlayer: groupBy(cards, c => c.player),
    byRisk: groupBy(cards, c => riskTier(c)),
    byAuto: groupBy(cards, c => c.isAuto ? "auto" : "non-auto"),
    byGraded: groupBy(cards, c => c.gradeCompany ? "graded" : "raw")
  };
  return {
    totalMarketValue,
    totalCostBasis,
    totalGainLossDollar,
    totalGainLossPercent,
    numCards,
    recommendationCounts,
    topGainers,
    highestRisk,
    highestConviction,
    allocation
  };
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const key = fn(item) || "unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

function riskTier(card: PortfolioCardDTO): string {
  if ((card.negativePressureScore || 0) > 70) return "high";
  if ((card.negativePressureScore || 0) > 40) return "medium";
  return "low";
}
