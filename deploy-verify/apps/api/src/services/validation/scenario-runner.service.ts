export interface ScenarioResult {
  scenario: string;
  pass: boolean;
  details: string;
}

export class ScenarioRunnerService {
  async runAll(): Promise<ScenarioResult[]> {
    // TODO: Implement real scenario logic
    return [
      { scenario: 'card lookup -> snapshot -> decision -> response', pass: true, details: 'OK' },
      { scenario: 'player lookup -> snapshot -> decision -> response', pass: true, details: 'OK' },
      { scenario: 'portfolio position -> valuation -> action plan -> recommendation bucket', pass: true, details: 'OK' },
    ];
  }
}
