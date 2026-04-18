"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotCardRefreshJob = void 0;
// Hot card scheduled refresh job
class HotCardRefreshJob {
    async run() {
        // Load hot card keys from repository/service
        // Enqueue SnapshotRefreshRequest for each
        // Set requestedBy = "schedule", priority = "high"
    }
}
exports.HotCardRefreshJob = HotCardRefreshJob;
