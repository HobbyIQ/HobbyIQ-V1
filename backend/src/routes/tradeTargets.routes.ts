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
  const [{ readCachedActiveListings }, { getCardMetaById }, { readLatestGradeCurve }] = await Promise.all([
    import("../services/ebay/ebayActiveListingsCache.service.js"),
    import("../services/compiq/cardsight.router.js"),
    import("../services/compiq/cardhedgeLearnCorpus.service.js"),
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

        // CF-CORPUS-READ (Drew, 2026-07-17): pull the latest persisted
        // grade curve for this cardId to compare active-listing asks
        // against the engine's Raw market value + predicted. Panel-
        // visited cards have this populated; long-tail cards do not,
        // in which case engineMV/enginePred stay null and the ranker
        // filters them out from trade-target results.
        const [meta, curve] = await Promise.all([
          getCardMetaById(cardId).catch(() => null),
          readLatestGradeCurve(cardId).catch(() => null),
        ]);
        const metaAny = meta as { player?: string; year?: number | string } | null;
        const engineMV = curve?.rawMarketValue ?? null;
        const enginePred = curve?.rawPredictedPrice ?? null;
        // Guestimate detection: when the Raw entry's valueSource is
        // "estimated" (family blend / sibling fallback / guestimate),
        // the ranker's confidence tier drops. We conservatively treat
        // any non-"observed" Raw as guestimate for trade-target purposes.
        const rawEntry = curve?.entries.find((e) => e.grader === "Raw" || e.grade === "Raw");
        const isGuestimate = rawEntry ? rawEntry.valueSource !== "observed" : false;

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
    } else if (source === "watchlist") {
      // CF-WATCHLIST-CARDID-RESOLVE (Drew, 2026-07-17): watchlist is
      // playerId-keyed. Resolve each watched player to their top N
      // most-recently-traded cardIds so Trade Targets scans those.
      // Top N per player kept small (default 3) so a 20-player
      // watchlist doesn't blow the eBay-listings-cache read budget.
      const perPlayerCap = Math.max(1, Math.min(10, Number(req.query.perPlayer) || 3));
      const [{ getWatchlistEntries }, { readCompsByPlayer }] = await Promise.all([
        import("../services/dailyiq/watchlistStore.service.js"),
        import("../services/portfolioiq/soldCompsStore.service.js"),
      ]);
      const entries = await getWatchlistEntries(userId);
      const playerNames = entries
        .map((e) => (e.playerName ?? "").trim())
        .filter((n) => n.length > 0);
      // Bounded concurrency across players
      const bag: string[] = [];
      const CONCURRENCY = 5;
      let cursor = 0;
      async function worker() {
        while (cursor < playerNames.length) {
          const i = cursor++;
          const player = playerNames[i];
          try {
            const comps = await readCompsByPlayer({ playerName: player, limit: 50 });
            // Rank cardIds by number of recent trades then latest sale price
            const byCardId = new Map<string, { count: number; latestPrice: number }>();
            for (const c of comps) {
              const cid = String(c.cardId ?? "").trim();
              if (!cid) continue;
              const cur = byCardId.get(cid) ?? { count: 0, latestPrice: 0 };
              cur.count += 1;
              if (typeof c.price === "number" && c.price > cur.latestPrice) cur.latestPrice = c.price;
              byCardId.set(cid, cur);
            }
            const sorted = [...byCardId.entries()]
              .sort((a, b) => b[1].count - a[1].count || b[1].latestPrice - a[1].latestPrice)
              .slice(0, perPlayerCap)
              .map(([cid]) => cid);
            bag.push(...sorted);
          } catch { /* silent — one player failing shouldn't kill the scan */ }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, playerNames.length) }, () => worker()),
      );
      cardIds = bag;
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
