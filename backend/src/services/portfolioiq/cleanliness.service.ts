// CF-CLEANLINESS-METRICS (Drew, 2026-08-01). The number Drew calls
// when someone asks "how clean is the data?". Rolls up the sold_comps
// container into six top-line metrics + per-source breakdown +
// contamination surface areas.
//
// Cached for 5 min (this walks the whole container; not cheap).

import { CosmosClient, type Container } from "@azure/cosmos";

export interface CleanlinessReport {
  totalRows: number;
  bySource: Record<string, number>;
  slug: {
    withValid: number;
    missingOrInvalid: number;
    validPct: number;
  };
  identity: {
    withCardNumber: number;
    withPlayerName: number;
    withCardYear: number;
    missingAny: number;
  };
  flags: {
    priceOutliers: number;
    cardsightUnverified: number;
    catalogCanonicalized: number;
    stage2TitleParsed: number;
    priceOutlierBelowFloor: number;
    priceOutlierAboveCeiling: number;
  };
  cleanliness: {
    // Composite score 0-100: rewards catalog canonicalized + confirmed sources,
    // penalizes flagged/unverified/missing-field rows.
    score: number;
    label: string;
  };
  computedAt: string;
}

let cache: { report: CleanlinessReport; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

let cachedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedContainer = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  return cachedContainer;
}

async function count(container: Container, whereClause: string | null): Promise<number> {
  const q = `SELECT VALUE COUNT(1) FROM c${whereClause ? " WHERE " + whereClause : ""}`;
  const { resources } = await container.items.query({ query: q }).fetchAll();
  return Number(resources?.[0]) || 0;
}

async function countBySource(container: Container): Promise<Record<string, number>> {
  const q = `SELECT c.source, COUNT(1) AS n FROM c GROUP BY c.source`;
  const { resources } = await container.items.query({ query: q }).fetchAll();
  const out: Record<string, number> = {};
  for (const r of resources ?? []) {
    const src = String((r as { source: string }).source ?? "unknown");
    out[src] = Number((r as { n: number }).n) || 0;
  }
  return out;
}

export async function computeCleanlinessReport(force = false): Promise<CleanlinessReport | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.report;
  const container = await getContainer();
  if (!container) return null;

  const [
    totalRows,
    bySource,
    withValidSlug,
    missingSlug,
    withCn,
    withPn,
    withYr,
    missingAny,
    priceOutliers,
    csUnverified,
    catalogFlag,
    stage2Flag,
    belowFloor,
    aboveCeiling,
  ] = await Promise.all([
    count(container, null),
    countBySource(container),
    count(container, "STARTSWITH(c.hobbyiqCardId, 'hiq:')"),
    count(container, "NOT IS_DEFINED(c.hobbyiqCardId) OR NOT STARTSWITH(c.hobbyiqCardId, 'hiq:')"),
    count(container, "IS_DEFINED(c.cardNumber) AND c.cardNumber != ''"),
    count(container, "IS_DEFINED(c.playerName) AND c.playerName != ''"),
    count(container, "IS_DEFINED(c.cardYear) AND c.cardYear != null"),
    count(container, "NOT IS_DEFINED(c.cardNumber) OR c.cardNumber = '' OR NOT IS_DEFINED(c.playerName) OR c.playerName = ''"),
    count(container, "c.__priceOutlier = true"),
    count(container, "c.__cardsightUnverified = true"),
    count(container, "IS_DEFINED(c.__catalogCanonicalizedAt)"),
    count(container, "IS_DEFINED(c.__stage2TitleParsedAt)"),
    count(container, `c.__priceOutlier = true AND c.__priceOutlierBand = 'below-floor'`),
    count(container, `c.__priceOutlier = true AND c.__priceOutlierBand = 'above-ceiling'`),
  ]);

  // Score: rewards clean canonicalization + confirmed sources, penalizes flags + missing fields
  const denom = totalRows || 1;
  const cleanCanonicalized = catalogFlag + stage2Flag;
  const confirmedSources = (bySource["cardhedge"] || 0) + (bySource["ebay-user-purchase"] || 0) + (bySource["manual-user-entry"] || 0) + (bySource["ebay-user-sale"] || 0) + (bySource["ebay-account"] || 0);
  const flagged = priceOutliers + csUnverified;
  const rawScore = ((cleanCanonicalized + confirmedSources) - (flagged + missingAny)) / denom;
  const score = Math.max(0, Math.min(100, Math.round(rawScore * 100)));
  const label = score >= 90 ? "excellent"
              : score >= 80 ? "good"
              : score >= 60 ? "fair"
              : score >= 40 ? "needs work"
              : "poor";

  const report: CleanlinessReport = {
    totalRows,
    bySource,
    slug: {
      withValid: withValidSlug,
      missingOrInvalid: missingSlug,
      validPct: Math.round((withValidSlug / denom) * 10000) / 100,
    },
    identity: {
      withCardNumber: withCn,
      withPlayerName: withPn,
      withCardYear: withYr,
      missingAny,
    },
    flags: {
      priceOutliers,
      cardsightUnverified: csUnverified,
      catalogCanonicalized: catalogFlag,
      stage2TitleParsed: stage2Flag,
      priceOutlierBelowFloor: belowFloor,
      priceOutlierAboveCeiling: aboveCeiling,
    },
    cleanliness: { score, label },
    computedAt: new Date().toISOString(),
  };
  cache = { report, at: Date.now() };
  return report;
}
