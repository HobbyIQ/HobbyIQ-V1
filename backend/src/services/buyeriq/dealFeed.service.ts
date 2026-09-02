// CF-BUYERIQ-DEAL-FEED (Drew, 2026-09-02). The deal SCANNER: walk a
// user's BuyerIQ targets, compare live asks against each card's
// canonical projected next sale, and return the ones listed far enough
// under to be worth a look — each carrying the basis that justified it.
//
// This is a READ. It changes no valuation, writes no comp, and persists
// nothing. computeCanonicalFmv is called exactly as Card Detail calls
// it; the scanner only decides what to SHOW.
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
// No new vendor integration, no new scraper, no new quota consumer.
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
import { computeCanonicalFmv } from "../compiq/canonicalFmv.service.js";
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
  reason: DealRefusal | "no-listings" | "no-player-name";
  /** Present when a projection existed but did not clear the gate. */
  basis: DealBasis | null;
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

/** Apply listing-range's title verification so cross-parallel listings
 *  cannot masquerade as a discount on this card. */
function verifiedListings(listings: ActiveListing[], t: BuyerIqTarget): ActiveListing[] {
  return listings
    .filter((l) =>
      titleMatchesParallel(l.title ?? "", t.parallel ?? null, t.cardNumber ?? null, t.playerName ?? null),
    )
    .slice(0, MAX_LISTINGS_PER_TARGET);
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

    const verified = verifiedListings(fetchResult.listings, t);
    if (verified.length === 0) {
      skipped.push({ targetId: t.id, playerName: t.playerName, reason: "no-listings", basis: null });
      continue;
    }

    // The projection. Same call Card Detail makes — no valuation change.
    const fmvResult = await computeCanonicalFmv({
      cardId: t.hobbyiqCardId ?? cacheCardId(t),
      parallel: t.parallel ?? null,
      gradeCompany: t.gradeCompany ?? null,
      gradeValue: t.gradeValue ?? null,
      cardYear: t.cardYear ?? null,
      product: t.setName ?? null,
      player: t.playerName,
      cardNumber: t.cardNumber ?? null,
      isAuto: t.isAuto ?? null,
      freshCompute: false,
    });

    // Evaluate every verified listing; keep the deepest qualifying one.
    let best: { listing: ActiveListing; basis: DealBasis } | null = null;
    let lastRefusal: { reason: DealRefusal; basis: DealBasis | null } | null = null;

    for (const l of verified) {
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
          best = { listing: l, basis: verdict.basis };
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
    complete,
    stoppedReason,
    budget: result.budget,
  }));

  return result;
}
