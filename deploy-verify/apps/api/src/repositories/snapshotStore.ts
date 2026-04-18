export interface SnapshotStore {
  getLatest(entityType: "card" | "player", entityKey: string): Promise<Record<string, unknown> | null>;
  saveResult(result: Record<string, unknown>): Promise<void>;
  saveSnapshotJson?(
    entityType: "card" | "player",
    entityKey: string,
    snapshotId: string,
    snapshotJson: Record<string, unknown>
  ): Promise<void>;
}
