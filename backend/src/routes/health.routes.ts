import { Router } from "express";
const router = Router();

router.get(["/", ""], (req, res) => {
  res.json({
    status: "ok",
    service: "HobbyIQ API",
    brand: "HobbyIQ",
    port: Number(process.env.PORT || 8080),
    environment: process.env.NODE_ENV || "production",
    timestamp: new Date().toISOString()
  });
});

export default router;
