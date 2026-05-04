import { Request, Response } from "express";
import { PortfolioHolding } from "../../types/portfolioiq.types.js";

let holdings: PortfolioHolding[] = [];
let idCounter = 1;

export function getHoldings(req: Request, res: Response) {
  res.json({ holdings });
}

export function addHolding(req: Request, res: Response) {
  const holding: PortfolioHolding = { ...req.body, id: idCounter++ };
  holdings.push(holding);
  res.status(201).json(holding);
}

export function getHoldingById(req: Request, res: Response) {
  const id = Number(req.params.id);
  const holding = holdings.find(h => h.id === id);
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  res.json(holding);
}

export function updateHolding(req: Request, res: Response) {
  const id = Number(req.params.id);
  const idx = holdings.findIndex(h => h.id === id);
  if (idx === -1) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  holdings[idx] = { ...holdings[idx], ...req.body };
  res.json(holdings[idx]);
}

export function refreshHolding(req: Request, res: Response) {
  const id = Number(req.params.id);
  const holding = holdings.find(h => h.id === id);
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  holding.freshnessStatus = "Needs refresh";
  holding.lastUpdated = new Date().toISOString();
  res.json(holding);
}
