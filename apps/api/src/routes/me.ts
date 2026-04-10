import express from "express";
import { getUserPlan } from "../repositories/subscriptionRepository";
import { getUnlockedFeatures } from "../utils/featureAccess";
import { PLAN_NOTIFICATION_LIMITS } from "../models/planTiers";

const router = express.Router();

// /api/me/access
router.get("/access", (req, res) => {
  const userId = req.headers["x-user-id"] as string || req.query.userId as string || req.body.userId;
  if (!userId) return res.status(401).json({ success: false, error: "Missing userId" });
  const plan = getUserPlan(userId);
  const features = getUnlockedFeatures(plan);
  const limits = PLAN_NOTIFICATION_LIMITS[plan] || {};
  res.json({
    userId,
    plan,
    features,
    limits
  });
});

export default router;
