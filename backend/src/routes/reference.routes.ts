// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4). Query surface for the
// Cosmos-backed reference-catalog container.
//
// Two endpoints:
//
//   GET /api/reference/parallels?product=&year=
//       List every parallel doc for a given (productKey, year). Used by
//       the iOS structured search form's parallel picker and by internal
//       CompIQ code paths that need the full print-run table.
//
//   GET /api/reference/parallels/resolve?product=&year=&parallel=
//       Point lookup for one parallel. Returns the ParallelDoc when the
//       exact canonical key hits, otherwise the closest fuzzy match with
//       a score so the caller can decide whether to accept it.
//
// Canonicalization: uses shared/slug.ts — the same function that WROTE
// parallelKey / productKey during PR A ingest. No second canonicalization
// path lives here.

import { Router, Request, Response } from "express";
import { slug } from "../shared/slug.js";
import {
  listParallelsByProductYear,
  getParallelByCanonicalKey,
  listParallelsForFuzzyResolve,
} from "../repositories/referenceCatalog.repository.js";
import { ParallelDoc } from "../services/reference/referenceCatalog.types.js";

const router = Router();

function badRequest(res: Response, message: string): void {
  res.status(400).json({ success: false, error: message });
}

function parseYear(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 1887 || n > 2100) return null;
  return n;
}

router.get("/parallels", async (req: Request, res: Response) => {
  const productRaw = String(req.query.product ?? "").trim();
  const year = parseYear(req.query.year);
  if (!productRaw) return badRequest(res, "product query parameter is required");
  if (year === null)
    return badRequest(res, "year query parameter is required and must be a 4-digit number in [1887, 2100]");

  const productKey = slug(productRaw);
  const docs = await listParallelsByProductYear(productKey, year);
  res.json({
    success: true,
    productKey,
    product: productRaw,
    year,
    count: docs.length,
    parallels: docs,
  });
});

// ─── Fuzzy scoring ────────────────────────────────────────────────────────
//
// Only invoked when the exact canonical key misses. Both sides are already
// slug-normalized (kebab, alnum), so token overlap is a good enough signal
// without pulling in a real edit-distance dep.
function fuzzyScore(target: string, candidate: string): number {
  if (target === candidate) return 1;
  const tTokens = new Set(target.split("-").filter(Boolean));
  const cTokens = new Set(candidate.split("-").filter(Boolean));
  if (tTokens.size === 0 || cTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of tTokens) if (cTokens.has(t)) overlap++;
  // Jaccard, then a small containment bonus so "gold refractor" matches
  // "gold-refractor-refractor" over "gold-prizm".
  const union = new Set([...tTokens, ...cTokens]);
  const jaccard = overlap / union.size;
  const containment = overlap / tTokens.size;
  return 0.6 * jaccard + 0.4 * containment;
}

router.get("/parallels/resolve", async (req: Request, res: Response) => {
  const productRaw = String(req.query.product ?? "").trim();
  const year = parseYear(req.query.year);
  const parallelRaw = String(req.query.parallel ?? "").trim();
  const cardSetRaw = String(req.query.cardSet ?? "").trim();
  if (!productRaw) return badRequest(res, "product query parameter is required");
  if (year === null)
    return badRequest(res, "year query parameter is required and must be a 4-digit number in [1887, 2100]");
  if (!parallelRaw) return badRequest(res, "parallel query parameter is required");

  const productKey = slug(productRaw);
  const parallelKey = slug(parallelRaw);
  const cardSetKey = cardSetRaw ? slug(cardSetRaw) : "";

  // Fast path: exact (productKey, year, cardSetKey, parallelKey) hit.
  if (cardSetKey) {
    const hit = await getParallelByCanonicalKey(productKey, year, cardSetKey, parallelKey);
    if (hit) {
      res.json({
        success: true,
        match: "exact",
        productKey,
        year,
        parallel: hit,
      });
      return;
    }
  }

  // Fuzzy fallback: pull the (productKey, year) shard and rank by token overlap.
  const candidates = await listParallelsForFuzzyResolve(productKey, year);
  if (candidates.length === 0) {
    res.json({
      success: true,
      match: "miss",
      productKey,
      year,
      parallel: null,
      note: "no parallels curated for (productKey, year)",
    });
    return;
  }

  let best: { doc: ParallelDoc; score: number } | null = null;
  for (const doc of candidates) {
    const score = fuzzyScore(parallelKey, doc.parallelKey);
    if (!best || score > best.score) best = { doc, score };
  }
  // Threshold: below 0.35 is not a meaningful match — return miss so the
  // caller doesn't act on noise.
  if (!best || best.score < 0.35) {
    res.json({
      success: true,
      match: "miss",
      productKey,
      year,
      parallel: null,
      candidateCount: candidates.length,
    });
    return;
  }
  res.json({
    success: true,
    match: best.score === 1 ? "exact" : "fuzzy",
    score: best.score,
    productKey,
    year,
    parallel: best.doc,
    candidateCount: candidates.length,
  });
});

export default router;
