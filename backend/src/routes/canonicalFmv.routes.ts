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

const router = Router();

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

export default router;
