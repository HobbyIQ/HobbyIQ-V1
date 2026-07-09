import express from "express";
import cors from "cors";
import path from "path";
import { getConfig } from "./config/env.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import healthRoutes from "./routes/health.routes.js";
import compiqRoutes from "./routes/compiq.routes.js";
import portfolioiqRoutes from "./routes/portfolioiq.routes.js";
import portfolioErpRoutes from "./routes/portfolioiq.erp.routes.js";
import dailyiqRoutes from "./routes/dailyiq.routes.js";
import playeriqRoutes from "./routes/playeriq.routes.js";
import authRoutes from "./routes/auth.routes.js";
import ebayRoutes from "./routes/ebay.routes.js";
import ebayWebhookRoutes from "./routes/ebayWebhook.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import ocrRoutes from "./routes/ocr.routes.js";
import psaRoutes from "./routes/psa.routes.js";
// CF-WATCHLIST-UNIFY (2026-06-02): /api/watchlist (basic system) retired.
// /api/dailyiq/watchlist is the canonical system; mount preserved below.
// Requests to /api/watchlist will 404 (handled by the catch-all notFound
// middleware). iOS rewire from /api/watchlist -> /api/dailyiq/watchlist
// is blocking after this CF deploys.
import devicesRoutes from "./routes/devices.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";
import alertsAdvancedRoutes from "./routes/alerts.advanced.routes.js";
import accountRoutes from "./routes/account.routes.js";
import opsRoutes from "./routes/ops.routes.js";
import searchRoutes from "./routes/search.routes.js";
// CF-SEARCH-ADMIN-ROUTES (2026-07-08, Drew): admin surface for the
// Cosmos-backed alias store — add/correct/reload aliases without a
// code deploy. Gated by ADMIN_API_TOKEN via requireAdmin middleware.
import searchAdminRoutes from "./routes/searchAdmin.routes.js";
import entitlementsRoutes from "./routes/entitlements.routes.js";
import subscriptionsRoutes from "./routes/subscriptions.routes.js";
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
// CF-FINALIZE (2026-06-03): config.CORS_ALLOWED_ORIGINS is now pre-parsed
// to boolean | "*" | string[]. The `|| "*"` fallback was the source of
// the malformed `Access-Control-Allow-Origin: false` echo when the env
// var was set to the literal string "false". cors() with `origin: false`
// emits NO ACAO header — cross-origin browser requests are rejected
// silently; iOS-native (no Origin header) is unaffected.
app.use(cors({
  origin: config.CORS_ALLOWED_ORIGINS,
}));
app.use(requestLogger);

// Publicly serve uploaded card photos saved by the uploads API.
app.use("/uploads", express.static(path.join(process.cwd(), ".data", "uploads")));

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/compiq", compiqRoutes);
app.use("/api/portfolioiq", portfolioiqRoutes);
// CF-ERP-RECONCILIATION (2026-06-03): /api/portfolio/erp MUST mount BEFORE
// /api/portfolio so the ERP sub-router's path tree is reachable. Same
// mount-order pattern as /api/alerts/advanced.
app.use("/api/portfolio/erp", portfolioErpRoutes);
app.use("/api/portfolio", portfolioiqRoutes);
app.use("/api/dailyiq", dailyiqRoutes);
app.use("/api/dailyIQ", dailyiqRoutes);
app.use("/api/daily", dailyiqRoutes);
app.use("/api/playeriq", playeriqRoutes);
app.use("/api/ebay/webhook", ebayWebhookRoutes);
app.use("/api/ebay", ebayRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/internal/ocr", ocrRoutes);
app.use("/api/psa", psaRoutes);
// CF-WATCHLIST-UNIFY: /api/watchlist mount removed; route returns 404 via
// the notFound handler. /api/dailyiq/watchlist is canonical.
app.use("/api/devices", devicesRoutes);
// Order matters: /api/alerts/advanced MUST mount BEFORE /api/alerts so the
// advanced subrouter's path tree is reachable. Express matches in mount
// order; mounting /api/alerts first would let alertsRoutes consume
// /api/alerts/advanced before it ever reaches alertsAdvancedRoutes.
app.use("/api/alerts/advanced", alertsAdvancedRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/ops", opsRoutes);
app.use("/api/search", searchRoutes);
// CF-SEARCH-ADMIN (2026-07-08, Drew): mount admin surface after the
// user-facing /api/search so path resolution can't shadow user routes.
app.use("/api/admin", searchAdminRoutes);
app.use("/api/entitlements", entitlementsRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
// CF-ACCOUNT-DELETION (2026-06-04): Apple Guideline 5.1.1(v) compliance.
app.use("/api/account", accountRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
