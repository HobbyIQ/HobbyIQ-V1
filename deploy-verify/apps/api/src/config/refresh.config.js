"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshConfig = void 0;
exports.refreshConfig = {
    hotCardTtlMinutes: Number(process.env.REFRESH_HOT_CARD_TTL_MINUTES ?? 180),
    mediumCardTtlMinutes: Number(process.env.REFRESH_MEDIUM_CARD_TTL_MINUTES ?? 720),
    coldCardTtlMinutes: Number(process.env.REFRESH_COLD_CARD_TTL_MINUTES ?? 1440),
    playerSummaryTtlMinutes: Number(process.env.REFRESH_PLAYER_SUMMARY_TTL_MINUTES ?? 1440),
    staleServeAllowedMinutes: Number(process.env.REFRESH_STALE_SERVE_ALLOWED_MINUTES ?? 180),
    weightedMedianChangePctThreshold: Number(process.env.REFRESH_WEIGHTED_MEDIAN_CHANGE_PCT ?? 5),
    activeSupplyChangePctThreshold: Number(process.env.REFRESH_ACTIVE_SUPPLY_CHANGE_PCT ?? 10),
    demandRatioChangePctThreshold: Number(process.env.REFRESH_DEMAND_RATIO_CHANGE_PCT ?? 10),
    confidenceDeltaThreshold: Number(process.env.REFRESH_CONFIDENCE_DELTA_THRESHOLD ?? 8),
    maxRetryCount: Number(process.env.REFRESH_MAX_RETRY_COUNT ?? 3),
};
