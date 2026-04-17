// src/domain/snapshots/snapshot-access-result.ts
import { SnapshotMetadata } from "./snapshot-metadata";

export interface SnapshotAccessResult {
  snapshot: Record<string, unknown> | null;
  refreshQueued: boolean;
  snapshotAgeMinutes: number | null;
  freshnessTier: SnapshotMetadata["freshnessTier"] | null;
  confidenceScore: number | null;
  sourceCount: number | null;
  dataCompletenessScore: number | null;
}
