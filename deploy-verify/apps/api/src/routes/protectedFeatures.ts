import express from "express";
import { requireFeature } from "../middleware/requireFeature";

const router = express.Router();

// Sample protected route: alerts.realtime
router.get("/alerts/realtime", requireFeature("alerts.realtime"), (req, res) => {
  res.json({ success: true, message: "You have access to real-time alerts!" });
});

// Sample protected route: decision.engine
router.get("/decision/engine", requireFeature("decision.engine"), (req, res) => {
  res.json({ success: true, message: "You have access to the decision engine!" });
});

// Sample protected route: selliq.full
router.get("/selliq/full", requireFeature("selliq.full"), (req, res) => {
  res.json({ success: true, message: "You have access to SellIQ Full!" });
});

export default router;
