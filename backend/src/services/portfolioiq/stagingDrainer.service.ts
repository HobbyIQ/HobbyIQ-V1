// CF-STAGING-DRAINER (Drew, 2026-08-06).
//
// In-process continuous drainer for comps_staging. Runs data-clean +
// promotion in a tight loop at TICK_MS cadence so the pipeline keeps
// pace with webhook ingest.
//
// Multiple in-process workers (STAGING_DRAINER_WORKERS) run in parallel
// on each App Service instance. When scaled out to N instances, each
// worker's *global* shard index is computed from a stable hash of
// WEBSITE_INSTANCE_ID + local worker id, so all N × WORKER_COUNT
// workers across the fleet pull disjoint slices of the pending queue.
//
// Guarded by STAGING_DRAINER_ENABLED env flag. Default off.

import { createHash } from "crypto";
import { runDataCleanBatch } from "./dataCleanJob.service.js";
import { runPromotionBatch } from "./promotionJob.service.js";

const TICK_MS = Number(process.env.STAGING_DRAINER_TICK_MS ?? 60_000);
const DATA_CLEAN_LIMIT = Number(process.env.STAGING_DRAINER_CLEAN_LIMIT ?? 500);
const PROMOTION_LIMIT = Number(process.env.STAGING_DRAINER_PROMO_LIMIT ?? 500);
const WORKER_COUNT = Math.max(1, Math.min(16, Number(process.env.STAGING_DRAINER_WORKERS ?? 1)));

// CF-DRAINER-MULTI-INSTANCE-SHARDING (Drew, 2026-08-06). When scaled
// out on App Service, WEBSITE_INSTANCE_ID is stable-and-unique per
// instance. Hash it to a small int and offset the worker id by
// (instanceIndex * WORKER_COUNT) so worker (instance=B, local=0)
// computes a different shard than worker (instance=A, local=0).
//
// STAGING_DRAINER_TOTAL_INSTANCES tells the workers how many instances
// exist so the shard math uses the right divisor. Set it to match the
// App Service plan's number-of-workers count.
const TOTAL_INSTANCES = Math.max(1, Math.min(16, Number(process.env.STAGING_DRAINER_TOTAL_INSTANCES ?? 1)));
const GLOBAL_WORKER_COUNT = WORKER_COUNT * TOTAL_INSTANCES;

function computeInstanceIndex(): number {
  if (TOTAL_INSTANCES <= 1) return 0;
  const id = process.env.WEBSITE_INSTANCE_ID ?? "";
  if (!id) return 0;
  // Hash to an int in [0, TOTAL_INSTANCES). SHA256 first 8 bytes → uint32 → mod.
  const buf = createHash("sha256").update(id).digest();
  const n = buf.readUInt32BE(0);
  return n % TOTAL_INSTANCES;
}

const INSTANCE_INDEX = computeInstanceIndex();

interface Worker {
  id: number;
  globalId: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  ticks: number;
  totalCleaned: number;
  totalPromoted: number;
  totalErrors: number;
  lastTickAt: number | null;
}

const workers: Worker[] = [];

async function tick(w: Worker): Promise<void> {
  if (w.running) return;
  w.running = true;
  w.ticks++;
  w.lastTickAt = Date.now();
  try {
    // Global shard index across the entire fleet ensures no two workers
    // (even on different instances) pull the same slice.
    const shard = { index: w.globalId, total: GLOBAL_WORKER_COUNT };
    const dc = await runDataCleanBatch({ limit: DATA_CLEAN_LIMIT, workerShard: shard });
    w.totalCleaned += (dc as { cleaned?: number }).cleaned ?? 0;
    const pr = await runPromotionBatch({ limit: PROMOTION_LIMIT, workerShard: shard });
    w.totalPromoted += pr.promoted ?? 0;
    if (w.ticks % 20 === 0) {
      console.log(JSON.stringify({
        event: "staging_drainer_progress",
        source: "stagingDrainer",
        instance: INSTANCE_INDEX,
        worker: w.id,
        globalWorker: w.globalId,
        ticks: w.ticks,
        totalCleaned: w.totalCleaned,
        totalPromoted: w.totalPromoted,
        totalErrors: w.totalErrors,
        dcScanned: dc.scanned,
        dcCleaned: (dc as { cleaned?: number }).cleaned ?? 0,
        dcAnomalies: (dc as { anomalies?: number }).anomalies ?? 0,
        prScanned: pr.scanned,
        prPromoted: pr.promoted,
      }));
    }
  } catch (err) {
    w.totalErrors++;
    console.warn(JSON.stringify({
      event: "staging_drainer_tick_error",
      source: "stagingDrainer",
      instance: INSTANCE_INDEX,
      worker: w.id,
      globalWorker: w.globalId,
      ticks: w.ticks,
      error: (err as Error)?.message ?? String(err),
    }));
  } finally {
    w.running = false;
  }
}

export function startStagingDrainer(): void {
  if (workers.length > 0) return;
  if (process.env.STAGING_DRAINER_ENABLED !== "true") {
    console.log(JSON.stringify({
      event: "staging_drainer_disabled",
      source: "stagingDrainer",
      note: "STAGING_DRAINER_ENABLED != true; drainer not starting",
    }));
    return;
  }
  console.log(JSON.stringify({
    event: "staging_drainer_started",
    source: "stagingDrainer",
    workerCount: WORKER_COUNT,
    instanceIndex: INSTANCE_INDEX,
    totalInstances: TOTAL_INSTANCES,
    globalWorkerCount: GLOBAL_WORKER_COUNT,
    tickMs: TICK_MS,
    dataCleanLimit: DATA_CLEAN_LIMIT,
    promotionLimit: PROMOTION_LIMIT,
  }));
  for (let i = 0; i < WORKER_COUNT; i++) {
    const globalId = INSTANCE_INDEX * WORKER_COUNT + i;
    const w: Worker = {
      id: i,
      globalId,
      timer: null,
      running: false,
      ticks: 0,
      totalCleaned: 0,
      totalPromoted: 0,
      totalErrors: 0,
      lastTickAt: null,
    };
    // Stagger worker start so they don't all fire the same batch on tick 1.
    const stagger = Math.floor((TICK_MS / WORKER_COUNT) * i);
    setTimeout(() => {
      void tick(w);
      w.timer = setInterval(() => { void tick(w); }, TICK_MS);
    }, stagger);
    workers.push(w);
  }
}

export function stopStagingDrainer(): void {
  for (const w of workers) if (w.timer) { clearInterval(w.timer); w.timer = null; }
  workers.length = 0;
}

export function drainerStatus(): {
  enabled: boolean;
  workerCount: number;
  instanceIndex: number;
  totalInstances: number;
  globalWorkerCount: number;
  ticks: number;
  totalCleaned: number;
  totalPromoted: number;
  totalErrors: number;
  lastTickAt: number | null;
} {
  return {
    enabled: workers.length > 0,
    workerCount: workers.length,
    instanceIndex: INSTANCE_INDEX,
    totalInstances: TOTAL_INSTANCES,
    globalWorkerCount: GLOBAL_WORKER_COUNT,
    ticks: workers.reduce((a, w) => a + w.ticks, 0),
    totalCleaned: workers.reduce((a, w) => a + w.totalCleaned, 0),
    totalPromoted: workers.reduce((a, w) => a + w.totalPromoted, 0),
    totalErrors: workers.reduce((a, w) => a + w.totalErrors, 0),
    lastTickAt: workers.reduce<number | null>((a, w) => (w.lastTickAt !== null && (a === null || w.lastTickAt > a) ? w.lastTickAt : a), null),
  };
}
