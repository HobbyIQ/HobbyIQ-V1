import { Router } from "express";
const router = Router();

router.get(["/", ""], (req, res) => {
  res.json({
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
  });
});

export default router;
