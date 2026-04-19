"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DedupeMergeService = void 0;
class DedupeMergeService {
    static shouldMerge(existing, incoming) {
        // Example: merge if entityKey matches exactly
        return existing && existing.entityKey === incoming.rawJson.entityKey;
    }
}
exports.DedupeMergeService = DedupeMergeService;
