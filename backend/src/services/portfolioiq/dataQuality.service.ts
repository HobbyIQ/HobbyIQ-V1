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

let _catCached: Container | null = null;
async function getCatalogContainer(): Promise<Container | null> {
  if (_catCached) return _catCached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _catCached = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog");
    return _catCached;
  } catch {
    return null;
  }
}

/** Pull every slug present in card_catalog into a Set for O(1) match
 *  during the sold_comps scan. Cardinality is bounded by distinct
 *  cards in the market (tens-of-thousands, not millions), so an
 *  in-memory Set is fine. Empty on Cosmos failure or when the catalog
 *  hasn't been seeded — falls back to the slug-prefix heuristic. */
async function loadCatalogSlugs(): Promise<Set<string> | null> {
  const c = await getCatalogContainer();
  if (!c) return null;
  try {
    const { resources } = await c.items.query<string>("SELECT VALUE c.id FROM c").fetchAll();
    if (!Array.isArray(resources) || resources.length === 0) return null;
    return new Set(resources);
  } catch {
    return null;
  }
}

/** Count catalog entries + how many have referenceImage / phash coverage.
 *  All three COUNTs in one round-trip via COUNT(1) + conditional aggregates
 *  so we don't fire 3 separate cross-partition scans. */
async function computeCatalogCoverage(): Promise<DataQualityReport["catalog"]> {
  const empty = { total: 0, withReferenceImage: 0, withReferenceImagePhash: 0, imageCoveragePct: 0, phashCoveragePct: 0 };
  const c = await getCatalogContainer();
  if (!c) return empty;
  try {
    // Cosmos SQL doesn't support conditional aggregates natively; run 3
    // COUNTs in parallel instead. Cheap because the queries are
    // partition-agnostic + count-only (no doc fetch).
    const [t, i, p] = await Promise.all([
      c.items.query<number>("SELECT VALUE COUNT(1) FROM c").fetchAll(),
      c.items.query<number>("SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.referenceImage)").fetchAll(),
      c.items.query<number>("SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.referenceImage.phash)").fetchAll(),
    ]);
    const total = t.resources[0] ?? 0;
    const withReferenceImage = i.resources[0] ?? 0;
    const withReferenceImagePhash = p.resources[0] ?? 0;
    return {
      total,
      withReferenceImage,
      withReferenceImagePhash,
      imageCoveragePct: total > 0 ? withReferenceImage / total : 0,
      phashCoveragePct: total > 0 ? withReferenceImagePhash / total : 0,
    };
  } catch {
    return empty;
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
  // CF-IMAGE-VERIFY (Drew, 2026-07-28). Catalog-level coverage
  // numbers — separate from the sold_comps pool trust score. These
  // measure the substrate the pool leans on: how many real cards
  // do we have identity for, and how many of those have a
  // pHash-comparable reference image.
  catalog: {
    total: number;
    withReferenceImage: number;
    withReferenceImagePhash: number;
    imageCoveragePct: number;   // withReferenceImage / total
    phashCoveragePct: number;   // withReferenceImagePhash / total
  };
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
    catalog: {
      total: 0,
      withReferenceImage: 0,
      withReferenceImagePhash: 0,
      imageCoveragePct: 0,
      phashCoveragePct: 0,
    },
    computedAt: now.toISOString(),
  };

  const container = await getContainer();
  if (!container) return empty;

  // Load catalog slugs ONCE so the sold_comps scan can hit an in-memory
  // Set instead of firing a point-read per row. Falls back to the
  // slug-prefix heuristic when the catalog isn't seeded (early days).
  // Also fetch catalog coverage stats in parallel.
  const [catalogSlugs, catalogCoverage] = await Promise.all([
    loadCatalogSlugs(),
    computeCatalogCoverage(),
  ]);

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
    // Real catalog match when the seed has run; slug-prefix heuristic
    // as a fallback until then.
    const slug = typeof r.hobbyiqCardId === "string" ? r.hobbyiqCardId : "";
    const hasSlug = slug.startsWith("hiq:");
    if (catalogSlugs) {
      if (hasSlug && catalogSlugs.has(slug)) catalogMatched += 1;
    } else if (hasSlug) {
      catalogMatched += 1;
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
    catalog: catalogCoverage,
    computedAt: now.toISOString(),
  };
}
