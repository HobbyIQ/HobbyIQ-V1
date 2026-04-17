// Hot card scheduled refresh job
export class HotCardRefreshJob {
  async run() {
    // Load hot card keys from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "high"
  }
}
