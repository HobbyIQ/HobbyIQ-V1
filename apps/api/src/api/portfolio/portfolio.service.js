"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioService = void 0;
// Compose all portfolio services here for controller use
class PortfolioService {
    constructor(position, metrics, allocation, exposure, summary, decision, actionPlan, importService) {
        this.position = position;
        this.metrics = metrics;
        this.allocation = allocation;
        this.exposure = exposure;
        this.summary = summary;
        this.decision = decision;
        this.actionPlan = actionPlan;
        this.importService = importService;
    }
}
exports.PortfolioService = PortfolioService;
