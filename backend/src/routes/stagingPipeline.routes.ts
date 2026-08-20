// CF-STAGING-PIPELINE-ROUTES (Drew, 2026-07-28).
//
// Admin-gated triggers for the three staging pipeline jobs. Meant
// for both nightly cron and on-demand manual runs during rollout.
//
//   POST /api/staging/data-clean?limit=100    → runDataCleanBatch
//   POST /api/staging/image-verify?limit=25   → runImageVerifyBatch
//   POST /api/staging/promotion?limit=100     → runPromotionBatch
//   POST /api/staging/full-cycle?limit=25     → runs all 3 in order
//   GET  /api/staging/health                  → live counts by status

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { runDataCleanBatch } from "../services/portfolioiq/dataCleanJob.service.js";
import { runImageVerifyBatch } from "../services/portfolioiq/imageVerifyJob.service.js";
import { runPromotionBatch } from "../services/portfolioiq/promotionJob.service.js";
import { runAutoTriageBatch } from "../services/portfolioiq/autoTriageJob.service.js";
import { CosmosClient } from "@azure/cosmos";

const router = Router();
// CF-ADMIN-GATE-SCOPE (Drew, 2026-08-12). MUST stay path-scoped. This
// router is mounted at the bare "/api" in app.ts, so an unscoped
// router.use(requireAdmin) runs for EVERY /api/* request that reaches
// it — and requireAdmin ends the response instead of calling next(),
// so every route mounted after it in app.ts became unreachable
// (401 "Invalid admin token" in prod, 503 in CI where the token is
// unset). That shadowed /api/account, /api/entitlements,
// /api/subscriptions and /api/reference from 2026-07-31 until this fix.
router.use("/staging", requireAdmin);

function parseLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === "string" ? Number(raw) : def;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

// CF-STAGING-LIMIT-CAP-WAS-THE-BOTTLENECK (Drew, 2026-08-13: "how can we speed
// it up? ... go live date is 9/14").
//
// The Staging Pipeline Cron has asked for data_clean_limit=800 and
// promotion_limit=2000 since the 2026-08-01 "4x batch bump", whose stated aim
// was ~230K/day clean and ~575K/day promotion. parseLimit's third argument is a
// Math.min CEILING, and it was 500 — so both were silently clamped and the bump
// never took effect. Real capacity was 500/5min = 144K/day, against ~300K/day
// inbound. That gap is why the backlog only ever grew.
//
// Nothing logged this: the workflow passed 800, got a 200 back, and reported
// success. Green workflow, capped data flow.
//
// The ceiling was also DUPLICATED: runDataCleanBatch, runPromotionBatch and
// runAutoTriageBatch each clamped to 500 internally too. Raising only this one
// changed nothing — a live limit=2500 call still came back scanned=500, which
// is how the second cap surfaced. Both layers now agree at 5000; if you raise
// one, raise MAX_JOB_BATCH in the job as well or nothing happens.
//
// It is a guard against a typo'd query param, not a throughput policy — the
// real limiters are the job's own wall-clock and the caller's curl --max-time.
const MAX_BATCH = 5000;

/** Optional worker shard, so the cron can fan out disjoint slices in parallel.
 *  Both jobs already supported this; only the routes never exposed it. */
function parseShard(req: { query: Record<string, unknown> }): { index: number; total: number } | undefined {
  const idx = Number(req.query.shard);
  const total = Number(req.query.shards);
  if (!Number.isFinite(idx) || !Number.isFinite(total)) return undefined;
  if (total < 2 || idx < 0 || idx >= total) return undefined;
  return { index: Math.floor(idx), total: Math.floor(total) };
}

router.post("/staging/data-clean", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 100, MAX_BATCH);
    const result = await runDataCleanBatch({ limit, workerShard: parseShard(req) });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/image-verify", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 25, 200);  // vision-rate-limited; matches imageVerifyJob's own ceiling
    const result = await runImageVerifyBatch({ limit });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/promotion", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 100, MAX_BATCH);
    const result = await runPromotionBatch({ limit, workerShard: parseShard(req) });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/auto-triage", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 100, MAX_BATCH);
    const result = await runAutoTriageBatch({ limit });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/full-cycle", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 25, 200);
    const dc = await runDataCleanBatch({ limit: limit * 4 });
    const iv = await runImageVerifyBatch({ limit });
    const at = await runAutoTriageBatch({ limit: limit * 4 });
    const pr = await runPromotionBatch({ limit: limit * 4 });
    res.json({ success: true, dataClean: dc, imageVerify: iv, autoTriage: at, promotion: pr });
  } catch (err) { next(err); }
});

router.get("/staging/health", async (_req, res, next) => {
  try {
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return res.json({ success: true, counts: {}, note: "cosmos not configured" });
    const client = new CosmosClient(conn);
    const staging = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(process.env.COSMOS_COMPS_STAGING_CONTAINER ?? "comps_staging");
    const statuses = ["pending", "clean", "anomaly", "verified", "pending-manual", "promoted", "awaiting-catalog", "holding-tcg", "player-precision"] as const;
    const counts: Record<string, number> = {};
    await Promise.all(statuses.map(async (s) => {
      const { resources } = await staging.items.query<number>({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = @s",
        parameters: [{ name: "@s", value: s }],
      }).fetchAll();
      counts[s] = resources[0] ?? 0;
    }));
    const { resources: total } = await staging.items.query<number>("SELECT VALUE COUNT(1) FROM c").fetchAll();
    res.json({ success: true, total: total[0] ?? 0, counts });
  } catch (err) { next(err); }
});

export default router;
