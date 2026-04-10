import { Router, Request, Response } from "express";

const router = Router();

// POST /api/compiq/estimate
router.post("/estimate", (req: Request, res: Response) => {
  const { player, cardSet, parallel, rawPrice } = req.body || {};
  if (
    typeof player !== "string" ||
    typeof cardSet !== "string" ||
    typeof parallel !== "string" ||
    typeof rawPrice !== "number"
  ) {
    return res.status(400).json({
      success: false,
      error: "Missing or invalid input. Required: player, cardSet, parallel, rawPrice (number)"
    });
  }
  const estimatedPsa10 = rawPrice * 2.25;
  const estimatedPsa9 = rawPrice * 1.15;
  const estimatedPsa8 = rawPrice * 0.9;
  res.json({
    success: true,
    player,
    cardSet,
    parallel,
    rawPrice,
    estimatedPsa10,
    estimatedPsa9,
    estimatedPsa8
  });
});

export default router;
