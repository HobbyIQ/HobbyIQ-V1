// Ranking Impact Engine
// Detects recent ranking movement or rank-based market influence
import { MarketImpactSignal } from './types';

export function getRankingImpact(rankingData: any): MarketImpactSignal {
  if (!rankingData) {
    return {
      type: 'ranking_neutral',
      direction: 'neutral',
      score: 0,
      impactWeight: 0,
      reason: 'No ranking data',
    };
  }
  if (rankingData.rankingChange > 0) {
    return {
      type: 'ranking_up',
      direction: 'positive',
      score: 6,
      impactWeight: 0.5,
      reason: 'Player ranking improved',
    };
  }
  if (rankingData.rankingChange < 0) {
    return {
      type: 'ranking_down',
      direction: 'negative',
      score: 6,
      impactWeight: 0.5,
      reason: 'Player ranking dropped',
    };
  }
  return {
    type: 'ranking_neutral',
    direction: 'neutral',
    score: 2,
    impactWeight: 0.2,
    reason: 'No recent ranking movement',
  };
}
