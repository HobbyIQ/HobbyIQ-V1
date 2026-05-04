import { ScenarioRunnerService } from '../../services/validation/scenario-runner.service';

describe('ScenarioRunnerService', () => {
  it('should run all scenarios', async () => {
    const runner = new ScenarioRunnerService();
    const results = await runner.runAll();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('scenario');
    expect(results[0]).toHaveProperty('pass');
  });
});
