"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlayerSummaryRefreshJob = void 0;
// Player summary scheduled refresh job
class PlayerSummaryRefreshJob {
    async run() {
        // Load player IDs from repository/service
        // Enqueue SnapshotRefreshRequest for each
        // Set requestedBy = "schedule", priority = "medium"
    }
}
exports.PlayerSummaryRefreshJob = PlayerSummaryRefreshJob;
