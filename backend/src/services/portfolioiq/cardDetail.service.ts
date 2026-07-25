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
  related: RelatedCardsResult | null;
  relatedError: string | null;
  processingMs: number;
  computedAt: string;
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

  // Fan out — both sub-calls read from Cosmos in parallel. Wall-clock =
  // slowest of the two, not sum.
  const [fmvSettled, relatedSettled] = await Promise.allSettled([
    computeHobbyIqFmv({
      hobbyiqCardId: slug,
      gradeCompany: input.gradeCompany ?? null,
      gradeValue: input.gradeValue ?? null,
      maxAgeDays: input.maxAgeDays,
      previewLimit: input.previewLimit,
    }),
    computeRelatedCards(slug, input.relatedLimit ?? 8),
  ]);

  const fmv = fmvSettled.status === "fulfilled" ? fmvSettled.value : null;
  const fmvError = fmvSettled.status === "rejected"
    ? (fmvSettled.reason instanceof Error ? fmvSettled.reason.message : String(fmvSettled.reason))
    : null;
  const related = relatedSettled.status === "fulfilled" ? relatedSettled.value : null;
  const relatedError = relatedSettled.status === "rejected"
    ? (relatedSettled.reason instanceof Error ? relatedSettled.reason.message : String(relatedSettled.reason))
    : null;

  return {
    success: true,
    hobbyiqCardId: slug,
    identity,
    fmv, fmvError,
    related, relatedError,
    processingMs: Date.now() - t0,
    computedAt: new Date().toISOString(),
  };
}
