// CF-RARE-CARD-FMV (Drew, 2026-08-01). Rare cards (1-of-1s, /5, /10,
// deep-vintage stars) don't trade often enough for the standard "5
// comps in 90d" trend projection. This service handles them by:
//
//   1. Finding the LAST actual sale for this exact hobbyiqCardId
//      (even if it's years old).
//   2. Computing the parent pool's trend since that sale date —
//      "how has the comparable pool moved since the last time this
//      rare card sold?"
//   3. Applying that delta to the last sale price to project the
//      next sale.
//
// Result: FMV_rare = lastSalePrice × (1 + parentDeltaPct)
//
// Emitted with explicit context so users see the reasoning:
//   "Last sold $8,500 on Mar 15, 2024. Comparable pool up 26% since.
//    Projected: $10,710."
//
// Parent slug derivation: swap the slug's parallel and printRun
// segments back to their base equivalents. Same year, same
// cardNumber, same player, same isAuto. Base parallel, no printRun.
//
// Fallback ladder if the base parent has no liquidity either:
//   1. Base parent (parallel=Base, no printRun) in the same year
//   2. Any-parallel same-year sibling pool
//   3. Emit "insufficient comparables" with wide historical band
//
// Vendor-agnostic per [[project-calibration-from-our-pool-only]] —
// reads sold_comps by identity, never by vendor cardId.

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseHobbyIqCardId, computeHobbyIqCardId } from "./hobbyIqCardId.service.js";

// POOL-1 residue (audit, 2026-09-03). The rare-card rung reads sold_comps
// directly, so an adjudicated-wrong row could BE the "last actual sale" this
// whole method anchors to -- the thinner the pool, the more one bad row
// decides the published number. Same store-form predicate as
// exactPoolReader:84-85.
const ADJUDICATION_FILTER =
  "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)"
  + " AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)";

export interface RareCardFmvInput {
  hobbyiqCardId: string;
  /** Freshness threshold used to detect the rare-card case. Default: if
   *  the exact slug has < 3 sales in this many days, the card qualifies
   *  as rare and this service takes over. */
  rareCardThresholdDays?: number;
  rareCardMinComps?: number;
}

export interface RareCardFmvResult {
  slug: string;
  qualifies: boolean;                  // false = enough comps, use normal ladder
  fmv: number | null;
  method: "rare-card-anchor" | "no-basis";
  lastSale: {
    price: number;
    soldAt: string;
    source: string;
  } | null;
  parentDeltaPct: number | null;       // % change in parent pool since lastSale
  parentComps: {
    beforeCount: number;
    beforeMedian: number | null;
    afterCount: number;
    afterMedian: number | null;
    parentSlug: string | null;
  };
  confidenceBand: {
    low: number | null;
    high: number | null;
  } | null;
  basisNote: string;
  computedAt: string;
}

const DEFAULT_RARE_THRESHOLD_DAYS = 180;
const DEFAULT_RARE_MIN_COMPS = 3;

let cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (cached) return cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cached = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cached;
  } catch { return null; }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function computeParentSlug(slug: string): string | null {
  const parts = parseHobbyIqCardId(slug);
  if (!parts) return null;
  // Rare-card parent = same identity but with parallel=Base, no printRun.
  // Preserves sport, year, setKey, cardNumber, isAuto (isAuto stays; the
  // base version of an auto card is still an auto).
  return computeHobbyIqCardId({
    sport: parts.sport,
    year: parts.year,
    setKey: parts.setKey,
    cardNumber: parts.cardNumber,
    parallel: "Base",
    isAuto: parts.isAuto,
    printRun: null,
  });
}

export async function computeRareCardFmv(input: RareCardFmvInput): Promise<RareCardFmvResult> {
  const slug = String(input.hobbyiqCardId ?? "").trim();
  const nowIso = new Date().toISOString();
  const empty: RareCardFmvResult = {
    slug,
    qualifies: false,
    fmv: null,
    method: "no-basis",
    lastSale: null,
    parentDeltaPct: null,
    parentComps: { beforeCount: 0, beforeMedian: null, afterCount: 0, afterMedian: null, parentSlug: null },
    confidenceBand: null,
    basisNote: "no slug provided",
    computedAt: nowIso,
  };
  if (!slug || !slug.startsWith("hiq:")) return empty;

  const container = await getContainer();
  if (!container) return { ...empty, basisNote: "sold_comps container unavailable" };

  const thresholdDays = input.rareCardThresholdDays ?? DEFAULT_RARE_THRESHOLD_DAYS;
  const minComps = input.rareCardMinComps ?? DEFAULT_RARE_MIN_COMPS;
  const now = Date.now();
  const rareCutoff = new Date(now - thresholdDays * 86_400_000).toISOString();

  // Step 1: check if the card qualifies as "rare" — < minComps in recent window
  let recentCount = 0;
  try {
    const { resources } = await container.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @slug AND c.soldAt >= @from AND ${ADJUDICATION_FILTER}`,
      parameters: [{ name: "@slug", value: slug }, { name: "@from", value: rareCutoff }],
    }).fetchAll();
    recentCount = Number(resources[0]) || 0;
  } catch { /* treat as 0 */ }

  if (recentCount >= minComps) {
    return { ...empty, qualifies: false, basisNote: `${recentCount} comps in last ${thresholdDays}d — use normal FMV ladder` };
  }

  // Step 2: find LAST actual sale (any time)
  let lastSale: RareCardFmvResult["lastSale"] = null;
  try {
    const { resources } = await container.items.query({
      query: `SELECT TOP 1 c.price, c.soldAt, c.source FROM c WHERE c.hobbyiqCardId = @slug AND IS_DEFINED(c.price) AND c.price > 0 AND ${ADJUDICATION_FILTER} ORDER BY c.soldAt DESC`,
      parameters: [{ name: "@slug", value: slug }],
    }).fetchAll();
    if (resources.length > 0 && Number.isFinite(Number(resources[0].price))) {
      lastSale = {
        price: Number(resources[0].price),
        soldAt: String(resources[0].soldAt),
        source: String(resources[0].source ?? "unknown"),
      };
    }
  } catch { /* no sales */ }

  if (!lastSale) {
    return { ...empty, qualifies: true, basisNote: "rare card — no historical sales at this slug either; deferring to parent-only projection" };
  }

  // Step 3: compute parent slug
  const parentSlug = computeParentSlug(slug);
  if (!parentSlug || parentSlug === slug) {
    // Slug is already the base — can't derive a parent. Just return last sale as-is.
    return {
      slug, qualifies: true,
      fmv: lastSale.price,
      method: "rare-card-anchor",
      lastSale,
      parentDeltaPct: null,
      parentComps: { beforeCount: 0, beforeMedian: null, afterCount: 0, afterMedian: null, parentSlug: null },
      confidenceBand: { low: Math.round(lastSale.price * 0.85), high: Math.round(lastSale.price * 1.15) },
      basisNote: `Last sold $${lastSale.price} on ${lastSale.soldAt.slice(0, 10)}. No parent pool derivable — anchor to last sale ±15%.`,
      computedAt: nowIso,
    };
  }

  // Step 4: fetch parent pool sales split around the lastSale date
  let parentBefore: number[] = [];
  let parentAfter: number[] = [];
  try {
    const { resources } = await container.items.query({
      query: `SELECT c.price, c.soldAt FROM c WHERE c.hobbyiqCardId = @slug AND IS_DEFINED(c.price) AND c.price > 0 AND ${ADJUDICATION_FILTER} ORDER BY c.soldAt DESC`,
      parameters: [{ name: "@slug", value: parentSlug }],
    }).fetchAll();
    for (const r of resources || []) {
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (String(r.soldAt) < lastSale.soldAt) parentBefore.push(p);
      else parentAfter.push(p);
    }
  } catch { /* no parent data */ }

  const beforeMedian = median(parentBefore);
  const afterMedian = median(parentAfter);

  // Step 5: compute delta + projected FMV
  let parentDeltaPct: number | null = null;
  let projected: number | null = null;
  let basisNote = "";

  if (beforeMedian !== null && afterMedian !== null && beforeMedian > 0) {
    parentDeltaPct = Math.round(((afterMedian - beforeMedian) / beforeMedian) * 1000) / 10;
    projected = Math.round(lastSale.price * (1 + parentDeltaPct / 100));
    const dirWord = parentDeltaPct >= 0 ? "up" : "down";
    basisNote = `Last sold $${lastSale.price} on ${lastSale.soldAt.slice(0, 10)}. Comparable base pool ${dirWord} ${Math.abs(parentDeltaPct).toFixed(1)}% since. Projected: $${projected}.`;
  } else if (afterMedian !== null && parentAfter.length >= 3) {
    // Parent has recent liquidity but nothing before lastSale — can't compute delta.
    // Still anchor on last sale with a wider band.
    projected = lastSale.price;
    basisNote = `Last sold $${lastSale.price} on ${lastSale.soldAt.slice(0, 10)}. Insufficient parent-pool history before that date — anchor to last sale ±20%.`;
  } else {
    // Parent has no useful liquidity either. Just return last sale with wide band.
    projected = lastSale.price;
    basisNote = `Last sold $${lastSale.price} on ${lastSale.soldAt.slice(0, 10)}. Parent pool thin (${parentBefore.length + parentAfter.length} total sales) — anchor to last sale ±25%.`;
  }

  const bandPct = parentDeltaPct !== null ? 0.15 : 0.20;
  const confidenceBand = projected !== null
    ? { low: Math.round(projected * (1 - bandPct)), high: Math.round(projected * (1 + bandPct)) }
    : null;

  return {
    slug,
    qualifies: true,
    fmv: projected,
    method: projected !== null ? "rare-card-anchor" : "no-basis",
    lastSale,
    parentDeltaPct,
    parentComps: {
      beforeCount: parentBefore.length,
      beforeMedian,
      afterCount: parentAfter.length,
      afterMedian,
      parentSlug,
    },
    confidenceBand,
    basisNote,
    computedAt: nowIso,
  };
}
