import { Router } from "express";
const router = Router();

router.get(["/", ""], (req, res) => {
  res.json({
    ok: true,
    status: "ok",
    service: "HobbyIQ API",
    brand: "HobbyIQ",
    port: Number(process.env.PORT || 8080),
    environment: process.env.NODE_ENV || "production",
    timestamp: new Date().toISOString(),
    services: {
      cosmos: !!process.env.COSMOS_ENDPOINT ? "configured" : "fallback",
      redis: !!process.env.REDIS_HOST ? "configured" : "fallback",
      appInsights: !!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ? "active" : "off",
    },
    // Build metadata stamped at deploy time by scripts/deploy-with-build-info.ps1.
    // Always present — falls back to "unknown" for local dev / tests / pre-PR deploys.
    build: {
      sha: process.env.GIT_SHA || "unknown",
      shaShort: process.env.GIT_SHA_SHORT || "unknown",
      branch: process.env.GIT_BRANCH || "unknown",
      deployedAt: process.env.DEPLOYED_AT || "unknown",
    },
  });
});

export default router;
