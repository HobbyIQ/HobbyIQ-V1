"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.E2EValidationService = void 0;
const scenario_runner_service_1 = require("./scenario-runner.service");
class E2EValidationService {
    constructor(scenarioRunner = new scenario_runner_service_1.ScenarioRunnerService()) {
        this.scenarioRunner = scenarioRunner;
    }
    async run() {
        return this.scenarioRunner.runAll();
    }
}
exports.E2EValidationService = E2EValidationService;
