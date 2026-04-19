"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BetaReadinessService = void 0;
class BetaReadinessService {
    constructor(providerHealth) {
        this.providerHealth = providerHealth;
    }
    async evaluate() {
        const status = await this.providerHealth.getStatus();
        const warnings = [];
        const blockers = [];
        const recommendedActions = [];
        if (!status.ebay.authConfigured)
            blockers.push('eBay provider not configured');
        if (!status.psa.authConfigured)
            blockers.push('PSA provider not configured');
        if (!status.redis.reachable)
            blockers.push('Redis not reachable');
        if (!status.queue.reachable)
            warnings.push('Queue not reachable');
        if (!status.encryption.keyConfigured)
            warnings.push('Encryption key not configured');
        // TODO: Add more checks for snapshot freshness, contract validation, etc.
        return {
            pass: blockers.length === 0,
            warnings,
            blockers,
            recommendedActions,
        };
    }
}
exports.BetaReadinessService = BetaReadinessService;
