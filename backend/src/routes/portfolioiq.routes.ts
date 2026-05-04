import { Router } from "express";
import * as portfolio from "../services/portfolioiq/portfolioStore.service.js";
const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "PortfolioIQ", timestamp: new Date().toISOString() });
});

router.get("/holdings", portfolio.getHoldings);
router.post("/holdings", portfolio.addHolding);
router.get("/holdings/:id", portfolio.getHoldingById);
router.patch("/holdings/:id", portfolio.updateHolding);
router.post("/holdings/:id/refresh", portfolio.refreshHolding);

export default router;
