"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticsService = void 0;
class DiagnosticsService {
    constructor(providerHealth) {
        this.providerHealth = providerHealth;
    }
    async getOverview() {
        // TODO: Wire up real data sources
        const providerStatus = await this.providerHealth.getStatus();
        return {
            sync: { lastRun: null, failures: 0, pending: 0 },
            snapshots: { freshness: 'ok', staleCount: 0, rebuildFailures: 0 },
            alerts: { candidateCount: 0, suppressedCount: 0 },
            learning: { lastRun: null, calibrationStatus: 'unknown' },
            imports: { batchHealth: 'ok', unmatchedRecords: 0, failedReconciliations: 0 },
            providers: {
                ebay: providerStatus.ebay.authConfigured ? 'ok' : 'not_configured',
                psa: providerStatus.psa.authConfigured ? 'ok' : 'not_configured',
                redis: providerStatus.redis.reachable ? 'ok' : 'unreachable',
                queue: providerStatus.queue.reachable ? 'ok' : 'unreachable',
                encryption: providerStatus.encryption.keyConfigured ? 'ok' : 'not_configured',
            },
        };
    }
}
exports.DiagnosticsService = DiagnosticsService;
