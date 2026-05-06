import { Router } from "express";
import * as portfolio from "../services/portfolioiq/portfolioStore.service.js";
const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "PortfolioIQ", timestamp: new Date().toISOString() });
});

router.get("/holdings", portfolio.getHoldings);
router.get("/ledger", portfolio.getLedger);
router.post("/holdings", portfolio.addHolding);
router.get("/holdings/:id", portfolio.getHoldingById);
router.put("/holdings/:id", portfolio.updateHolding);
router.patch("/holdings/:id", portfolio.updateHolding);
router.delete("/holdings/:id", portfolio.deleteHolding);
router.post("/holdings/:id/sell", portfolio.sellHolding);
router.post("/holdings/:id/refresh", portfolio.refreshHolding);

export default router;
