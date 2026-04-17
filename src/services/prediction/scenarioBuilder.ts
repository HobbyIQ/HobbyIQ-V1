import { getEventModel, EventType } from './eventModel';
import { projectPrice } from './priceProjectionEngine';

export function buildScenarios(payload: any) {
  const { currentEstimatedValue, events = [] } = payload;
  const eventModels = events.map((e: EventType) => getEventModel(e));
  // For now, one scenario per event, plus a combined scenario
  const scenarios = eventModels.map(event => {
    const { projectedValueLow, projectedValueHigh, multiplierLow, multiplierHigh, probability, timelineDays, reasoning } = projectPrice(payload, [event]);
    return {
      name: `${event.eventType.replace('_', ' ').toUpperCase()} Scenario`,
      projectedValueLow,
      projectedValueHigh,
      multiplierLow,
      multiplierHigh,
      probability,
      timelineDays,
      reasoning
    };
  });
  // Combined scenario
  if (eventModels.length > 1) {
    const { projectedValueLow, projectedValueHigh, multiplierLow, multiplierHigh, probability, timelineDays, reasoning } = projectPrice(payload, eventModels);
    scenarios.push({
      name: 'Combined Scenario',
      projectedValueLow,
      projectedValueHigh,
      multiplierLow,
      multiplierHigh,
      probability,
      timelineDays,
      reasoning
    });
  }
  // Summary
  const bestCase = Math.max(...scenarios.map(s => s.projectedValueHigh));
  const worstCase = Math.min(...scenarios.map(s => s.projectedValueLow));
  const mostLikely = Math.round(scenarios.reduce((sum, s) => sum + s.projectedValueLow * s.probability, 0) / scenarios.length);
  return {
    scenarios,
    summary: {
      currentValue: currentEstimatedValue,
      bestCase,
      worstCase,
      mostLikely
    }
  };
}
