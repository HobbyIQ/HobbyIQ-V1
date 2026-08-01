// CF-BAD-ACTOR-DETECTION (Drew, 2026-08-01). Aggregate contamination
// flags per sellerHandle. A seller with a high rate of flagged rows
// (price outliers, user-quarantined, cardsight-unverified) across a
// meaningful sample is a bad actor — their FUTURE rows can be
// pre-flagged at ingest, and their EXISTING rows can be bulk
// quarantined via the admin surface.
//
// Cached for 30 min. Only sellers with min_rows contributions are
// considered (small-sample false-positive protection).

import { CosmosClient, type Container } from "@azure/cosmos";

export interface BadActorSeller {
  sellerHandle: string;
  totalRows: number;
  priceOutlierRows: number;
  userQuarantinedRows: number;
  cardsightUnverifiedRows: number;
  contaminationRate: number;
  score: number; // 0-100, higher = worse
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface BadActorReport {
  totalSellers: number;
  suspiciousSellers: BadActorSeller[];
  banned: BadActorSeller[];
  minRowsThreshold: number;
  contaminationRateThreshold: number;
  computedAt: string;
}

const MIN_ROWS = 10;                // seller needs 10+ rows before we judge
const SUSPICIOUS_RATE = 0.25;       // >=25% flagged = suspicious
const BANNED_RATE = 0.50;           // >=50% flagged = banned
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: { report: BadActorReport; at: number } | null = null;

let cachedSc: Container | null = null;
async function getSoldComps(): Promise<Container | null> {
  if (cachedSc) return cachedSc;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedSc = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  return cachedSc;
}

export async function computeBadActorReport(force = false): Promise<BadActorReport | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report;
  const sc = await getSoldComps();
  if (!sc) return null;

  const aggregates = new Map<string, {
    totalRows: number;
    priceOutlierRows: number;
    userQuarantinedRows: number;
    cardsightUnverifiedRows: number;
    firstSeenAt?: string;
    lastSeenAt?: string;
  }>();

  const iter = sc.items.query({
    query: `SELECT c.sellerHandle, c.__priceOutlier, c.__userFlagQuarantine, c.__cardsightUnverified,
                   c.observedAt, c.soldAt
              FROM c
              WHERE IS_DEFINED(c.sellerHandle) AND c.sellerHandle != null AND c.sellerHandle != ''`
  }, { maxItemCount: 5000 });

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      const seller = String((r as { sellerHandle: string }).sellerHandle).trim();
      if (!seller) continue;
      let agg = aggregates.get(seller);
      if (!agg) {
        agg = { totalRows: 0, priceOutlierRows: 0, userQuarantinedRows: 0, cardsightUnverifiedRows: 0 };
        aggregates.set(seller, agg);
      }
      agg.totalRows++;
      if ((r as { __priceOutlier?: boolean }).__priceOutlier === true) agg.priceOutlierRows++;
      if ((r as { __userFlagQuarantine?: boolean }).__userFlagQuarantine === true) agg.userQuarantinedRows++;
      if ((r as { __cardsightUnverified?: boolean }).__cardsightUnverified === true) agg.cardsightUnverifiedRows++;
      const dt = (r as { soldAt?: string; observedAt?: string }).soldAt ?? (r as { observedAt?: string }).observedAt;
      if (dt) {
        if (!agg.firstSeenAt || dt < agg.firstSeenAt) agg.firstSeenAt = dt;
        if (!agg.lastSeenAt || dt > agg.lastSeenAt) agg.lastSeenAt = dt;
      }
    }
  }

  const rows: BadActorSeller[] = [];
  for (const [seller, agg] of aggregates) {
    if (agg.totalRows < MIN_ROWS) continue;
    const flagged = agg.priceOutlierRows + agg.userQuarantinedRows + agg.cardsightUnverifiedRows;
    const rate = flagged / agg.totalRows;
    if (rate < SUSPICIOUS_RATE) continue;
    rows.push({
      sellerHandle: seller,
      totalRows: agg.totalRows,
      priceOutlierRows: agg.priceOutlierRows,
      userQuarantinedRows: agg.userQuarantinedRows,
      cardsightUnverifiedRows: agg.cardsightUnverifiedRows,
      contaminationRate: Math.round(rate * 10000) / 100,
      score: Math.min(100, Math.round(rate * 100)),
      firstSeenAt: agg.firstSeenAt,
      lastSeenAt: agg.lastSeenAt,
    });
  }
  rows.sort((a, b) => b.contaminationRate - a.contaminationRate);
  const banned = rows.filter((r) => r.contaminationRate >= BANNED_RATE * 100);
  const suspicious = rows.filter((r) => r.contaminationRate < BANNED_RATE * 100);

  const report: BadActorReport = {
    totalSellers: aggregates.size,
    suspiciousSellers: suspicious,
    banned,
    minRowsThreshold: MIN_ROWS,
    contaminationRateThreshold: SUSPICIOUS_RATE,
    computedAt: new Date().toISOString(),
  };
  cache = { report, at: Date.now() };
  return report;
}

/** Fast lookup: is this sellerHandle currently on the banned list? */
export async function isBannedSeller(sellerHandle: string): Promise<boolean> {
  if (!sellerHandle) return false;
  const report = await computeBadActorReport(false);
  if (!report) return false;
  return report.banned.some((s) => s.sellerHandle === sellerHandle);
}
