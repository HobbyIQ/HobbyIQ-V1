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

router.get("/labeler/queue", async (req, res, next) => {
  try {
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 25;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, limitRaw) : 25;
    const { listLabelerQueue } = await import("../services/portfolioiq/labeler.service.js");
    const items = await listLabelerQueue(limit);
    res.json({ success: true, items, totalReturned: items.length });
  } catch (err) { next(err); }
});

router.post("/labeler/ai-suggest", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const required = ["chVariant", "set", "cardNumber", "cardYear", "playerName"];
    for (const k of required) {
      if (!b[k] && b[k] !== 0) { res.status(400).json({ success: false, error: `Missing field: ${k}` }); return; }
    }
    const { suggestLabelFromCatalogVariant } = await import("../services/portfolioiq/labelerAiSuggest.service.js");
    const out = await suggestLabelFromCatalogVariant({
      chVariant: String(b.chVariant),
      set: String(b.set),
      cardNumber: String(b.cardNumber),
      cardYear: Number(b.cardYear),
      playerName: String(b.playerName),
      imageUrl: typeof b.imageUrl === "string" ? b.imageUrl : null,
      currentGuess: typeof b.currentGuess === "string" ? b.currentGuess : undefined,
    });
    if (!out) { res.status(503).json({ success: false, error: "AI suggest unavailable (Azure OpenAI env missing or upstream failure)" }); return; }
    res.json({ success: true, suggestion: out });
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
