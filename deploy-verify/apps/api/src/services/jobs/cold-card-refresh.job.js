"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ColdCardRefreshJob = void 0;
// Cold card scheduled refresh job
class ColdCardRefreshJob {
    async run() {
        // Load cold card keys from repository/service
        // Enqueue SnapshotRefreshRequest for each
        // Set requestedBy = "schedule", priority = "low"
    }
}
exports.ColdCardRefreshJob = ColdCardRefreshJob;
