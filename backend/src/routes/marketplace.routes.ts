// CF-MARKETPLACE-SEARCH (Drew, 2026-08-10). Cross-storefront search.
// Buyers query across every eligible seller's opted-in storefront
// cards in one call.
//
// Route: GET /api/marketplace/search
// Auth: public (no login required — this is a marketplace discovery
//       surface, not a personal-data surface).
//
// Query params:
//   q             — free-text (space-separated tokens; ANDed across searchTokens)
//   year          — 2024 | 2025 | ...
//   parallel      — "Blue Refractor" (case-insensitive exact match)
//   gradeCompany  — PSA | BGS | SGC | CGC
//   gradeValue    — 10 | 9.5 | 9 | ...
//   isAuto        — true | false
//   priceMin      — inclusive FMV floor
//   priceMax      — inclusive FMV ceiling
//   sellerId      — restrict to one seller's storefront
//   sortBy        — relevance (default) | price-asc | price-desc | newest
//   limit         — 1..200 (default 50)
//   groupBySeller — if true, groups results by seller with counts
//
// Response (default flat):
//   {
//     success: true,
//     results: [ MarketplaceListing, ... ],
//     count: N,
//     truncated: boolean
//   }
//
// Response (groupBySeller=true):
//   {
//     success: true,
//     sellers: [ { username, plan, count, cards: [MarketplaceListing, ...] }, ... ],
//     totalCards: N
//   }

import { Router, type Request, type Response } from "express";
import { searchListings, type MarketplaceListing } from "../services/marketplace/marketplaceListingsStore.service.js";

const router = Router();

router.get("/search", async (req: Request, res: Response, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const year = typeof req.query.year === "string" ? Number(req.query.year) : undefined;
    const parallel = typeof req.query.parallel === "string" ? req.query.parallel : undefined;
    const gradeCompany = typeof req.query.gradeCompany === "string" ? req.query.gradeCompany.toUpperCase() : undefined;
    const gradeValue = typeof req.query.gradeValue === "string" ? Number(req.query.gradeValue) : undefined;
    const isAutoParam = typeof req.query.isAuto === "string" ? req.query.isAuto.toLowerCase() : "";
    const isAuto = isAutoParam === "true" ? true : isAutoParam === "false" ? false : undefined;
    const priceMin = typeof req.query.priceMin === "string" ? Number(req.query.priceMin) : undefined;
    const priceMax = typeof req.query.priceMax === "string" ? Number(req.query.priceMax) : undefined;
    const sellerId = typeof req.query.sellerId === "string" ? req.query.sellerId : undefined;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const sortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "relevance";
    const groupBySeller = String(req.query.groupBySeller ?? "").toLowerCase() === "true";

    // Require at least one filter to prevent naked scans
    if (!q && year === undefined && !parallel && !gradeCompany && gradeValue === undefined && isAuto === undefined && priceMin === undefined && priceMax === undefined && !sellerId) {
      return res.status(400).json({
        success: false,
        error: "at_least_one_filter_required",
        message: "Provide at least one of: q, year, parallel, gradeCompany, gradeValue, isAuto, priceMin, priceMax, sellerId",
      });
    }

    let results = await searchListings({
      q, year, parallel, gradeCompany, gradeValue, isAuto, priceMin, priceMax, sellerId, limit,
    });

    // Sort
    if (sortBy === "price-asc") {
      results.sort((a, b) => (a.fmv ?? Number.POSITIVE_INFINITY) - (b.fmv ?? Number.POSITIVE_INFINITY));
    } else if (sortBy === "price-desc") {
      results.sort((a, b) => (b.fmv ?? -1) - (a.fmv ?? -1));
    } else if (sortBy === "newest") {
      results.sort((a, b) => String(b.addedToStorefrontAt ?? "").localeCompare(String(a.addedToStorefrontAt ?? "")));
    }
    // relevance = insertion order from query (Cosmos returns matched rows,
    // more-token-matched implicitly first when ARRAY_CONTAINS filter chain
    // is applied — no extra sort needed).

    if (groupBySeller) {
      const bySeller = new Map<string, { username: string | null; plan: string; count: number; cards: MarketplaceListing[] }>();
      for (const r of results) {
        const existing = bySeller.get(r.sellerId) ?? {
          username: r.sellerUsername,
          plan: r.sellerPlan,
          count: 0,
          cards: [],
        };
        existing.count++;
        existing.cards.push(r);
        bySeller.set(r.sellerId, existing);
      }
      const sellers = [...bySeller.entries()].map(([sellerId, s]) => ({ sellerId, ...s }))
        .sort((a, b) => b.count - a.count);
      return res.json({
        success: true,
        sellers,
        totalCards: results.length,
        truncated: results.length >= limit,
      });
    }

    return res.json({
      success: true,
      results,
      count: results.length,
      truncated: results.length >= limit,
    });
  } catch (err) { next(err); }
});

export default router;
