// Player summary scheduled refresh job
export class PlayerSummaryRefreshJob {
  async run() {
    // Load player IDs from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "medium"
  }
}
