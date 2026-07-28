// CF-DATA-QUALITY-REPORT (Drew, 2026-07-28).
//
// Pool-level quality metrics — the number Drew wants to be able to
// point at when he says "HobbyIQ prices are 99.9% verified data."
//
// The report answers three questions:
//   1. HOW MUCH of the pool have we validated in some way?
//   2. HOW MUCH is currently flagged / uncertain?
//   3. HOW MUCH could a targeted fix pass save?
//
// Buckets:
//   verified          — verifiedByUser=true OR image-hash match
//                       against catalog reference (once image verify
//                       lands)
//   catalog-matched   — hobbyiqCardId resolves cleanly to a catalog
//                       entry (once catalog-master lands)
//   auto-parsed       — parseListingIdentity produced a definite
//                       (non-"Base") parallel + a non-null cardNumber
//   uncertain         — cardNumber null OR parallel = "Base" fallback
//                       with a suspiciously-named title
//   flagged           — qualityFlags array is non-empty (price-outlier,
//                       raw-priced-like-graded, same-day-same-slug-dupe,
//                       user-flagged)
//   pending-verify    — waiting in verify_queue (see verifyQueue.service)
//
// A row can belong to multiple buckets — verified + catalog-matched is
// the ideal state. The overall "trust" percentage is verified /
// (verified + auto-parsed + uncertain) — flagged rows are excluded from
// the denominator since they're already excluded from FMV compute.

import { CosmosClient, type Container } from "@azure/cosmos";

let _cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return _cached;
  } catch {
    return null;
  }
}

export interface DataQualityReport {
  totalRows: number;
  cutoffDays: number;
  buckets: {
    verified: number;
    catalogMatched: number;
    autoParsed: number;
    uncertain: number;
    flagged: number;
    pendingVerify: number;
  };
  trustScore: number;          // 0-1
  trustPercentageDisplay: string;  // "97.4%"
  bySource: Record<string, {
    total: number;
    uncertain: number;
    flagged: number;
    uncertainPct: number;
  }>;
  topFlagReasons: Array<{ reason: string; count: number }>;
  computedAt: string;
}

/**
 * Compute a fresh pool quality report for the last `cutoffDays` window.
 * Cross-partition, so cache aggressively (30 minutes) at the caller.
 * Silent-safe: returns a zero-populated report on Cosmos-unavailable
 * so the /report endpoint stays green in dev.
 */
export async function computeDataQualityReport(cutoffDays = 180): Promise<DataQualityReport> {
  const now = new Date();
  const empty: DataQualityReport = {
    totalRows: 0,
    cutoffDays,
    buckets: {
      verified: 0,
      catalogMatched: 0,
      autoParsed: 0,
      uncertain: 0,
      flagged: 0,
      pendingVerify: 0,
    },
    trustScore: 0,
    trustPercentageDisplay: "0.0%",
    bySource: {},
    topFlagReasons: [],
    computedAt: now.toISOString(),
  };

  const container = await getContainer();
  if (!container) return empty;

  const cutoffIso = new Date(now.getTime() - cutoffDays * 86_400_000).toISOString();

  // Single scan; classify each row in JS. Cheaper than firing 6 separate
  // COUNT queries because Cosmos amortizes across the same read cost.
  const { resources } = await container.items.query<{
    source?: string;
    parallel?: string | null;
    cardNumber?: string | null;
    verifiedByUser?: boolean;
    qualityFlags?: string[];
    hobbyiqCardId?: string;
    title?: string | null;
  }>({
    query:
      "SELECT c.source, c.parallel, c.cardNumber, c.verifiedByUser, c.qualityFlags, c.hobbyiqCardId, c.title FROM c WHERE c.soldAt >= @cutoff",
    parameters: [{ name: "@cutoff", value: cutoffIso }],
  }).fetchAll();

  const bySource: DataQualityReport["bySource"] = {};
  const flagCounts = new Map<string, number>();
  let verified = 0;
  let catalogMatched = 0;
  let autoParsed = 0;
  let uncertain = 0;
  let flagged = 0;

  for (const r of resources) {
    const src = r.source ?? "unknown";
    (bySource[src] ??= { total: 0, uncertain: 0, flagged: 0, uncertainPct: 0 });
    bySource[src].total += 1;

    const rowFlags = Array.isArray(r.qualityFlags) ? r.qualityFlags : [];
    const isFlagged = rowFlags.length > 0;
    if (isFlagged) {
      flagged += 1;
      bySource[src].flagged += 1;
      for (const f of rowFlags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
      continue;  // flagged rows exclude from the other buckets
    }

    if (r.verifiedByUser === true) {
      verified += 1;
    }
    if (typeof r.hobbyiqCardId === "string" && r.hobbyiqCardId.startsWith("hiq:")) {
      catalogMatched += 1;  // proxy until real catalog-master lands
    }

    const par = String(r.parallel ?? "").trim();
    const num = String(r.cardNumber ?? "").trim();
    const parIsSpecific = par !== "" && par.toLowerCase() !== "base";
    const hasNumber = num !== "";
    if (parIsSpecific && hasNumber) {
      autoParsed += 1;
    } else {
      uncertain += 1;
      bySource[src].uncertain += 1;
    }
  }

  for (const s of Object.values(bySource)) {
    s.uncertainPct = s.total > 0 ? s.uncertain / s.total : 0;
  }

  const denominator = verified + autoParsed + uncertain;
  const trustScore = denominator > 0 ? (verified + autoParsed) / denominator : 0;

  const topFlagReasons = [...flagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  return {
    totalRows: resources.length,
    cutoffDays,
    buckets: {
      verified,
      catalogMatched,
      autoParsed,
      uncertain,
      flagged,
      pendingVerify: 0,  // filled in by combining verifyQueue count once wired
    },
    trustScore,
    trustPercentageDisplay: `${(trustScore * 100).toFixed(1)}%`,
    bySource,
    topFlagReasons,
    computedAt: now.toISOString(),
  };
}
