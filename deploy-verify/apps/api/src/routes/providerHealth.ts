import { Router } from "express";
import type { Request, Response } from "express";
import { getAllProviderHealth } from "../services/providerHealth";

const router = Router();

// GET /api/provider-health
router.get("/provider-health", async (_req: Request, res: Response) => {
  const health = await getAllProviderHealth();
  res.json({ health });
});

export default router;
