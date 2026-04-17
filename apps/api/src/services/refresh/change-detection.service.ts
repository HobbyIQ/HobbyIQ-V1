import { MarketDataEvent } from "../../domain/events/market-data-event";
import { RefreshPriority } from "../../domain/events/snapshot-refresh-request";
import { RefreshConfig } from "../../config/refresh.config";

export interface ChangeDetectionInput {
  event: MarketDataEvent;
  hasSnapshot: boolean;
  isExpired: boolean;
  weightedMedianChangePct?: number;
  activeSupplyChangePct?: number;
  demandRatioChangePct?: number;
  confidenceDelta?: number;
}

export interface ChangeDetectionResult {
  shouldRefresh: boolean;
  priority: RefreshPriority;
  reasonCodes: string[];
  affectedDependencies: Array<"card" | "player">;
}

export class ChangeDetectionService {
  constructor(private readonly config: RefreshConfig) {}

  evaluate(input: ChangeDetectionInput): ChangeDetectionResult {
    const reasons: string[] = [];
    const dependencies = new Set<"card" | "player">();

    if (!input.hasSnapshot) reasons.push("missing_snapshot");
    if (input.isExpired) reasons.push("snapshot_expired");

    if ((input.weightedMedianChangePct ?? 0) >= this.config.weightedMedianChangePctThreshold) {
      reasons.push("weighted_median_changed");
    }

    if ((input.activeSupplyChangePct ?? 0) >= this.config.activeSupplyChangePctThreshold) {
      reasons.push("active_supply_changed");
    }

    if ((input.demandRatioChangePct ?? 0) >= this.config.demandRatioChangePctThreshold) {
      reasons.push("demand_ratio_changed");
    }

    if ((input.confidenceDelta ?? 0) >= this.config.confidenceDeltaThreshold) {
      reasons.push("confidence_changed");
    }

    if (
      ["injury_updated", "promotion_signal", "ranking_updated", "player_stats_updated"].includes(
        input.event.eventType,
      )
    ) {
      dependencies.add("player");
    }

    if (
      ["new_sale", "listing_added", "listing_removed", "listing_price_changed"].includes(
        input.event.eventType,
      )
    ) {
      dependencies.add("card");
    }

    const shouldRefresh = reasons.length > 0 || (input.event.importanceScore ?? 0) >= 8;

    const priority: RefreshPriority =
      (input.event.importanceScore ?? 0) >= 8 || reasons.includes("missing_snapshot")
        ? "high"
        : reasons.length > 0
          ? "medium"
          : "low";

    return {
      shouldRefresh,
      priority,
      reasonCodes: reasons.length ? reasons : ["no_material_change"],
      affectedDependencies: Array.from(dependencies),
    };
  }
}
