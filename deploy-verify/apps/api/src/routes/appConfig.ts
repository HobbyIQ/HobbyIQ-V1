// Central app config/bootstrap endpoint for HobbyIQ frontend/mobile
import { Router } from "express";
import { PLAN_DEFINITIONS } from "../constants/plans";
import { PLAN_NOTIFICATION_LIMITS } from "../models/planTiers";
import * as FeatureKey from "../constants/features";

const router = Router();

router.get("/bootstrap", (_req, res) => {
  res.json({
    plans: PLAN_DEFINITIONS,
    planLimits: PLAN_NOTIFICATION_LIMITS,
    features: Object.values(FeatureKey),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      CLIENT_APP_URL: process.env.CLIENT_APP_URL,
      AI_MODE: process.env.AI_MODE,
    },
    now: Date.now(),
  });
});

export default router;
