"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotInvalidationService = void 0;
class SnapshotInvalidationService {
    constructor(staleServeAllowedMinutes, ttlMap) {
        this.staleServeAllowedMinutes = staleServeAllowedMinutes;
        this.ttlMap = ttlMap;
    }
    evaluate(input) {
        if (!input.asOf) {
            return {
                isExpired: true,
                isServeableStale: false,
                ageMinutes: null,
                reason: "missing_snapshot_timestamp",
            };
        }
        const now = input.now ?? new Date();
        const ageMinutes = Math.floor((now.getTime() - new Date(input.asOf).getTime()) / 60000);
        const ttl = input.entityType === "player"
            ? this.ttlMap.player
            : this.ttlMap[input.freshnessTier ?? "cold"] ?? this.ttlMap.cold;
        const isExpired = ageMinutes > ttl;
        const isServeableStale = isExpired && ageMinutes <= ttl + this.staleServeAllowedMinutes;
        return {
            isExpired,
            isServeableStale,
            ageMinutes,
            reason: isExpired ? "ttl_expired" : "fresh",
        };
    }
}
exports.SnapshotInvalidationService = SnapshotInvalidationService;
