// CF-INGEST-HEALTH (Drew, 2026-08-05).
//
// GET /api/health/ingest — reports per-source freshness so silent
// pipeline failures (TCA webhook going dark, CH schedule commented out,
// Cardsight throttled) surface before the next user question. Returns
// last-row timestamps per source + rolling counts in tight windows.
//
// No auth — safe surface (aggregates only, no card content). Cached
// 5 min so hitting it in a monitor loop is cheap.

import { Router, type Request, type Response } from "express";
import { CosmosClient } from "@azure/cosmos";

const router = Router();

interface SourceStatus {
  source: string;
  lastObservedAt: string | null;
  lastSoldAt: string | null;
  ageMinutes: number | null;   // minutes since lastObservedAt
  last30min: number;
  last24h: number;
  last7d: number;
  status: "green" | "yellow" | "red";
}

interface HealthResponse {
  now: string;
  sources: SourceStatus[];
  totalLast24h: number;
  totalLast7d: number;
}

// D13 (2026-08-29): `cardsight` dropped — the vendor was retired from
// matching on 2026-08-16 and its nightly cron is off; monitoring a
// retired source can only ever report red or a stray trickle.
const KNOWN_SOURCES = ["cardhedge", "tca-ebay"];
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { at: number; payload: HealthResponse } | null = null;

async function collect(): Promise<HealthResponse> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const now = new Date();
  if (!conn) {
    return { now: now.toISOString(), sources: [], totalLast24h: 0, totalLast7d: 0 };
  }
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  const nowMs = now.getTime();
  const since30 = new Date(nowMs - 30 * 60_000).toISOString();
  const since24 = new Date(nowMs - 24 * 3600_000).toISOString();
  const since7d = new Date(nowMs - 7 * 24 * 3600_000).toISOString();

  const sources: SourceStatus[] = [];
  let totalLast24h = 0;
  let totalLast7d = 0;

  for (const source of KNOWN_SOURCES) {
    // One query returns all four aggregates via CASE-style filter.
    const { resources } = await sc.items.query<{
      lastObservedAt: string | null; lastSoldAt: string | null;
      last30min: number; last24h: number; last7d: number;
    }>({
      query: `
        SELECT
          MAX(c.observedAt) AS lastObservedAt,
          MAX(c.soldAt) AS lastSoldAt,
          SUM(c.observedAt >= @s30 ? 1 : 0) AS last30min,
          SUM(c.observedAt >= @s24 ? 1 : 0) AS last24h,
          SUM(c.observedAt >= @s7d ? 1 : 0) AS last7d
        FROM c WHERE c.source = @src`,
      parameters: [
        { name: "@src", value: source },
        { name: "@s30", value: since30 },
        { name: "@s24", value: since24 },
        { name: "@s7d", value: since7d },
      ],
    }).fetchAll();
    const r = resources[0] ?? { lastObservedAt: null, lastSoldAt: null, last30min: 0, last24h: 0, last7d: 0 };
    const lastMs = r.lastObservedAt ? Date.parse(r.lastObservedAt) : null;
    const ageMinutes = lastMs ? Math.floor((nowMs - lastMs) / 60_000) : null;
    // Health thresholds tuned per source's expected cadence.
    let status: "green" | "yellow" | "red" = "green";
    if (source === "tca-ebay") {
      // Webhook every 30 min. Red at 2h silence, yellow at 45 min.
      if (ageMinutes === null || ageMinutes > 120) status = "red";
      else if (ageMinutes > 45) status = "yellow";
    } else if (source === "cardhedge") {
      // On-demand from user activity + daily schedule. Red at 24h, yellow at 4h.
      if (ageMinutes === null || ageMinutes > 24 * 60) status = "red";
      else if (ageMinutes > 4 * 60) status = "yellow";
    } else {
      // Default cadence for any source added later: red at 24h, yellow at 4h.
      if (ageMinutes === null || ageMinutes > 24 * 60) status = "red";
      else if (ageMinutes > 4 * 60) status = "yellow";
    }
    sources.push({
      source,
      lastObservedAt: r.lastObservedAt,
      lastSoldAt: r.lastSoldAt,
      ageMinutes,
      last30min: Number(r.last30min ?? 0),
      last24h: Number(r.last24h ?? 0),
      last7d: Number(r.last7d ?? 0),
      status,
    });
    totalLast24h += Number(r.last24h ?? 0);
    totalLast7d += Number(r.last7d ?? 0);
  }
  return { now: now.toISOString(), sources, totalLast24h, totalLast7d };
}

router.get("/ingest", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    res.set("Cache-Control", "public, max-age=120");
    res.json(cached.payload);
    return;
  }
  try {
    const payload = await collect();
    cached = { at: now, payload };
    res.set("Cache-Control", "public, max-age=120");
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message ?? String(err) });
  }
});

export default router;
