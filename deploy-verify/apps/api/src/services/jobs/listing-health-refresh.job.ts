// Listing health scheduled refresh job
export class ListingHealthRefreshJob {
  async run() {
    // Load listing health keys from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "medium"
  }
}
