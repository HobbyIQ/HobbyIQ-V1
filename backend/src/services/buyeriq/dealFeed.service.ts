// CF-BUYERIQ-DEAL-FEED (Drew, 2026-09-02). The deal SCANNER: walk a
// user's BuyerIQ targets, compare live asks against each card's
// canonical projected next sale, and return the ones listed far enough
// under to be worth a look — each carrying the basis that justified it.
//
// This is a READ. It changes no valuation, writes no comp, and persists
// nothing. It prices through valueIdentity — the one valuation path —
// exactly as Card Detail does; the scanner only decides what to SHOW.
//
// REUSE, not new scraping. Every live price here comes from the paths
// that already exist:
//   - fetchCardActiveListings  (ebayListingSearch.service) — the same
//     Browse call listing-range and Card Detail make
//   - read/writeCachedActiveListings — the 12h cache that amortizes the
//     Browse budget across the whole userbase
//   - titleMatchesParallel — the SAME post-fetch verification
//     listing-range applies, so a Blue Refractor target cannot be
//     "discounted" against a base-card listing
//   - listingMatchesGrade — the grade half of that identity check, so a
//     RAW listing cannot be "discounted" against a PSA 10 projection
// No new vendor integration, no new scraper, no new quota consumer.
//
// IDENTITY INCLUDES GRADE (CF-BUYERIQ-GRADE-AWARE-MATCH, 2026-09-03).
// Verification is two-dimensional: parallel AND grade tier. The
// parallel half shipped first and the grade half did not, so the
// scanner compared listings against projections belonging to a
// different tier — 6 of 8 sampled deals were a raw or lower-grade ask
// measured against a higher tier's number. FMV is per exact identity
// INCLUDING grade (D21: the grade curve IS the graded card), so a deal
// is a listing under the projection of ITS OWN tier. A listing whose
// grade cannot be read is NOT SCORED — never defaulted to raw, never
// to the target's tier. See listingGradeMatch.ts.
//
// Budget: ScanBudget charges live Browse calls only (cache reads are
// free). When it runs out the scan STOPS and reports truncation rather
// than returning a short feed that looks complete.

import {
  fetchCardActiveListings,
  type ActiveListing,
} from "../ebay/ebayListingSearch.service.js";
import {
  readCachedActiveListings,
  writeCachedActiveListings,
} from "../ebay/ebayActiveListingsCache.service.js";
import { titleMatchesParallel } from "../compiq/titleParallelMatch.js";
import {
  listingMatchesGrade,
  type GradeMismatchReason,
  type ListingGradeReading,
} from "./listingGradeMatch.js";
import { computeCanonicalValuation } from "../compiq/canonicalValuation.js";
import { listTargets, type BuyerIqTarget } from "./buyeriqStore.service.js";
import {
  evaluateDeal,
  DEFAULT_BASE_DISCOUNT_PCT,
  MAX_REQUIRED_DISCOUNT_PCT,
  type DealBasis,
  type DealRefusal,
} from "./dealGate.js";
import { ScanBudget, type BudgetStopReason, type ScanBudgetState } from "./scanBudget.js";

/** Listings considered per target. The ranker already trims to the top
 *  5 most-likely matches; we look at all of them and keep the best deal. */
const MAX_LISTINGS_PER_TARGET = 5;

export interface DealListing {
  listingId: string;
  title: string;
  price: number;
  currency: string;
  itemWebUrl: string;
  imageUrl: string | null;
  sellerHandle: string | null;
  endsAt: string | null;
}

export interface Deal {
  targetId: string;
  listId: string;
  playerName: string;
  cardYear: number | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  listing: DealListing;
  /** The grade tier read off the LISTING title, verified equal to the
   *  target's tier before this deal was scored. "raw" for an ungraded
   *  listing matched to a raw target. Never null on a flagged deal —
   *  an unreadable grade is refused, not scored. */
  matchedTier: string;
  /** Why this is a deal: the projection, the rung it came from, the
   *  confidence in it, the discount carried and the discount required. */
  basis: DealBasis;
  /** Rounded percentages for display. */
  discountPctDisplay: number;
  requiredDiscountPctDisplay: number;
  /** projection - price, in dollars. */
  savingsVsProjection: number;
}

export interface SkippedTarget {
  targetId: string;
  playerName: string;
  /** "no-catalog-identity": the target carries no hiq: slug, so there is no
   *  pool to price it from. It is REFUSED rather than priced off a minted
   *  cache key (H-2, audit 2026-09-03) — the same refusal the scanner makes. */
  reason:
    | DealRefusal
    | GradeMismatchReason
    | "no-listings"
    | "no-player-name"
    | "no-catalog-identity";
  /** Present when a projection existed but did not clear the gate. */
  basis: DealBasis | null;
  /** How many listings passed the parallel gate but failed the grade
   *  gate, by reason. Present only on a grade-mismatch skip — this is
   *  what lets the feed say "2 listed, both raw, your target is PSA 10"
   *  instead of the misleading "nothing listed". */
  gradeRejections?: Partial<Record<GradeMismatchReason, number>>;
}

export interface DealFeedResult {
  deals: Deal[];
  /** True when the scan examined every eligible target. */
  complete: boolean;
  /** Set when complete === false. */
  stoppedReason: BudgetStopReason | null;
  /** Targets never examined because the scan stopped early. */
  targetsUnexamined: number;
  targetsScanned: number;
  targetsEligible: number;
  /** Near-misses and refusals, for the "why isn't X here?" question. */
  skipped: SkippedTarget[];
  budget: ScanBudgetState;
  baseDiscountPct: number;
  scannedAt: string;
}

export interface ScanDealsOptions {
  userId: string;
  /** Restrict to one buying list. */
  listId?: string;
  /** Base discount threshold at full confidence. Default 0.20 (20% under). */
  baseDiscountPct?: number;
  /** Override the per-scan vendor-call budget (tests / ops). */
  vendorCallBudget?: number;
  /** Cap on targets examined regardless of budget. */
  maxTargets?: number;
}

function clampThreshold(pct: number | undefined): number {
  if (pct === undefined || !Number.isFinite(pct) || pct <= 0) {
    return DEFAULT_BASE_DISCOUNT_PCT;
  }
  return Math.max(0.02, Math.min(MAX_REQUIRED_DISCOUNT_PCT, pct));
}

function gradeSlugParts(t: BuyerIqTarget): { company?: string; value?: string } {
  return {
    company: t.gradeCompany ?? undefined,
    value: t.gradeValue !== null && t.gradeValue !== undefined ? String(t.gradeValue) : undefined,
  };
}

/** The cache key cardId. Prefer the canonical hobbyiqCardId; fall back
 *  to a stable identity string so two targets for the same card share a
 *  cache entry (and therefore one Browse call) even when unslugged. */
function cacheCardId(t: BuyerIqTarget): string {
  if (t.hobbyiqCardId) return t.hobbyiqCardId;
  return [
    "buyeriq-identity",
    t.cardYear ?? "",
    t.setName ?? "",
    t.playerName ?? "",
    t.cardNumber ?? "",
    t.parallel ?? "",
  ].join(":").toLowerCase();
}

/**
 * Fetch active listings for a target, preferring the shared 12h cache.
 * Charges the budget ONLY on a live vendor call. Returns null when the
 * budget refused the call — the caller must treat that as a stop, not
 * as "no listings".
 */
async function listingsForTarget(
  t: BuyerIqTarget,
  budget: ScanBudget,
): Promise<{ listings: ActiveListing[] } | null> {
  const cardId = cacheCardId(t);
  const grade = gradeSlugParts(t);

  const cached = await readCachedActiveListings(cardId, grade.company, grade.value);
  if (cached) {
    budget.recordCacheHit();
    return { listings: cached.listings ?? [] };
  }

  // Cache miss — this costs a live Browse call.
  if (!budget.spend()) return null;

  const fetched = await fetchCardActiveListings({
    year: t.cardYear ?? undefined,
    set: t.setName ?? undefined,
    player: t.playerName,
    cardNumber: t.cardNumber ?? undefined,
    parallel: t.parallel ?? undefined,
    gradeCompany: grade.company,
    gradeValue: grade.value,
  });
  if (!fetched) return { listings: [] };

  // Populate the shared cache so the next scan (and Card Detail, and
  // listing-range) ride free on this call.
  await writeCachedActiveListings(cardId, grade.company, grade.value, fetched);
  return { listings: fetched.listings ?? [] };
}

/** A listing that survived parallel verification, with its grade read. */
interface VerifiedListing {
  listing: ActiveListing;
  reading: ListingGradeReading;
}

/** Why nothing on this target was scoreable. */
interface VerificationOutcome {
  verified: VerifiedListing[];
  /** Grade-rejection tallies, for the "why isn't X here?" feed. */
  gradeRejections: Partial<Record<GradeMismatchReason, number>>;
  /** Listings that passed parallel verification, before the grade gate. */
  parallelMatched: number;
}

/**
 * Two-dimensional verification: PARALLEL then GRADE.
 *
 * The parallel gate (titleMatchesParallel) is listing-range's own, and
 * stops a Blue Refractor target being priced off a base-card ask. The
 * grade gate (listingMatchesGrade) stops the same error along the axis
 * the original scanner ignored: a raw or PSA 9 ask priced off the PSA
 * 10 projection.
 *
 * A listing whose grade the title does not settle is DROPPED, not
 * assumed into either tier — counted under "grade-unknown" so the feed
 * can say "3 listings, grade not stated, not scored" rather than
 * silently scoring them or silently showing nothing.
 */
function verifiedListings(listings: ActiveListing[], t: BuyerIqTarget): VerificationOutcome {
  const gradeRejections: Partial<Record<GradeMismatchReason, number>> = {};
  const verified: VerifiedListing[] = [];
  let parallelMatched = 0;

  for (const l of listings) {
    const title = l.title ?? "";
    if (!titleMatchesParallel(title, t.parallel ?? null, t.cardNumber ?? null, t.playerName ?? null)) {
      continue;
    }
    parallelMatched++;

    const grade = listingMatchesGrade(title, {
      gradeCompany: t.gradeCompany ?? null,
      gradeValue: t.gradeValue ?? null,
    });
    if (!grade.ok) {
      gradeRejections[grade.reason] = (gradeRejections[grade.reason] ?? 0) + 1;
      continue;
    }

    verified.push({ listing: l, reading: grade.reading });
    if (verified.length >= MAX_LISTINGS_PER_TARGET) break;
  }

  return { verified, gradeRejections, parallelMatched };
}

/** Render a verified grade reading as the tier label shown on the deal
 *  ("PSA 10", "BGS 10 Black Label", "Raw"). Only ever called for a
 *  reading that already matched the target, so "unknown" cannot occur. */
function tierLabel(reading: ListingGradeReading): string {
  if (reading.kind === "raw") return "Raw";
  if (reading.kind === "unknown") return "Unknown";
  const base = `${reading.company} ${reading.value}`;
  return reading.isBlackLabel ? `${base} Black Label` : base;
}

/** The dominant reason a target with listings produced no scoreable one. */
function dominantGradeRejection(
  rejections: Partial<Record<GradeMismatchReason, number>>,
): GradeMismatchReason | null {
  let best: GradeMismatchReason | null = null;
  let bestN = 0;
  for (const [reason, n] of Object.entries(rejections) as Array<[GradeMismatchReason, number]>) {
    if (n > bestN) {
      best = reason;
      bestN = n;
    }
  }
  return best;
}

function toDealListing(l: ActiveListing): DealListing {
  return {
    listingId: l.id,
    title: l.title,
    price: l.price,
    currency: l.currency,
    itemWebUrl: l.itemWebUrl,
    imageUrl: l.imageUrl,
    sellerHandle: l.seller?.username ?? null,
    endsAt: l.endsAt,
  };
}

/**
 * Scan a user's BuyerIQ targets for listings under their projected next
 * sale. Read-only. Never flags off a no-basis or speculative-confidence
 * projection; stops and reports when the vendor-call budget runs out.
 */
export async function scanDeals(opts: ScanDealsOptions): Promise<DealFeedResult> {
  const scannedAt = new Date().toISOString();
  const baseDiscountPct = clampThreshold(opts.baseDiscountPct);
  const budget = new ScanBudget(opts.vendorCallBudget);

  const allTargets = await listTargets(opts.userId, opts.listId);
  // Only cards the user still wants. Acquired/passed targets are history.
  const eligible = allTargets.filter((t) => t.status === "wanted");
  const capped = typeof opts.maxTargets === "number" && opts.maxTargets >= 0
    ? eligible.slice(0, opts.maxTargets)
    : eligible;

  const deals: Deal[] = [];
  const skipped: SkippedTarget[] = [];
  let scanned = 0;
  let stoppedReason: BudgetStopReason | null = null;

  for (const t of capped) {
    if (!t.playerName) {
      skipped.push({ targetId: t.id, playerName: t.playerName ?? "", reason: "no-player-name", basis: null });
      scanned++;
      continue;
    }

    const fetchResult = await listingsForTarget(t, budget);
    if (fetchResult === null) {
      // PINNED REFUSAL: the vendor-call budget is exhausted. Stop the
      // scan here and report it. Do NOT keep going against the cache
      // only and present the result as a full scan.
      stoppedReason = "vendor-call-budget-exhausted";
      break;
    }
    scanned++;

    const { verified, gradeRejections, parallelMatched } = verifiedListings(fetchResult.listings, t);
    if (verified.length === 0) {
      // Distinguish "nothing is listed" from "things are listed but none
      // of them are THIS card in THIS tier". Reporting the latter as
      // "no listings" hides the very confusion that produced the false
      // positives — a user seeing raw asks on the page needs to be told
      // we did not score them, and why.
      const dominant = parallelMatched > 0 ? dominantGradeRejection(gradeRejections) : null;
      skipped.push({
        targetId: t.id,
        playerName: t.playerName,
        reason: dominant ?? "no-listings",
        basis: null,
        ...(dominant ? { gradeRejections } : {}),
      });
      continue;
    }

    // The projection. The ONE valuation path — the same entry Card Detail,
    // the scanner and the sell loop price through.
    //
    // H-2 (audit 2026-09-03) reached this file too. The old call passed
    // `t.hobbyiqCardId ?? cacheCardId(t)`, and cacheCardId mints
    // `buyeriq-identity:<year>:<set>:<player>:<number>:<parallel>` for a
    // target with no slug. That string is a CACHE KEY — it names no catalog
    // row — and handing it to the engine priced whatever pool it collided
    // with, then published the result as DealBasis.projection with a rung
    // and a confidence. The scanner was fixed to refuse such a target by
    // name; the feed, which is what the user actually reads, was not.
    //
    // A target is priced only through its own catalog slug. One without a
    // slug is refused by name: no price, no deal, no basis.
    const slug = typeof t.hobbyiqCardId === "string" ? t.hobbyiqCardId.trim() : "";
    if (!slug.startsWith("hiq:")) {
      skipped.push({
        targetId: t.id,
        playerName: t.playerName,
        reason: "no-catalog-identity",
        basis: null,
      });
      continue;
    }
    const fmvResult = await computeCanonicalValuation({
      cardId: slug,
      parallel: t.parallel ?? null,
      gradeCompany: t.gradeCompany ?? null,
      gradeValue: t.gradeValue ?? null,
      cardYear: t.cardYear ?? null,
      product: t.setName ?? null,
      player: t.playerName,
      cardNumber: t.cardNumber ?? null,
      isAuto: t.isAuto ?? null,
    });

    // Evaluate every verified listing; keep the deepest qualifying one.
    let best: { listing: ActiveListing; basis: DealBasis; reading: ListingGradeReading } | null = null;
    let lastRefusal: { reason: DealRefusal; basis: DealBasis | null } | null = null;

    for (const { listing: l, reading } of verified) {
      const verdict = evaluateDeal({
        listingPrice: l.price,
        fmv: fmvResult?.fmv ?? null,
        confidence: fmvResult?.confidence ?? 0,
        method: fmvResult?.method ?? null,
        rungLabel: fmvResult?.rungLabel ?? null,
        baseDiscountPct,
      });
      if (verdict.flagged && verdict.basis) {
        if (!best || verdict.basis.discountPct > best.basis.discountPct) {
          best = { listing: l, basis: verdict.basis, reading };
        }
      } else if (verdict.refusal) {
        // Keep the closest near-miss for the explanation feed.
        if (
          !lastRefusal ||
          (verdict.basis && lastRefusal.basis &&
            verdict.basis.discountPct > lastRefusal.basis.discountPct)
        ) {
          lastRefusal = { reason: verdict.refusal, basis: verdict.basis };
        }
      }
    }

    if (best) {
      const savings = Math.round((best.basis.projection - best.listing.price) * 100) / 100;
      deals.push({
        targetId: t.id,
        listId: t.listId,
        playerName: t.playerName,
        cardYear: t.cardYear ?? null,
        setName: t.setName ?? null,
        cardNumber: t.cardNumber ?? null,
        parallel: t.parallel ?? null,
        gradeCompany: t.gradeCompany ?? null,
        gradeValue: t.gradeValue ?? null,
        listing: toDealListing(best.listing),
        matchedTier: tierLabel(best.reading),
        basis: best.basis,
        discountPctDisplay: Math.round(best.basis.discountPct * 1000) / 10,
        requiredDiscountPctDisplay: Math.round(best.basis.requiredDiscountPct * 1000) / 10,
        savingsVsProjection: savings,
      });
    } else if (lastRefusal) {
      skipped.push({
        targetId: t.id,
        playerName: t.playerName,
        reason: lastRefusal.reason,
        basis: lastRefusal.basis,
      });
    }
  }

  // Deepest discount first — the feed's whole job is to put the best
  // deal at the top.
  deals.sort((a, b) => b.basis.discountPct - a.basis.discountPct);

  const complete = stoppedReason === null;
  const result: DealFeedResult = {
    deals,
    complete,
    stoppedReason,
    targetsUnexamined: complete ? 0 : capped.length - scanned,
    targetsScanned: scanned,
    targetsEligible: capped.length,
    skipped,
    budget: budget.state(),
    baseDiscountPct,
    scannedAt,
  };

  console.log(JSON.stringify({
    event: "buyeriq_deal_feed_scan",
    source: "dealFeed.service",
    userId: opts.userId,
    listId: opts.listId ?? null,
    baseDiscountPct,
    targetsEligible: result.targetsEligible,
    targetsScanned: result.targetsScanned,
    targetsUnexamined: result.targetsUnexamined,
    dealsFound: deals.length,
    // Grade-gate telemetry: how many targets were skipped because the
    // only listings were in a DIFFERENT tier than the target. A rising
    // count here is the false-positive population the old scanner was
    // silently reporting as deals.
    skippedGradeUnknown: skipped.filter((s) => s.reason === "grade-unknown").length,
    skippedGradeMismatch: skipped.filter((s) =>
      s.reason === "listing-raw-target-graded" ||
      s.reason === "listing-graded-target-raw" ||
      s.reason === "grade-company-mismatch" ||
      s.reason === "grade-value-mismatch").length,
    complete,
    stoppedReason,
    budget: result.budget,
  }));

  return result;
}
