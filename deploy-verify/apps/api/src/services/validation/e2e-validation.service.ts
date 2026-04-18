import { ScenarioRunnerService, ScenarioResult } from './scenario-runner.service';

export class E2EValidationService {
  constructor(private scenarioRunner: ScenarioRunnerService = new ScenarioRunnerService()) {}

  async run(): Promise<ScenarioResult[]> {
    return this.scenarioRunner.runAll();
  }
}
