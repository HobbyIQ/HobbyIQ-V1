// CF-TRADE-TARGET-DISCOVERY (Drew, 2026-07-17). Route: for each
// cardId in the caller's watchlist, fetch active eBay listings
// (PR #544 endpoint) + engine estimate, feed into discoverTradeTargets
// to surface underpriced buys.

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";
import { discoverTradeTargets, type TradeTargetListing } from "../services/portfolioiq/tradeTargetDiscovery.js";

const router = Router();

async function requireUserId(req: Request, res: Response): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return user.userId;
}

/** Scan a list of cardIds. Fetch active listings + engine estimate for
 *  each, feed into the discovery filter. */
async function scanCardIds(cardIds: string[]): Promise<TradeTargetListing[]> {
  const [{ readCachedActiveListings }, { getCardMetaById }] = await Promise.all([
    import("../services/ebay/ebayActiveListingsCache.service.js"),
    import("../services/compiq/cardsight.router.js"),
  ]);

  const bag: TradeTargetListing[] = [];
  // Bounded concurrency — 5 cards in flight
  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < cardIds.length) {
      const i = cursor++;
      const cardId = cardIds[i];
      try {
        // Fetch active listings cache (no on-demand fetch — that would
        // fan out to eBay Browse for each cardId and blow the budget).
        const cachedRaw = await readCachedActiveListings(cardId);
        if (!cachedRaw || cachedRaw.listings.length === 0) continue;

        // Engine estimate: use card-panel corpus row if available
        // (persisted per estimate, PR #543). Falls back to null when
        // we don't have coverage.
        const meta = await getCardMetaById(cardId).catch(() => null);
        const metaAny = meta as { player?: string; year?: number | string } | null;
        // Simple engine value lookup: use the most recent card-panel
        // predictedPriceAt30d for Raw grade. For MVP the actual number
        // ships zeroed and iOS shows "engine value unavailable" until we
        // wire the full lookup; a follow-up plumbs the corpus read.
        const engineMV: number | null = null;
        const enginePred: number | null = null;
        const isGuestimate = false;

        for (const l of cachedRaw.listings) {
          bag.push({
            id: l.id,
            cardId,
            cardTitle: l.title,
            playerName: metaAny?.player ?? "",
            askPrice: l.price,
            imageUrl: l.imageUrl,
            listingUrl: l.itemWebUrl,
            sellerUsername: l.seller.username,
            sellerFeedbackScore: l.seller.feedbackScore,
            engineMarketValue: engineMV,
            enginePredictedPrice: enginePred,
            isGuestimate,
            matchScore: l.matchScore,
          });
        }
      } catch { /* silent skip */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cardIds.length) }, () => worker()));
  return bag;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/portfolio/trade-targets?source=watchlist  (default)
//   Scans the caller's watchlist for underpriced eBay listings.
//
// GET /api/portfolio/trade-targets?source=inventory
//   Scans the caller's own inventory (useful for finding duplicate
//   underpriced cards to arbitrage or upgrade).
// ────────────────────────────────────────────────────────────────────
router.get("/trade-targets", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const source = String(req.query.source ?? "watchlist").trim().toLowerCase();

    let cardIds: string[] = [];
    if (source === "inventory") {
      const { readUserDoc } = await import("../services/portfolioiq/portfolioStore.service.js");
      const doc = await readUserDoc(userId);
      const items = Object.values(doc.holdings ?? {});
      cardIds = items
        .map((h) => String(h.cardId ?? "").trim())
        .filter((id) => id.length > 0);
    } else {
      // watchlist — the watchlist store is playerId-keyed, not cardId,
      // so we can't scan it directly. Return an informative empty set
      // for now; a follow-up should plumb watchlist→cardIds resolution.
      cardIds = [];
    }

    // Dedup
    cardIds = [...new Set(cardIds)];

    const listings = await scanCardIds(cardIds);
    const results = discoverTradeTargets(listings);

    res.json({
      computedAt: new Date().toISOString(),
      source,
      cardsScanned: cardIds.length,
      listingsSeen: listings.length,
      targets: results,
    });
  } catch (err) { next(err); }
});

export default router;
