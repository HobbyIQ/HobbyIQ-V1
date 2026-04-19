
import { getEventModel, EventType } from './eventModel';
import { projectPrice } from './priceProjectionEngine';

export interface Scenario {
  name: string;
  projectedValueLow: number;
  projectedValueHigh: number;
  multiplierLow: number;
  multiplierHigh: number;
  probability: number;
  timelineDays: number;
  reasoning: string;
}

export interface ScenariosSummary {
  currentValue: number;
  bestCase: number;
  worstCase: number;
  mostLikely: number;
}

export interface BuildScenariosResult {
  scenarios: Scenario[];
  summary: ScenariosSummary;
}

interface ScenarioPayload {
  currentEstimatedValue: number;
  events?: EventType[];
  [key: string]: any;
}

export function buildScenarios(payload: ScenarioPayload): BuildScenariosResult {
  const { currentEstimatedValue, events = [] } = payload;
  const eventModels = events.map((e: EventType) => getEventModel(e));
  // For now, one scenario per event, plus a combined scenario
  const scenarios: Scenario[] = eventModels.map(event => {
    const { projectedValueLow, projectedValueHigh, multiplierLow, multiplierHigh, probability, timelineDays, reasoning } = projectPrice(payload, [event]);
    return {
      name: `${event.eventType.replace('_', ' ').toUpperCase()} Scenario`,
      projectedValueLow,
      projectedValueHigh,
      multiplierLow,
      multiplierHigh,
      probability,
      timelineDays,
      reasoning: Array.isArray(reasoning) ? reasoning.join('; ') : reasoning
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
      reasoning: Array.isArray(reasoning) ? reasoning.join('; ') : reasoning
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
