// Strong sell signal
export function evaluateStrongSellSignal(card: PortfolioCardDTO): CreateAlertInput | null {
  if (card.currentRecommendation === 'STRONG_SELL') {
    return {
      userId: card.userId,
      portfolioCardId: card.id,
      alertType: AlertType.CUSTOM,
      severity: AlertSeverity.CRITICAL,
      title: `Strong Sell Signal for ${card.player}`,
      message: `A strong sell signal was triggered for this card. Consider selling soon.`,
      metadata: { recommendation: card.currentRecommendation },
    };
  }
  return null;
}

// Strong buy opportunity
export function evaluateStrongBuyOpportunity(card: PortfolioCardDTO): CreateAlertInput | null {
  if (card.currentRecommendation === 'STRONG_BUY') {
    return {
      userId: card.userId,
      portfolioCardId: card.id,
      alertType: AlertType.CUSTOM,
      severity: AlertSeverity.INFO,
      title: `Strong Buy Opportunity for ${card.player}`,
      message: `A strong buy opportunity was detected for this card.`,
      metadata: { recommendation: card.currentRecommendation },
    };
  }
  return null;
}

// Price crossing threshold (up or down)
export function evaluatePriceThreshold(card: PortfolioCardDTO, prevValue: number | null): CreateAlertInput | null {
  if (typeof prevValue !== 'number' || typeof card.currentEstimatedValue !== 'number') return null;
  // Example: alert if price crosses $100 up or down
  if ((prevValue < 100 && card.currentEstimatedValue >= 100) || (prevValue >= 100 && card.currentEstimatedValue < 100)) {
    return {
      userId: card.userId,
      portfolioCardId: card.id,
      alertType: AlertType.CUSTOM,
      severity: AlertSeverity.WARNING,
      title: `Price threshold crossed for ${card.player}`,
      message: `Card value crossed $100: now $${card.currentEstimatedValue}.`,
      metadata: { prev: prevValue, current: card.currentEstimatedValue },
    };
  }
  return null;
}
// Alerts Engine rules for alert evaluation
import { PortfolioCardDTO } from "../portfolio/types";
import { WatchlistItem, AlertType, AlertSeverity } from "@prisma/client";
import { Recommendation } from "@prisma/client";
import { CreateAlertInput } from "./types";

export function evaluateBuyTargetBreach(card: PortfolioCardDTO, watchlistItem: WatchlistItem | null): CreateAlertInput | null {
  if (!watchlistItem?.targetBuyPrice || card.currentEstimatedValue >= watchlistItem.targetBuyPrice) return null;
  return {
    userId: card.userId,
    portfolioCardId: card.id,
    alertType: AlertType.BUY_TARGET_BREACH,
    severity: AlertSeverity.INFO,
    title: `Buy target reached for ${card.player}`,
    message: `Current value $${card.currentEstimatedValue} is below your target buy price $${watchlistItem.targetBuyPrice}.`,
    metadata: { current: card.currentEstimatedValue, target: watchlistItem.targetBuyPrice },
    // Timestamp will be set by DB
  };
}

export function evaluateSellTargetBreach(card: PortfolioCardDTO, watchlistItem: WatchlistItem | null): CreateAlertInput | null {
  if (!watchlistItem?.targetSellPrice || card.currentEstimatedValue <= watchlistItem.targetSellPrice) return null;
  return {
    userId: card.userId,
    portfolioCardId: card.id,
    alertType: AlertType.SELL_TARGET_BREACH,
    severity: AlertSeverity.INFO,
    title: `Sell target reached for ${card.player}`,
    message: `Current value $${card.currentEstimatedValue} is above your target sell price $${watchlistItem.targetSellPrice}.`,
    metadata: { current: card.currentEstimatedValue, target: watchlistItem.targetSellPrice },
    // Timestamp will be set by DB
  };
}

export function evaluateRecommendationShift(card: PortfolioCardDTO, prevRecommendation: string): CreateAlertInput | null {
  if (card.currentRecommendation !== prevRecommendation) {
    // High-severity for strong buy/sell
    if (card.currentRecommendation === 'STRONG_SELL' || card.currentRecommendation === 'STRONG_BUY') {
      return {
        userId: card.userId,
        portfolioCardId: card.id,
        alertType: AlertType.RECOMMENDATION_SHIFT,
        severity: AlertSeverity.CRITICAL,
        title: `Recommendation changed: ${prevRecommendation} → ${card.currentRecommendation} for ${card.player}`,
        message: `Recommendation changed from ${prevRecommendation} to ${card.currentRecommendation}.`,
        metadata: { prev: prevRecommendation, next: card.currentRecommendation },
      };
    }
    // Default moderate severity for other rec changes
    return {
      userId: card.userId,
      portfolioCardId: card.id,
      alertType: AlertType.RECOMMENDATION_SHIFT,
      severity: AlertSeverity.WARNING,
      title: `Recommendation changed for ${card.player}`,
      message: `Recommendation changed from ${prevRecommendation} to ${card.currentRecommendation}.`,
      metadata: { prev: prevRecommendation, next: card.currentRecommendation },
    };
  }
  return null;
}

// --- Additional rules ---

// Negative pressure spike
export function evaluateNegativePressureSpike(card: PortfolioCardDTO): CreateAlertInput | null {
  if (typeof card.negativePressureScore === 'number' && card.negativePressureScore >= 70) {
    return {
      userId: card.userId,
      portfolioCardId: card.id,
      alertType: AlertType.CUSTOM,
      severity: AlertSeverity.CRITICAL,
      title: `Negative pressure spike for ${card.player}`,
      message: `Market signals indicate strong negative pressure (score: ${card.negativePressureScore}). Consider risk.`,
      metadata: { negativePressureScore: card.negativePressureScore },
    };
  }
  return null;
}

// Strong momentum signal
export function evaluateStrongMomentum(card: PortfolioCardDTO): CreateAlertInput | null {
  if (typeof card.marketMomentumScore === 'number' && card.marketMomentumScore >= 80) {
    return {
      userId: card.userId,
      portfolioCardId: card.id,
      alertType: AlertType.CUSTOM,
      severity: AlertSeverity.INFO,
      title: `Strong momentum for ${card.player}`,
      message: `Momentum signals are very strong (score: ${card.marketMomentumScore}).`,
      metadata: { marketMomentumScore: card.marketMomentumScore },
    };
  }
  return null;
}
// Add more rules as needed for risk spike, momentum breakout, etc.
