"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotPriorityService = void 0;
// Priority policy for snapshot refreshes
class SnapshotPriorityService {
    getCardPriority(cardKey, context) {
        // Expandable: hot cards, manual, etc.
        if (context?.manual)
            return "high";
        if (context?.hot)
            return "high";
        if (context?.frequent)
            return "medium";
        return "low";
    }
    getPlayerPriority(playerId, context) {
        if (context?.manual)
            return "high";
        if (context?.hot)
            return "high";
        if (context?.frequent)
            return "medium";
        return "low";
    }
}
exports.SnapshotPriorityService = SnapshotPriorityService;
