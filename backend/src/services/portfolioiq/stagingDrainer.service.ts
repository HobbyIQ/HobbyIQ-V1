// CF-STAGING-DRAINER (Drew, 2026-08-06).
//
// In-process continuous drainer for comps_staging. Runs data-clean +
// promotion in a tight loop at TICK_MS cadence so the pipeline keeps
// pace with webhook ingest (~80K/hr = ~22/s) instead of drifting
// behind (as it has, hitting 5.9M pending on 2026-08-06 00:00 UTC).
//
// One in-process worker; App Service Always-On keeps it alive. Not
// deployed as a separate scheduled job because GH Actions crons drift
// 1-3h per the daily-refresh.yml comment, and Azure Function timers
// require a separate Function App.
//
// Guarded by STAGING_DRAINER_ENABLED env flag. Default off so a
// merge alone doesn't start the drainer — the App Service config
// change to enable it is a HALT-for-confirm live prod change.

import { runDataCleanBatch } from "./dataCleanJob.service.js";
import { runPromotionBatch } from "./promotionJob.service.js";

const TICK_MS = Number(process.env.STAGING_DRAINER_TICK_MS ?? 60_000);
const DATA_CLEAN_LIMIT = Number(process.env.STAGING_DRAINER_CLEAN_LIMIT ?? 500);
const PROMOTION_LIMIT = Number(process.env.STAGING_DRAINER_PROMO_LIMIT ?? 500);

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticks = 0;
let totalCleaned = 0;
let totalPromoted = 0;
let totalErrors = 0;
let lastTickAt: number | null = null;

async function tick(): Promise<void> {
  if (running) {
    // Prior tick still working — skip so we don't stack overlapping
    // work when a batch takes longer than TICK_MS.
    return;
  }
  running = true;
  ticks++;
  lastTickAt = Date.now();
  try {
    const dc = await runDataCleanBatch({ limit: DATA_CLEAN_LIMIT });
    totalCleaned += (dc as { cleaned?: number }).cleaned ?? 0;
    const pr = await runPromotionBatch({ limit: PROMOTION_LIMIT });
    totalPromoted += pr.promoted ?? 0;
    // Emit compact telemetry every 20 ticks (~20 min at default cadence).
    if (ticks % 20 === 0) {
      console.log(JSON.stringify({
        event: "staging_drainer_progress",
        source: "stagingDrainer",
        ticks,
        totalCleaned,
        totalPromoted,
        totalErrors,
        dcScanned: dc.scanned,
        dcCleaned: (dc as { cleaned?: number }).cleaned ?? 0,
        dcAnomalies: (dc as { anomalies?: number }).anomalies ?? 0,
        prScanned: pr.scanned,
        prPromoted: pr.promoted,
      }));
    }
  } catch (err) {
    totalErrors++;
    console.warn(JSON.stringify({
      event: "staging_drainer_tick_error",
      source: "stagingDrainer",
      ticks,
      error: (err as Error)?.message ?? String(err),
    }));
  } finally {
    running = false;
  }
}

export function startStagingDrainer(): void {
  if (timer) return;
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
    tickMs: TICK_MS,
    dataCleanLimit: DATA_CLEAN_LIMIT,
    promotionLimit: PROMOTION_LIMIT,
  }));
  // Fire once immediately, then on interval.
  void tick();
  timer = setInterval(() => { void tick(); }, TICK_MS);
}

export function stopStagingDrainer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function drainerStatus(): {
  enabled: boolean;
  ticks: number;
  totalCleaned: number;
  totalPromoted: number;
  totalErrors: number;
  lastTickAt: number | null;
} {
  return {
    enabled: !!timer,
    ticks,
    totalCleaned,
    totalPromoted,
    totalErrors,
    lastTickAt,
  };
}
