"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAllJobs = runAllJobs;
// Mock job runner for HobbyIQ
async function runAllJobs() {
    // Simulate running background jobs
    return { status: "ok", jobsRun: ["refreshComps", "refreshSupply", "refreshPerformance"] };
}
