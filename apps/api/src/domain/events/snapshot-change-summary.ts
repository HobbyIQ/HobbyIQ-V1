export interface SnapshotChangeSummary {
  changeId: string;
  entityType: "card" | "player";
  entityKey: string;
  oldSnapshotId?: string;
  newSnapshotId?: string;
  changedFieldsJson: Record<string, unknown>;
  significanceScore: number;
  generatedAt: string;
}
