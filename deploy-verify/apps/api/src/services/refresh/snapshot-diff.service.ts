export interface SnapshotDiffResult {
  changedFields: Record<string, { before: unknown; after: unknown }>;
  significanceScore: number;
}

export class SnapshotDiffService {
  diff(previous: Record<string, unknown> | null, next: Record<string, unknown>): SnapshotDiffResult {
    if (!previous) {
      return {
        changedFields: { initial_build: { before: null, after: "created" } },
        significanceScore: 100,
      };
    }

    const changedFields: Record<string, { before: unknown; after: unknown }> = {};

    for (const [key, value] of Object.entries(next)) {
      const before = previous[key];
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        changedFields[key] = { before, after: value };
      }
    }

    const significanceScore = Math.min(100, Object.keys(changedFields).length * 10);

    return { changedFields, significanceScore };
  }
}
