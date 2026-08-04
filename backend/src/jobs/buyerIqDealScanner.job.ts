// CF-BUYERIQ-DEAL-SCANNER-JOB (Drew, 2026-08-03). Scheduler shell —
// same pattern as priceAlertEvaluator.job. Fires runBuyerIqDealScan
// on interval, catches errors so a bad scan can't kill the loop.
//
// Env:
//   BUYERIQ_DEAL_SCANNER_INTERVAL_MIN     default 60 (min between runs)
//   BUYERIQ_DEAL_SCANNER_FIRST_DELAY_MS   default 120000 (2 min post-boot)
//   BUYERIQ_DEAL_SCANNER_DISABLE          "true" to no-op (also gates the scan itself)

import { runBuyerIqDealScan } from "../services/buyeriq/buyerIqDealScanner.service.js";

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
    console.error("[buyeriq.deal.scanner.job] scan error:", (err as Error)?.message ?? err);
  } finally {
    _running = false;
  }
}

export function startBuyerIqDealScannerJob(): void {
  const intervalMin = Math.max(5, Number(process.env.BUYERIQ_DEAL_SCANNER_INTERVAL_MIN ?? DEFAULT_INTERVAL_MIN));
  const firstDelayMs = Math.max(30_000, Number(process.env.BUYERIQ_DEAL_SCANNER_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS));
  console.log(`[buyeriq.deal.scanner.job] scheduler armed (interval=${intervalMin}min, firstDelay=${firstDelayMs / 1000}s, disabled=${process.env.BUYERIQ_DEAL_SCANNER_DISABLE === "true"})`);
  _firstRunTimer = setTimeout(() => { void tick(); }, firstDelayMs);
  _intervalTimer = setInterval(() => { void tick(); }, intervalMin * 60 * 1000);
}

export function stopBuyerIqDealScannerJob(): void {
  if (_firstRunTimer) { clearTimeout(_firstRunTimer); _firstRunTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
