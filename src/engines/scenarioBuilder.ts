

export interface ScenarioEvent {
  type: string;
  value: number;
}

export interface ScenarioResult {
  total: number;
  average: number;
  count: number;
}

export function buildScenario(events: ScenarioEvent[]): ScenarioResult {
  if (!events || events.length === 0) {
    return {
      total: 0,
      average: 0,
      count: 0
    };
  }

  const total = events.reduce((sum: number, event: ScenarioEvent) => {
    return sum + (event.value ?? 0);
  }, 0);

  const count = events.length;
  const average = count > 0 ? total / count : 0;

  return {
    total,
    average,
    count
  };
}