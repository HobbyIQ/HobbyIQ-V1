// cardsightInventoryRefresh.job.ts — Scheduled Cardsight identifiable-set
// inventory refresh job. Mirrors the dailyiq.job pattern:
//
//   - In-process setTimeout to the next configured wall-clock time, then
//     setInterval at 24h.
//   - Fires runInventoryRefreshJob() which paginates Cardsight's
//     /v1/identify/list/sets endpoint and upserts the snapshot doc.
//   - Time / TZ configurable via CARDSIGHT_INVENTORY_JOB_HOUR /
//     CARDSIGHT_INVENTORY_JOB_MINUTE / CARDSIGHT_INVENTORY_JOB_TIMEZONE.
//   - Scheduler can be disabled by CARDSIGHT_INVENTORY_DISABLE_SCHEDULER=true.
//
// Defaults to 04:30 America/Los_Angeles (well before the DailyIQ 06:00
// kickoff — the refreshes don't share an upstream so the offset is
// hygiene, not contention).

import {
  refreshIdentifiableSetInventory,
  type RefreshResult,
} from "../services/cardsight/identifiableSetCache.service.js";

function msUntilNextRun(hour: number, minute: number, tz: string): number {
  // Same algorithm as dailyiq.job — compute the next wall-clock moment in
  // tz that matches hh:mm:00, then subtract the current UTC moment.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const localNowMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const tzOffsetMs = localNowMs - now.getTime();
  let targetLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    minute,
    0,
  );
  if (targetLocal <= localNowMs) {
    targetLocal += 24 * 60 * 60 * 1000;
  }
  return targetLocal - tzOffsetMs - now.getTime();
}

/**
 * Public wrapper so the admin trigger (if/when added) and tests can drive
 * a one-off refresh without the scheduler. Errors propagate.
 */
export async function runInventoryRefreshJob(): Promise<RefreshResult> {
  console.log("[cardsightInventoryRefresh.job] starting refresh");
  const result = await refreshIdentifiableSetInventory();
  // CF-OPS-HARDENING-1b (2026-06-04): consistent `[<jobName>] done` heartbeat
  // line on success, so the per-job log-search alert can pattern-match a
  // single keyword across all 8 schedulers.
  console.log(
    `[cardsightInventoryRefresh.job] done total=${result.totalCount} ` +
    `pages=${result.pagesFetched} durationMs=${result.durationMs}`,
  );
  return result;
}

let _scheduleTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

export function startInventoryRefreshJob(): void {
  if (process.env.CARDSIGHT_INVENTORY_DISABLE_SCHEDULER === "true") {
    console.log("[cardsightInventoryRefresh.job] scheduler disabled via env");
    return;
  }
  if (_scheduleTimer || _intervalTimer) {
    console.warn("[cardsightInventoryRefresh.job] scheduler already running; ignoring duplicate start");
    return;
  }
  const hour = Number(process.env.CARDSIGHT_INVENTORY_JOB_HOUR ?? "4");
  const minute = Number(process.env.CARDSIGHT_INVENTORY_JOB_MINUTE ?? "30");
  const tz = process.env.CARDSIGHT_INVENTORY_JOB_TIMEZONE ?? "America/Los_Angeles";
  const delay = msUntilNextRun(hour, minute, tz);
  console.log(
    `[cardsightInventoryRefresh.job] scheduling first run in ${Math.round(delay / 1000 / 60)} min ` +
    `(target ${hour}:${String(minute).padStart(2, "0")} ${tz})`,
  );

  _scheduleTimer = setTimeout(() => {
    runInventoryRefreshJob().catch((err) => {
      console.error("[cardsightInventoryRefresh.job] refresh threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runInventoryRefreshJob().catch((err) => {
        console.error("[cardsightInventoryRefresh.job] refresh threw:", err?.message ?? err);
      });
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

export function stopInventoryRefreshJob(): void {
  if (_scheduleTimer) { clearTimeout(_scheduleTimer); _scheduleTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
