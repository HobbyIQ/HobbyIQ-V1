import { Router } from "express";
const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "PlayerIQ", timestamp: new Date().toISOString() });
});

router.get("/query", (req, res) => {
  res.json({
    result: "No player data available. This is a placeholder.",
    timestamp: new Date().toISOString()
  });
});

export default router;
