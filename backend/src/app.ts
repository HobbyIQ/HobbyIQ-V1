import express from "express";
import cors from "cors";
import path from "path";
import { getConfig } from "./config/env.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import healthRoutes from "./routes/health.routes.js";
import compiqRoutes from "./routes/compiq.routes.js";
import portfolioiqRoutes from "./routes/portfolioiq.routes.js";
import dailyiqRoutes from "./routes/dailyiq.routes.js";
import playeriqRoutes from "./routes/playeriq.routes.js";
import authRoutes from "./routes/auth.routes.js";
import ebayRoutes from "./routes/ebay.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import ocrRoutes from "./routes/ocr.routes.js";
import psaRoutes from "./routes/psa.routes.js";
import watchlistRoutes from "./routes/watchlist.routes.js";
import devicesRoutes from "./routes/devices.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";
import opsRoutes from "./routes/ops.routes.js";
import rateLimit from "express-rate-limit";

const config = getConfig();
const app = express();

// Rate limiting — 200 req/min per IP
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please slow down." },
}));

app.use(express.json({ limit: "12mb" }));
app.use(cors({
  origin: config.CORS_ALLOWED_ORIGINS || "*",
}));
app.use(requestLogger);

// Publicly serve uploaded card photos saved by the uploads API.
app.use("/uploads", express.static(path.join(process.cwd(), ".data", "uploads")));

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/compiq", compiqRoutes);
app.use("/api/portfolioiq", portfolioiqRoutes);
app.use("/api/portfolio", portfolioiqRoutes);
app.use("/api/dailyiq", dailyiqRoutes);
app.use("/api/dailyIQ", dailyiqRoutes);
app.use("/api/daily", dailyiqRoutes);
app.use("/api/playeriq", playeriqRoutes);
app.use("/api/ebay", ebayRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/internal/ocr", ocrRoutes);
app.use("/api/psa", psaRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/devices", devicesRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/ops", opsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
