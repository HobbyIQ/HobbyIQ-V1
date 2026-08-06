// CF-STAGING-DRAINER (Drew, 2026-08-06).
//
// In-process continuous drainer for comps_staging. Runs data-clean +
// promotion in a tight loop at TICK_MS cadence so the pipeline keeps
// pace with webhook ingest (~80K/hr = ~22/s) instead of drifting
// behind (as it has, hitting 5.9M pending on 2026-08-06 00:00 UTC).
//
// Multiple in-process workers (STAGING_DRAINER_WORKERS) run in
// parallel to leverage the P3v3 8-vCPU box. Each worker guards
// against its own re-entrance, but workers can overlap because they
// all pull TOP N from the same staging query — Cosmos handles the
// concurrent reads/writes.
//
// Guarded by STAGING_DRAINER_ENABLED env flag. Default off so a
// merge alone doesn't start the drainer.

import { runDataCleanBatch } from "./dataCleanJob.service.js";
import { runPromotionBatch } from "./promotionJob.service.js";

const TICK_MS = Number(process.env.STAGING_DRAINER_TICK_MS ?? 60_000);
const DATA_CLEAN_LIMIT = Number(process.env.STAGING_DRAINER_CLEAN_LIMIT ?? 500);
const PROMOTION_LIMIT = Number(process.env.STAGING_DRAINER_PROMO_LIMIT ?? 500);
// CF-STAGING-DRAINER-PARALLEL (Drew, 2026-08-06). Number of parallel
// in-process workers. Each runs its own tick() loop and has its own
// re-entrance guard. Set >1 on P3v3 (8 vCPU) to actually use the
// available compute; leave 1 on smaller SKUs.
const WORKER_COUNT = Math.max(1, Math.min(16, Number(process.env.STAGING_DRAINER_WORKERS ?? 1)));

interface Worker {
  id: number;
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
    const dc = await runDataCleanBatch({ limit: DATA_CLEAN_LIMIT });
    w.totalCleaned += (dc as { cleaned?: number }).cleaned ?? 0;
    const pr = await runPromotionBatch({ limit: PROMOTION_LIMIT });
    w.totalPromoted += pr.promoted ?? 0;
    if (w.ticks % 20 === 0) {
      console.log(JSON.stringify({
        event: "staging_drainer_progress",
        source: "stagingDrainer",
        worker: w.id,
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
      worker: w.id,
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
    tickMs: TICK_MS,
    dataCleanLimit: DATA_CLEAN_LIMIT,
    promotionLimit: PROMOTION_LIMIT,
  }));
  for (let i = 0; i < WORKER_COUNT; i++) {
    const w: Worker = {
      id: i,
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
  ticks: number;
  totalCleaned: number;
  totalPromoted: number;
  totalErrors: number;
  lastTickAt: number | null;
} {
  return {
    enabled: workers.length > 0,
    workerCount: workers.length,
    ticks: workers.reduce((a, w) => a + w.ticks, 0),
    totalCleaned: workers.reduce((a, w) => a + w.totalCleaned, 0),
    totalPromoted: workers.reduce((a, w) => a + w.totalPromoted, 0),
    totalErrors: workers.reduce((a, w) => a + w.totalErrors, 0),
    lastTickAt: workers.reduce<number | null>((a, w) => (w.lastTickAt !== null && (a === null || w.lastTickAt > a) ? w.lastTickAt : a), null),
  };
}
