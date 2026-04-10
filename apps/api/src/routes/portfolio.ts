import { Router } from "express";
import type { Request, Response } from "express";
import { getPortfolio } from "../services/portfolio";
import { makeDecision } from "../services/decision";
import { calculateScarcity } from "../services/scarcity";
import { trackSupply } from "../services/supply";
import { getGemRate } from "../services/gemrate";

const router = Router();

// GET /api/portfolio
router.get("/portfolio", (_req: Request, res: Response) => {
  // In production, use userId from auth/session
  const portfolio = getPortfolio("demo");
  res.json({ portfolio });
});

// GET /api/portfolio/:cardId/decision
router.get("/portfolio/:cardId/decision", (req: Request, res: Response) => {
  const { cardId } = req.params;
  const portfolio = getPortfolio("demo");
  const card = portfolio.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: "Card not found" });
  const decision = makeDecision(card);
  res.json(decision);
});

// GET /api/portfolio/:cardId/scarcity
router.get("/portfolio/:cardId/scarcity", (req: Request, res: Response) => {
  const { cardId } = req.params;
  const portfolio = getPortfolio("demo");
  const card = portfolio.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: "Card not found" });
  const scarcity = calculateScarcity(card);
  res.json(scarcity);
});

// GET /api/portfolio/:cardId/supply
router.get("/portfolio/:cardId/supply", (req: Request, res: Response) => {
  const { cardId } = req.params;
  const portfolio = getPortfolio("demo");
  const card = portfolio.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: "Card not found" });
  const supply = trackSupply(card);
  res.json(supply);
});

// GET /api/portfolio/:cardId/gemrate
router.get("/portfolio/:cardId/gemrate", (req: Request, res: Response) => {
  const { cardId } = req.params;
  const portfolio = getPortfolio("demo");
  const card = portfolio.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: "Card not found" });
  const gemRate = getGemRate(card);
  res.json(gemRate);
});

export default router;
