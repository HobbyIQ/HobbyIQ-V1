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
import { createCompsProvider, createSupplyProvider, createPlayerPerformanceProvider } from "./providers/factory";

function logProviderInitSummary() {
  const comps = createCompsProvider();
  const supply = createSupplyProvider();
  const perf = createPlayerPerformanceProvider();
  console.log("Provider initialization summary:");
  console.log("- Comps Provider:", comps.constructor.name);
  console.log("- Supply Provider:", supply.constructor.name);
  console.log("- Player Performance Provider:", perf.constructor.name);
}


import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";



const app = express();
app.use(express.json());

app.get("/api/compiq/estimate", (req, res) => {
  const { player, cardSet, parallel, rawPrice } = req.query;

  const price = Number(rawPrice);

  if (Number.isNaN(price)) {
    return res.status(400).json({
      success: false,
      error: "rawPrice must be a number",
    });
  }

  return res.json({
    success: true,
    player,
    cardSet,
    parallel,
    rawPrice: price,
    estimatedPsa10: price * 2.25,
    estimatedPsa9: price * 1.15,
    estimatedPsa8: price * 0.9,
  });
});

// Public GET /
app.get("/", (req, res) => {
  res.json({ success: true, message: "HobbyIQ API live" });
});

const app = express();
app.use(express.json());

// Public GET /api/compiq/estimate (no user context, no middleware)
app.get("/api/compiq/estimate", (req, res) => {
  const { player, cardSet, parallel, rawPrice } = req.query;
  const rawPriceNumber = Number(rawPrice);
  if (isNaN(rawPriceNumber)) {
    return res.json({ success: false, error: "rawPrice must be a number" });
  }
  res.json({
    success: true,
    player,
    cardSet,
    parallel,
    rawPrice: rawPriceNumber,
    estimatedPsa10: rawPriceNumber * 2.25,
    estimatedPsa9: rawPriceNumber * 1.15,
    estimatedPsa8: rawPriceNumber * 0.9
  });
});

// Public GET /
// Public GET /health
app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok" });
});


// Public POST /api/compiq/estimate
app.use("/api/compiq", compiqRouter);

import dashboardRouter from "./routes/dashboard";
import jobsRouter from "./routes/jobs";
import subscriptionsRouter from "./routes/subscriptions";
import providerHealthRouter from "./routes/providerHealth";
import learningRoutes from "./routes/learning/learningRoutes";
import appConfigRouter from "./routes/appConfig";
import { mockAuth } from "./middleware/mockAuth";

// All other routes require mockAuth
app.use(mockAuth);

// Mount all protected routers
app.use("/api/comps", compsRouter);
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
