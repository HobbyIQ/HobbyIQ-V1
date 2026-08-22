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

import { computeHobbyIqFmv, computeGradeBreakdownSingleScan, type HobbyIqFmvResult, type GradeBreakdownTier } from "./hobbyIqFmv.service.js";
import { computeRelatedCards, type RelatedCardsResult } from "./discoverySurfaces.service.js";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";

export interface CardDetailInput {
  hobbyiqCardId: string;              // canonical slug
  gradeCompany?: string | null;
  gradeValue?: number | null;
  maxAgeDays?: number;                // passed to computeHobbyIqFmv
  previewLimit?: number;              // passed to computeHobbyIqFmv (recentComps)
  relatedLimit?: number;              // passed to computeRelatedCards (default 8)
  /** When true, run parallel FMV computes for a fixed grade ladder so
   *  iOS can render "PSA 10 = $X, PSA 9.5 = $Y, Raw = $Z" in one call.
   *
   *  CF-GRADE-LADDER-OPT-IN (Drew, 2026-07-25). Default flipped to
   *  FALSE — 7 parallel computeHobbyIqFmv calls tie up the Cosmos SDK
   *  hard (measured 15-17s cold on `hiq:baseball:2025:topps-chrome-
   *  sapphire:300:base:no-auto`). iOS should opt in explicitly for the
   *  full grade breakdown view; the default fast path (primary FMV +
   *  related) returns in ~200-700ms. A proper single-scan grade
   *  breakdown is queued as follow-up. */
  includeGradeLadder?: boolean;
}

/** One tier in the grade ladder. gradeCompany=null + gradeValue=null = "Raw". */
export interface GradeLadderTier {
  gradeLabel: string;                 // "PSA 10", "BGS 9.5", "Raw"
  gradeCompany: string | null;
  gradeValue: number | null;
  fmv: number | null;
  compCount: number;                  // direct comps at this grade (before fallback)
  trend: "up" | "down" | "flat";
  method: string;                     // rung from HobbyIqFmvMethod
  confidence: number;
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
}

// Standard grade tiers surfaced in the ladder. Kept intentionally short —
// these are the tiers 95% of iOS users care about at glance. PSA
// dominates market share, BGS is the second-most-tracked, Raw is the
// no-grade baseline. If a tier has zero direct comps, computeHobbyIqFmv's
// internal fallback ladder still returns a number — the compCount field
// signals "how much conviction" (0 = fallback-only, positive = direct).
const GRADE_LADDER_TIERS: Array<{ label: string; company: string | null; value: number | null }> = [
  { label: "PSA 10",  company: "PSA", value: 10 },
  { label: "PSA 9.5", company: "PSA", value: 9.5 },
  { label: "PSA 9",   company: "PSA", value: 9 },
  { label: "BGS 10",  company: "BGS", value: 10 },
  { label: "BGS 9.5", company: "BGS", value: 9.5 },
  { label: "SGC 10",  company: "SGC", value: 10 },
  { label: "Raw",     company: null,  value: null },
];

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
  };
  if (!slug || !slug.startsWith("hiq:")) {
    return { ...empty, fmvError: "invalid hobbyiqCardId (must start with 'hiq:')", processingMs: Date.now() - t0 };
  }

  const parsed = parseHobbyIqCardId(slug);
  const identity: CardDetailIdentity = {
    hobbyiqCardId: slug,
    sport: parsed?.sport ?? null,
    year: parsed?.year ?? null,
    setKey: parsed?.setKey ?? null,
    cardNumber: parsed?.cardNumber ?? null,
    parallel: parsed?.parallel ?? null,
    isAuto: parsed?.isAuto ?? null,
    printRun: parsed?.printRun ?? null,
  };

  // CF-GRADE-BREAKDOWN-SINGLE-SCAN (Drew, 2026-07-26). Replaced the
  // 7-parallel-computeHobbyIqFmv implementation (measured 15-17s cold
  // on prod due to Cosmos SDK contention) with ONE Cosmos scan of the
  // slug's comps, grouped by (gradeCompany, gradeValue) in-memory.
  // O(1) Cosmos queries. Empirical-only: tiers with fewer than
  // minTierComps direct comps are OMITTED (iOS shows "insufficient
  // data" not a fabricated fallback multiplier).
  //
  // includeGradeLadder default remains false per the PR #763 opt-in
  // hotfix; iOS asks for it explicitly on the grade-breakdown view.
  const includeGradeLadder = input.includeGradeLadder === true;

  // CF-LADDER-PROJECTS-FROM-ANCHOR (2026-08-22). The header and the ladder used
  // to be two independent computations raced in the same Promise.allSettled,
  // and nothing made the ladder's entry for the card's own grade equal the
  // number printed above it. On Griffin they disagreed completely: header $650
  // from his last real sale, ladder empty.
  //
  // computeHobbyIqFmv is NOT memoised — only its Cosmos container is cached —
  // so it is computed exactly ONCE here and its value feeds both the header
  // and the ladder's anchor. Calling it twice would double the expensive path
  // on the very route CF-GRADE-BREAKDOWN-SINGLE-SCAN exists to keep fast.
  //
  // relatedPromise is started BEFORE the await so it still overlaps the FMV
  // call. Only the ladder is serialised behind it, and only when the ladder
  // was actually asked for (opt-in; iOS grade-breakdown view).
  const relatedPromise = computeRelatedCards(slug, input.relatedLimit ?? 8);

  const fmvSettled = (await Promise.allSettled([
    computeHobbyIqFmv({
      hobbyiqCardId: slug,
      gradeCompany: input.gradeCompany ?? null,
      gradeValue: input.gradeValue ?? null,
      maxAgeDays: input.maxAgeDays,
      previewLimit: input.previewLimit,
    }),
  ]))[0];
  const fmvForAnchor = fmvSettled.status === "fulfilled" ? fmvSettled.value : null;

  const gradeLadderPromise: Promise<GradeLadderTier[]> = includeGradeLadder
    ? computeGradeBreakdownSingleScan(slug, {
        maxAgeDays: input.maxAgeDays,
        anchorFmv: fmvForAnchor?.fmv ?? null,
        anchorGradeCompany: input.gradeCompany ?? null,
        anchorGradeValue: input.gradeValue ?? null,
      })
        .then((r): GradeLadderTier[] => r.tiers.map((t: GradeBreakdownTier) => ({
          gradeLabel: t.gradeLabel,
          gradeCompany: t.gradeCompany,
          gradeValue: t.gradeValue,
          fmv: t.fmv,
          compCount: t.compCount,
          trend: t.trend,
          // CF-LADDER-PROJECTS-FROM-ANCHOR: a projected tier is NOT direct-slug
          // and must not claim direct-slug's 0.95. The tier carries its own.
          method: t.basis === "projected" ? "anchor-projected" : "direct-slug",
          confidence: t.confidence,
        })))
    : Promise.resolve([]);

  const [relatedSettled, gradeLadderSettled] = await Promise.allSettled([
    relatedPromise,
    gradeLadderPromise,
  ]);

  const fmv = fmvSettled.status === "fulfilled" ? fmvSettled.value : null;
  const fmvError = fmvSettled.status === "rejected"
    ? (fmvSettled.reason instanceof Error ? fmvSettled.reason.message : String(fmvSettled.reason))
    : null;
  const related = relatedSettled.status === "fulfilled" ? relatedSettled.value : null;
  const relatedError = relatedSettled.status === "rejected"
    ? (relatedSettled.reason instanceof Error ? relatedSettled.reason.message : String(relatedSettled.reason))
    : null;
  const gradeLadder = includeGradeLadder && gradeLadderSettled.status === "fulfilled"
    ? gradeLadderSettled.value
    : null;
  const gradeLadderError = gradeLadderSettled.status === "rejected"
    ? (gradeLadderSettled.reason instanceof Error ? gradeLadderSettled.reason.message : String(gradeLadderSettled.reason))
    : null;

  return {
    success: true,
    hobbyiqCardId: slug,
    identity,
    fmv, fmvError,
    gradeLadder, gradeLadderError,
    related, relatedError,
    processingMs: Date.now() - t0,
    computedAt: new Date().toISOString(),
  };
}
