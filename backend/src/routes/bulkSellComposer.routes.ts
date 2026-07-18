// CF-BULK-SELL-COMPOSER (Drew, 2026-07-17). Route for the multi-card
// bundle-vs-individual composer. iOS: user picks N cards, we return
// per-card strategy recommendation + total net comparison.

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";
import { composeBulkSell, type BulkSellHolding } from "../services/portfolioiq/bulkSellComposer.js";

const router = Router();

async function requireUserId(req: Request, res: Response): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return user.userId;
}

// ────────────────────────────────────────────────────────────────────
// POST /api/portfolio/bulk-sell-composer
//   body: { holdingIds: string[], options?: BulkSellComposerOptions }
//
// Response: BulkSellComposerResult with per-card strategy
// recommendation + total individual vs bundle net comparison.
// ────────────────────────────────────────────────────────────────────
router.post("/bulk-sell-composer", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const holdingIds: string[] = Array.isArray(req.body?.holdingIds)
      ? req.body.holdingIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (holdingIds.length === 0) {
      return res.status(400).json({ error: "holdingIds array required" });
    }
    if (holdingIds.length > 50) {
      return res.status(400).json({ error: "max 50 holdings per request" });
    }

    const { readUserDoc } = await import("../services/portfolioiq/portfolioStore.service.js");
    const doc = await readUserDoc(userId);
    const holdings = doc.holdings ?? {};

    const bulkInputs: BulkSellHolding[] = [];
    for (const id of holdingIds) {
      // Case-insensitive key match
      const key = Object.keys(holdings).find((k) => k.toLowerCase() === id.toLowerCase());
      const h = key ? holdings[key] : undefined;
      if (!h) continue;
      bulkInputs.push({
        holdingId: h.id ?? id,
        playerName: h.playerName ?? "",
        cardTitle: [h.cardYear, h.setName ?? h.product, h.parallel].filter(Boolean).join(" "),
        predictedPrice: typeof h.predictedPrice === "number" ? h.predictedPrice : null,
        marketValue: typeof h.fairMarketValue === "number" ? h.fairMarketValue : null,
        purchasePrice: typeof h.purchasePrice === "number" ? h.purchasePrice : null,
      });
    }
    if (bulkInputs.length === 0) {
      return res.status(404).json({ error: "no matching holdings" });
    }

    const opts = req.body?.options ?? {};
    const result = composeBulkSell(bulkInputs, opts);
    res.json({
      computedAt: new Date().toISOString(),
      requestedCount: holdingIds.length,
      resolvedCount: bulkInputs.length,
      ...result,
    });
  } catch (err) { next(err); }
});

export default router;
