// CompIQ MCP HTTP server — production entrypoint.
//
// Exposes:
//   GET  /health
//   POST /api/compiq/predict
//
// This is what iOS and the HobbyIQ backend talk to. It fetches blob-cached
// comps + signals + price floor (via fn-compiq), then runs `getPredictedPrice`
// (the MEDIUM-block prompt with H6/H10 enforcement) and returns a response
// shaped for the existing CompIQService.swift contract.

import * as appInsights from "applicationinsights";

// Initialize App Insights — must be called before the server handles requests.
// The Azure App Service agent (ApplicationInsightsAgent_EXTENSION_VERSION=~3)
// handles deep instrumentation; this SDK call enables custom telemetry and live metrics.
// Reports to the shared hobbyiq-insights AppI resource (same as hobbyiq3) for
// cross-service correlation during the upcoming MCP rewire workstream.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  try {
    appInsights
      .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(true, true)
      .setSendLiveMetrics(true)
      .start();
    console.log("[AppInsights] Telemetry active");
  } catch (err: any) {
    console.warn("[AppInsights] Init failed:", err.message);
  }
}

import express, { type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  getPredictedPrice,
  type Card,
  type CardComp,
  type PriceResult,
} from "./pricing.js";
import { fetchPlayerComps } from "./compsLoader.js";
import { filterCompsForCard } from "./compFilter.js";
import { primePlayerComps, lookupCardImage } from "./cardhedge.js";
import { logPrediction } from "./predictionLog.js";
import { runBacktest, backtestSummary } from "./backtest.js";
import { checkUrlReachable, isUrlHealthy } from "./healthChecks.js";

const PORT = Number(process.env.PORT ?? 8080);
const app = express();
app.use(express.json({ limit: "256kb" }));

// POST /api/compiq/image — Accepts base64 image, uploads to blob, then asks
// Card Hedge to identify the card. lookupCardImage currently does a text
// search only, so we pass the player name (when provided) as the query and
// the uploaded blob URL is kept for future image-identify support.
app.post("/api/compiq/image", async (req: Request, res: Response) => {
  try {
    const { image, mimeType, playerName, query } = req.body ?? {};
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "image (base64) is required" });
    }
    const contentType =
      typeof mimeType === "string" && mimeType.startsWith("image/")
        ? mimeType
        : "image/jpeg";

    // Strip data URL prefix if present, then decode base64.
    const base64Payload = image.startsWith("data:") && image.indexOf(",") > -1
      ? image.split(",")[1]
      : image;
    const buf = Buffer.from(base64Payload, "base64");

    const blobName = `scan-${randomUUID()}-${Date.now()}.jpg`;
    const containerName = "compiq-scans";
    const connStr = process.env.AZURE_BLOB_CONNECTION_STRING;
    if (!connStr) {
      return res.status(503).json({ error: "blob_connection_not_configured" });
    }
    const blobService = BlobServiceClient.fromConnectionString(connStr);
    const container = blobService.getContainerClient(containerName);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadData(buf, {
      blobHTTPHeaders: { blobContentType: contentType },
      metadata: {
        "x-ms-expiry-time": new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const blobUrl = blob.url;

    const lookupQuery =
      typeof query === "string" && query.trim()
        ? query.trim()
        : typeof playerName === "string" && playerName.trim()
        ? playerName.trim()
        : blobUrl;
    const out = await lookupCardImage({
      query: lookupQuery,
      playerName: typeof playerName === "string" ? playerName : undefined,
    });
    if (out && out.confidence >= 0.8) {
      return res.status(200).json({ ...out, blobUrl });
    }
    return res.status(404).json({
      error: "Card not recognized",
      confidence: out?.confidence ?? 0,
      blobUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "image_scan_failed";
    console.error("[image-scan] failed:", message);
    return res.status(500).json({ error: message });
  }
});

app.get("/health", async (_req: Request, res: Response) => {
  const hasAzureOpenAI = Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
      (process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_KEY) &&
      process.env.AZURE_OPENAI_DEPLOYMENT
  );
  // CF-HEALTH-SIGNAL-URL-CHECK: real URL resolution probes for URL-based
  // dependencies (vs the prior env-var-presence-only check that masked the
  // 2026-05-24 signal URL misconfiguration for an unknown duration). Probes
  // run in parallel so /health total latency is max(probes), not sum.
  const [signalUrl, floorUrl] = await Promise.all([
    checkUrlReachable("AZURE_SIGNAL_FUNCTION_URL", "AZURE_SIGNAL_FUNCTION_KEY"),
    checkUrlReachable("AZURE_PRICE_FLOOR_URL", "AZURE_PRICE_FLOOR_KEY"),
  ]);
  res.json({
    ok: true,
    service: "compiq-mcp",
    // Backward-compat booleans (true iff URL_OK per real probe — was
    // previously env-var-presence; semantics tightened per CF-HEALTH-
    // SIGNAL-URL-CHECK so a misconfigured URL no longer reports true).
    has_signal_url: isUrlHealthy(signalUrl),
    has_floor_url: isUrlHealthy(floorUrl),
    // Per-URL detail (new)
    signal_url: signalUrl,
    floor_url: floorUrl,
    // Non-URL deps — env-var-presence check is appropriate for credentials
    has_blob_conn: Boolean(process.env.AZURE_BLOB_CONNECTION_STRING),
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    has_azure_openai: hasAzureOpenAI,
    openai_provider: hasAzureOpenAI ? "azure" : "openai",
    has_card_hedge: Boolean(process.env.CARD_HEDGE_API_KEY),
    has_cosmos:
      Boolean(process.env.COSMOS_CONNECTION_STRING) ||
      Boolean(process.env.COSMOS_ENDPOINT && process.env.COSMOS_KEY),
  });
});

interface PredictRequestBody {
  playerName?: string;
  year?: number;
  set?: string;
  cardNumber?: string;
  grade?: string;
  variant?: string;
  printRun?: number;
  isRookie?: boolean;
  jerseyNumber?: number;
  anchorPrice?: number;
  recentComps?: CardComp[]; // optional override; otherwise loaded from blob
}

function buildCardId(b: PredictRequestBody): string {
  return [
    b.playerName,
    b.year,
    b.set,
    b.cardNumber,
    b.grade ?? "raw",
    b.variant ?? "base",
  ]
    .map((s) => String(s ?? "").trim())
    .join("|");
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function mapBestTimeToRecommendation(t: PriceResult["best_time_to_sell"]): string {
  return t === "now" || t === "3 days" ? "move" : "hold";
}

app.post("/api/compiq/predict", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as PredictRequestBody;

  const playerName = (body.playerName ?? "").trim();
  if (!playerName) {
    return res.status(400).json({ error: "playerName is required" });
  }
  const year = Number(body.year);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return res.status(400).json({ error: "year is required" });
  }
  const setName = (body.set ?? "").trim();
  const cardNumber = (body.cardNumber ?? "").trim();

  // Load comps: caller-provided wins; otherwise pull from backend
  // /api/compiq/comps-by-player. Phase 2 of MCP rewire (61e2d5c addendum):
  // product is REQUIRED on the new endpoint. When body.set is empty,
  // fetchPlayerComps returns [] and pricing.ts's neutral-multiplier path
  // takes over — same behavior as the prior blob-miss case.
  let comps: CardComp[] = Array.isArray(body.recentComps)
    ? body.recentComps
    : [];
  if (!comps.length) {
    comps = await fetchPlayerComps(playerName, setName, {
      cardYear: year,
      preferredGrade: body.grade,
    });
  }

  // Hard-filter on title tokens (year + player surname + set) to drop
  // reprints and wrong-year listings before anchor + analytics math runs.
  // cardNumber (when present) further isolates the exact card so a $125 auto
  // isn't blended with $10 base-prospect comps under the same player+set.
  comps = filterCompsForCard(comps, playerName, year, setName, cardNumber);

  // Determine anchor price: caller > median of comps.
  let anchorPrice = Number(body.anchorPrice);
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    const med = median(comps.map((c) => c.price));
    if (med > 0) anchorPrice = med;
  }
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    return res.status(422).json({
      error:
        "no_anchor_price: pass anchorPrice or wait for nightly comps to populate",
      compCount: comps.length,
      // Even though we can't price the card, ship the comps we DID find so
      // the iOS UI can show the user what Card Hedge has on file instead of
      // a blank "insufficient data" screen.
      recentComps: comps
        .slice()
        .sort(
          (a, b) =>
            new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime(),
        ),
    });
  }

  const card: Card = {
    id: buildCardId(body),
    playerName,
    year,
    set: setName,
    cardNumber,
    grade: body.grade,
    variant: body.variant,
    printRun: body.printRun,
    isRookie: body.isRookie,
    jerseyNumber: body.jerseyNumber,
    anchorPrice,
    recentComps: comps,
  };

  try {
    const result = await getPredictedPrice(card);

    const prices = comps.map((c) => c.price);
    const compRange = prices.length
      ? {
          low: Math.min(...prices),
          median: median(prices),
          high: Math.max(...prices),
        }
      : { low: 0, median: 0, high: 0 };

    // Fire-and-forget prediction log (Cosmos)
    logPrediction({
      player: playerName,
      year,
      set: setName,
      cardNumber,
      variant: body.variant,
      grade: body.grade,
      isRookie: body.isRookie,
      printRun: body.printRun,
      anchorPrice,
      compsCount: comps.length,
      compsMedian: compRange.median,
      compsLow: compRange.low,
      compsHigh: compRange.high,
      prediction: result,
      predicted72h: result.predicted_price_72h,
      predicted7d: result.predicted_price_7d,
      direction: result.predicted_direction,
      confidence: result.confidence,
      recommendation: mapBestTimeToRecommendation(result.best_time_to_sell),
      source: "predict",
      client: req.get("x-client-id") ?? req.get("user-agent") ?? undefined,
      analytics: result.analytics,
    });

    return res.json({
      // iOS contract (CompIQService.swift)
      nextSaleEstimate: result.predicted_price_72h,
      compRange,
      pricing: { sampleSize: comps.length },
      recommendation: mapBestTimeToRecommendation(result.best_time_to_sell),
      // Full MCP result for newer clients
      prediction: result,
      anchorPrice,
      // Comps used to build the prediction — iOS shows these under the
      // price tiles (or instead of them when insufficient).
      recentComps: comps
        .slice()
        .sort(
          (a, b) =>
            new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime(),
        ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "prediction_failed";
    // eslint-disable-next-line no-console
    console.error("[predict] failed:", message);
    return res.status(500).json({ error: message });
  }
});

// ----------------------------------------------------------------------------
// Admin: prime the blob comp cache for a single player by calling Card Hedge
// live. This is the ONLY endpoint that hits Card Hedge directly.
//
// Auth: requires `x-admin-key` header to match COMPIQ_ADMIN_KEY env var.
// Body: { playerName: string, query?: string, cardId?: string,
//         grade?: string, limit?: number }
// ----------------------------------------------------------------------------
app.post("/api/compiq/admin/prime", async (req: Request, res: Response) => {
  const adminKey = process.env.COMPIQ_ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: "admin_key_not_configured" });
  }
  if (req.get("x-admin-key") !== adminKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const b = (req.body ?? {}) as {
    playerName?: string;
    query?: string;
    cardId?: string;
    grade?: string;
    limit?: number;
  };
  const playerName = (b.playerName ?? "").trim();
  if (!playerName) {
    return res.status(400).json({ error: "playerName is required" });
  }

  try {
    const result = await primePlayerComps({
      playerName,
      query: b.query,
      cardId: b.cardId,
      grade: b.grade,
      limit: b.limit,
    });
    return res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "prime_failed";
    console.error("[prime] failed:", message);
    return res.status(500).json({ error: message });
  }
});

// ----------------------------------------------------------------------------
// Phase C: Backtest harness.
//   POST /api/compiq/admin/backtest/run    — score new predictions older than 7d
//   GET  /api/compiq/backtest/summary       — read-only summary of scored rows
// ----------------------------------------------------------------------------
app.post("/api/compiq/admin/backtest/run", async (req: Request, res: Response) => {
  const adminKey = process.env.COMPIQ_ADMIN_KEY;
  if (!adminKey) return res.status(503).json({ error: "admin_key_not_configured" });
  if (req.get("x-admin-key") !== adminKey) return res.status(401).json({ error: "unauthorized" });

  const b = (req.body ?? {}) as {
    minAgeDays?: number;
    limit?: number;
    player?: string;
  };
  try {
    const out = await runBacktest({
      minAgeDays: Number.isFinite(b.minAgeDays) ? Number(b.minAgeDays) : undefined,
      limit: Number.isFinite(b.limit) ? Number(b.limit) : undefined,
      player: typeof b.player === "string" && b.player.trim() ? b.player.trim() : undefined,
    });
    return res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "backtest_failed";
    console.error("[backtest] failed:", message);
    return res.status(500).json({ error: message });
  }
});

app.get("/api/compiq/backtest/summary", async (req: Request, res: Response) => {
  try {
    const player = typeof req.query.player === "string" ? req.query.player.trim() : undefined;
    const out = await backtestSummary(player || undefined);
    return res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "summary_failed";
    return res.status(500).json({ error: message });
  }
});

// ----------------------------------------------------------------------------
// InventoryIQ: card image lookup. Public read endpoint, cached 7 days in blob.
//   GET /api/compiq/image?query=...&player=...
//
// iOS calls this when a card opens with no photoURLs. Only returns image URLs
// when Card Hedge AI text-match confidence is >= 0.80.
// ----------------------------------------------------------------------------
app.get("/api/compiq/image", async (req: Request, res: Response) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const player = typeof req.query.player === "string" ? req.query.player.trim() : undefined;
  if (!query) {
    return res.status(400).json({ error: "query is required" });
  }
  try {
    const out = await lookupCardImage({ query, playerName: player });
    return res.status(out.ok ? 200 : 404).json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "image_lookup_failed";
    console.error("[image] failed:", message);
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[compiq-mcp] listening on :${PORT}`);
});
