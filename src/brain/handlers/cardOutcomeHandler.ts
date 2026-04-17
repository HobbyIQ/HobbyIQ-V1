
import { buildScenarios } from '../../services/prediction/scenarioBuilder';
import { formatCardOutcomeViewModel } from '../formatters/cardOutcomeViewModel';
import { getPerformanceImpact } from '../../services/marketImpact/performanceImpactEngine';
import { getRankingImpact } from '../../services/marketImpact/rankingImpactEngine';
import { getAwardsImpact } from '../../services/marketImpact/awardsImpactEngine';
import { getHobbyBuzzImpact } from '../../services/marketImpact/hobbyBuzzEngine';
import { aggregateMarketImpact } from '../../services/marketImpact/marketImpactAggregator';
import { logOutcomePrediction } from '../../services/learning/outcomeLogger';

export async function cardOutcomeHandler(payload: any) {
  // Build scenarios
  const scenariosResult = buildScenarios(payload);
  // Market Impact Layer (mocked inputs for now)
  const perfImpact = getPerformanceImpact(payload?.stats || null);
  const rankingImpact = getRankingImpact(payload?.rankingData || null);
  const awardsImpact = getAwardsImpact(payload?.awardsData || null);
  const hobbyBuzzImpact = getHobbyBuzzImpact(payload?.hobbyBuzzData || null);
  const marketImpact = aggregateMarketImpact([
    perfImpact,
    rankingImpact,
    awardsImpact,
    hobbyBuzzImpact
  ]);
  // Log prediction
  logOutcomePrediction({ input: payload, ...scenariosResult, marketImpact, timestamp: new Date().toISOString() });
  // Format for frontend
  return formatCardOutcomeViewModel(payload, { ...scenariosResult, marketImpact });
}
