import { SnapshotChangeSummary } from "../domain/events/snapshot-change-summary";

export interface SnapshotChangeSummaryRepository {
  save(summary: SnapshotChangeSummary): Promise<void>;
}
