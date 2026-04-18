"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediumCardRefreshJob = void 0;
// Medium card scheduled refresh job
class MediumCardRefreshJob {
    async run() {
        // Load medium card keys from repository/service
        // Enqueue SnapshotRefreshRequest for each
        // Set requestedBy = "schedule", priority = "medium"
    }
}
exports.MediumCardRefreshJob = MediumCardRefreshJob;
