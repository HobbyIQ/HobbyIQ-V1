"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaleServePolicyService = void 0;
class StaleServePolicyService {
    static shouldServeStale(lastUpdated, maxAgeMinutes) {
        const updated = new Date(lastUpdated).getTime();
        const now = Date.now();
        return now - updated < maxAgeMinutes * 60 * 1000;
    }
}
exports.StaleServePolicyService = StaleServePolicyService;
