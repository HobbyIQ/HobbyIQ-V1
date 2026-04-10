import { Router } from "express";
import type { Request, Response } from "express";
import { fetchApifySoldComps } from "../services/comps/apifyClient";
import { normalizeComps } from "../services/comps/normalize";
import { calculateFmv } from "../services/comps/fmv";
import { InMemoryCache } from "../services/comps/cache";

// In-memory cache for FMV results (by query string)
const fmvCache = new InMemoryCache<{ summary: any; buckets: any; comps: any[] }>(5 * 60 * 1000, 100);
const router = Router();

router.get("/search", async (req: Request, res: Response) => {
  const q = req.query.q;
  if (!q || typeof q !== "string" || !q.trim()) {
    return res.status(400).json({ error: "Missing or invalid query parameter 'q'" });
  }

  // Check cache first
  const cacheKey = q.trim().toLowerCase();
  const cached = fmvCache.get(cacheKey);
  if (cached) {
    return res.json({
      query: q,
      summary: cached.summary,
      buckets: cached.buckets,
      comps: cached.comps,
      cached: true,
    });
  }

  try {
    // 1. Fetch raw comps from Apify
    const rawComps = await fetchApifySoldComps(q);

    // 2. Normalize comps
    const normalized = normalizeComps(rawComps, q);

    // 3. Calculate FMV and grade buckets
    const { summary, buckets } = calculateFmv(normalized);

    // 4. Sort comps by matchScore desc, then soldDate desc
    const comps = normalized
      .slice()
      .sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        const da = a.soldDate ? new Date(a.soldDate).getTime() : 0;
        const db = b.soldDate ? new Date(b.soldDate).getTime() : 0;
        return db - da;
      })
      .slice(0, 50); // Limit to 50 most relevant comps

    // Store in cache
    fmvCache.set(cacheKey, { summary, buckets, comps });

    // 5. Return response
    return res.json({
      query: q,
      summary,
      buckets,
      comps,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
});

export default router;
