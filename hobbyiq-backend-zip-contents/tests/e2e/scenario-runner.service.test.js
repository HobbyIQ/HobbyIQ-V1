"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const scenario_runner_service_1 = require("../../services/validation/scenario-runner.service");
describe('ScenarioRunnerService', () => {
    it('should run all scenarios', async () => {
        const runner = new scenario_runner_service_1.ScenarioRunnerService();
        const results = await runner.runAll();
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toHaveProperty('scenario');
        expect(results[0]).toHaveProperty('pass');
    });
});
