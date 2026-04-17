
import { CacheProvider } from "../../providers/cache/CacheProvider";
import { SnapshotInvalidationService } from "./snapshot-invalidation.service";
import { SnapshotRefreshOrchestratorService } from "./snapshot-refresh-orchestrator.service";
import { SnapshotAccessRequest } from "../../domain/snapshots/snapshot-access-request";
import { SnapshotAccessResult } from "../../domain/snapshots/snapshot-access-result";
import { SnapshotMetadata } from "../../domain/snapshots/snapshot-metadata";

/**
 * Main entry point for snapshot access with cache, invalidation, and refresh orchestration.
 */
export class SnapshotAccessService {
  constructor(
    private readonly cacheProvider: CacheProvider,
    private readonly invalidationService: SnapshotInvalidationService,
    private readonly orchestrator: SnapshotRefreshOrchestratorService,
  ) {}

  /**
   * Get a snapshot, queue refresh if stale, or trigger rebuild if missing/hard stale.
   */
  async getOrRefreshSnapshot(request: SnapshotAccessRequest): Promise<SnapshotAccessResult> {
    const { entityType, entityKey } = request;
    const cacheKey = `${entityType}:${entityKey}`;
    const snapshot = await this.cacheProvider.get(cacheKey) as (Record<string, unknown> & { metadata?: SnapshotMetadata }) | null;
    let refreshQueued = false;
    let snapshotAgeMinutes: number | null = null;
    let freshnessTier: SnapshotMetadata["freshnessTier"] | null = null;
    let confidenceScore: number | null = null;
    let sourceCount: number | null = null;
    let dataCompletenessScore: number | null = null;

    if (snapshot && snapshot.metadata) {
      const meta = snapshot.metadata;
      freshnessTier = meta.freshnessTier;
      confidenceScore = meta.confidenceScore;
      sourceCount = meta.sourceCount;
      dataCompletenessScore = meta.dataCompletenessScore;
      snapshotAgeMinutes = Math.floor((Date.now() - new Date(meta.asOf).getTime()) / 60000);
      const inv = this.invalidationService.evaluate({
        asOf: meta.asOf,
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
      } else if (inv.isServeableStale) {
        // Stale but serveable
        refreshQueued = true;
        this.orchestrator.queueRefreshRequest({
          ...request,
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
      } else {
        // Hard stale
        refreshQueued = true;
        this.orchestrator.queueRefreshRequest({
          ...request,
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
    } else {
      // Missing
      refreshQueued = true;
      this.orchestrator.queueRefreshRequest({
        ...request,
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
