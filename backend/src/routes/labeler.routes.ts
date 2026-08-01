// CF-LABELER-ROUTES (Drew, 2026-07-31). Admin-gated endpoints for
// the variant labeler. GET returns all CH catalog variants for a
// card (with images + matched sold_comps counts). POST saves a
// canonical label + optionally rewrites matching sold_comps rows.

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { listVariantsForCard, saveVariantLabel } from "../services/portfolioiq/labeler.service.js";

const router = Router();
router.use(requireAdmin);

router.get("/labeler/variants", async (req, res, next) => {
  try {
    const cardNumber = typeof req.query.cardNumber === "string" ? req.query.cardNumber : "";
    const yearRaw = typeof req.query.cardYear === "string" ? Number(req.query.cardYear) : NaN;
    const cardYear = Number.isFinite(yearRaw) ? yearRaw : null;
    if (!cardNumber) {
      res.status(400).json({ success: false, error: "cardNumber query param required" });
      return;
    }
    const out = await listVariantsForCard(cardNumber, cardYear);
    if (!out) {
      res.status(503).json({ success: false, error: "Cosmos not configured" });
      return;
    }
    res.json({ success: true, ...out });
  } catch (err) { next(err); }
});

router.post("/labeler/label", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const required = ["cardCatalogId", "cardNumber", "cardYear", "set", "chVariant", "canonicalParallel", "labeledBy"];
    for (const k of required) {
      if (!b[k] && b[k] !== 0) {
        res.status(400).json({ success: false, error: `Missing field: ${k}` });
        return;
      }
    }
    const out = await saveVariantLabel({
      cardCatalogId: String(b.cardCatalogId),
      cardNumber: String(b.cardNumber),
      cardYear: Number(b.cardYear),
      set: String(b.set),
      chVariant: String(b.chVariant),
      canonicalParallel: String(b.canonicalParallel),
      isRefractor: Boolean(b.isRefractor),
      printRun: b.printRun == null ? null : Number(b.printRun),
      labeledBy: String(b.labeledBy),
      applyToSoldComps: b.applyToSoldComps !== false,
      sport: typeof b.sport === "string" ? b.sport : undefined,
    });
    res.json({ success: true, ...out });
  } catch (err) { next(err); }
});

export default router;
