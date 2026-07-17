// CF-PARALLEL-LADDER (Drew, 2026-07-17). Orchestration for the card-
// detail parallel ladder — query ch_daily_sales for a (player, year,
// cardSet) bucket, feed sales into computeParallelLadder, wrap with
// the bucket key + confidence tier.
//
// Never throws — bails to a null-ladder response so the route handler
// can 200 empty. Used by GET /api/portfolio/parallel-ladder/:key.

import { lookupLocalComps } from "./localCompStore.service.js";
import { computeParallelLadder } from "./parallelLadderCompute.service.js";
import type { ParallelLadderRung } from "./parallelLadderCompute.service.js";

export interface ParallelLadderBucketKey {
  player: string;
  year: number;
  cardSet: string;
}

export interface ParallelLadderResponseBucket {
  player: string;
  year: number;
  cardSet: string;
  baseMedianPrice: number | null;
  ladder: ParallelLadderRung[];
  confidence: "high" | "medium" | "low" | "insufficient";
  suppressedReason: "no_sales" | "base_thin" | null;
}

export interface ParallelLadderResponse {
  bucket: ParallelLadderResponseBucket;
}

/**
 * Parse the `player::year::cardSet` URL-path key (as sent by iOS) into
 * a structured bucket. Returns null on any malformed / missing part —
 * caller emits 400.
 *
 * All three fields are required. Year must be a 4-digit integer.
 */
export function parseBucketKey(raw: string): ParallelLadderBucketKey | null {
  if (typeof raw !== "string") return null;
  const decoded = tryDecode(raw);
  const parts = decoded.split("::");
  if (parts.length !== 3) return null;
  const [player, yearRaw, cardSet] = parts.map((s) => s.trim());
  if (!player || !yearRaw || !cardSet) return null;
  const year = Number(yearRaw);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  return { player, year, cardSet };
}

function tryDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Query ch_daily_sales for the (player, year, cardSet) bucket, compute
 * the ladder. Structured lookup pulls raw + graded rows for the
 * player+year+cardSet triple (allGrades=true so grader premiums don't
 * skew the ladder — parallel curve should reflect raw price at each
 * variant tier, not "PSA 10 Gold vs raw Base").
 *
 * Actually — we WANT the ladder to reflect the mix of grades that
 * actually trade in that variant. A Gold /50 with mostly PSA 10 comps
 * has a real Gold /50 market value that includes that grading premium.
 * So we pull all sales and let the median absorb the market's mix.
 *
 * If future UX wants a raw-only ladder we'd flip skipPremiums-style
 * gates; for now the current mix mirrors what a seller would actually
 * see if they searched sold-comps for a variant.
 */
export async function analyzeParallelLadder(
  key: ParallelLadderBucketKey,
): Promise<ParallelLadderResponse> {
  let sales: Awaited<ReturnType<typeof lookupLocalComps>>["recentSales"] = [];
  try {
    const result = await lookupLocalComps(
      {
        player: key.player,
        year: key.year,
        cardSet: key.cardSet,
        allGrades: true,
      },
      // Pull a wider recent-sales window so the median has real signal
      // per variant. skipPremiums=true — we do our own bucketing here.
      { recentSalesLimit: 10_000, skipPremiums: true },
    );
    sales = result.recentSales;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "parallel_ladder_lookup_error",
      source: "parallelLadderAnalyze.service",
      player: key.player, year: key.year, cardSet: key.cardSet,
      error: (err as Error)?.message ?? String(err),
    }));
  }

  const { ladder, suppressedReason } = computeParallelLadder(sales);

  if (!ladder) {
    return {
      bucket: {
        player: key.player,
        year: key.year,
        cardSet: key.cardSet,
        baseMedianPrice: null,
        ladder: [],
        confidence: "insufficient",
        suppressedReason,
      },
    };
  }

  return {
    bucket: {
      player: key.player,
      year: key.year,
      cardSet: key.cardSet,
      baseMedianPrice: ladder.baseMedianPrice,
      ladder: ladder.ladder,
      confidence: ladder.confidence,
      suppressedReason: null,
    },
  };
}
