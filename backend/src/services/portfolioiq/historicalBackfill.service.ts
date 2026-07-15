// CF-HISTORICAL-BACKFILL (Drew, 2026-07-15): sweep known cardIds and
// pull full-history sales from BOTH CardHedge + Cardsight into the
// sold_comps pool. Companion to CF-SEASONALITY-EXTENDED-TTL — TTL
// controls retention; this service does the accumulation.
//
// Why both vendors: CH is our higher-trust source (0.8 confidence,
// AI-matched to canonical); CS is broader-coverage (0.6, includes
// title-searchable listings CH catalog may miss). For seasonality
// analysis both are valuable — CH gives clean per-SKU price series,
// CS gives cross-market volume signal.
//
// Design:
//   - Driven by a list of TARGETS: {csCardId?, chCardId?, identity}
//   - For each target, dual-fetch in parallel (CH + CS)
//   - Idempotent: sold_comps upsert dedups on (source, sourceExternalId)
//     so running this repeatedly doesn't create duplicates
//   - Rate-limit friendly: caps concurrent fetches
//
// Runs manually via /api/ops/historical-backfill/run route. Future:
// nightly cron for active holdings.

import { getCardSales, type CardHedgeSale } from "../compiq/cardhedge.client.js";
import {
  getPricing,
  type CardsightPricingResponse,
} from "../compiq/cardsightSlim.client.js";
import { recordSoldComp } from "./soldCompsStore.service.js";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, source: "historicalBackfill.service", ...fields }));
};

/** Max concurrent per-target dual-fetches. Keeps us polite to both
 *  vendors under bulk-load conditions. */
const CONCURRENCY = 4;

/** How many sales to request from CH per card. CH's default limit is 20;
 *  bump for backfill so we get more of the tail. */
const CH_MAX_SALES = 500;

export interface BackfillTargetIdentity {
  playerName: string;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean;
}

export interface BackfillTarget {
  /** Either or both required — we fetch from every vendor we have an ID for. */
  chCardId?: string | null;
  csCardId?: string | null;
  /** Denormalized identity for the sold_comps doc. */
  identity: BackfillTargetIdentity;
  /** Optional per-target grade for CH's getCardSales. Default "Raw". */
  grade?: string;
}

export interface BackfillTargetResult {
  chCardId: string | null;
  csCardId: string | null;
  chSalesWritten: number;
  csSalesWritten: number;
  errors: string[];
}

export interface BackfillRunResult {
  totalTargets: number;
  totalCHSalesWritten: number;
  totalCSSalesWritten: number;
  perTarget: BackfillTargetResult[];
  durationMs: number;
}

async function backfillOneCH(target: BackfillTarget): Promise<{ written: number; error?: string }> {
  const chCardId = target.chCardId?.trim();
  if (!chCardId) return { written: 0 };
  const grade = target.grade ?? "Raw";
  let sales: CardHedgeSale[];
  try {
    sales = await getCardSales(chCardId, grade, CH_MAX_SALES);
  } catch (err) {
    return { written: 0, error: `ch:${(err as Error)?.message ?? String(err)}` };
  }
  if (sales.length === 0) return { written: 0 };

  let written = 0;
  const cardYear = target.identity.cardYear ?? null;
  for (const s of sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    if (!s.date) continue;
    // Composite external id from (chCardId, date, price-cents). Matches
    // the pattern used in cardsight.router tryCardHedge emit so re-writes
    // dedupe cleanly against records already in the pool.
    const externalId = `${chCardId}::${s.date}::${Math.round(s.price * 100)}`;
    try {
      await recordSoldComp({
        cardId: chCardId,
        playerName: target.identity.playerName,
        cardYear,
        setName: target.identity.setName ?? null,
        parallel: target.identity.parallel ?? null,
        cardNumber: target.identity.cardNumber ?? null,
        isAuto: target.identity.isAuto ?? false,
        price: s.price,
        soldAt: s.date,
        source: "cardhedge",
        sourceExternalId: externalId,
        contributorUserId: null,
        title: s.title ?? null,
        imageUrl: null,
        sellerHandle: null,
        verifiedByUser: false,
        confidence: 0.8,
      });
      written += 1;
    } catch {
      // swallow — individual write failures shouldn't kill the batch
    }
  }
  return { written };
}

async function backfillOneCS(target: BackfillTarget): Promise<{ written: number; error?: string }> {
  const csCardId = target.csCardId?.trim();
  if (!csCardId) return { written: 0 };
  let pricing: CardsightPricingResponse;
  try {
    pricing = await getPricing(csCardId);
  } catch (err) {
    return { written: 0, error: `cs:${(err as Error)?.message ?? String(err)}` };
  }

  // Collect from raw + all graded arrays for full history.
  const allRecords: Array<{ price: number; date: string | null; title?: string | null; listing_type?: string | null; image_url?: string | null; grade?: string }> = [];
  for (const r of pricing.raw?.records ?? []) {
    allRecords.push({ ...r, grade: "Raw" });
  }
  for (const co of pricing.graded ?? []) {
    for (const g of co.grades ?? []) {
      for (const r of g.records ?? []) {
        allRecords.push({ ...r, grade: `${co.company_name} ${g.grade_value}` });
      }
    }
  }
  if (allRecords.length === 0) return { written: 0 };

  let written = 0;
  const cardYear = target.identity.cardYear ?? null;
  for (const r of allRecords) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    if (!r.date) continue;
    const externalId = `${csCardId}::${r.date}::${Math.round(r.price * 100)}`;
    try {
      await recordSoldComp({
        cardId: csCardId,
        playerName: target.identity.playerName,
        cardYear,
        setName: target.identity.setName ?? null,
        parallel: target.identity.parallel ?? null,
        cardNumber: target.identity.cardNumber ?? null,
        isAuto: target.identity.isAuto ?? false,
        price: r.price,
        soldAt: r.date,
        source: "cardsight",
        sourceExternalId: externalId,
        contributorUserId: null,
        title: r.title ?? null,
        imageUrl: r.image_url ?? null,
        sellerHandle: null,
        verifiedByUser: false,
        confidence: 0.6,
      });
      written += 1;
    } catch {
      // swallow
    }
  }
  return { written };
}

async function processTargetsWithConcurrency(
  targets: BackfillTarget[],
): Promise<BackfillTargetResult[]> {
  const results: BackfillTargetResult[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (idx < targets.length) {
      const myIdx = idx++;
      const t = targets[myIdx];
      const [ch, cs] = await Promise.all([backfillOneCH(t), backfillOneCS(t)]);
      const errors: string[] = [];
      if (ch.error) errors.push(ch.error);
      if (cs.error) errors.push(cs.error);
      results[myIdx] = {
        chCardId: t.chCardId ?? null,
        csCardId: t.csCardId ?? null,
        chSalesWritten: ch.written,
        csSalesWritten: cs.written,
        errors,
      };
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Backfill historical sales from CH + CS for the given targets. Idempotent.
 * Existing records are upserted (dedup on composite external id) so this
 * can be re-run daily/weekly without duplicating.
 */
export async function runHistoricalBackfill(
  targets: BackfillTarget[],
): Promise<BackfillRunResult> {
  const start = Date.now();
  log("historical_backfill.start", { targetCount: targets.length });

  const perTarget = await processTargetsWithConcurrency(targets);
  const totalCH = perTarget.reduce((sum, r) => sum + r.chSalesWritten, 0);
  const totalCS = perTarget.reduce((sum, r) => sum + r.csSalesWritten, 0);

  const result: BackfillRunResult = {
    totalTargets: targets.length,
    totalCHSalesWritten: totalCH,
    totalCSSalesWritten: totalCS,
    perTarget,
    durationMs: Date.now() - start,
  };
  log("historical_backfill.complete", {
    totalTargets: result.totalTargets,
    totalCHSalesWritten: totalCH,
    totalCSSalesWritten: totalCS,
    durationMs: result.durationMs,
  });
  return result;
}

/**
 * Build backfill targets from a user's active holdings. Skips holdings
 * without any resolved cardId (nothing to backfill against).
 */
export function buildTargetsFromHoldings(holdings: Array<{
  cardId?: string | null;
  chCardId?: string | null;
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
}>): BackfillTarget[] {
  const targets: BackfillTarget[] = [];
  for (const h of holdings) {
    const csCardId = h.cardId?.trim() ?? "";
    const chCardId = h.chCardId?.trim() ?? "";
    // Prefer CS UUIDs; skip clearly-non-CS "cardsight:x::y" compound ids
    // (those are backstop synthetic and won't resolve via CS getPricing).
    const isCsBackstopSynthetic = csCardId.startsWith("cardsight:");
    const effectiveCsCardId = isCsBackstopSynthetic ? null : (csCardId || null);
    if (!effectiveCsCardId && !chCardId) continue;
    if (!h.playerName?.trim()) continue;

    // CH's getCardSales takes a grade filter — use the holding's grade
    // if graded, else Raw.
    const grade = h.gradeCompany && h.gradeValue
      ? `${h.gradeCompany} ${h.gradeValue}`
      : "Raw";

    targets.push({
      chCardId: chCardId || null,
      csCardId: effectiveCsCardId,
      identity: {
        playerName: h.playerName.trim(),
        cardYear: h.cardYear ?? null,
        setName: h.setName ?? null,
        parallel: h.parallel ?? null,
        cardNumber: h.cardNumber ?? null,
        isAuto: h.isAuto ?? false,
      },
      grade,
    });
  }
  return targets;
}
