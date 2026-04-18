"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalystRefreshJob = void 0;
// Catalyst scheduled refresh job
class CatalystRefreshJob {
    async run() {
        // Load catalyst event keys from repository/service
        // Enqueue SnapshotRefreshRequest for each
        // Set requestedBy = "schedule", priority = "high"
    }
}
exports.CatalystRefreshJob = CatalystRefreshJob;
