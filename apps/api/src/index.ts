import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import testRouter from "./routes/test";
import healthRouter from "./routes/health";
import compsRouter from "./routes/comps";
import compiqRouter from "./routes/compiq";
import universalRouter from "./routes/universal";
import portfolioRouter from "./routes/portfolio";
import protectedFeaturesRouter from "./routes/protectedFeatures";
import meRouter from "./routes/me";
import plansRouter from "./routes/plans";
import notificationsRouter from "./routes/notifications";
import { parallelMultipliers, ProductFamily } from "./config/parallelMultipliers";
import dashboardRouter from "./routes/dashboard";
import jobsRouter from "./routes/jobs";
import subscriptionsRouter from "./routes/subscriptions";
import providerHealthRouter from "./routes/providerHealth";
import learningRoutes from "./routes/learning/learningRoutes";
import appConfigRouter from "./routes/appConfig";
import { mockAuth } from "./middleware/mockAuth";
import { createCompsProvider, createSupplyProvider, createPlayerPerformanceProvider } from "./providers/factory";

const app = express();
app.use(express.json());

// Public GET /api/compiq/estimate (no user context, no middleware)
// --- Helper functions for CompIQ parallel pricing ---
function normalizeParallelName(parallel: string | undefined): string {
  return (parallel || "base").toLowerCase().replace(/[^a-z0-9 ]/gi, "").replace(/\s+/g, " ").trim();
}

function detectProductFamily(cardSet: string | undefined, isAuto: boolean): ProductFamily | undefined {
  if (!cardSet) return undefined;
  const set = cardSet.toLowerCase();
  if (set.includes("chrome update")) {
    if (isAuto) return "Topps Chrome Update Auto";
    return "Topps Chrome Update Non-Auto";
  }
  if (set.includes("chrome")) {
    if (set.includes("bowman")) {
      if (isAuto) return "Bowman Chrome Auto";
      return "Bowman Chrome Non-Auto";
    }
    if (isAuto) return "Topps Chrome Auto";
    return "Topps Chrome Non-Auto";
  }
  if (set.includes("draft")) {
    if (isAuto) return "Bowman Draft Auto";
    return "Bowman Draft Non-Auto";
  }
  if (set.includes("bowman")) return "Bowman";
  if (set.includes("flagship")) return "Topps Flagship";
  if (set.includes("paper")) return "Topps Paper";
  if (set.includes("topps")) return "Topps";
  return undefined;
}

function getParallelMultiplier(productFamily: ProductFamily | undefined, parallel: string, isAuto: boolean): number {
  if (!productFamily) return 1.0;
  const famKey = productFamily.toLowerCase();
  const config = isAuto ? parallelMultipliers.auto[famKey] : parallelMultipliers.nonAuto[famKey];
  if (!config) return 1.0;
  return config[parallel] ?? 1.0;
}

function roundTo2(val: number): number {
  return Math.round(val * 100) / 100;
}

// --- Serial scarcity multiplier helper ---
function getSerialMultiplier(serial: string | number | undefined): number {
  if (!serial) return 1.0;
  const n = typeof serial === "string" ? parseInt(serial, 10) : serial;
  if (isNaN(n)) return 1.0;
  if (n >= 499) return 1.0;
  if (n >= 299) return 1.1;
  if (n >= 250) return 1.2;
  if (n >= 199) return 1.3;
  if (n >= 150) return 1.4;
  if (n >= 125) return 1.5;
  if (n >= 100) return 1.7;
  if (n >= 99) return 1.8;
  if (n >= 75) return 2.0;
  if (n >= 50) return 2.5;
  if (n >= 25) return 3.5;
  if (n >= 10) return 5.0;
  if (n >= 5) return 7.0;
  if (n >= 1) return 12.0;
  return 1.0;
}

app.get("/api/compiq/estimate", (req, res) => {
  const { player, cardSet, parallel, rawPrice, isAuto, serial } = req.query;
  const price = Number(rawPrice);
  if (Number.isNaN(price)) {
    return res.status(400).json({
      success: false,
      error: "rawPrice must be a number",
    });
  }

  const normalizedParallel = normalizeParallelName(typeof parallel === "string" ? parallel : undefined);
  const isAutoBool = typeof isAuto === "string" ? isAuto.toLowerCase() === "true" : false;
  const productFamily = detectProductFamily(typeof cardSet === "string" ? cardSet : undefined, isAutoBool);
  const parallelMultiplier = getParallelMultiplier(productFamily, normalizedParallel, isAutoBool);
  const serialMultiplier = getSerialMultiplier(serial);
  const adjustedRaw = price * parallelMultiplier * serialMultiplier;
  let cardType = "Non-Auto";
  if (isAutoBool) cardType = "Auto";

  return res.json({
    success: true,
    player,
    cardSet,
    productFamily: productFamily || null,
    parallel,
    normalizedParallel,
    isAuto: isAutoBool,
    cardType,
    rawPrice: roundTo2(price),
    parallelMultiplier: roundTo2(parallelMultiplier),
    serial: serial ?? null,
    serialMultiplier: roundTo2(serialMultiplier),
    adjustedRaw: roundTo2(adjustedRaw),
    estimatedPsa10: roundTo2(adjustedRaw * 2.25),
    estimatedPsa9: roundTo2(adjustedRaw * 1.15),
    estimatedPsa8: roundTo2(adjustedRaw * 0.9),
  });
});

app.get("/health", (_req, res) => {
  return res.json({
    success: true,
    status: "ok",
  });
});

app.get("/", (_req, res) => {
  return res.json({
    success: true,
    message: "HobbyIQ API live",
  });
});

// Mount routers and middleware below public routes
app.use("/api/universal", universalRouter);
app.use("/api/portfolio", portfolioRouter);
app.use("/api/protected", protectedFeaturesRouter);
app.use("/api/me", meRouter);
app.use("/api/plans", plansRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/subscription", subscriptionsRouter);
app.use("/api/provider-health", providerHealthRouter);
app.use("/api/learning", learningRoutes);
app.use("/api/app-config", appConfigRouter);


// 404 handler (after all routes)
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.originalUrl}`
    }
  });
});

// Central error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[ERROR]", err);
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: err?.message || "Unexpected error"
    }
  });
});

const PORT = process.env.PORT && !isNaN(Number(process.env.PORT)) ? Number(process.env.PORT) : 4000;
console.log("\n==============================");
console.log(`Starting HobbyIQ API (env: ${process.env.NODE_ENV || "development"})`);
console.log(`Listening on http://localhost:${PORT}`);
console.log(`Frontend: ${process.env.CLIENT_APP_URL || "(not set)"}`);
console.log(`AI Mode: ${process.env.AI_MODE || "mock"}`);
console.log("==============================\n");
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] HobbyIQ API server ready on port ${PORT}`);
});
