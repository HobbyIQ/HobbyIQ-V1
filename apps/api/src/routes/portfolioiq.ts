import express from "express";
import { handleAddHolding, handleListHoldings, handlePortfolioSummary } from "../engines/portfolioiq";
import type { PortfolioAddRequest } from "../shared/types";

const router = express.Router();

// POST /api/portfolioiq/add-holding
router.post("/add-holding", async (req, res) => {
  try {
    const input: PortfolioAddRequest = req.body;
    const result = await handleAddHolding(input);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/portfolioiq/list-holdings
router.get("/list-holdings", async (_req, res) => {
  try {
    const result = await handleListHoldings();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/portfolioiq/summary
router.get("/summary", async (_req, res) => {
  try {
    const result = await handlePortfolioSummary();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
