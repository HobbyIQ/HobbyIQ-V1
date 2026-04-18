// Cold card scheduled refresh job
export class ColdCardRefreshJob {
  async run() {
    // Load cold card keys from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "low"
  }
}
