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

const router = Router();

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
