// CF-SUPPLY-DEMAND-SIGNAL (Drew, 2026-07-13, PR #420): eBay Browse
// item_summary/search wrapper for daily supply snapshots.
//
// Purpose: count active listings for a player (or specific card) so the
// listings trend feeds the supply-side of the market read. Combined with
// the sales trend (demand-side), Card Detail can surface a real
// supply-demand verdict (bull / bear / mixed / static).
//
// Uses the same OAuth token as GetMyeBayBuying — no new scope required.
// Rate: eBay Browse tier = 5000 calls/day free. Daily player snapshots
// stay well within budget (top-500 players × 1 call each per day).

import { getAccessToken } from "./ebayAuth.service.js";
import {
  getAppScopeToken,
  invalidateAppScopeTokenCache,
} from "./ebayAppToken.service.js";

const BROWSE_API_BASE_PROD = "https://api.ebay.com/buy/browse/v1";
const BROWSE_API_BASE_SANDBOX = "https://api.sandbox.ebay.com/buy/browse/v1";

function browseApiBase(): string {
  return (process.env.EBAY_ENV ?? "sandbox") === "production"
    ? BROWSE_API_BASE_PROD
    : BROWSE_API_BASE_SANDBOX;
}

// eBay category for Sports Trading Cards → Baseball singles. Narrows the
// player-name search to actual baseball cards (not memorabilia, not
// autographed jerseys, not photos of the player).
const CATEGORY_BASEBALL_SINGLES = "213";

export interface ListingsSummary {
  /** Total count reported by eBay (across all pages). */
  totalListings: number;
  /** Median asking price across the first page of results (or null). */
  medianAsk: number | null;
  /** Number of items whose price was extractable. Feeds the median n. */
  pricedItemCount: number;
  /** Search query eBay actually saw — useful for debugging. */
  effectiveQuery: string;
  /** ISO timestamp of the snapshot. */
  snapshottedAt: string;
}

/**
 * Query eBay Browse for active listings matching a player + (optional)
 * card qualifier, and aggregate into a supply-side snapshot.
 *
 * Returns null on auth failure / network error / empty results so the
 * caller can persist a null snapshot (still useful — "no data today" is
 * a signal).
 *
 * CF-BROWSE-APP-SCOPE-TOKEN (Drew, 2026-07-13, PR #422): the Browse
 * search endpoint is a public read — user context isn't required. Prefer
 * the app-scope EBAY_BROWSE_TOKEN when configured so the daily cron
 * doesn't depend on any specific user having a live OAuth session. Falls
 * back to per-user OAuth via getAccessToken for backward compat with
 * flows that pass a real userId (e.g. iOS-initiated snapshots).
 */
export async function fetchPlayerListingsSummary(
  userId: string,
  playerName: string,
  qualifier: string | null = null,
): Promise<ListingsSummary | null> {
  if (!playerName) return null;

  // CF-EBAY-APP-TOKEN (PR #423): prefer the auto-minted app-scope token
  // (client_credentials, cached with expiry) so the daily cron doesn't
  // depend on any user's OAuth session. Falls back to per-user OAuth only
  // when app-scope minting fails (missing credentials, transient issue).
  const q = qualifier ? `${playerName} ${qualifier}` : playerName;
  const effectiveQuery = q.trim();
  const params = new URLSearchParams({
    q: effectiveQuery,
    category_ids: CATEGORY_BASEBALL_SINGLES,
    limit: "50",
  });
  const url = `${browseApiBase()}/item_summary/search?${params}`;

  const runRequest = async (token: string): Promise<Response> =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        Accept: "application/json",
      },
    });

  try {
    let token = await getAppScopeToken();
    let usedFallback = false;
    if (!token && userId) {
      token = await getAccessToken(userId).catch(() => null);
      usedFallback = true;
    }
    if (!token) return null;

    let res = await runRequest(token);
    // Retry ONCE if the cached app-scope token was invalidated server-
    // side. Skip retry when we already used the user OAuth fallback
    // (that path has its own refresh flow inside ebayAuth.service).
    if (res.status === 401 && !usedFallback) {
      invalidateAppScopeTokenCache();
      const fresh = await getAppScopeToken();
      if (fresh) {
        res = await runRequest(fresh);
      }
    }
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "ebay_listing_search_http_error",
        source: "ebayListingSearch.service",
        status: res.status,
        q: effectiveQuery,
      }));
      return null;
    }
    const body = await res.json() as {
      total?: number;
      itemSummaries?: Array<{ price?: { value?: string; currency?: string } }>;
    };
    const totalListings = typeof body.total === "number" ? body.total : 0;
    const prices = (body.itemSummaries ?? [])
      .map((it) => {
        const v = it.price?.value;
        const num = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
        return Number.isFinite(num) && num > 0 ? num : null;
      })
      .filter((p): p is number => p != null);
    const medianAsk = prices.length > 0 ? median(prices) : null;
    return {
      totalListings,
      medianAsk,
      pricedItemCount: prices.length,
      effectiveQuery,
      snapshottedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_listing_search_error",
      source: "ebayListingSearch.service",
      q: effectiveQuery,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── CF-EBAY-ACTIVE-LISTINGS (Drew, 2026-07-17) ──────────────────────
// Card-specific active-listings search. Sibling of
// fetchPlayerListingsSummary but returns per-item shapes (title, price,
// image, seller, url) so iOS Card Detail can render individual
// listings under "Active Listings on eBay". Uses the same app-scope
// OAuth token minted by ebayAppToken.service.
// ─────────────────────────────────────────────────────────────────────

import { rankAndFilter, type ScoreBreakdown } from "./ebayListingRank.js";

export interface CardListingIdentity {
  year?: number | string;
  set?: string;
  player: string;
  cardNumber?: string;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: string;
  /** Sibling parallels to this one — used for wrong-parallel scoring.
   *  Caller (route handler) supplies these from the reference catalog. */
  knownDifferentParallels?: string[];
}

export interface ActiveListing {
  id: string;
  title: string;
  price: number;
  currency: string;
  imageUrl: string | null;
  itemWebUrl: string;
  seller: {
    username: string;
    feedbackScore: number | null;
    feedbackPercentage: number | null;
  };
  endsAt: string | null;
  matchScore: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface CardActiveListingsResult {
  listings: ActiveListing[];
  /** Total listings eBay reported for the query — includes filtered-out
   *  entries. Useful for "showing 3 of 47 matches" iOS renders. */
  totalReported: number;
  effectiveQuery: string;
  snapshottedAt: string;
}

/** Fetch card-specific active listings, ranked + filtered. Returns
 *  null on auth/network error (caller can cache a null result and
 *  retry later). Never throws. */
export async function fetchCardActiveListings(
  identity: CardListingIdentity,
): Promise<CardActiveListingsResult | null> {
  const player = String(identity.player ?? "").trim();
  if (!player) return null;

  // Query: "year set player parallel" — full descriptive query so
  // eBay's fuzzy matcher lands on the specific SKU. Grade is NOT in
  // the query (Raw + graded compete for user attention on eBay under
  // the same title stem); the ranker handles grade classification.
  const parts: string[] = [];
  if (identity.year !== undefined && identity.year !== null && String(identity.year).length > 0) {
    parts.push(String(identity.year));
  }
  if (identity.set) parts.push(identity.set);
  parts.push(player);
  if (identity.parallel) parts.push(identity.parallel);
  const effectiveQuery = parts.join(" ").trim();
  if (!effectiveQuery) return null;

  const params = new URLSearchParams({
    q: effectiveQuery,
    category_ids: CATEGORY_BASEBALL_SINGLES,
    limit: "20",   // pull 20, rank+filter to top 5
  });
  const url = `${browseApiBase()}/item_summary/search?${params}`;

  const runRequest = async (token: string): Promise<Response> =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        Accept: "application/json",
      },
    });

  try {
    let token = await getAppScopeToken();
    if (!token) return null;
    let res = await runRequest(token);
    if (res.status === 401) {
      invalidateAppScopeTokenCache();
      const fresh = await getAppScopeToken();
      if (!fresh) return null;
      res = await runRequest(fresh);
    }
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "ebay_card_listings_http_error",
        source: "ebayListingSearch.service",
        status: res.status,
        q: effectiveQuery,
      }));
      return null;
    }
    const body = await res.json() as {
      total?: number;
      itemSummaries?: Array<{
        itemId?: string;
        title?: string;
        price?: { value?: string; currency?: string };
        image?: { imageUrl?: string };
        itemWebUrl?: string;
        seller?: {
          username?: string;
          feedbackScore?: number;
          feedbackPercentage?: string;
        };
        itemEndDate?: string;
      }>;
    };

    const rawItems = (body.itemSummaries ?? [])
      .map((it) => {
        const priceStr = it.price?.value;
        const priceNum = typeof priceStr === "string" ? Number(priceStr) : NaN;
        if (!Number.isFinite(priceNum) || priceNum <= 0) return null;
        if (!it.itemId || !it.title || !it.itemWebUrl) return null;
        return {
          id: it.itemId,
          title: it.title,
          price: priceNum,
          currency: it.price?.currency ?? "USD",
          imageUrl: it.image?.imageUrl ?? null,
          itemWebUrl: it.itemWebUrl,
          seller: {
            username: it.seller?.username ?? "",
            feedbackScore: typeof it.seller?.feedbackScore === "number"
              ? it.seller.feedbackScore : null,
            feedbackPercentage: it.seller?.feedbackPercentage
              ? Number(it.seller.feedbackPercentage)
              : null,
          },
          endsAt: it.itemEndDate ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const ranked = rankAndFilter(rawItems, {
      year: identity.year,
      set: identity.set,
      cardNumber: identity.cardNumber,
      parallel: identity.parallel,
      gradeCompany: identity.gradeCompany,
      gradeValue: identity.gradeValue,
      knownDifferentParallels: identity.knownDifferentParallels,
    }, 5);

    const result = {
      listings: ranked,
      totalReported: typeof body.total === "number" ? body.total : rawItems.length,
      effectiveQuery,
      snapshottedAt: new Date().toISOString(),
    };

    // CF-PERSIST-ACTIVE-LISTINGS (Drew, 2026-07-23, issue #722 listings):
    // ship active listings we observed to active_listings in background.
    // Uses the identity's stringified key as our pseudo cardId — real
    // cardId resolution happens elsewhere. Feature-flagged:
    // PERSIST_ACTIVE_LISTINGS_ENABLED.
    if (ranked.length > 0) {
      const pseudoCardId = `ebay-identity:${identity.year ?? ""}:${identity.set ?? ""}:${identity.player ?? ""}:${identity.parallel ?? ""}:${identity.cardNumber ?? ""}`.toLowerCase();
      import("../portfolioiq/persistActiveListings.service.js")
        .then(({ persistActiveListingsInBackground }) => {
          persistActiveListingsInBackground(
            "ebay",
            ranked.map((l) => ({
              listingId: l.id,
              cardId: pseudoCardId,
              title: l.title,
              price: l.price,
              askType: l.endsAt ? "auction" : "fixed",
              endDate: l.endsAt,
              url: l.itemWebUrl,
              imageUrl: l.imageUrl,
              sellerHandle: l.seller?.username ?? null,
            })),
          );
        })
        .catch(() => { /* silent no-op */ });
    }

    return result;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_card_listings_error",
      source: "ebayListingSearch.service",
      q: effectiveQuery,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}
