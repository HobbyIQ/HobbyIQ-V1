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

import { computeHobbyIqFmv, type HobbyIqFmvResult } from "./hobbyIqFmv.service.js";
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

  // Fan out — primary FMV + related in parallel, PLUS the grade ladder
  // fires N parallel FMV computes (one per tier). All complete under a
  // single Promise.allSettled so wall-clock = slowest of ANY sub-call,
  // not sum. Every sub-call goes through computeHobbyIqFmv's own cache
  // path so a second card-detail render for the same slug is near-free.
  const includeGradeLadder = input.includeGradeLadder === true;    // default false
  const gradeLadderPromise: Promise<GradeLadderTier[]> = includeGradeLadder
    ? Promise.all(GRADE_LADDER_TIERS.map(async (t) => {
        const r = await computeHobbyIqFmv({
          hobbyiqCardId: slug,
          gradeCompany: t.company,
          gradeValue: t.value,
          maxAgeDays: input.maxAgeDays,
          previewLimit: 1,     // don't need recentComps in ladder tiers
        });
        // compCount is direct-slug conviction only; fallback rungs still
        // return an FMV number but with method != "direct-slug". iOS can
        // gray out low-conviction tiers using this signal.
        const directCount = r.method === "direct-slug" ? r.compCount : 0;
        return {
          gradeLabel: t.label,
          gradeCompany: t.company,
          gradeValue: t.value,
          fmv: r.fmv,
          compCount: directCount,
          trend: r.trend.direction,
          method: r.method,
          confidence: r.confidence,
        };
      }))
    : Promise.resolve([]);

  const [fmvSettled, relatedSettled, gradeLadderSettled] = await Promise.allSettled([
    computeHobbyIqFmv({
      hobbyiqCardId: slug,
      gradeCompany: input.gradeCompany ?? null,
      gradeValue: input.gradeValue ?? null,
      maxAgeDays: input.maxAgeDays,
      previewLimit: input.previewLimit,
    }),
    computeRelatedCards(slug, input.relatedLimit ?? 8),
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
