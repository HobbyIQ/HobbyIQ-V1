// Medium card scheduled refresh job
export class MediumCardRefreshJob {
  async run() {
    // Load medium card keys from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "medium"
  }
}
