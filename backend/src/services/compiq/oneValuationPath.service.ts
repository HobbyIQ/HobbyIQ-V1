/**
 * CF-ONE-VALUATION-PATH (D16, 2026-08-30). ONE computation behind the four
 * pricing routes — `/price-by-id`, `/canonical-fmv`, `/hobbyiq-fmv` and
 * `/observed-grade-curve` — so they cannot disagree.
 *
 * The D14 probe (probe-price-routes, 200 checklist-backed slugs with >= 3
 * raw sales) found the four routes disagreeing by more than 25% on 44.2% of
 * (slug, Raw): 2018 Bowman #49 Gold priced $11,995 / $11,995 / $3,893.55 /
 * $88 off a pool of three sales. Each route ran its own engine over its own
 * pool — canonical-fmv's five-source ladder keyed by cardId, hobbyIqFmv's
 * unified call at the density window, the curve's unified overlay at a
 * fixed 180d window unioned with a vendor id — and labelled the result with
 * its own vocabulary (`direct-comp` on one wire, `unified-market-value` on
 * another, both outside the rung vocabulary).
 *
 * This module is not a fifth engine. It is the ENTRY: the identity is
 * resolved once (a catalog slug — a vendor id maps to its slug through the
 * catalog, never minted), the exact pool is priced once by the unified
 * engine (exactPoolSupremacy.priceHoldingFromExactPool: hobbyiqCardId alone
 * first, its numbered / un-numbered twin second, >= 1 sale; every tier at
 * its own density-chosen window), and the grade curve is that same result
 * mapped over the canonical tiers. The headline for any tier IS its curve
 * entry, by construction. The rung label is the engine's, in the closed
 * vocabulary (fmvRung.ts).
 *
 * When the requested tier has no exact pool:
 *   1. the identity's OTHER tiers anchor an empirical-ratio fill
 *      (`grade-curve-estimate` — this card's own sales × GRADE_CALIBRATION;
 *      no hardcoded matrix, no clamp on anything observed);
 *   2. with no sale of this identity at any grade, the GATED fallback ladder
 *      (hobbyIqFmv with the exact pool skipped: cross-setkey inside the
 *      product family and player, sibling parallels, family baseline, the
 *      rare-card anchor …) may answer, under its own honest rung name;
 *   3. otherwise the answer is null with a stated reason — on every route.
 *
 * Doctrine: FMV is the projected next sale from the exact-identity pool,
 * never a median (the engine's thin-pool rung says "weighted-median" when
 * that is what it had); grade monotonicity is not an invariant (an observed
 * tier is never rewritten); multipliers are empirical only.
 */
import { type FmvRungLabel } from "./fmvRung.js";
import type { UnifiedGradeEntry, UnifiedPriceResult } from "./unifiedPricing.service.js";
import {
  applyUnifiedTierToEntry,
  blankGradeCurveEntry,
  gradeCurveEntryLabel,
  unifiedTierHasPool,
} from "./gradeCurveEntry.js";
import {
  CANONICAL_GRADES,
  capProjectedTiers,
  computeConfidence,
  fillUnavailableTiersFromAnchor,
  type ObservedGradeEntry,
} from "./observedGradeCurve.service.js";
import { priceHoldingFromExactPool } from "../portfolioiq/exactPoolSupremacy.js";
import { computeHobbyIqFmv, type HobbyIqFmvResult } from "../portfolioiq/hobbyIqFmv.service.js";
import { catalogSlugIfExists, readCatalogIdentityBySlug } from "../catalog/catalogMatcher.service.js";
import { lookupHobbyIqCardIdForVendorCardId } from "../portfolioiq/soldCompsStore.service.js";
import { parseHobbyIqCardId } from "../portfolioiq/hobbyIqCardId.service.js";

export interface ValuationGrade {
  company: string | null;
  value: number | null;
}

export interface ValuationRequest {
  /** An hiq slug, or a vendor id the catalog can map to one. */
  id: string;
  /** undefined / null / no company → the Raw tier. */
  grade?: ValuationGrade | null;
  /** The caller's print run, when it knows one the slug does not carry. */
  printRun?: number | null;
  /** The caller's player name (a holding's), for the cross-setkey rule. */
  playerName?: string | null;
  /** Portfolio callers: keep the user's own purchases out of the pool. */
  excludeContributorUserId?: string | null;
}

/** Why there is no number, when there is none. */
export type ValuationReason =
  /** An hiq slug the catalog does not hold — no identity, no pool. */
  | "identity-not-in-catalog"
  /** A vendor id no catalog slug maps to. */
  | "no-catalog-identity"
  /** No sale of this identity in 180d at any grade, and the gated fallback
   *  ladder found nothing either. */
  | "no-exact-pool"
  /** This identity has sales at other grades, but none at the requested
   *  tier, no empirical ratio to project it, and the ladder found nothing. */
  | "no-exact-pool-at-tier"
  | null;

export interface ValuationIdentity {
  /** The catalog's form of the slug (a numbered slug may resolve to its
   *  un-numbered twin). Null when unresolved. */
  slug: string | null;
  /** The id the caller sent. */
  requestedId: string;
  /** The identity the unified engine actually read (the slug or its twin). */
  pooledAs: string | null;
  sport: string | null;
  year: number | null;
  setKey: string | null;
  setName: string | null;
  cardNumber: string | null;
  /** Pretty parallel name ("Gold Refractor"), "Base" for the base card. */
  parallel: string;
  parallelSlug: string | null;
  isAuto: boolean;
  printRun: number | null;
  playerName: string | null;
  imageUrl: string | null;
}

export interface Valuation {
  /** The projected next sale for the requested tier; null with `reason`. */
  fairMarketValue: number | null;
  /** The rung that produced it, in the closed vocabulary; "no-basis" when null. */
  rungLabel: FmvRungLabel;
  valueSource: "observed" | "estimated" | "unavailable";
  reason: ValuationReason;
  /** Sales that priced the number: the tier's pool size on an exact-pool
   *  rung, the ladder's comp count on a fallback rung, 0 on a fill. */
  compsUsed: number;
  /** The engine's confidence for the rung (its own scale). */
  confidence: number;
  /** Prose for the transparency sheet. Never the label. */
  basis: string;
  identity: ValuationIdentity;
  /** "Raw" | "PSA 10" — the tier the headline describes. */
  requestedTier: string;
  /** The requested tier's window when the exact pool priced it. */
  windowDays: number | null;
  trend: { direction: "up" | "down" | "flat"; pctPerWeek: number | null };
  /** The same fit read at +7d (the observed band's centre). */
  predictedPrice: number | null;
  /** DIAGNOSTIC: the pool's recency-weighted median. Never the headline. */
  weightedMedian: number | null;
  /** The sales behind the headline, newest first (exact-pool rungs only). */
  sales: Array<{ price: number; soldAt: string; source: string | null }>;
  /** Every canonical tier (plus any tier the pool has that the canonical
   *  list does not), each from the same engine result; the requested tier's
   *  entry IS the headline. */
  gradeCurve: ObservedGradeEntry[];
  totalSampleCount: number;
  /** The engine's result, when the identity had a pool. */
  unified: UnifiedPriceResult | null;
  /** The gated ladder's answer, when it was asked. */
  fallback: HobbyIqFmvResult | null;
  computedAt: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const prettySeg = (v: string | null | undefined): string => String(v ?? "")
  .split("-").filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The engine's tier label for a grade: "Raw", or "PSA 10". */
export function tierLabelFor(grade: ValuationGrade | null | undefined): string {
  const company = String(grade?.company ?? "").trim();
  if (!company) return "Raw";
  return `${company.toUpperCase()} ${grade?.value ?? "?"}`;
}

/** Normalize a caller's grade: no company → Raw (null). */
export function normalizeGrade(grade: ValuationGrade | null | undefined): ValuationGrade | null {
  const company = String(grade?.company ?? "").trim();
  if (!company) return null;
  const v = grade?.value;
  return { company: company.toUpperCase(), value: typeof v === "number" && Number.isFinite(v) ? v : null };
}

function blankIdentity(requestedId: string): ValuationIdentity {
  return {
    slug: null, requestedId, pooledAs: null,
    sport: null, year: null, setKey: null, setName: null, cardNumber: null,
    parallel: "Base", parallelSlug: null, isAuto: false, printRun: null,
    playerName: null, imageUrl: null,
  };
}

/** Resolve the caller's id to the catalog's slug and the identity block.
 *  A vendor id maps through sold_comps (the rows carry both ids) and then
 *  the catalog must hold the slug — nothing is minted here. */
export async function resolveValuationIdentity(
  requestedId: string,
  printRunHint: number | null,
): Promise<{ identity: ValuationIdentity; reason: ValuationReason }> {
  const id = String(requestedId ?? "").trim();
  const identity = blankIdentity(id);
  if (!id) return { identity, reason: "no-catalog-identity" };

  let candidate: string | null = null;
  let missReason: ValuationReason = "no-catalog-identity";
  if (id.startsWith("hiq:")) {
    candidate = id;
    missReason = "identity-not-in-catalog";
  } else {
    try { candidate = await lookupHobbyIqCardIdForVendorCardId(id); } catch { candidate = null; }
  }
  const slug = candidate ? await catalogSlugIfExists(candidate) : null;
  if (!slug) return { identity, reason: missReason };

  const parsed = parseHobbyIqCardId(slug);
  const seg = slug.split(":");
  const row = await readCatalogIdentityBySlug(slug).catch(() => null);
  identity.slug = slug;
  identity.sport = row?.sport ?? parsed?.sport ?? seg[1] ?? null;
  identity.year = row?.year ?? parsed?.year ?? (Number(seg[2]) || null);
  identity.setKey = parsed?.setKey ?? seg[3] ?? row?.setKey ?? null;
  identity.setName = row?.setName ?? null;
  identity.cardNumber = String(row?.cardNumber ?? parsed?.cardNumber ?? seg[4] ?? "").toUpperCase() || null;
  identity.parallelSlug = seg[5] ?? null;
  identity.parallel = row?.parallel
    ?? (parsed?.parallel && parsed.parallel.toLowerCase() !== "base" ? parsed.parallel : null)
    ?? (seg[5] && seg[5] !== "base" ? prettySeg(seg[5]) : "Base");
  identity.isAuto = row?.isAuto ?? parsed?.isAuto ?? seg[6] === "auto";
  identity.printRun = printRunHint ?? parsed?.printRun ?? row?.printRun ?? null;
  identity.playerName = row?.playerName ?? null;
  identity.imageUrl = row?.imageUrl ?? null;
  return { identity, reason: null };
}

/** Every canonical tier as a blank entry, in canonical order. */
function blankCurve(): ObservedGradeEntry[] {
  return CANONICAL_GRADES.map((g) => blankGradeCurveEntry(g.label, g.grader));
}

/** Map the engine's tiers onto the canonical entries (and append any tier the
 *  pool has that the canonical list does not), through the ONE writer of a
 *  tier's numbers (gradeCurveEntry.applyUnifiedTierToEntry). */
export function curveFromUnified(u: UnifiedPriceResult, nowMs: number): ObservedGradeEntry[] {
  const entries = blankCurve();
  const byLabel = new Map<string, UnifiedGradeEntry>(u.gradeCurve.map((e) => [e.grade, e]));
  const seen = new Set<string>();
  const stampSales = (entry: ObservedGradeEntry, um: UnifiedGradeEntry) => {
    const sales = um.sales ?? [];
    entry.salesHistory = sales.map((s) => ({ price: s.price, date: s.soldAt, saleType: null }));
    entry.newestSalePrice = sales.length > 0 ? sales[0].price : null;
    let oldest: string | null = null;
    for (const s of sales) if (oldest === null || s.soldAt < oldest) oldest = s.soldAt;
    entry.oldestSaleDate = oldest;
  };
  for (const entry of entries) {
    const label = gradeCurveEntryLabel(entry);
    seen.add(label);
    const um = byLabel.get(label);
    if (um && unifiedTierHasPool(um)) {
      applyUnifiedTierToEntry(entry, um, { confidenceScore: computeConfidence(um.sampleCount, um.newestSaleDate), nowMs });
      stampSales(entry, um);
    }
  }
  for (const um of u.gradeCurve) {
    if (seen.has(um.grade) || !unifiedTierHasPool(um)) continue;
    if (/\?/.test(um.grade)) continue;   // a grader with no numeric grade is not a tier
    const grader = um.gradeCompany ? String(um.gradeCompany).toUpperCase() : "Raw";
    const extra = applyUnifiedTierToEntry(blankGradeCurveEntry(um.grade, grader), um, {
      confidenceScore: computeConfidence(um.sampleCount, um.newestSaleDate), nowMs,
    });
    stampSales(extra, um);
    let insertAt = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].grader === grader) { insertAt = i + 1; break; }
    }
    entries.splice(insertAt, 0, extra);
    seen.add(um.grade);
  }
  return entries;
}

/**
 * THE entry. One identity, one engine call, one curve; the headline for the
 * requested tier is that tier's curve entry.
 */
export async function valueIdentity(req: ValuationRequest): Promise<Valuation> {
  const nowMs = Date.now();
  const grade = normalizeGrade(req.grade);
  const requestedTier = tierLabelFor(grade);
  const printRunHint = typeof req.printRun === "number" && Number.isFinite(req.printRun) && req.printRun > 0
    ? Math.trunc(req.printRun) : null;

  const base = (identity: ValuationIdentity): Valuation => ({
    fairMarketValue: null,
    rungLabel: "no-basis",
    valueSource: "unavailable",
    reason: null,
    compsUsed: 0,
    confidence: 0,
    basis: "",
    identity,
    requestedTier,
    windowDays: null,
    trend: { direction: "flat", pctPerWeek: null },
    predictedPrice: null,
    weightedMedian: null,
    sales: [],
    gradeCurve: blankCurve(),
    totalSampleCount: 0,
    unified: null,
    fallback: null,
    computedAt: new Date(nowMs).toISOString(),
  });

  const { identity, reason: idReason } = await resolveValuationIdentity(req.id, printRunHint);
  if (!identity.slug || idReason) {
    const v = base(identity);
    v.reason = idReason ?? "no-catalog-identity";
    v.basis = v.reason === "identity-not-in-catalog"
      ? `${identity.requestedId} is not a catalog row — no identity, no pool`
      : `${identity.requestedId} maps to no catalog identity — no pool`;
    return v;
  }
  const slug = identity.slug;
  const playerName = req.playerName ?? identity.playerName ?? null;

  // ── 1. The exact pool, priced once ─────────────────────────────────────
  const exact = await priceHoldingFromExactPool(
    { hobbyiqCardId: slug, cardId: null, printRun: identity.printRun },
    {
      grade,
      playerName,
      cardYear: identity.year,
      excludeContributorUserId: req.excludeContributorUserId ?? null,
      perTierWindows: true,
    },
  );
  const v = base(identity);
  const u = exact?.u ?? null;
  v.unified = u;
  if (exact) v.identity.pooledAs = exact.attempt.cardId;
  if (u) {
    v.gradeCurve = curveFromUnified(u, nowMs);
    v.totalSampleCount = u.totalSampleCount;
  }

  const findTier = (): ObservedGradeEntry => {
    let entry = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === requestedTier);
    if (!entry) {
      entry = blankGradeCurveEntry(requestedTier, grade?.company ?? "Raw");
      v.gradeCurve.push(entry);
    }
    return entry;
  };
  let tier = findTier();

  // The requested tier has its own pool: the exact-pool rung, the engine's
  // number, the engine's label. Nothing else touches it.
  if (tier.valueSource === "observed" && tier.trendAdjustedValue != null && tier.trendAdjustedValue > 0 && u) {
    const um = u.gradeCurve.find((e) => e.grade === requestedTier);
    v.fairMarketValue = tier.trendAdjustedValue;
    v.rungLabel = tier.rungLabel ?? "exact-pool-projection";
    v.valueSource = "observed";
    v.compsUsed = tier.sampleCount;
    v.confidence = um?.confidence ?? tier.confidenceScore;
    v.windowDays = u.windowDays;
    v.trend = { direction: um?.trendDirection ?? "flat", pctPerWeek: um?.trendPctPerWeek ?? null };
    v.predictedPrice = tier.predictedPriceAt30d;
    v.weightedMedian = tier.weightedMedianPrice;
    v.sales = (um?.sales ?? []).slice();
    v.basis = `unified: ${requestedTier} window=${u.windowDays}d n=${tier.sampleCount} median=$${tier.weightedMedianPrice?.toFixed(0) ?? "?"} marketValue=$${v.fairMarketValue.toFixed(0)} predicted=$${v.predictedPrice?.toFixed(0) ?? "?"} trend=${v.trend.direction} ${v.trend.pctPerWeek?.toFixed(1) ?? "?"}%/wk rung=${v.rungLabel}`;
    // Tiers with no pool of their own are filled from this identity's
    // observed tiers × the empirical ratio (estimated, labelled), never
    // touching an observed tier.
    await fillUnavailableTiersFromAnchor(v.gradeCurve, {
      anchorFallback: null, setName: identity.setName, sport: identity.sport, slug,
    });
    capProjectedTiers(v.gradeCurve);
    labelEstimates(v.gradeCurve);
    return v;
  }

  // ── 2. No pool at this tier, but this identity has sales at others ──────
  if (u) {
    await fillUnavailableTiersFromAnchor(v.gradeCurve, {
      anchorFallback: null, setName: identity.setName, sport: identity.sport, slug,
    });
    capProjectedTiers(v.gradeCurve);
    labelEstimates(v.gradeCurve);
    tier = findTier();
    if (tier.valueSource === "estimated" && tier.value != null && tier.value > 0) {
      const anchor = v.gradeCurve.find((e) => e.valueSource === "observed" && (e.value ?? 0) > 0);
      v.fairMarketValue = tier.value;
      v.rungLabel = "grade-curve-estimate";
      v.valueSource = "estimated";
      v.compsUsed = 0;
      v.confidence = tier.confidenceScore;
      v.windowDays = u.windowDays;
      v.predictedPrice = tier.predictedPriceAt30d ?? null;
      v.basis = `Estimated from this card's own ${anchor ? gradeCurveEntryLabel(anchor) : "observed"} sales × the empirical ${requestedTier} ratio${tier.estimatedMultiplier != null ? ` (${tier.estimatedMultiplier.toFixed(2)}×)` : ""}; no ${requestedTier} sale of this card in ${u.windowDays}d`;
      return v;
    }
  }

  // ── 3. No sale of this identity at any grade: the gated ladder ─────────
  //
  // Only when the exact pool is empty may another identity price this one
  // (exact-pool supremacy). The ladder names its rung honestly.
  let fb: HobbyIqFmvResult | null = null;
  try {
    fb = await computeHobbyIqFmv({
      hobbyiqCardId: slug,
      gradeCompany: grade?.company ?? null,
      gradeValue: grade?.value ?? null,
      playerName,
      skipExactPool: true,
    });
  } catch { fb = null; }
  v.fallback = fb;
  if (fb && fb.method !== "no-basis" && fb.fmv !== null && fb.fmv > 0) {
    v.fairMarketValue = round2(fb.fmv);
    v.rungLabel = fb.rungLabel;
    v.valueSource = "estimated";
    v.compsUsed = fb.compCount;
    v.confidence = fb.confidence;
    v.trend = {
      direction: fb.trend.direction,
      pctPerWeek: Number.isFinite(fb.trend.slopePerMonthPct) ? round2(fb.trend.slopePerMonthPct / (30 / 7)) : null,
    };
    v.basis = fb.basisNote;
    v.sales = fb.recentComps.map((c) => ({ price: c.price, soldAt: c.soldAt, source: c.source ?? null }));
    tier = findTier();
    tier.value = v.fairMarketValue;
    tier.trendAdjustedValue = v.fairMarketValue;
    tier.valueSource = "estimated";
    tier.rungLabel = fb.rungLabel;
    (tier as { estimatedFrom: string | null }).estimatedFrom = fb.rungLabel;
    tier.confidenceScore = fb.confidence;
    // A Raw estimate anchors the graded tiers × the empirical ratio, exactly
    // as the curve always cascaded a sibling-derived Raw.
    if (requestedTier === "Raw") {
      await fillUnavailableTiersFromAnchor(v.gradeCurve, {
        anchorFallback: v.fairMarketValue, setName: identity.setName, sport: identity.sport, slug,
      });
      capProjectedTiers(v.gradeCurve);
      labelEstimates(v.gradeCurve);
    }
    return v;
  }

  // ── 4. Nothing — and every route says so the same way ──────────────────
  if (u) {
    v.reason = "no-exact-pool-at-tier";
    v.basis = `${slug} has sales at other grades but none at ${requestedTier} in 180d, no empirical ratio projects it, and no gated fallback rung could price it`;
  } else {
    v.reason = "no-exact-pool";
    v.basis = `No sale of ${slug} in 180d at any grade, and no gated fallback rung could price it`;
  }
  return v;
}

/** Name the rung on every filled tier the fill did not already label. */
function labelEstimates(entries: ObservedGradeEntry[]): void {
  for (const e of entries) {
    if (e.rungLabel) continue;
    if (e.valueSource === "estimated") e.rungLabel = "grade-curve-estimate";
  }
}

/**
 * CF-ONE-VALUATION-PATH (D17, 2026-08-30). Many identities through the ONE
 * entry: each id is valued exactly once (deduped), `concurrency` at a time,
 * one exact-pool read per identity — the batched shape
 * /observed-grade-curves-bulk needs. Not a second computation: every
 * valuation is `valueIdentity`'s. An id whose valuation throws is absent
 * from the map (logged); the caller decides what a miss becomes.
 */
export async function valueIdentitiesBulk(
  ids: ReadonlyArray<string>,
  opts: { concurrency?: number; grade?: ValuationGrade | null } = {},
): Promise<Map<string, Valuation>> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())));
  const out = new Map<string, Valuation>();
  const width = Math.max(1, Math.min(Math.trunc(opts.concurrency ?? 8), unique.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const id = unique[cursor++];
      try {
        out.set(id, await valueIdentity({ id, grade: opts.grade ?? null }));
      } catch (err) {
        console.warn(JSON.stringify({
          event: "one_valuation_path_bulk_id_failed",
          source: "oneValuationPath.valueIdentitiesBulk",
          id,
          error: (err as Error)?.message ?? String(err),
        }));
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
