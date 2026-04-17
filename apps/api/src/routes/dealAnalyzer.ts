import { Router, Request, Response } from "express";
import { analyzeDeal } from "../services/dealAnalyzer";
import { CompIQResult } from "../../../../types/hobbyiq";

const router = Router();

// POST /
router.post("/", (req: Request, res: Response) => {
  try {
    const { enteredPrice, compIQ }: { enteredPrice: number; compIQ: CompIQResult } = req.body;
    const result = analyzeDeal(enteredPrice, compIQ);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : err });
  }
});

export default router;
