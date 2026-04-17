import { Router, Request, Response } from "express";
import { getAlerts, markAlertRead, dismissAlert } from "../alerts/service";

const router = Router();

// GET /api/alerts
router.get("/", async (req: Request, res: Response) => {
  // TEMP: single-user assumption
  const userId = req.query.userId as string || "user-uuid";
  const result = await getAlerts(userId);
  res.json(result);
});

// POST /api/alerts
router.post("/", async (req: Request, res: Response) => {
  // Endpoint not implemented: createAlert
  res.status(501).json({ error: "Not implemented" });
});

// POST /api/alerts/:id/read
router.post("/:id/read", async (req: Request, res: Response) => {
  const { id } = req.params;
  const alertId = Array.isArray(id) ? id[0] : id;
  const result = await markAlertRead(alertId);
  res.json(result);
});

// POST /api/alerts/:id/dismiss
router.post("/:id/dismiss", async (req: Request, res: Response) => {
  const { id } = req.params;
  const alertId = Array.isArray(id) ? id[0] : id;
  const result = await dismissAlert(alertId);
  res.json(result);
});

// POST /api/alerts/evaluate
router.post("/evaluate", async (req: Request, res: Response) => {
  // Endpoint not implemented: evaluateAlertsForPortfolio
  res.status(501).json({ error: "Not implemented" });
});

export default router;
