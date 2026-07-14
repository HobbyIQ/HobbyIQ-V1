// Owner-only ops/health report.
// GET /api/ops/report   header: x-admin-token: $OPS_REPORT_TOKEN
//
// Aggregates the same state we manually verify during health audits:
//   - uptime + which env-driven services are configured
//   - cosmos: container list + row counts + most recent _ts per container
//   - dailyiq: top watchlist counts (Cosmos source of truth)
//   - signals: live aggregator payload for a canonical player (via fn-serve-signals)
//   - iosKnownBugs: static checklist with the file references known-good as of deploy
//
// Returns JSON only. No secrets are ever included in the payload.

import { Router, Request, Response, NextFunction } from "express";
import { CosmosClient, Database } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const router = Router();

// ---------- auth gate ----------
function requireOpsToken(req: Request, res: Response, next: NextFunction): void {
  // CF-OPS-TOKEN-TRIM-SYMMETRY (Drew, 2026-07-13, PR #424): Azure App
  // Service injects \n on env vars, GitHub Actions can add CRLF when
  // secrets get piped, PowerShell adds line endings when piping to gh
  // secret set. Same class of bug as the Tier 1 harness 2026-06-30
  // whitespace injection. Trim BOTH sides so any transport-added
  // whitespace stops silently 401'ing.
  const expected = process.env.OPS_REPORT_TOKEN?.trim();
  if (!expected) {
    res.status(503).json({ success: false, error: "OPS_REPORT_TOKEN is not configured on this server." });
    return;
  }
  const provided = (req.header("x-admin-token") ?? req.header("x-ops-token") ?? "").trim();
  if (provided !== expected) {
    res.status(401).json({ success: false, error: "Invalid or missing admin token." });
    return;
  }
  next();
}

// ---------- cosmos helper ----------
let _db: Database | null = null;
async function getDb(): Promise<Database | null> {
  if (_db) return _db;
  try {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    const connStr = process.env.COSMOS_CONNECTION_STRING;
    const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
    if (!endpoint && !connStr) return null;
    let client: CosmosClient;
    if (connStr) client = new CosmosClient(connStr);
    else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
    else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
    _db = client.database(dbName);
    return _db;
  } catch (err: any) {
    console.warn("[cosmos][ops.report] cosmos init failed:", err?.message ?? err);
    return null;
  }
}

interface ContainerStat {
  id: string;
  lastWriteUtc: string | null;
  ageHours: number | null;
  error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function listContainerStats(): Promise<{ database: string | null; containers: ContainerStat[]; error?: string }> {
  const db = await getDb();
  if (!db) return { database: null, containers: [], error: "Cosmos not configured" };
  try {
    const { resources } = await db.containers.readAll().fetchAll();
    const stats: ContainerStat[] = [];
    // Only probe newest _ts (indexed, fast). Skip COUNT(1) — it scans and is slow on large containers.
    await Promise.all(resources.map(async (c) => {
      const id = c.id;
      const stat: ContainerStat = { id, lastWriteUtc: null, ageHours: null };
      try {
        const container = db.container(id);
        const tsRes = await withTimeout(
          container.items.query<number>("SELECT VALUE MAX(c._ts) FROM c").fetchAll(),
          4000,
          `MAX(_ts) ${id}`,
        );
        const maxTs = Number(tsRes.resources?.[0] ?? 0);
        if (maxTs > 0) {
          stat.lastWriteUtc = new Date(maxTs * 1000).toISOString();
          stat.ageHours = Math.round(((Date.now() / 1000 - maxTs) / 3600) * 10) / 10;
        }
      } catch (err: any) {
        stat.error = err?.message ?? String(err);
      }
      stats.push(stat);
    }));
    stats.sort((a, b) => a.id.localeCompare(b.id));
    return { database: db.id, containers: stats };
  } catch (err: any) {
    return { database: db.id, containers: [], error: err?.message ?? String(err) };
  }
}

// ---------- signal probe ----------
async function probeSignalAggregator(): Promise<unknown> {
  const url = process.env.AZURE_SIGNAL_FUNCTION_URL;
  const key = process.env.AZURE_SIGNAL_FUNCTION_KEY;
  if (!url) return { configured: false };
  const probePlayer = process.env.OPS_REPORT_PROBE_PLAYER ?? "shohei-ohtani";
  const sep = url.includes("?") ? "&" : "?";
  const full = `${url}${sep}player=${encodeURIComponent(probePlayer)}${key ? `&code=${encodeURIComponent(key)}` : ""}`;
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(full, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    const elapsedMs = Date.now() - started;
    if (!res.ok) {
      return { configured: true, ok: false, status: res.status, elapsedMs, player: probePlayer };
    }
    const body = await res.json().catch(() => ({}));
    const generatedAt = (body as any)?.generated_at ?? (body as any)?.generatedAt ?? null;
    const ageHours = generatedAt ? Math.round(((Date.now() - new Date(generatedAt).getTime()) / 3600000) * 10) / 10 : null;
    return {
      configured: true,
      ok: true,
      status: res.status,
      elapsedMs,
      player: probePlayer,
      generatedAt,
      ageHours,
      multiplier: (body as any)?.combined_multiplier ?? (body as any)?.multiplier ?? null,
      signalTypes: Object.keys((body as any)?.signals ?? {}),
    };
  } catch (err: any) {
    return { configured: true, ok: false, error: err?.message ?? String(err), elapsedMs: Date.now() - started };
  }
}

// ---------- dailyiq watchlist top ----------
// NOTE: we deliberately do NOT call the production `getAllWatchCounts()` here.
// That helper issues `SELECT playerId, COUNT(1) FROM c GROUP BY playerId` as a
// cross-partition query. In production on this Cosmos account the Node SDK
// retries that query in a microtask-only loop that never yields to the event
// loop's timer phase — which means any `setTimeout`-based timeout we wrap it in
// will never fire and the whole `/report` handler hangs indefinitely.
//
// For the ops/report endpoint we only need a coarse health signal, not a real
// leaderboard, so we read a single page of recent docs and aggregate in JS.
// This is bounded, fast, and uses an AbortController so the SDK call itself
// terminates if it stalls.
async function watchlistSummary(): Promise<unknown> {
  const db = await getDb();
  if (!db) return { error: "Cosmos not configured" };
  const containerName = process.env.COSMOS_DAILYIQ_WATCHLIST_CONTAINER ?? "dailyiq_watchlist";
  const container = db.container(containerName);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 5000);
  try {
    const iter = container.items.query<{ playerId: string }>(
      {
        query:
          'SELECT TOP 1000 c["playerId"] FROM c WHERE c["docType"] = "watchlist_entry" ORDER BY c["_ts"] DESC',
      },
      { maxItemCount: 200, abortSignal: controller.signal },
    );
    const sample: { playerId: string }[] = [];
    while (iter.hasMoreResults() && sample.length < 1000) {
      const page = await iter.fetchNext();
        const resources = Array.isArray(page?.resources) ? page.resources : [];
        for (const r of resources) if (r?.playerId) sample.push(r);
        if (resources.length === 0) break;
      // Yield to the event loop's timer/IO phases between pages so timers fire.
      await new Promise((r) => setImmediate(r));
    }
    const counts = new Map<string, number>();
    for (const r of sample) counts.set(r.playerId, (counts.get(r.playerId) ?? 0) + 1);
    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    return {
      sampleSize: sample.length,
      note: sample.length === 1000 ? "truncated at 1000 most-recent docs" : "full result within TOP 1000",
      uniquePlayersInSample: entries.length,
      totalWatchesInSample: entries.reduce((sum, [, n]) => sum + n, 0),
      top: entries.slice(0, 10).map(([playerId, count]) => ({ playerId, count })),
    };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  } finally {
    clearTimeout(abortTimer);
  }
}

// ---------- inventoryiq: latest reprice run ----------
// Reads the most recent row from the `reprice_runs` Cosmos container
// (written by portfolioReprice.job). Surfaces last-run age + counts so
// InventoryIQ health is visible from one URL.
async function inventoryIqSummary(): Promise<unknown> {
  const db = await getDb();
  if (!db) return { error: "Cosmos not configured" };
  const containerName = process.env.PORTFOLIO_REPRICE_RUNS_CONTAINER ?? "reprice_runs";
  const container = db.container(containerName);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 5000);
  try {
    const iter = container.items.query<Record<string, unknown>>(
      {
        query:
          'SELECT TOP 10 * FROM c WHERE c["kind"] = "portfolio-reprice" ORDER BY c["startedAt"] DESC',
      },
      { partitionKey: "portfolio-reprice", maxItemCount: 10, abortSignal: controller.signal },
    );
    const page = await iter.fetchNext();
    const resources = Array.isArray(page?.resources) ? page.resources : [];
    if (resources.length === 0) {
      return { lastRun: null, note: "no reprice runs recorded yet" };
    }
    const rows = resources as Record<string, any>[];
    const summarize = (row: Record<string, any>) => ({
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      durationMs: row.durationMs ?? null,
      users: row.users ?? 0,
      usersWithHoldings: row.usersWithHoldings ?? 0,
      holdingsRequested: row.holdingsRequested ?? 0,
      repriced: row.repriced ?? 0,
      skipped: row.skipped ?? 0,
      freshSkipped: row.freshSkipped ?? 0,
      errors: row.errors ?? 0,
    });
    const latest = rows[0];
    const finishedAt = typeof latest.finishedAt === "string" ? latest.finishedAt : null;
    const ageHours = finishedAt
      ? Math.round(((Date.now() - new Date(finishedAt).getTime()) / 3600000) * 10) / 10
      : null;
    const intervalHours = Number(process.env.PORTFOLIO_REPRICE_INTERVAL_HOURS ?? 6);
    const stale = ageHours !== null ? ageHours > intervalHours * 1.5 : false;
    // Aggregate across the last 10 runs so we can see if ANY repricing is
    // actually succeeding over time (vs. confidence-gated every cycle).
    let totalRequested = 0;
    let totalRepriced = 0;
    let totalSkipped = 0;
    let totalFreshSkipped = 0;
    let totalErrors = 0;
    for (const r of rows) {
      totalRequested += Number(r.holdingsRequested ?? 0);
      totalRepriced += Number(r.repriced ?? 0);
      totalSkipped += Number(r.skipped ?? 0);
      totalFreshSkipped += Number(r.freshSkipped ?? 0);
      totalErrors += Number(r.errors ?? 0);
    }
    return {
      lastRun: { ...summarize(latest), ageHours },
      recentRuns: rows.map(summarize),
      aggregate10Runs: {
        holdingsRequested: totalRequested,
        repriced: totalRepriced,
        skipped: totalSkipped,
        freshSkipped: totalFreshSkipped,
        errors: totalErrors,
        repricePct:
          totalRequested > 0
            ? Math.round((totalRepriced / totalRequested) * 1000) / 10
            : 0,
      },
      gates: {
        minPricingConfidence: Number(process.env.PORTFOLIO_MIN_PRICING_CONFIDENCE ?? 55),
        minCompsUsed: Number(process.env.PORTFOLIO_MIN_COMPS_USED ?? 3),
        minHoldingAgeMin: Number(process.env.PORTFOLIO_REPRICE_MIN_AGE_MIN ?? 30),
      },
      intervalHours,
      stale,
      schedulerDisabled: process.env.PORTFOLIO_REPRICE_DISABLE_SCHEDULER === "true",
    };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  } finally {
    clearTimeout(abortTimer);
  }
}

// ---------- env flags ----------
function envFlags(): Record<string, boolean> {
  const keys = [
    "COSMOS_CONNECTION_STRING",
    "COSMOS_ENDPOINT",
    "COSMOS_DATABASE",
    "AZURE_SIGNAL_FUNCTION_URL",
    "AZURE_SIGNAL_FUNCTION_KEY",
    "AZURE_PRICE_FLOOR_URL",
    "AZURE_PRICE_FLOOR_KEY",
    "OPENAI_API_KEY",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "REDIS_URL",
    "EBAY_APP_ID",
    "CARD_HEDGE_API_KEY",
    "BACKEND_ADMIN_KEY",
    "DAILYIQ_ADMIN_TOKEN",
    "OPS_REPORT_TOKEN",
  ];
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = Boolean(process.env[k]);
  return out;
}

// ---------- iOS known-bugs static checklist ----------
function iosKnownBugs() {
  return [
    {
      bug: "Refresh does not wipe inventory",
      status: "ok",
      reference: "CardInventoryView.swift .refreshable → InventoryRefreshService.refreshStaleCards",
    },
    {
      bug: "Card tap navigates via NavigationStack",
      status: "ok",
      reference: "CardDashboardView.swift NavigationStack + NavigationLink(value: card)",
    },
    {
      bug: "Images auto-resolve on card open",
      status: "ok",
      reference: "CardDetailView.swift .task { await autoResolveImagesIfNeeded() } → CompIQImageResolver.shared.resolve",
    },
    {
      bug: "Photo delete with confirmation",
      status: "ok",
      reference: "CardDetailView.swift confirmationDialog on photo tap",
    },
  ];
}

// ---------- main handler ----------
// Each section is wrapped with a hard timeout so a single slow dependency
// cannot hang the whole report. Returns a `{ error }` sentinel on timeout
// or failure instead of throwing.
async function safe<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T | { error: string }> {
  const timeoutSentinel: { error: string } = { error: `timeout after ${ms}ms: ${label}` };
  const timer = new Promise<{ error: string }>((resolve) =>
    setTimeout(() => resolve(timeoutSentinel), ms),
  );
  try {
    const work = fn();
    return await Promise.race([work, timer]);
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

const BUILD_MARKER = "ops-v10-2026-05-13T1745Z";

// Quick liveness ping (no token required) — proves the router is mounted.
router.get("/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, build: BUILD_MARKER, ts: new Date().toISOString() });
});

// CF-SUPPLY-DEMAND-SIGNAL (Drew, 2026-07-13, PR #420): manual snapshot
// trigger. Takes { userId, player, qualifier? }, hits eBay Browse, and
// upserts a listings_snapshots doc. Ops-token gated; used to seed data
// before the daily cron lands (PR #421) and for debug/backfill.
router.post("/listings/snapshot", requireOpsToken, async (req: Request, res: Response) => {
  const { userId, player, qualifier } = (req.body ?? {}) as {
    userId?: string; player?: string; qualifier?: string;
  };
  if (!userId || !player) {
    return res.status(400).json({ success: false, error: "userId + player required" });
  }
  const { fetchPlayerListingsSummary } = await import(
    "../services/ebay/ebayListingSearch.service.js"
  );
  const { upsertSnapshot } = await import(
    "../services/portfolioiq/listingsSnapshotStore.service.js"
  );
  const summary = await fetchPlayerListingsSummary(
    userId, player, qualifier ?? null,
  );
  if (!summary) {
    return res.status(502).json({
      success: false, error: "eBay Browse returned no data (auth or rate limit?)"
    });
  }
  await upsertSnapshot({
    playerDisplay: player,
    totalListings: summary.totalListings,
    medianAsk: summary.medianAsk,
    pricedItemCount: summary.pricedItemCount,
    effectiveQuery: summary.effectiveQuery,
    snapshottedAt: summary.snapshottedAt,
  });
  return res.json({ success: true, summary });
});

// CF-DAILY-LISTINGS-CRON (Drew, 2026-07-13, PR #421): daily snapshot
// job endpoint. Called by a GitHub Actions cron; also triggerable
// manually via the same ops token. Body:
//   { userId?: string, topN?: number, concurrency?: number }
// All fields optional — defaults picked to fit the 5K/day free-tier
// Browse budget with 10x headroom.
router.post("/listings/cron-tick", requireOpsToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { userId?: string; topN?: number; concurrency?: number };
  const { runDailyListingsSnapshotJob } = await import(
    "../services/compiq/dailyListingsSnapshotJob.service.js"
  );
  try {
    const summary = await runDailyListingsSnapshotJob({
      userId: body.userId,
      topN: body.topN,
      concurrency: body.concurrency,
    });
    return res.json({ success: true, summary });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message ?? "cron-tick failed",
    });
  }
});

router.get("/listings/trend", requireOpsToken, async (req: Request, res: Response) => {
  const player = (req.query.player as string | undefined)?.trim();
  const daysRaw = req.query.days as string | undefined;
  const days = daysRaw ? Math.max(2, Math.min(90, Number(daysRaw))) : 30;
  if (!player) {
    return res.status(400).json({ success: false, error: "player query param required" });
  }
  const { computeListingsTrend } = await import(
    "../services/compiq/supplyDemandSignal.service.js"
  );
  const { readSnapshots } = await import(
    "../services/portfolioiq/listingsSnapshotStore.service.js"
  );
  const [trend, snaps] = await Promise.all([
    computeListingsTrend(player, days),
    readSnapshots(player, days),
  ]);
  return res.json({
    success: true,
    player,
    days,
    snapshotCount: snaps.length,
    trend,
    latestSnapshots: snaps.slice(-5),
  });
});

router.get("/report", requireOpsToken, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const sectionParam = (req.query.section as string | undefined)?.toLowerCase();
  const sections = sectionParam ? new Set(sectionParam.split(",").map((s) => s.trim())) : null;
  const want = (name: string) => !sections || sections.has(name);

  const cosmosP = want("cosmos") ? safe("cosmos", 12000, listContainerStats) : Promise.resolve({ skipped: true });
  const signalsP = want("signals") ? safe("signals", 10000, probeSignalAggregator) : Promise.resolve({ skipped: true });
  const watchlistP = want("watchlist") ? safe("watchlist", 8000, watchlistSummary) : Promise.resolve({ skipped: true });
  const inventoryP = want("inventoryiq") ? safe("inventoryiq", 6000, inventoryIqSummary) : Promise.resolve({ skipped: true });

  const [cosmosStats, signals, watchlist, inventoryiq] = await Promise.all([cosmosP, signalsP, watchlistP, inventoryP]);
  res.json({
    success: true,
    build: BUILD_MARKER,
    generatedAtUtc: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    process: {
      nodeEnv: process.env.NODE_ENV ?? "development",
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      instanceId: process.env.WEBSITE_INSTANCE_ID ?? null,
      siteName: process.env.WEBSITE_SITE_NAME ?? null,
    },
    envConfigured: envFlags(),
    cosmos: cosmosStats,
    dailyiqWatchlist: watchlist,
    inventoryiq,
    signals,
    iosKnownBugs: iosKnownBugs(),
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Cardsight upstream diagnostic probe (admin-only, read-only).
//
// CF-AUTOPRICE-GRADE-CANONICAL-MIGRATION (2026-05-27 incident): /api/compiq/
// estimate began returning source=no-recent-comps + cardIdentity=null for
// ALL queries (including uncached ones), while /api/compiq/cardsearch
// (which uses Card Hedge legacy upstream) continued returning hits. This
// endpoint probes Cardsight's catalog + pricing APIs directly from inside
// the App Service (which has the IP-allowlisted CARDSIGHT_API_KEY) and
// returns the raw upstream response shape so we can classify the issue:
//   A) Healthy 200 with records → resolver/cache issue (our problem)
//   B) HTTP error → vendor incident
//   C) 200 with empty records → vendor data issue
//   D) 401/403/429 → API key or quota issue
//
// Behind requireOpsToken. Read-only — no state mutations. Should be
// removed or feature-gated after the incident is resolved.
// ────────────────────────────────────────────────────────────────────────────
router.get("/cardsight-probe", requireOpsToken, async (req: Request, res: Response) => {
  const query = String(req.query.query ?? "Mike Trout 2021 Topps Chrome").trim();
  const yearParam = req.query.year ? String(req.query.year) : null;
  const apiKey = process.env.CARDSIGHT_API_KEY;
  if (!apiKey) {
    res.status(503).json({ success: false, error: "CARDSIGHT_API_KEY not configured" });
    return;
  }
  const BASE_URL = "https://api.cardsight.ai/v1";

  // ── Step 1: searchCatalog ──────────────────────────────────────────
  const catalogParams = new URLSearchParams({
    q: query,
    type: "card",
    segment: "baseball",
    take: "10",
  });
  if (yearParam) catalogParams.set("year", yearParam);

  const catalogStart = Date.now();
  let catalogOutcome: Record<string, unknown> = {};
  let firstCardId: string | null = null;
  try {
    const r = await fetch(`${BASE_URL}/catalog/search?${catalogParams}`, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - catalogStart;
    const raw = await r.text();
    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { __parseError: true, rawLength: raw.length, rawSample: raw.slice(0, 200) };
    }
    const resultsLen = Array.isArray(body?.results) ? body.results.length : null;
    if (resultsLen != null && resultsLen > 0) {
      firstCardId = body.results[0]?.id ?? null;
    }
    catalogOutcome = {
      httpStatus: r.status,
      ok: r.ok,
      latencyMs,
      contentLength: raw.length,
      contentType: r.headers.get("content-type"),
      resultsCount: resultsLen,
      firstResult: Array.isArray(body?.results) && body.results[0]
        ? {
            id: body.results[0].id,
            name: body.results[0].name,
            year: body.results[0].year,
            releaseName: body.results[0].releaseName,
            setName: body.results[0].setName,
          }
        : null,
      rawResponseSample: typeof raw === "string" ? raw.slice(0, 500) : null,
    };
  } catch (e: any) {
    catalogOutcome = {
      ok: false,
      errorName: e?.name ?? "unknown",
      errorMessage: e?.message ?? String(e),
      latencyMs: Date.now() - catalogStart,
    };
  }

  // ── Step 2: getPricing for the first catalog hit (if any) ──────────
  let pricingOutcome: Record<string, unknown> | null = null;
  if (firstCardId) {
    const pricingStart = Date.now();
    try {
      const r = await fetch(`${BASE_URL}/pricing/${firstCardId}`, {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - pricingStart;
      const raw = await r.text();
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { __parseError: true, rawLength: raw.length, rawSample: raw.slice(0, 200) };
      }
      const rawCount = body?.raw?.count ?? null;
      const gradedCompanies = Array.isArray(body?.graded)
        ? body.graded.map((g: any) => ({
            company_name: g.company_name,
            gradeKeys: Array.isArray(g.grades) ? g.grades.map((gr: any) => gr.grade_value) : null,
          }))
        : null;
      pricingOutcome = {
        cardId: firstCardId,
        httpStatus: r.status,
        ok: r.ok,
        latencyMs,
        contentLength: raw.length,
        contentType: r.headers.get("content-type"),
        rawCount,
        gradedCompanies,
        rawResponseSample: typeof raw === "string" ? raw.slice(0, 500) : null,
      };
    } catch (e: any) {
      pricingOutcome = {
        cardId: firstCardId,
        ok: false,
        errorName: e?.name ?? "unknown",
        errorMessage: e?.message ?? String(e),
        latencyMs: Date.now() - pricingStart,
      };
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    query,
    yearParam,
    searchCatalog: catalogOutcome,
    getPricing: pricingOutcome,
  });
});

export default router;
