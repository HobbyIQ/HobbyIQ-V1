// CF-CARDSIGHT-RESTORE (2026-07-13): Cardsight vendor source plugin.
//
// Third source in the multi-vendor resolver stack — reclaims Cardsight
// coverage on SKUs CH doesn't index (e.g. 2026 CPA-EHA Blue Refractor
// Auto). Wraps the slim client into the VendorSource interface.
//
// Graceful degradation: when CARDSIGHT_API_KEY is unset, resolveCard
// returns null immediately without any HTTP call. The plugin can register
// safely even in dev / test envs where the key isn't configured.

import type {
  CardQuery,
  CardResolution,
  VendorSource,
  ResolutionConfidence,
  ResolverComp,
  ResolverGradedComp,
} from "./catalogResolver.service.js";
import {
  searchCatalog,
  getPricing,
  getCardDetail,
  isCardsightConfigured,
  type CardsightCatalogHit,
} from "./cardsightSlim.client.js";

function buildQuery(q: CardQuery): string {
  const parts: string[] = [];
  if (q.cardYear) parts.push(String(q.cardYear));
  if (q.setName) parts.push(q.setName);
  if (q.playerName) parts.push(q.playerName);
  if (q.parallel) parts.push(q.parallel);
  if (q.cardNumber) parts.push(`#${q.cardNumber}`);
  return parts.join(" ").trim();
}

/**
 * Match a Cardsight catalog hit against the query — same weighted scoring
 * we use for CH. Fields present on the query are checked; missing fields
 * are skipped (denominator adapts).
 */
function scoreHit(q: CardQuery, hit: CardsightCatalogHit): { score: number; matched: number; checked: number } {
  let matched = 0;
  let checked = 0;
  if (q.cardYear) {
    checked++;
    if (Number(hit.year) === q.cardYear) matched++;
  }
  if (q.cardNumber) {
    checked++;
    const a = String(q.cardNumber).toLowerCase();
    const b = String(hit.number ?? "").toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) matched++;
  }
  if (q.setName) {
    checked++;
    const a = String(q.setName).toLowerCase();
    const b = String(hit.setName ?? "").toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) matched++;
  }
  if (q.playerName) {
    checked++;
    const a = String(q.playerName).toLowerCase();
    const b = String(hit.player ?? hit.name ?? "").toLowerCase();
    if (b.includes(a)) matched++;
  }
  const score = checked === 0 ? 0 : matched / checked;
  return { score, matched, checked };
}

function tierFromScore(score: number): ResolutionConfidence {
  if (score >= 0.85) return "high";
  if (score >= 0.60) return "medium";
  return "low";
}

/**
 * Extract an authoritative FMV from a Cardsight pricing response, prefering
 * the grade the query specified. Falls back to raw median if graded miss.
 */
function extractFmv(
  pricing: Awaited<ReturnType<typeof getPricing>>,
  q: CardQuery,
): { fmv: number | null; compCount: number; lastSale: string | null } {
  if (pricing.notFound) return { fmv: null, compCount: 0, lastSale: null };

  // Graded query — try to match company + grade
  if (q.gradeCompany && q.gradeValue) {
    const companyMatch = pricing.graded.find(
      (g) => g.company_name.toLowerCase().includes(q.gradeCompany!.toLowerCase()),
    );
    if (companyMatch) {
      const gradeMatch = companyMatch.grades.find(
        (g) => Number(g.grade_value) === q.gradeValue,
      );
      if (gradeMatch && gradeMatch.records.length > 0) {
        const prices = gradeMatch.records.map((r) => r.price).filter((p) => p > 0);
        const sorted = [...prices].sort((a, b) => a - b);
        const median = sorted.length === 0
          ? 0
          : sorted.length % 2 === 1
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        const dates = gradeMatch.records.map((r) => r.date).filter((d): d is string => !!d);
        return {
          fmv: Math.round(median * 100) / 100,
          compCount: gradeMatch.count,
          lastSale: dates.sort().reverse()[0] ?? null,
        };
      }
    }
  }

  // Raw or graded-miss fallback: raw pool median
  if (pricing.raw.records.length > 0) {
    const prices = pricing.raw.records.map((r) => r.price).filter((p) => p > 0);
    const sorted = [...prices].sort((a, b) => a - b);
    const median = sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return {
      fmv: Math.round(median * 100) / 100,
      compCount: pricing.raw.count,
      lastSale: pricing.meta.last_sale_date,
    };
  }

  return { fmv: null, compCount: 0, lastSale: pricing.meta.last_sale_date };
}

export const cardsightVendorSource: VendorSource = {
  name: "cardsight",
  async resolveCard(query: CardQuery): Promise<CardResolution | null> {
    if (!isCardsightConfigured()) return null;   // graceful no-op
    if (!query.playerName && !query.cardId) return null;

    // Search for the catalog card
    const q = buildQuery(query);
    if (!q) return null;
    let hits: CardsightCatalogHit[];
    try {
      hits = await searchCatalog(q, { year: query.cardYear, take: 10 });
    } catch {
      return null;
    }
    if (!hits || hits.length === 0) return null;

    // Score each hit + pick the best
    const scored = hits
      .map((hit) => ({ hit, ...scoreHit(query, hit) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top.hit.id) return null;

    // CF-CARDSIGHT-PARALLEL-FILTER (2026-07-13): resolve the query's
    // parallel string against the catalog card's parallels list, then
    // filter pricing by that parallelId. Without this, aggregated pricing
    // mixes every variant (base + all colors + refractors) and produces
    // misleading medians for graded/high-end parallels — Drew's real
    // example: CPA-EHA Blue Refractor is ~$500-$1900 sales, but aggregated
    // pool median is ~$150 due to cheap base auto sales dragging it down.
    let parallelId: string | undefined;
    let parallelMatchedName: string | undefined;
    if (query.parallel) {
      try {
        const detail = await getCardDetail(top.hit.id);
        if (detail && Array.isArray(detail.parallels)) {
          const qp = String(query.parallel).toLowerCase().trim();
          const exact = detail.parallels.find(
            (p) => String(p.name).toLowerCase() === qp,
          );
          const partial = exact ?? detail.parallels.find(
            (p) => String(p.name).toLowerCase().includes(qp) ||
                   qp.includes(String(p.name).toLowerCase()),
          );
          if (partial) {
            parallelId = partial.id;
            parallelMatchedName = partial.name;
          }
        }
      } catch {
        // Detail fetch failed — fall back to unfiltered pricing
      }
    }

    // Get pricing for the top match, with parallel filter when available
    let pricing;
    try {
      pricing = await getPricing(top.hit.id, { parallelId });
      // Fallback: if parallel_id returned 0 comps, retry unfiltered so
      // we at least surface the pooled pricing signal (this matches the
      // pre-cutover client's fallback behavior).
      const noComps = (pricing.raw?.count ?? 0) === 0 && (pricing.graded?.length ?? 0) === 0;
      if (parallelId && noComps && !pricing.notFound) {
        pricing = await getPricing(top.hit.id);
      }
    } catch {
      return {
        vendor: "cardsight",
        cardId: top.hit.id,
        fairMarketValue: null,
        compCount: 0,
        freshestSaleDate: null,
        confidence: tierFromScore(top.score),
        raw: top.hit,
      };
    }
    const { fmv, compCount, lastSale } = extractFmv(pricing, query);

    // CF-RESOLVER-RAW-COMPS (Drew, 2026-07-13): flatten Cardsight's pricing
    // response into the resolver's per-record shape. Downstream engine
    // paths (graded projection, prediction, market read) operate on pooled
    // records, not vendor-derived aggregates, so we emit every real sale
    // — the engine decides how to bucket / weight / project from there.
    // Records with non-positive prices are dropped at this boundary so
    // engine math never has to defend against invalid data.
    const rawComps: ResolverComp[] = !pricing.notFound
      ? pricing.raw.records
          .filter((r) => typeof r.price === "number" && r.price > 0)
          .map((r) => ({ saleDate: r.date ?? null, price: r.price }))
      : [];

    const gradedComps: ResolverGradedComp[] = !pricing.notFound
      ? pricing.graded.flatMap((company) => {
          const canonicalCompany = normalizeGradeCompany(company.company_name);
          if (!canonicalCompany) return [];
          return company.grades.flatMap((grade) => {
            const gradeNum = Number(grade.grade_value);
            if (!Number.isFinite(gradeNum) || gradeNum <= 0) return [];
            return grade.records
              .filter((r) => typeof r.price === "number" && r.price > 0)
              .map((r) => ({
                saleDate: r.date ?? null,
                price: r.price,
                gradeCompany: canonicalCompany,
                gradeValue: gradeNum,
              }));
          });
        })
      : [];

    if (parallelMatchedName) {
      console.log(JSON.stringify({
        event: "cardsight_pricing_filtered_by_parallel",
        source: "cardsightVendorSource",
        cardId: top.hit.id,
        queryParallel: query.parallel,
        matchedParallel: parallelMatchedName,
        parallelId,
        compCount,
        rawCompsCount: rawComps.length,
        gradedCompsCount: gradedComps.length,
        fmv,
      }));
    }

    return {
      vendor: "cardsight",
      cardId: top.hit.id,
      fairMarketValue: fmv,
      compCount,
      freshestSaleDate: lastSale,
      confidence: tierFromScore(top.score),
      rawComps,
      gradedComps,
      raw: { hit: top.hit, pricing },
    };
  },
};

/**
 * CF-RESOLVER-RAW-COMPS (Drew, 2026-07-13): normalize Cardsight's raw
 * `company_name` (which can vary in casing / spacing) to the canonical
 * uppercase form the engine's graded-projection code expects. Returns
 * null for empty or unrecognized companies — those records are dropped
 * so downstream engine math never has to handle a "?"-tier bucket.
 */
function normalizeGradeCompany(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const upper = raw.trim().toUpperCase();
  if (upper.length === 0) return null;
  if (upper.includes("PSA")) return "PSA";
  if (upper.includes("BGS") || upper.includes("BECKETT")) return "BGS";
  if (upper.includes("SGC")) return "SGC";
  if (upper.includes("CGC")) return "CGC";
  return null;
}
