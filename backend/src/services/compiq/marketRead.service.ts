/**
 * CF-MARKET-READ (2026-06-08): "Market Read" prose paragraph for the
 * /api/compiq/price-by-id response. A 2-4 sentence calm-style summary
 * of how the comp set actually behaves, grounded in a fact pack
 * assembled from existing pipeline outputs — NO new Cardsight calls,
 * NO change to FMV / predicted / zones.
 *
 * Architecture:
 *
 *   1. buildMarketReadFactPack(pricing, grade, est, cardId)
 *      Pure-function fact pack assembly:
 *        - sampleUsed / sampleAvailable from est.compsUsed/compsAvailable
 *        - 14d-recent bin/auction split via selectSalesByGrade +
 *          applyCompQualityFilter on the cs:pricing cached payload
 *        - trend from est.trendIQ.components.cardTrajectory
 *        - exclusion reasons from the same filter pass
 *
 *   2. generateMarketRead(pricing, grade, est, cardId)
 *      Orchestrator: build fact pack → cache lookup (24h TTL keyed on
 *      hash of fact pack) → on miss, call LLM hook → validate every
 *      number in LLM output appears in fact pack → on miss/failure
 *      fall back to deterministic template.
 *
 *   3. templateMarketRead(factPack)
 *      Deterministic prose generator. Conditional phrasing: if
 *      bin/auction both ≥2 emit the split sentence; else suppress.
 *      Trend sentence uses up/down/flat phrasing based on the
 *      direction derived from pctChange (±3% deadband).
 *
 *   4. validateMarketReadNumbers(text, factPack)
 *      Extract every numeric token from the prose; assert each maps
 *      to a value in the fact pack (plus 0 as a freebie). Catches LLM
 *      hallucinations of unmapped numbers.
 *
 * The LLM client is stubbed (returns null) until OPENAI_API_KEY +
 * package integration lands as a follow-up CF. Until then the template
 * is load-bearing and the validator only sees template output (which
 * trivially passes).
 */

import crypto from "crypto";
import {
  selectSalesByGrade,
  applyCompQualityFilterDetailed,
} from "./compiqEstimate.service.js";
import { cacheWrap } from "../shared/cache.service.js";
import type {
  CardsightPricingResponse,
  CardsightSaleRecord,
} from "./cardsight.client.js";

/** Window the fact pack and trajectory operate on (matches Layer 2
 *  computeCardTrajectory's RECENT window). */
const WINDOW_DAYS = 14;

const MARKET_READ_CACHE_TTL_SECONDS = 24 * 3600;

/** Inputs the template + validator + cache key all read from. */
export interface MarketReadFactPack {
  cardId: string;
  grade: string;
  sampleUsed: number;
  sampleAvailable: number;
  windowDays: number;
  /** Min/max of the SURVIVING recent pool (post-filter). */
  priceMin: number | null;
  priceMax: number | null;
  /** Buy It Now (`listing_type === "fixed"`) median + count in the 14d
   *  recent window (post-EXCLUSION_KEYWORDS + outlier trim). */
  binMedian: number | null;
  binCount: number;
  /** Min/max of the BIN-specific surviving pool. Prose's "most of the
   *  spread" sentence cites these rather than the full-pool min/max so
   *  the BIN sentence stays internally consistent (no auction-priced
   *  $183.52 leaking into a Buy It Now spread claim). */
  binPriceMin: number | null;
  binPriceMax: number | null;
  /** Auction (`listing_type === "auction"`) median + count, same window. */
  auctionMedian: number | null;
  auctionCount: number;
  /** From cardTrajectory.pctChange; direction is derived with ±3% deadband. */
  trendDirection: "up" | "down" | "flat";
  trendPct: number;
  /** Comps dropped by applyCompQualityFilter on this grade's 14d window. */
  excludedCount: number;
  /** Price range of the EXCLUDED comps. Surfaced in S4 of the prose so
   *  users understand the excluded sales are the LOW end of the pool
   *  (typically damage/read warnings) and shouldn't be used to value
   *  their card. CF-MARKET-READ-EXCLUDED-ADVISORY (2026-06-08). */
  excludedPriceMin: number | null;
  excludedPriceMax: number | null;
  /** Top 3 exclusion reasons, plain-language. */
  topExclusionReasons: Array<{ reason: string; count: number; label: string }>;
  fmv: number | null;
}

/** Single comp dropped by applyCompQualityFilter within the 14d window.
 *  Surfaced in the route response so iOS can render a greyed
 *  "not counted" sub-section under Recent Sales (Damaged / Read desc.
 *  / price outlier tags), making the prose's advisor callout visible
 *  in the list. */
export interface ExcludedCompEntry {
  price: number;
  date: string;
  title: string;
  /** Raw key from the filter histogram, e.g. "keyword:damage", "outlier". */
  reason: string;
  /** Plain-language label, same vocabulary as topExclusionReasons. */
  label: string;
}

export interface MarketReadResult {
  marketRead: string;
  source: "llm" | "template";
  factPack: MarketReadFactPack;
  factPackHash: string;
  /** In-window excluded comps with per-comp reasons. Always present
   *  (empty array when nothing was excluded). */
  excludedComps: ExcludedCompEntry[];
}

/** CF-MARKET-READ-EXCLUDED-CALLOUT (2026-06-08): condition-flag classifier.
 *  Distinguishes reasons that imply ACTUAL DAMAGE / READ-DESCRIPTION
 *  warnings on the comp (damaged, please read, as-is, etc.) from
 *  pure-statistical outliers and other disqualifications (lot sales,
 *  digital, etc.). The S4 advisor uses this to gate the damaged/read
 *  callout — we only claim "these went low because of condition" when
 *  the excluded set actually contains condition-flagged comps. Pure
 *  outliers get the neutral "set aside as outliers" line. */
const CONDITION_KEYWORD_STEMS: ReadonlySet<string> = new Set([
  "damage", "damaged", "crease", "creased", "bent", "flaw",
  "scuff", "stain", "worn", "water damage",
  "writing on", "marks on",
  "trimmed", "altered", "restored", "repaired",
  "poor condition", "fair condition", "rough condition", "rough shape",
  "see description", "see desc",
  "please read", "read description", "read desciption",
  "as is", "as-is", "(as is)", "(as-is)",
]);

export function isConditionReason(reason: string): boolean {
  if (reason === "outlier") return false;
  if (reason === "invalid") return false;
  const stem = reason.replace(/^keyword:/, "");
  return CONDITION_KEYWORD_STEMS.has(stem);
}

type EnrichedComp = {
  price: number;
  title: string;
  soldDate: string;
  listingType: string | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map a `keyword:<stem>` reason to a friendly noun phrase for prose. */
function friendlyExclusionLabel(reason: string): string {
  if (reason === "outlier") return "price outliers";
  if (reason === "invalid") return "missing data";
  // keyword:xyz
  const stem = reason.replace(/^keyword:/, "");
  if (stem === "damage" || stem === "damaged") return "seller-described damage";
  if (stem === "crease" || stem === "creased") return "creases";
  if (stem === "bent") return "bends";
  if (stem === "flaw") return "flaws";
  if (stem === "scuff") return "scuffs";
  if (stem === "stain") return "stains";
  if (stem === "worn") return "wear";
  if (stem === "trimmed") return "trimming";
  if (stem === "altered") return "alteration";
  if (stem === "restored") return "restoration";
  if (stem === "repaired") return "repairs";
  if (stem === "fake") return "fakes";
  if (stem === "reprint") return "reprints";
  if (stem === "please read" || stem === "read description" || stem === "read desciption") {
    return "seller condition warnings";
  }
  if (stem === "as is" || stem === "as-is" || stem === "(as is)" || stem === "(as-is)") {
    return "as-is sales";
  }
  if (stem === "see description" || stem === "see desc") return "seller condition warnings";
  if (stem === "lot of" || stem === "lot" || stem === "bundle" || stem === "collection") {
    return "lot sales";
  }
  if (stem === "reprint" || stem === "fake") return "reprints";
  if (stem === "redemption" || stem === "placeholder" || stem === "digital") return "non-physical listings";
  if (stem === "poor condition" || stem === "fair condition" || stem === "rough condition" || stem === "rough shape") {
    return "low-condition listings";
  }
  return stem;
}

/** Build the excluded-comps array from a detailed-filter pass. Sorted
 *  by date descending (newest first) so the iOS list reads naturally. */
function buildExcludedComps(
  excludedDetail: Array<{ comp: EnrichedComp; reason: string }>,
): ExcludedCompEntry[] {
  return excludedDetail
    .map((e) => ({
      price: round2(e.comp.price),
      date: e.comp.soldDate,
      title: e.comp.title,
      reason: e.reason,
      label: friendlyExclusionLabel(e.reason),
    }))
    .sort((a, b) => {
      const ta = Date.parse(a.date) || 0;
      const tb = Date.parse(b.date) || 0;
      return tb - ta;
    });
}

/** Internal: runs the filter ONCE and returns both the fact pack and the
 *  per-comp excluded-comps array. Used by generateMarketRead; the public
 *  buildMarketReadFactPack delegates to this and returns just the fact
 *  pack so existing callers / tests keep their signature. */
function buildFactPackAndExcludedInternal(
  pricing: CardsightPricingResponse,
  grade: string,
  est: Record<string, unknown>,
  cardId: string,
): { factPack: MarketReadFactPack; excludedComps: ExcludedCompEntry[] } {
  const sales: CardsightSaleRecord[] = selectSalesByGrade(pricing as unknown as Parameters<typeof selectSalesByGrade>[0], grade);

  const enriched: EnrichedComp[] = sales
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .map((s) => ({
      price: s.price,
      title: s.title ?? "",
      soldDate: s.date ?? "",
      listingType: (s as { listing_type?: string | null }).listing_type ?? null,
    }));

  // Window FIRST, then quality-filter. Why this order vs the trend
  // pool: the trend pool applies the filter to ALL dates (CF-TREND-
  // DIRTY-POOL) so the outlier-trim's MAD has a stable population.
  // But for the user-facing excludedCount we want a number that
  // describes the WINDOW, not the historical population. If a 60-day-
  // old $800 sale gets MAD-trimmed, it's noise to a user reading the
  // 14-day Market Read paragraph. The bin/auction medians + counts
  // also become directly comparable to compsUsed/compsAvailable from
  // the same window.
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 24 * 3600 * 1000;
  const windowed = enriched.filter((c) => {
    const ts = Date.parse(c.soldDate);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const qualityResult = applyCompQualityFilterDetailed(
    windowed as Parameters<typeof applyCompQualityFilterDetailed>[0],
    { player: null, year: null, set: null },
  );
  const recent = qualityResult.filtered as unknown as EnrichedComp[];
  const excludedCount = qualityResult.excluded.length;
  const reasonHistogram = qualityResult.reasons;
  const excludedDetail = qualityResult.excluded;

  const excludedPrices = excludedDetail.map((e) => e.comp.price);
  const excludedPriceMin = excludedPrices.length > 0 ? Math.min(...excludedPrices) : null;
  const excludedPriceMax = excludedPrices.length > 0 ? Math.max(...excludedPrices) : null;

  const bin = recent.filter((c) => c.listingType === "fixed");
  const auction = recent.filter((c) => c.listingType === "auction");

  const recentPrices = recent.map((c) => c.price);
  const priceMin = recentPrices.length > 0 ? Math.min(...recentPrices) : null;
  const priceMax = recentPrices.length > 0 ? Math.max(...recentPrices) : null;

  const binPrices = bin.map((c) => c.price);
  const binPriceMin = binPrices.length > 0 ? Math.min(...binPrices) : null;
  const binPriceMax = binPrices.length > 0 ? Math.max(...binPrices) : null;

  const trajectory = (est?.trendIQ as { components?: { cardTrajectory?: { pctChange?: number } } } | undefined)
    ?.components?.cardTrajectory;
  const rawPct = typeof trajectory?.pctChange === "number" ? trajectory.pctChange : 0;
  const trendPct = round2(rawPct);
  const trendDirection: "up" | "down" | "flat" =
    trendPct > 3 ? "up" : trendPct < -3 ? "down" : "flat";

  const topExclusionReasons = Object.entries(reasonHistogram)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({
      reason,
      count,
      label: friendlyExclusionLabel(reason),
    }));

  const sampleUsed = typeof est?.compsUsed === "number" ? est.compsUsed : recent.length;
  const sampleAvailable = typeof est?.compsAvailable === "number" ? est.compsAvailable : sales.length;
  const fmv = typeof est?.fairMarketValue === "number" ? est.fairMarketValue : null;

  const factPack: MarketReadFactPack = {
    cardId,
    grade,
    sampleUsed,
    sampleAvailable,
    windowDays: WINDOW_DAYS,
    priceMin: priceMin !== null ? round2(priceMin) : null,
    priceMax: priceMax !== null ? round2(priceMax) : null,
    binMedian: bin.length > 0 ? round2(median(bin.map((c) => c.price)) ?? 0) : null,
    binCount: bin.length,
    binPriceMin: binPriceMin !== null ? round2(binPriceMin) : null,
    binPriceMax: binPriceMax !== null ? round2(binPriceMax) : null,
    auctionMedian: auction.length > 0 ? round2(median(auction.map((c) => c.price)) ?? 0) : null,
    auctionCount: auction.length,
    trendDirection,
    trendPct,
    excludedCount,
    excludedPriceMin: excludedPriceMin !== null ? round2(excludedPriceMin) : null,
    excludedPriceMax: excludedPriceMax !== null ? round2(excludedPriceMax) : null,
    topExclusionReasons,
    fmv: fmv !== null ? round2(fmv) : null,
  };

  const excludedComps = buildExcludedComps(
    excludedDetail as Array<{ comp: EnrichedComp; reason: string }>,
  );

  return { factPack, excludedComps };
}

/** Public wrapper: returns just the fact pack. Preserved for tests +
 *  external callers that only need the prose-input shape. */
export function buildMarketReadFactPack(
  pricing: CardsightPricingResponse,
  grade: string,
  est: Record<string, unknown>,
  cardId: string,
): MarketReadFactPack {
  return buildFactPackAndExcludedInternal(pricing, grade, est, cardId).factPack;
}

/** Round dollar amount for display in prose. Whole dollars; the
 *  validator allows both precise and rounded forms so this is just a
 *  cosmetic display choice. */
function dollar(n: number | null): string {
  if (n === null) return "";
  return String(Math.round(n));
}

/** Join 1-3 labels into "A", "A or B", or "A, B, or C" for the S4
 *  callout. Disjunctive "or" — each excluded comp matches one reason,
 *  not all. */
function joinReasonsDisjunctive(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

/** Deterministic prose generator. 2-4 sentences depending on what the
 *  fact pack supports. Used as the fallback whenever the LLM is
 *  unavailable / returns invalid output / token budget is exhausted.
 *
 *  CF-MARKET-READ-ADVISOR-VOICE (2026-06-08): S1+S2 merged into a single
 *  benchmark + selling-counsel sentence (leads with the anchor, weaves
 *  the bin/auction counts in mid-sentence, gives a route recommendation).
 *  S3 is trend counsel — pct dropped on flat ("no urgency either
 *  direction"), kept on up/down with directional advice ("paying up" /
 *  "if you're selling, sooner may beat later"). S4 unchanged (already
 *  advisor-toned in CF-MARKET-READ-EXCLUDED-CALLOUT).
 *
 *  Hard rules: every numeric token must trace to the fact pack (whole-
 *  dollar rounded for prose; validator allows both forms); no
 *  guarantees; counsel matches trendDirection. */
export function templateMarketRead(fp: MarketReadFactPack): string {
  const out: string[] = [];
  const gradeLabel = fp.grade === "Raw" ? "raw" : fp.grade;
  // "clean raw copy" reads naturally; for graded, "clean" is implied
  // by the slab — drop it ("PSA 10 copy", "BGS 9.5 copy").
  const openingNoun = fp.grade === "Raw" ? "clean raw copy" : `${fp.grade} copy`;

  // S1+S2 — benchmark + selling counsel.
  if (fp.sampleUsed === 0) {
    // Thin-sample fallback — nothing to anchor on yet.
    out.push(`Too few recent ${gradeLabel} sales to give a confident benchmark right now.`);
  } else if (
    fp.binCount >= 2 &&
    fp.auctionCount >= 2 &&
    fp.binMedian !== null &&
    fp.auctionMedian !== null
  ) {
    // Both formats represented. Phrasing splits on whether auctions
    // close lower than fixed-price (typical) or land higher (rare on
    // liquid cards but does happen).
    const binSpreadClause =
      fp.binPriceMin !== null && fp.binPriceMax !== null && fp.binPriceMin !== fp.binPriceMax
        ? `, mostly $${dollar(fp.binPriceMin)}–$${dollar(fp.binPriceMax)}`
        : "";
    if (fp.auctionMedian < fp.binMedian) {
      out.push(
        `For a ${openingNoun}, anchor to the fixed-price market — those are settling around $${dollar(fp.binMedian)} (${fp.binCount} sales${binSpreadClause}) — while auctions close lower near $${dollar(fp.auctionMedian)}, so listing it and being patient tends to beat a quick auction.`,
      );
    } else {
      out.push(
        `For a ${openingNoun}, anchor to the fixed-price market — those are settling around $${dollar(fp.binMedian)} (${fp.binCount} sales${binSpreadClause}) — auctions are landing near $${dollar(fp.auctionMedian)}, so either route can work.`,
      );
    }
  } else if (fp.binCount >= 3 && fp.binMedian !== null) {
    // Bin-only (no/thin auction data).
    const binSpreadClause =
      fp.binPriceMin !== null && fp.binPriceMax !== null && fp.binPriceMin !== fp.binPriceMax
        ? `, mostly $${dollar(fp.binPriceMin)}–$${dollar(fp.binPriceMax)}`
        : "";
    out.push(
      `For a ${openingNoun}, anchor to the fixed-price market — those are settling around $${dollar(fp.binMedian)} (${fp.binCount} sales${binSpreadClause}).`,
    );
  } else if (fp.auctionCount >= 3 && fp.auctionMedian !== null) {
    // Auction-only (no/thin BIN data) — different counsel.
    out.push(
      `Recent activity is mostly auctions (${fp.auctionCount} sales) closing around $${dollar(fp.auctionMedian)} — auction closes typically run below fixed-price, so listing it and being patient may beat a quick auction.`,
    );
  }

  // S3 — trend counsel. Drop pct on flat; keep on up/down.
  if (fp.trendDirection === "up") {
    out.push(`Momentum's building — buyers are paying up about ${fp.trendPct}%.`);
  } else if (fp.trendDirection === "down") {
    const absPct = Math.abs(fp.trendPct);
    out.push(`Cooling off about ${absPct}% — if you're selling, sooner may beat later.`);
  } else {
    out.push(`The market's held steady the past two weeks, so there's no urgency either direction.`);
  }

  // Sentence 4 — exclusion advisor.
  // CF-MARKET-READ-EXCLUDED-CALLOUT (2026-06-08): three variants.
  //
  //   A) DAMAGED/READ variant — fires when topExclusionReasons contains
  //      at least one condition-flagged reason (damage, please read,
  //      crease, scuff, etc.). Names the comps as the cheapest, attributes
  //      the LOW price to the condition flags, and tells the user not to
  //      value a clean card against them. Cites ONLY the condition labels
  //      (not "outlier") so the prose doesn't conflate the stat-cut with
  //      the condition cut.
  //
  //   B) OUTLIER-ONLY variant — fires when all exclusions are "outlier".
  //      Neutral phrasing: "X sales were set aside as outliers." No
  //      damage/read claim because there's no condition signal.
  //
  //   C) GENERIC variant — fires for everything else (e.g. lot sales,
  //      digital listings). Names the reasons without the condition
  //      advisory.
  if (fp.excludedCount > 0 && fp.topExclusionReasons.length > 0) {
    const conditionReasons = fp.topExclusionReasons.filter((r) => isConditionReason(r.reason));
    const isOutlierOnly =
      fp.topExclusionReasons.length > 0 &&
      fp.topExclusionReasons.every((r) => r.reason === "outlier");

    const saleNoun = fp.excludedCount === 1 ? "sale" : "sales";
    const wasOrWere = fp.excludedCount === 1 ? "was" : "were";

    let rangeClause = "";
    if (
      fp.excludedPriceMin !== null &&
      fp.excludedPriceMax !== null &&
      fp.excludedPriceMin !== fp.excludedPriceMax
    ) {
      rangeClause = ` (between $${dollar(fp.excludedPriceMin)} and $${dollar(fp.excludedPriceMax)})`;
    } else if (fp.excludedPriceMin !== null) {
      rangeClause = ` (around $${dollar(fp.excludedPriceMin)})`;
    }

    if (conditionReasons.length > 0) {
      // Variant A — damaged/read. Cite only condition labels.
      const condLabels = conditionReasons.map((r) => r.label);
      const condText = joinReasonsDisjunctive(condLabels);
      const cheapestNoun =
        fp.excludedCount === 1 ? "The cheapest sale" : `The ${fp.excludedCount} cheapest sales`;
      out.push(
        `${cheapestNoun}${rangeClause} ${fp.excludedCount === 1 ? "is" : "are"} flagged for ${condText} — that's why ${fp.excludedCount === 1 ? "it" : "they"} sold low. Don't value a clean card against ${fp.excludedCount === 1 ? "it" : "them"}.`,
      );
    } else if (isOutlierOnly) {
      // Variant B — outlier-only neutral.
      out.push(`${fp.excludedCount} ${saleNoun} ${wasOrWere} set aside as outliers.`);
    } else {
      // Variant C — generic mixed (no condition flags, not all outliers).
      const labels = fp.topExclusionReasons.map((r) => r.label);
      const reasonText = joinReasonsDisjunctive(labels);
      out.push(
        `${fp.excludedCount} ${saleNoun}${rangeClause} ${wasOrWere} excluded for ${reasonText}.`,
      );
    }
  }

  return out.join(" ");
}

/** Every numeric token in `text` must map to a fact-pack value. Catches
 *  LLM hallucinations of unmapped numbers (the most common failure mode
 *  with grounded-prose generation). */
export function validateMarketReadNumbers(
  text: string,
  fp: MarketReadFactPack,
): { ok: boolean; offendingNumbers: number[]; allowedNumbers: number[] } {
  const allowed = new Set<number>([0]);
  const add = (v: number | null | undefined): void => {
    if (typeof v === "number" && Number.isFinite(v)) {
      allowed.add(round2(v));
      // Common rounding variants: integer form, absolute value (for negative trends).
      allowed.add(Math.round(v));
      allowed.add(Math.abs(round2(v)));
      allowed.add(Math.abs(Math.round(v)));
    }
  };
  add(fp.sampleUsed);
  add(fp.sampleAvailable);
  add(fp.windowDays);
  add(fp.priceMin);
  add(fp.priceMax);
  add(fp.binMedian);
  add(fp.binCount);
  add(fp.binPriceMin);
  add(fp.binPriceMax);
  add(fp.auctionMedian);
  add(fp.auctionCount);
  add(fp.trendPct);
  add(fp.excludedCount);
  add(fp.excludedPriceMin);
  add(fp.excludedPriceMax);
  add(fp.fmv);

  const matches = text.match(/-?\$?\d+(?:\.\d+)?/g) ?? [];
  const offending: number[] = [];
  for (const m of matches) {
    const n = Number(m.replace("$", ""));
    if (!Number.isFinite(n)) continue;
    if (!allowed.has(n) && !allowed.has(round2(n))) {
      offending.push(n);
    }
  }
  return {
    ok: offending.length === 0,
    offendingNumbers: offending,
    allowedNumbers: Array.from(allowed).sort((a, b) => a - b),
  };
}

/** Stable hash over the load-bearing fact-pack fields. Cache key
 *  invalidates only when one of these changes — small price wiggles
 *  or new comps WILL change the hash and force regeneration. */
export function hashFactPack(fp: MarketReadFactPack): string {
  const stable = JSON.stringify({
    sampleUsed: fp.sampleUsed,
    sampleAvailable: fp.sampleAvailable,
    binMedian: fp.binMedian,
    binCount: fp.binCount,
    binPriceMin: fp.binPriceMin,
    binPriceMax: fp.binPriceMax,
    auctionMedian: fp.auctionMedian,
    auctionCount: fp.auctionCount,
    trendPct: fp.trendPct,
    excludedCount: fp.excludedCount,
    excludedPriceMin: fp.excludedPriceMin,
    excludedPriceMax: fp.excludedPriceMax,
    priceMin: fp.priceMin,
    priceMax: fp.priceMax,
    fmv: fp.fmv,
  });
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/** Build the prompt the LLM would receive. Kept as a named function
 *  so it's testable and so the integration-CF reviewer can see the
 *  exact contract (fact pack → ground rules → output format). */
export function buildLLMPrompt(fp: MarketReadFactPack): string {
  return [
    "You write 2-4 calm sentences summarizing the recent comp pool for a single trading card.",
    "Use ONLY the numbers from the FACT PACK below — invent no figures. Hedge appropriately;",
    'the bin vs auction split is directional, not absolute — phrasings like "most of the spread,"',
    '"tend toward," "cluster around" are preferred over hard claims. No emoji. No headlines.',
    "If a fact is null or zero, do not invent context.",
    "",
    "FACT PACK:",
    JSON.stringify(fp, null, 2),
  ].join("\n");
}

/** LLM call hook. Returns null in this build — no OpenAI client is
 *  wired up yet. The fact pack + prompt + validator + cache are all in
 *  place so the integration CF only needs to swap this stub with a real
 *  call (e.g. openai.chat.completions.create). When wired:
 *    - Read OPENAI_API_KEY from env; null when unset
 *    - Token budget cap; null on rejection
 *    - Timeout (5s) → null on timeout
 *    - Strip leading/trailing quotes the model occasionally adds */
async function callLLMMarketRead(_fp: MarketReadFactPack): Promise<string | null> {
  // Future integration; see CF-MARKET-READ-LLM-WIRE-UP.
  return null;
}

/** Orchestrator. Cached on the fact-pack hash so identical comp sets
 *  produce identical text + excluded-comps list without burning tokens. */
export async function generateMarketRead(
  pricing: CardsightPricingResponse,
  grade: string,
  est: Record<string, unknown>,
  cardId: string,
): Promise<MarketReadResult> {
  const { factPack, excludedComps } = buildFactPackAndExcludedInternal(pricing, grade, est, cardId);
  const factPackHash = hashFactPack(factPack);
  const cacheKey = `marketread:v1:${cardId}|${grade}|${factPackHash}`;

  return await cacheWrap(
    cacheKey,
    async () => {
      let marketRead: string | null = null;
      let source: "llm" | "template" = "template";

      try {
        const llmText = await callLLMMarketRead(factPack);
        if (llmText && llmText.trim().length > 0) {
          const verdict = validateMarketReadNumbers(llmText, factPack);
          if (verdict.ok) {
            marketRead = llmText.trim();
            source = "llm";
          } else {
            console.warn(
              `[marketRead] LLM output rejected (unmapped numbers: ${verdict.offendingNumbers.join(", ")}). Falling back to template.`,
            );
          }
        }
      } catch (err) {
        console.warn(`[marketRead] LLM call failed (non-fatal): ${(err as Error)?.message ?? err}`);
      }

      if (!marketRead) {
        marketRead = templateMarketRead(factPack);
        source = "template";
      }

      return { marketRead, source, factPack, factPackHash, excludedComps };
    },
    MARKET_READ_CACHE_TTL_SECONDS,
  ) as MarketReadResult;
}
