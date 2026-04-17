// Catalyst scheduled refresh job
export class CatalystRefreshJob {
  async run() {
    // Load catalyst event keys from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "high"
  }
}
