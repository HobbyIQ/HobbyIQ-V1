"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotDiffService = void 0;
class SnapshotDiffService {
    diff(previous, next) {
        if (!previous) {
            return {
                changedFields: { initial_build: { before: null, after: "created" } },
                significanceScore: 100,
            };
        }
        const changedFields = {};
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
exports.SnapshotDiffService = SnapshotDiffService;
