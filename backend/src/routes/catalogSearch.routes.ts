// CF-CATALOG-FIRST — search route (Drew, 2026-08-04).
//
// POST /api/catalog/search
//
// Direct query against card_catalog for canonical entries + attached
// salesSummary. Users find their card in OUR data first; the caller
// can optionally fall back to vendor search if catalog returns empty.
//
// Body: { query: string, limit?: number, sport?: string, year?: number, isAuto?: boolean }
// Response: CatalogSearchResponse

import { Request, Response, Router } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { searchCatalog } from "../services/catalog/catalogSearch.service.js";

const router = Router();
router.use(requireSession);

router.post("/search", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    query?: unknown;
    limit?: unknown;
    sport?: unknown;
    year?: unknown;
    isAuto?: unknown;
  };
  const query = typeof body.query === "string" ? body.query : "";
  if (!query.trim()) {
    res.status(400).json({ success: false, error: "query is required" });
    return;
  }
  const limit = typeof body.limit === "number" ? Math.floor(body.limit) : undefined;
  const sport = typeof body.sport === "string" ? body.sport : null;
  const year = typeof body.year === "number" ? body.year : null;
  const isAuto = typeof body.isAuto === "boolean" ? body.isAuto : null;

  // CF-SEARCH-RANK-AGAINST-THE-HOLDING (Drew, 2026-08-23). Optional: what the
  // caller already knows about the card being identified. Boosts matching hits
  // so the review queue's search-and-pick opens on the right answer instead of
  // making the user hunt. Never filters — see the weights in searchCatalog.
  const rawCtx = (req.body ?? {}) as { context?: Record<string, unknown> };
  const c = rawCtx.context && typeof rawCtx.context === "object" ? rawCtx.context : null;
  const context = c
    ? {
        cardNumber: typeof c.cardNumber === "string" ? c.cardNumber : null,
        year: typeof c.year === "number" ? c.year : null,
        setName: typeof c.setName === "string" ? c.setName : null,
        playerName: typeof c.playerName === "string" ? c.playerName : null,
        isAuto: typeof c.isAuto === "boolean" ? c.isAuto : null,
      }
    : null;

  try {
    const result = await searchCatalog({ query, limit, sport, year, isAuto, context });
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Catalog search failed";
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
