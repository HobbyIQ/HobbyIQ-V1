// Awards Impact Engine
// Captures awards, recognition, all-star, player-of-week/month, etc.
import { MarketImpactSignal } from './types';

export function getAwardsImpact(awardsData: any): MarketImpactSignal {
  if (!awardsData || !awardsData.recentAwards) {
    return {
      type: 'award',
      direction: 'neutral',
      score: 0,
      impactWeight: 0,
      reason: 'No recent awards',
    };
  }
  if (awardsData.recentAwards.length > 0) {
    return {
      type: 'award',
      direction: 'positive',
      score: 7,
      impactWeight: 0.6,
      reason: `Recent award(s): ${awardsData.recentAwards.join(', ')}`,
    };
  }
  return {
    type: 'award',
    direction: 'neutral',
    score: 2,
    impactWeight: 0.2,
    reason: 'No significant recent awards',
  };
}
