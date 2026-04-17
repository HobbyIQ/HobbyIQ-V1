// Handles snapshot invalidation and staleness rules
export interface SnapshotInvalidationService {
  isSnapshotStale(snapshot: any): boolean;
  shouldInvalidateSnapshot(event: MarketDataEvent, snapshot: any): boolean;
}
