// Daily market rollup scheduled refresh job
export class DailyMarketRollupJob {
  async run() {
    // Load daily market rollup keys from repository/service
    // Enqueue SnapshotRefreshRequest for each
    // Set requestedBy = "schedule", priority = "low"
  }
}
