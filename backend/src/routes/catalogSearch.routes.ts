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

  try {
    const result = await searchCatalog({ query, limit, sport, year, isAuto });
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Catalog search failed";
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
