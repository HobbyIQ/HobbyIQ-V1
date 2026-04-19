"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DailyMarketRollupJob = void 0;
// Daily market rollup scheduled refresh job
class DailyMarketRollupJob {
    async run() {
        // Load daily market rollup keys from repository/service
        // Enqueue SnapshotRefreshRequest for each
        // Set requestedBy = "schedule", priority = "low"
    }
}
exports.DailyMarketRollupJob = DailyMarketRollupJob;
