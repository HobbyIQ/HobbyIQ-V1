import { Router } from "express";
import type { Request, Response } from "express";
import { getSubscription, validateAppleReceipt } from "../services/subscription";

const router = Router();

// GET /api/subscription
router.get("/subscription", (_req: Request, res: Response) => {
  // In production, use userId from auth/session
  const subscription = getSubscription("demo");
  res.json({ subscription });
});

// POST /api/subscription/validate-apple
router.post("/subscription/validate-apple", async (req: Request, res: Response) => {
  const { receipt } = req.body;
  if (!receipt) return res.status(400).json({ error: "Missing receipt" });
  try {
    const result = await validateAppleReceipt(receipt);
    res.json({ valid: result });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
