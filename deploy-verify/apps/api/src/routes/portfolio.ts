import { Router, Request, Response } from "express";
// @ts-ignore
import { handleCompIQLiveEstimate } from "../../engines/compiq/index";
import { evaluatePortfolio } from "../engines/portfolioIQ";

const router = Router();

// POST /portfolio/evaluate: Evaluate a portfolio of cards
router.post("/evaluate", async (req: Request, res: Response) => {
  const cards = req.body;
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ success: false, error: "Input must be a non-empty array of cards" });
  }
  try {
    const compResultsMap: Record<string, any> = {};
    for (const card of cards) {
      const { player, set, parallel } = card;
      const query = [player, set, parallel].filter(Boolean).join(" ");
      const compResult = await handleCompIQLiveEstimate({ query } as any);
      const key = (player + "|" + parallel).toLowerCase().trim();
      compResultsMap[key] = compResult;
    }
    const evaluated = evaluatePortfolio(cards, compResultsMap);
    return res.json({ success: true, result: evaluated });
  } catch (err) {
    console.error("/portfolio/evaluate error", err);
    return res.status(500).json({ success: false, error: "Failed to evaluate portfolio" });
  }
});

export default router;
