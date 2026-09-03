// CF-SELL-NOW-RADAR + CF-NOTABLE-SALES-FEED (Drew, 2026-07-17).
// Separate router file so PR #533 (parallel work on portfolioiq.routes.ts)
// can merge without conflicting with this feature. Mounted BEFORE the
// blanket /api/portfolio → portfolioiqRoutes mount in app.ts so these
// two endpoints resolve to this handler even under Express's mount-
// order semantics.
//
// Both endpoints are session-required (router-level requireSession)
// and rate-limited by priceChecksPerDay — sell-radar iterates the
// user's whole holding list, notable-sales runs a Cosmos range query;
// neither should be a free-fire endpoint on the collector tier.
//
// CF-PRO-SELLER-GATE (Drew, 2026-09-02): "Gate all five to the Pro tiers."
// Both endpoints now sit behind requireEntitlement("sellerIntelligence")
// as well. Before this, the rate limiter was the ONLY thing standing
// between a free user and these reads — and a cap is not a gate: it
// metered the free tier's access rather than denying it (5 calls/day of
// the deal-scanner feed is still the deal-scanner feed). The cap stays
// for the tiers that have a finite one; the entitlement decides access.
//
// Order matters: entitlement BEFORE the rate limiter, so a free caller
// gets 402 subscription_required (the upgrade prompt) rather than 402
// rate_limit_exceeded (which would tell them to come back tomorrow for
// a feature they cannot have at any hour).
//
// PER-ROUTE, NOT router.use(). This router is mounted on the BARE
// /api/portfolio prefix (app.ts), ahead of portfolioiqRoutes on the same
// prefix. Express runs a router's `use` middleware for every request that
// matches the MOUNT path, before deciding that none of this router's own
// paths match and falling through to the next router. So a router-level
// entitlement gate here would 402 the entire /api/portfolio tree —
// GET /api/portfolio itself, /holdings, every mutation — turning a
// field-level gate into a total lockout of the free tier. It did exactly
// that, and proSellerFreeSurfacesUnchanged.test.ts caught it.

import { Router } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import { requireRateLimited } from "../middleware/requireRateLimited.js";
import { readUserDoc } from "../services/portfolioiq/portfolioStore.service.js";
import { detectSellNowCandidates } from "../services/portfolioiq/sellNowRadarAnalyze.service.js";
import { readNotableSales } from "../services/portfolioiq/notableSalesRead.service.js";

const router = Router();

// Every route in this router is session-required. Only the two
// endpoints below live here — no health / no public surface.
router.use(requireSession);

/**
 * GET /api/portfolio/sell-now-radar
 *
 * For each of the user's holdings, detect whether the SKU is trading at
 * >= 2x its baseline velocity AND the player's matched-cohort momentum
 * is up >= 10%. Returns sorted candidates for the "list this now" UI.
 *
 * Response: { count, candidates[] } — see SellRadarCandidate shape.
 */
router.get(
  "/sell-now-radar",
  requireEntitlement("sellerIntelligence"),
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const userDoc = await readUserDoc(userId);
      const holdings = Object.values(userDoc.holdings ?? {});
      const candidates = await detectSellNowCandidates(holdings);
      res.json({ count: candidates.length, candidates });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/portfolio/notable-sales
 *   ?minPrice=100000  — floor for the price filter (default 100_000)
 *   ?days=30          — window width, clamped to [1, 365] (default 30)
 *   ?limit=20         — result cap, clamped to [1, 100] (default 20)
 *
 * Reads the ch_daily_sales container for the top-dollar sales in the
 * window. Sorted saleDate DESC. `sourceLabel` derived from the listing
 * URL's domain (eBay / Goldin / Heritage / Fanatics Collect / Private).
 */
router.get(
  "/notable-sales",
  requireEntitlement("sellerIntelligence"),
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const minPrice = parseOptionalNumber(req.query.minPrice);
      const days = parseOptionalNumber(req.query.days);
      const limit = parseOptionalNumber(req.query.limit);
      const result = await readNotableSales({
        minPrice: minPrice ?? undefined,
        days: days ?? undefined,
        limit: limit ?? undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

function parseOptionalNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(typeof raw === "string" ? raw.trim() : raw);
  return Number.isFinite(n) ? n : null;
}

export default router;
