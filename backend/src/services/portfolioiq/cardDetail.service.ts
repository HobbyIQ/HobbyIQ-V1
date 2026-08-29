// CF-CARD-DETAIL-COMPOSITE (Drew, 2026-07-25). Single-call render for
// iOS card-detail screens. Collapses what would otherwise be N separate
// requests (/hobbyiq-fmv + /related-cards + optional listing-range) into
// one parallel Promise.all so iOS's tap-into-card sees full detail in
// one round-trip.
//
// Design: pure composition, no new business logic. Each sub-call already
// exists as a public service function. Failures in sub-calls degrade
// gracefully — the composite still returns whatever succeeded, with
// per-section error flags iOS can render as "temporarily unavailable"
// rather than blanking the whole screen.
//
// CF-ONE-VALUATION-PATH (D17, 2026-08-30). The headline and the ladder are
// ONE valuation (oneValuationPath.service.valueIdentity) — the same result
// /hobbyiq-fmv, /price-by-id, /canonical-fmv and /observed-grade-curve
// derive from. Before D17 this composite ran computeHobbyIqFmv for the
// header and computeGradeBreakdownSingleScan for the ladder: two engines
// over the same rows (the ladder at a fixed 180d window, the header at the
// density cascade), agreeing only because CF-LADDER-PROJECTS-FROM-ANCHOR
// handed the header's number to the ladder as an anchor. Now the `fmv`
// block IS /hobbyiq-fmv's answer (toHobbyIqFmvResponse over the valuation)
// and every ladder tier IS that valuation's curve entry — the requested
// grade's tier equals the header by construction. `maxAgeDays` is no
// longer honoured (the engine's window is the density cascade's; a
// caller-chosen window would be a second computation).

import type { HobbyIqFmvResult } from "./hobbyIqFmv.service.js";
import { computeRelatedCards, type RelatedCardsResult } from "./discoverySurfaces.service.js";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { valueIdentity, type Valuation } from "../compiq/oneValuationPath.service.js";
import { toHobbyIqFmvResponse, wireIdentity } from "../compiq/oneValuationPathAdapters.js";
import { gradeCurveEntryLabel } from "../compiq/gradeCurveEntry.js";
import type { ObservedGradeEntry } from "../compiq/observedGradeCurve.service.js";

export interface CardDetailInput {
  hobbyiqCardId: string;              // canonical slug
  gradeCompany?: string | null;
  gradeValue?: number | null;
  /** D17: accepted for back-compat, not honoured — the one valuation path's
   *  window is the engine's density cascade. */
  maxAgeDays?: number;
  previewLimit?: number;              // recentComps preview size on `fmv`
  relatedLimit?: number;              // passed to computeRelatedCards (default 8)
  /** When true, the grade ladder is rendered from the valuation's curve so
   *  iOS can render "PSA 10 = $X, PSA 9.5 = $Y, Raw = $Z" in one call.
   *
   *  CF-GRADE-LADDER-OPT-IN (Drew, 2026-07-25). Default FALSE. D17: the
   *  ladder no longer costs a second engine call — it is the same curve the
   *  header came from — but the opt-in is kept so the wire shape does not
   *  grow for callers that never asked for it. */
  includeGradeLadder?: boolean;
}

/** One tier in the grade ladder. gradeCompany=null + gradeValue=null = "Raw". */
export interface GradeLadderTier {
  gradeLabel: string;                 // "PSA 10", "BGS 9.5", "Raw"
  gradeCompany: string | null;
  gradeValue: number | null;
  fmv: number | null;
  compCount: number;                  // sales in this tier's own pool (0 when estimated)
  trend: "up" | "down" | "flat";
  /** D17: the tier's rung in the closed vocabulary (fmvRung.ts) — an
   *  exact-pool rung for an observed tier, `grade-curve-estimate` for a
   *  tier filled from this card's other tiers × the empirical ratio.
   *  (Pre-D17: "direct-slug" | "anchor-projected".) */
  method: string;
  confidence: number;
  /** Additive (D17): the same rung as `method`, and the tier's valueSource. */
  rungLabel: string | null;
  valueSource: "observed" | "estimated" | "unavailable";
}

export interface CardDetailIdentity {
  hobbyiqCardId: string;
  sport: string | null;
  year: number | null;
  setKey: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean | null;
  printRun: number | null;
}

export interface CardDetailResult {
  success: true;
  hobbyiqCardId: string;
  identity: CardDetailIdentity;
  fmv: HobbyIqFmvResult | null;
  fmvError: string | null;
  gradeLadder: GradeLadderTier[] | null;   // null when includeGradeLadder=false
  gradeLadderError: string | null;
  related: RelatedCardsResult | null;
  relatedError: string | null;
  processingMs: number;
  computedAt: string;
  /** Additive (D17): the valuation's rung, source and reason, and the
   *  catalog identity every other pricing wire carries. */
  rungLabel: string;
  valueSource: Valuation["valueSource"];
  fmvReason: Valuation["reason"];
  catalogIdentity: Record<string, unknown> | null;
}

/** The ladder's trend for a tier, from the tier's own fit (trendPctPerWeek). */
function tierTrend(entry: ObservedGradeEntry): "up" | "down" | "flat" {
  const pct = entry.predictedPricePct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "flat";
  if (pct > 0.5) return "up";
  if (pct < -0.5) return "down";
  return "flat";
}

/** Every priced tier of the valuation's curve as a ladder tier, sorted by
 *  value descending with Raw last (the order the ladder always had). */
export function ladderFromValuation(v: Valuation): GradeLadderTier[] {
  const tiers: GradeLadderTier[] = [];
  for (const e of v.gradeCurve) {
    const value = e.trendAdjustedValue ?? e.value;
    if (typeof value !== "number" || !(value > 0)) continue;
    const label = gradeCurveEntryLabel(e);
    const isRaw = label === "Raw";
    const m = String(e.grade).match(/(\d+(?:\.\d+)?)/);
    tiers.push({
      gradeLabel: label,
      gradeCompany: isRaw ? null : e.grader,
      gradeValue: isRaw ? null : (m ? Number(m[1]) : null),
      fmv: Math.round(value * 100) / 100,
      compCount: e.valueSource === "observed" ? e.sampleCount : 0,
      trend: tierTrend(e),
      method: e.rungLabel ?? (e.valueSource === "estimated" ? "grade-curve-estimate" : "no-basis"),
      confidence: e.confidenceScore ?? 0,
      rungLabel: e.rungLabel ?? null,
      valueSource: e.valueSource,
    });
  }
  tiers.sort((a, b) => {
    if (a.gradeCompany === null && b.gradeCompany !== null) return 1;
    if (b.gradeCompany === null && a.gradeCompany !== null) return -1;
    return (b.fmv ?? 0) - (a.fmv ?? 0);
  });
  return tiers;
}

export async function computeCardDetail(input: CardDetailInput): Promise<CardDetailResult> {
  const t0 = Date.now();
  const slug = String(input.hobbyiqCardId ?? "").trim();
  const now = new Date();
  const empty: CardDetailResult = {
    success: true,
    hobbyiqCardId: slug,
    identity: {
      hobbyiqCardId: slug, sport: null, year: null, setKey: null,
      cardNumber: null, parallel: null, isAuto: null, printRun: null,
    },
    fmv: null, fmvError: null,
    gradeLadder: null, gradeLadderError: null,
    related: null, relatedError: null,
    processingMs: 0,
    computedAt: now.toISOString(),
    rungLabel: "no-basis",
    valueSource: "unavailable",
    fmvReason: null,
    catalogIdentity: null,
  };
  if (!slug || !slug.startsWith("hiq:")) {
    return { ...empty, fmvError: "invalid hobbyiqCardId (must start with 'hiq:')", processingMs: Date.now() - t0 };
  }

  const parsed = parseHobbyIqCardId(slug);
  const includeGradeLadder = input.includeGradeLadder === true;

  // relatedPromise is started BEFORE the valuation so it overlaps it.
  const relatedPromise = computeRelatedCards(slug, input.relatedLimit ?? 8);

  // ONE valuation: the header, and the ladder's every tier, come from it.
  const valuationSettled = (await Promise.allSettled([
    valueIdentity({
      id: slug,
      grade: { company: input.gradeCompany ?? null, value: input.gradeValue ?? null },
    }),
  ]))[0];
  const v = valuationSettled.status === "fulfilled" ? valuationSettled.value : null;
  const fmvError = valuationSettled.status === "rejected"
    ? (valuationSettled.reason instanceof Error ? valuationSettled.reason.message : String(valuationSettled.reason))
    : null;

  const relatedSettled = (await Promise.allSettled([relatedPromise]))[0];
  const related = relatedSettled.status === "fulfilled" ? relatedSettled.value : null;
  const relatedError = relatedSettled.status === "rejected"
    ? (relatedSettled.reason instanceof Error ? relatedSettled.reason.message : String(relatedSettled.reason))
    : null;

  // The identity block: the catalog's identity when the entry resolved it,
  // the slug's own segments otherwise (the pre-D17 shape, same keys).
  const identity: CardDetailIdentity = {
    hobbyiqCardId: v?.identity.slug ?? slug,
    sport: v?.identity.sport ?? parsed?.sport ?? null,
    year: v?.identity.year ?? parsed?.year ?? null,
    setKey: v?.identity.setKey ?? parsed?.setKey ?? null,
    cardNumber: v?.identity.cardNumber ?? parsed?.cardNumber ?? null,
    parallel: v?.identity.parallel ?? parsed?.parallel ?? null,
    isAuto: v?.identity.isAuto ?? parsed?.isAuto ?? null,
    printRun: v?.identity.printRun ?? parsed?.printRun ?? null,
  };

  const fmv = v
    ? toHobbyIqFmvResponse(v, { previewLimit: input.previewLimit })
    : null;
  const gradeLadder = includeGradeLadder && v ? ladderFromValuation(v) : null;
  const gradeLadderError = includeGradeLadder && !v ? fmvError : null;

  return {
    success: true,
    hobbyiqCardId: v?.identity.slug ?? slug,
    identity,
    fmv, fmvError,
    gradeLadder, gradeLadderError,
    related, relatedError,
    processingMs: Date.now() - t0,
    computedAt: v?.computedAt ?? new Date().toISOString(),
    rungLabel: v?.rungLabel ?? "no-basis",
    valueSource: v?.valueSource ?? "unavailable",
    fmvReason: v?.reason ?? null,
    catalogIdentity: v ? wireIdentity(v.identity) : null,
  };
}
