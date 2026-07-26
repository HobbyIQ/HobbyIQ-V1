// CF-CANONICAL-FMV-ROUTE (Drew, 2026-07-18). Public read surface for
// the canonical FMV pipeline. Every FMV consumer eventually calls this
// so the answer is deterministic and identical across surfaces.
//
// Route: POST /api/compiq/canonical-fmv
// Auth: requireSession (rate-limited via app-level middleware).
// Body:
//   {
//     cardId: string,               // required
//     parallel?: string | null,     // "Blue Refractor", "Base", null
//     gradeCompany?: string | null, // "PSA", "BGS", null = raw
//     gradeValue?: number | null,   // 10, 9.5, null = raw
//     cardYear?: number | null,
//     product?: string | null,
//     player?: string | null,
//     cardNumber?: string | null,
//     freshCompute?: boolean,       // skip cache
//   }
// Response: CanonicalFmvResult envelope.
//
// Feature flag: CANONICAL_FMV_ENABLED=true. When unset, the route
// returns 503 so we can ship the code without turning it on.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { computeCanonicalFmv } from "../services/compiq/canonicalFmv.service.js";
import { computeHobbyIqFmv } from "../services/portfolioiq/hobbyIqFmv.service.js";
import { computeHobbyIqCardId } from "../services/portfolioiq/hobbyIqCardId.service.js";
import { canonicalCardSearch } from "../services/portfolioiq/canonicalCardSearch.service.js";
import { computeTrending, computeRelatedCards, computeTrendingPlayers } from "../services/portfolioiq/discoverySurfaces.service.js";
import { lookupByImage } from "../services/portfolioiq/imageSimilarityLookup.service.js";
import { autocomplete } from "../services/portfolioiq/autocompleteLookup.service.js";
import { computeCardDetail } from "../services/portfolioiq/cardDetail.service.js";

const router = Router();

// CF-COMPUTE-HOBBYIQ-SLUG-ROUTE (Drew, 2026-07-23). iOS helper endpoint
// that returns the canonical hobbyiqCardId slug for a given set of
// identity fields. Mirrors the backend's computeHobbyIqCardId exactly
// so iOS doesn't have to re-implement setKey normalization, parallel
// slug rules, or auto-flag handling — one source of truth.
//
// Route: POST /api/compiq/compute-hobbyiq-slug
// Body:
//   {
//     sport: string,                  // "baseball" | "football" | "basketball" | "hockey" | NFL/NBA/MLB/NHL aliases
//     cardYear: number,               // or `year`
//     setKey: string,                 // or `setName` / `product` (fallback chain)
//     cardNumber: string,             // "CPA-EHA" / "BSPA-OC" / "BCP-102" etc.
//     parallel?: string | null,       // "Blue Refractor" / "Base" / null → "Base"
//     isAuto: boolean,
//     printRun?: number | null,       // 150 / 199 / 50 / null
//   }
router.post("/compute-hobbyiq-slug", requireSession, async (req: Request, res: Response, next) => {
  try {
    const body = req.body ?? {};
    const sport = String(body.sport ?? "").trim();
    const yearRaw = body.cardYear ?? body.year;
    const year = Number(yearRaw);
    const setKey = String(body.setKey ?? body.setName ?? body.product ?? "").trim();
    const cardNumber = String(body.cardNumber ?? "").trim();
    const parallel = body.parallel == null || String(body.parallel).trim().length === 0
      ? "Base"
      : String(body.parallel).trim();
    const isAuto = body.isAuto === true;
    const printRun = body.printRun == null || body.printRun === "" ? null : Number(body.printRun);

    if (!sport || !Number.isFinite(year) || !setKey || !cardNumber) {
      res.status(400).json({
        success: false,
        error: "sport, cardYear (or year), setKey (or setName/product), and cardNumber are required",
        received: { sport, year, setKey, cardNumber },
      });
      return;
    }
    if (printRun !== null && (!Number.isFinite(printRun) || printRun <= 0)) {
      res.status(400).json({
        success: false,
        error: "printRun must be a positive integer or null",
      });
      return;
    }
    const slug = computeHobbyIqCardId({
      sport, year, setKey, cardNumber, parallel, isAuto,
      printRun: printRun as number | null,
    });
    res.json({ success: true, slug });
  } catch (err) { next(err); }
});

// CF-HOBBYIQ-FMV-ROUTE (Drew, 2026-07-23). "We set the market" surface.
// Reads OUR own sold_comps pool by canonical hobbyiqCardId slug and
// returns a full breakdown iOS can render — comp count, source mix,
// autoStyle mix (on-card vs sticker), gradeQualifier mix, trend, and
// recent comps.
//
// Zero vendor calls. Every field comes from HobbyIQ's own pool.
//
// Route: POST /api/compiq/hobbyiq-fmv
// Body:
//   {
//     hobbyiqCardId: string,        // required — canonical slug
//     gradeCompany?: string | null,
//     gradeValue?: number | null,
//     maxAgeDays?: number,          // freshness cutoff (default 180)
//     previewLimit?: number,        // recentComps preview size (default 10)
//   }
router.post("/hobbyiq-fmv", requireSession, async (req: Request, res: Response, next) => {
  try {
    const hobbyiqCardId = String(req.body?.hobbyiqCardId ?? "").trim();
    if (!hobbyiqCardId || !hobbyiqCardId.startsWith("hiq:")) {
      res.status(400).json({ success: false, error: "hobbyiqCardId required (must start with 'hiq:')" });
      return;
    }
    const result = await computeHobbyIqFmv({
      hobbyiqCardId,
      gradeCompany: typeof req.body?.gradeCompany === "string" ? req.body.gradeCompany : null,
      gradeValue: typeof req.body?.gradeValue === "number" ? req.body.gradeValue : null,
      maxAgeDays: typeof req.body?.maxAgeDays === "number" ? req.body.maxAgeDays : undefined,
      previewLimit: typeof req.body?.previewLimit === "number" ? req.body.previewLimit : undefined,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/canonical-fmv", requireSession, async (req: Request, res: Response, next) => {
  try {
    if (process.env.CANONICAL_FMV_ENABLED !== "true") {
      res.status(503).json({
        success: false,
        error: "canonical FMV endpoint is disabled (CANONICAL_FMV_ENABLED != true)",
      });
      return;
    }
    const cardId = String(req.body?.cardId ?? "").trim();
    if (!cardId) {
      res.status(400).json({ success: false, error: "cardId required" });
      return;
    }
    const result = await computeCanonicalFmv({
      cardId,
      parallel: typeof req.body?.parallel === "string" ? req.body.parallel : null,
      gradeCompany: typeof req.body?.gradeCompany === "string" ? req.body.gradeCompany : null,
      gradeValue: typeof req.body?.gradeValue === "number" ? req.body.gradeValue : null,
      cardYear: typeof req.body?.cardYear === "number" ? req.body.cardYear : null,
      product: typeof req.body?.product === "string" ? req.body.product : null,
      player: typeof req.body?.player === "string" ? req.body.player : null,
      cardNumber: typeof req.body?.cardNumber === "string" ? req.body.cardNumber : null,
      freshCompute: req.body?.freshCompute === true,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// CF-CANONICAL-CARD-SEARCH (Drew, 2026-07-24, renamed 2026-07-25).
// Free-text CATALOG search over card_catalog — returns multiple candidate
// cards for iOS to pick from. Response includes hobbyiqCardId, matched
// ranges, groups, momentum, and recentMedian.
//
// Mounted at POST /api/compiq/card-search. The old `/search` path is
// already claimed by compiq.routes.ts:2163 (DashboardView single-card
// FMV estimate, expects `{query}` not `{q}` and returns a full estimate
// envelope). Mount order in app.ts registers compiqRoutes BEFORE
// canonicalFmvRoutes, so a POST `/search` here was shadowed and never
// reached — smoke test 2026-07-25 confirmed. This name change keeps the
// two purposes semantically distinct without touching DashboardView.
router.post("/card-search", requireSession, async (req: Request, res: Response, next) => {
  try {
    const q = String(req.body?.q ?? "").trim();
    if (!q) {
      res.status(400).json({ success: false, error: "q is required" });
      return;
    }
    const result = await canonicalCardSearch({
      q,
      sport: typeof req.body?.sport === "string" ? req.body.sport : "baseball",
      limit: Number.isFinite(Number(req.body?.limit)) ? Number(req.body.limit) : 20,
      // Explicit filter params for iOS refinement chips
      parallel: typeof req.body?.parallel === "string" && req.body.parallel.trim() ? req.body.parallel.trim() : undefined,
      grade: typeof req.body?.grade === "string" && req.body.grade.trim() ? req.body.grade.trim() : undefined,
      printRun: Number.isFinite(Number(req.body?.printRun)) && Number(req.body.printRun) > 0 ? Number(req.body.printRun) : undefined,
      isAuto: typeof req.body?.isAuto === "boolean" ? req.body.isAuto : undefined,
      year: Number.isFinite(Number(req.body?.year)) ? Number(req.body.year) : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// CF-DISCOVERY-SURFACES (Drew, 2026-07-25). Three read-only endpoints
// that power iOS "explore" screens beyond typed search.

router.get("/trending", requireSession, async (req: Request, res: Response, next) => {
  try {
    const result = await computeTrending({
      sport: typeof req.query.sport === "string" ? req.query.sport : "baseball",
      limit: Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 10,
      minRecentMedian: Number.isFinite(Number(req.query.minRecentMedian)) ? Number(req.query.minRecentMedian) : undefined,
      minMomentum: Number.isFinite(Number(req.query.minMomentum)) ? Number(req.query.minMomentum) : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/related-cards", requireSession, async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.query.slug ?? "").trim();
    if (!slug || !slug.startsWith("hiq:")) {
      res.status(400).json({ success: false, error: "slug is required (hiq:... hobbyiqCardId format)" });
      return;
    }
    const result = await computeRelatedCards(
      slug,
      Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 8,
    );
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/trending-players", requireSession, async (req: Request, res: Response, next) => {
  try {
    const result = await computeTrendingPlayers({
      sport: typeof req.query.sport === "string" ? req.query.sport : "baseball",
      limit: Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 20,
      minRecentComps: Number.isFinite(Number(req.query.minRecentComps)) ? Number(req.query.minRecentComps) : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// CF-IMAGE-SIMILARITY-LOOKUP-ROUTE (Drew, 2026-07-25). "Scan any card"
// — user uploads a photo, we return the closest FMV-backed matches.
//
// POST /api/compiq/lookup-by-image
// Body: { imageBase64?: string, imageUrl?: string, limit?: 1..20, maxHamming?: 0..64 }
// Response: ImageLookupResult with algo=dhash-v1, hits[] enriched with recentMedian.
router.post("/lookup-by-image", requireSession, async (req: Request, res: Response, next) => {
  try {
    const body = req.body ?? {};
    const imageBase64 = typeof body.imageBase64 === "string" && body.imageBase64.length > 0 ? body.imageBase64 : undefined;
    const imageUrl = typeof body.imageUrl === "string" && body.imageUrl.length > 0 ? body.imageUrl : undefined;
    if (!imageBase64 && !imageUrl) {
      res.status(400).json({ success: false, error: "imageBase64 or imageUrl required" });
      return;
    }
    const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : undefined;
    const maxHamming = Number.isFinite(Number(body.maxHamming)) ? Number(body.maxHamming) : undefined;
    const result = await lookupByImage({ imageBase64, imageUrl, limit, maxHamming });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// CF-AUTOCOMPLETE-ROUTES (Drew, 2026-07-25). Fast prefix-match typeahead
// for iOS search UI. Backed by card_catalog with 10-min in-memory index.
//
// GET /api/compiq/autocomplete-player?q=trout&sport=baseball&limit=10
// GET /api/compiq/autocomplete-set?q=bowman&sport=baseball&limit=10
router.get("/autocomplete-player", requireSession, async (req: Request, res: Response, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) { res.status(400).json({ success: false, error: "q is required" }); return; }
    const result = await autocomplete("player", {
      q,
      sport: typeof req.query.sport === "string" ? req.query.sport : undefined,
      limit: Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 10,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// CF-CARD-DETAIL-COMPOSITE (Drew, 2026-07-25). Single-call card-detail
// render for iOS. Wraps computeHobbyIqFmv + computeRelatedCards in one
// parallel-fetched envelope so tap-into-card renders instantly instead
// of chaining 2+ round-trips.
//
// POST /api/compiq/card-detail
// Body: {
//   hobbyiqCardId: string,        // required — canonical slug
//   gradeCompany?: string | null,
//   gradeValue?: number | null,
//   maxAgeDays?: number,          // freshness cutoff for FMV pool
//   previewLimit?: number,        // recentComps preview size
//   relatedLimit?: number,        // # of related cards per bucket
// }
router.post("/card-detail", requireSession, async (req: Request, res: Response, next) => {
  try {
    const hobbyiqCardId = String(req.body?.hobbyiqCardId ?? "").trim();
    if (!hobbyiqCardId || !hobbyiqCardId.startsWith("hiq:")) {
      res.status(400).json({ success: false, error: "hobbyiqCardId required (must start with 'hiq:')" });
      return;
    }
    const result = await computeCardDetail({
      hobbyiqCardId,
      gradeCompany: typeof req.body?.gradeCompany === "string" ? req.body.gradeCompany : null,
      gradeValue: typeof req.body?.gradeValue === "number" ? req.body.gradeValue : null,
      maxAgeDays: typeof req.body?.maxAgeDays === "number" ? req.body.maxAgeDays : undefined,
      previewLimit: typeof req.body?.previewLimit === "number" ? req.body.previewLimit : undefined,
      relatedLimit: typeof req.body?.relatedLimit === "number" ? req.body.relatedLimit : undefined,
      // CF-GRADE-LADDER-OPT-IN (Drew, 2026-07-25). Default FALSE — 7
      // parallel FMV computes on the ladder take 15-17s cold in prod
      // (Cosmos SDK contention). iOS opts in explicitly when rendering
      // the grade-breakdown view; default keeps the tap-into-card path
      // at ~200-700ms.
      includeGradeLadder: req.body?.includeGradeLadder === true,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/autocomplete-set", requireSession, async (req: Request, res: Response, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) { res.status(400).json({ success: false, error: "q is required" }); return; }
    const result = await autocomplete("releaseName", {
      q,
      sport: typeof req.query.sport === "string" ? req.query.sport : undefined,
      limit: Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 10,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

export default router;
