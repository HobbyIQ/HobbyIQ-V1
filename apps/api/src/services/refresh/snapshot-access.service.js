"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotAccessService = void 0;
/**
 * Main entry point for snapshot access with cache, invalidation, and refresh orchestration.
 */
class SnapshotAccessService {
    constructor(cacheProvider, invalidationService, orchestrator) {
        this.cacheProvider = cacheProvider;
        this.invalidationService = invalidationService;
        this.orchestrator = orchestrator;
    }
    /**
     * Get a snapshot, queue refresh if stale, or trigger rebuild if missing/hard stale.
     */
    async getOrRefreshSnapshot(request) {
        const { entityType, entityKey } = request;
        const cacheKey = `${entityType}:${entityKey}`;
        const snapshot = await this.cacheProvider.get(cacheKey);
        let refreshQueued = false;
        let snapshotAgeMinutes = null;
        let freshnessTier = null;
        let confidenceScore = null;
        let sourceCount = null;
        let dataCompletenessScore = null;
        if (snapshot && snapshot.metadata) {
            const meta = snapshot.metadata;
            freshnessTier = meta.freshnessTier;
            confidenceScore = meta.confidenceScore;
            sourceCount = meta.sourceCount;
            dataCompletenessScore = meta.dataCompletenessScore;
            snapshotAgeMinutes = Math.floor((Date.now() - new Date(meta.asOf).getTime()) / 60000);
            const inv = this.invalidationService.evaluate({
                asOf: typeof meta.asOf === 'string' ? meta.asOf : meta.asOf.toISOString(),
                entityType,
                freshnessTier: meta.freshnessTier,
            });
            if (!inv.isExpired) {
                // Fresh
                return {
                    snapshot,
                    refreshQueued: false,
                    snapshotAgeMinutes,
                    freshnessTier,
                    confidenceScore,
                    sourceCount,
                    dataCompletenessScore,
                };
            }
            else if (inv.isServeableStale) {
                // Stale but serveable
                refreshQueued = true;
                this.orchestrator.handle({
                    ...request,
                    requestId: (globalThis.crypto?.randomUUID?.() || require('crypto').randomUUID()),
                    requestedAt: new Date().toISOString(),
                    priority: "medium",
                    forceRefresh: false,
                    requestedBy: request.requestedBy || "system",
                    reasonCodes: request.reasonCodes || ["stale_but_serveable"],
                });
                return {
                    snapshot,
                    refreshQueued,
                    snapshotAgeMinutes,
                    freshnessTier,
                    confidenceScore,
                    sourceCount,
                    dataCompletenessScore,
                };
            }
            else {
                // Hard stale
                refreshQueued = true;
                this.orchestrator.handle({
                    ...request,
                    requestId: (globalThis.crypto?.randomUUID?.() || require('crypto').randomUUID()),
                    requestedAt: new Date().toISOString(),
                    priority: "high",
                    forceRefresh: true,
                    requestedBy: request.requestedBy || "system",
                    reasonCodes: request.reasonCodes || ["hard_stale"],
                });
                return {
                    snapshot: null,
                    refreshQueued,
                    snapshotAgeMinutes,
                    freshnessTier,
                    confidenceScore,
                    sourceCount,
                    dataCompletenessScore,
                };
            }
        }
        else {
            // Missing
            refreshQueued = true;
            this.orchestrator.handle({
                ...request,
                requestId: (globalThis.crypto?.randomUUID?.() || require('crypto').randomUUID()),
                requestedAt: new Date().toISOString(),
                priority: "high",
                forceRefresh: true,
                requestedBy: request.requestedBy || "system",
                reasonCodes: request.reasonCodes || ["missing"],
            });
            return {
                snapshot: null,
                refreshQueued,
                snapshotAgeMinutes: null,
                freshnessTier: null,
                confidenceScore: null,
                sourceCount: null,
                dataCompletenessScore: null,
            };
        }
    }
}
exports.SnapshotAccessService = SnapshotAccessService;
