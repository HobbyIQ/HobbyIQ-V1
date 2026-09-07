// CF-BUYERIQ-DEAL-SCANNER-JOB (Drew, 2026-08-03). Scheduler shell —
// same pattern as priceAlertEvaluator.job. Fires runBuyerIqDealScan
// on interval, catches errors so a bad scan can't kill the loop.
//
// Env:
//   BUYERIQ_DEAL_SCANNER_INTERVAL_MIN     default 60 (min between runs)
//   BUYERIQ_DEAL_SCANNER_FIRST_DELAY_MS   default 120000 (2 min post-boot)
//   BUYERIQ_DEAL_SCANNER_DISABLE          "true" to no-op (also gates the scan itself)
//
// WHY THE TIMER TICKS FASTER THAN THE INTERVAL (2026-09-07). setInterval(60min)
// only ever fires if the process lives 60 minutes. On HobbyIQ3 it does not:
// measured 2026-09-07 in hobbyiq-insights, both workers re-armed this very
// scheduler SEVEN times in 45 minutes (restart gaps 19.4, 8.5, 13.6 min). The
// hourly interval timer had therefore never fired in production — every scan
// that ever ran came from the 120s first-delay timeout, and the run cadence was
// "whenever App Service happened to recycle", not hourly.
//
// So the timer ticks on a short period the process actually survives (see
// schedulerTickMs), and the single-flight cadence marker — whose Redis key
// outlives any one process — is what enforces the real interval. Restarts no
// longer skip cycles, and the job still scans exactly once per hour.
//
// runSingleFlight is passed the real intervalMs, not the tick, because the
// interval is what the cadence marker must be sized to.

import { runBuyerIqDealScan } from "../services/buyeriq/buyerIqDealScanner.service.js";
import { runSingleFlight, schedulerTickMs } from "./_singleFlight.js";

const DEFAULT_INTERVAL_MIN = 60;
const DEFAULT_FIRST_DELAY_MS = 2 * 60 * 1000;

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;
let _running = false;

async function tick(): Promise<void> {
  if (process.env.BUYERIQ_DEAL_SCANNER_DISABLE === "true") return;
  if (_running) {
    console.warn("[buyeriq.deal.scanner.job] already running; skipping overlap");
    return;
  }
  _running = true;
  try {
    await runBuyerIqDealScan();
  } catch (err) {
    // A failed scan must never take the scheduler with it. The timers stay
    // armed and the next tick runs; _running is cleared in finally so an
    // exception cannot wedge the overlap guard on forever.
    console.error("[buyeriq.deal.scanner.job] scan error:", (err as Error)?.message ?? err);
  } finally {
    _running = false;
  }
}

export function startBuyerIqDealScannerJob(): void {
  const intervalMin = Math.max(5, Number(process.env.BUYERIQ_DEAL_SCANNER_INTERVAL_MIN ?? DEFAULT_INTERVAL_MIN));
  const firstDelayMs = Math.max(30_000, Number(process.env.BUYERIQ_DEAL_SCANNER_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS));
  const intervalMs = intervalMin * 60 * 1000;
  console.log(`[buyeriq.deal.scanner.job] scheduler armed (interval=${intervalMin}min, tick=${schedulerTickMs(intervalMs) / 60000}min, firstDelay=${firstDelayMs / 1000}s, disabled=${process.env.BUYERIQ_DEAL_SCANNER_DISABLE === "true"})`);
  const fire = () => { void runSingleFlight("buyeriq.deal.scanner", intervalMs, tick); };
  _firstRunTimer = setTimeout(fire, firstDelayMs);
  _intervalTimer = setInterval(fire, schedulerTickMs(intervalMs));
}

export function stopBuyerIqDealScannerJob(): void {
  if (_firstRunTimer) { clearTimeout(_firstRunTimer); _firstRunTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
