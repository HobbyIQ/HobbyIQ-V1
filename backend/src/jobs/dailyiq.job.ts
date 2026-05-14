// dailyiq.job.ts — Scheduled DailyIQ job.
//
// Runs once at 06:00 America/Los_Angeles (override via DAILYIQ_JOB_HOUR /
// DAILYIQ_JOB_MINUTE / DAILYIQ_JOB_TIMEZONE), then every 24h thereafter.
//
// For each fire:
//   1. Build today's brief (top performers MLB + MiLB) via buildDailyBrief().
//   2. Persist brief in Cosmos (dailyiq_briefs container).
//   3. For every user with dailyIQAlerts=true:
//        - look up their watchlist
//        - choose featured player: top watchlist match (if any), else MLB #1
//        - send APNs push via notificationService.sendDailyIQNotification
//   4. Mark brief as notified.

import { buildDailyBrief } from "../routes/dailyiq.routes.js";
import { saveTopPlayers, markNotified, getTopPlayers } from "../repositories/dailyiq.repository.js";
import { getAllDailyIQAlertPreferences } from "../repositories/alertPreferences.repository.js";
import { getWatchlistSet } from "../services/dailyiq/watchlistStore.service.js";
import { sendDailyIQNotification, FeaturedPlayer } from "../services/notification.service.js";

function todayInTimezone(tz: string): string {
  return dateInTimezone(tz, new Date());
}

// The DailyIQ brief covers the most recently COMPLETED game day, which is
// yesterday in the publish timezone. The cron fires at 06:00 PT.
function yesterdayInTimezone(tz: string): string {
  return dateInTimezone(tz, new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function dateInTimezone(tz: string, when: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(when);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function msUntilNextRun(hour: number, minute: number, tz: string): number {
  // Compute the next moment when `tz`-local clock reads hh:mm:00.
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
  // Parts give us local (in tz) wall-clock components. Build an ISO-like
  // string and compute the UTC equivalent by treating the tz string as
  // an offset — but the cleanest approach is to step minute-by-minute
  // from now and check the tz clock. That said, we can do this with a
  // single Date math: build a Date assuming UTC for the tz wall-clock,
  // then compare timezone offset.
  const localNowMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const tzOffsetMs = localNowMs - now.getTime(); // approx tz offset from UTC
  // Target today in tz at hh:mm:00
  let targetLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    minute,
    0,
  );
  if (targetLocal <= localNowMs) {
    targetLocal += 24 * 60 * 60 * 1000; // tomorrow
  }
  return targetLocal - tzOffsetMs - now.getTime();
}

interface RankedPlayer {
  playerId: string;
  playerName: string;
  rank?: number;
  rankingScore?: number;
  league?: "MLB" | "MiLB";
  team?: string;
  teamName?: string;
  teamAbbreviation?: string;
  [k: string]: unknown;
}

function pickFeatured(
  mlb: RankedPlayer[],
  milb: RankedPlayer[],
  watchlist: Set<string>,
): { player: RankedPlayer | null; isWatchlistMatch: boolean } {
  if (watchlist.size > 0) {
    const combined = [...mlb, ...milb];
    const match = combined.find((p) => watchlist.has(p.playerId));
    if (match) return { player: match, isWatchlistMatch: true };
  }
  if (mlb.length) return { player: mlb[0], isWatchlistMatch: false };
  if (milb.length) return { player: milb[0], isWatchlistMatch: false };
  return { player: null, isWatchlistMatch: false };
}

function toFeatured(p: RankedPlayer): FeaturedPlayer {
  const team = p.teamAbbreviation || p.teamName || (typeof p.team === "string" ? p.team : undefined);
  return {
    playerId: p.playerId,
    playerName: p.playerName,
    league: p.league,
    team,
    rankingScore: typeof p.rankingScore === "number" ? p.rankingScore : undefined,
    rank: typeof p.rank === "number" ? p.rank : undefined,
  };
}

export async function runDailyIQJob(opts?: { force?: boolean }): Promise<{
  date: string;
  usersNotified: number;
  pushesSent: number;
  pushesFailed: number;
  removedTokens: number;
}> {
  const tz = process.env.DAILYIQ_JOB_TIMEZONE ?? "America/Los_Angeles";
  const date = yesterdayInTimezone(tz);
  console.log(`[dailyiq.job] runDailyIQJob start date=${date} tz=${tz}`);

  // 1) Build today's brief.
  const brief = await buildDailyBrief(date);
  console.log(`[dailyiq.job] built brief mlb=${brief.mlb.length} milb=${brief.milb.length}`);

  // 2) Persist to Cosmos.
  await saveTopPlayers(date, {
    mlb: brief.mlb as unknown as RankedPlayer[],
    milb: brief.milb as unknown as RankedPlayer[],
  });

  // 2b) Idempotency: avoid double-push if already notified today (unless forced).
  if (!opts?.force) {
    const existing = await getTopPlayers(date);
    if (existing?.notifiedAt) {
      console.log(`[dailyiq.job] already notified today (${existing.notifiedAt}); skipping pushes`);
      return { date, usersNotified: 0, pushesSent: 0, pushesFailed: 0, removedTokens: 0 };
    }
  }

  // 3) Send pushes.
  const prefs = await getAllDailyIQAlertPreferences();
  console.log(`[dailyiq.job] users opted-in: ${prefs.length}`);
  let usersNotified = 0;
  let pushesSent = 0;
  let pushesFailed = 0;
  let removedTokens = 0;

  const mlbList = brief.mlb as unknown as RankedPlayer[];
  const milbList = brief.milb as unknown as RankedPlayer[];

  await Promise.all(
    prefs.map(async (pref) => {
      try {
        const watchlist = await getWatchlistSet(pref.userId);
        const { player, isWatchlistMatch } = pickFeatured(mlbList, milbList, watchlist);
        if (!player) return;
        const result = await sendDailyIQNotification(pref.userId, toFeatured(player), isWatchlistMatch);
        if (result.sent > 0) usersNotified += 1;
        pushesSent += result.sent;
        pushesFailed += result.failed;
        removedTokens += result.removedTokens;
      } catch (err: any) {
        console.error(`[dailyiq.job] failed for user=${pref.userId}:`, err?.message ?? err);
      }
    }),
  );

  // 4) Mark brief as notified.
  await markNotified(date);

  console.log(
    `[dailyiq.job] done date=${date} usersNotified=${usersNotified} pushesSent=${pushesSent} failed=${pushesFailed} removedTokens=${removedTokens}`,
  );
  return { date, usersNotified, pushesSent, pushesFailed, removedTokens };
}

let _scheduleTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

export function startDailyJobs(): void {
  if (process.env.DAILYIQ_DISABLE_SCHEDULER === "true") {
    console.log("[dailyiq.job] scheduler disabled via DAILYIQ_DISABLE_SCHEDULER");
    return;
  }
  if (_scheduleTimer || _intervalTimer) {
    console.warn("[dailyiq.job] scheduler already running; ignoring duplicate startDailyJobs()");
    return;
  }
  const hour = Number(process.env.DAILYIQ_JOB_HOUR ?? "6");
  const minute = Number(process.env.DAILYIQ_JOB_MINUTE ?? "0");
  const tz = process.env.DAILYIQ_JOB_TIMEZONE ?? "America/Los_Angeles";
  const delay = msUntilNextRun(hour, minute, tz);
  console.log(`[dailyiq.job] scheduling first run in ${Math.round(delay / 1000 / 60)} min (target ${hour}:${String(minute).padStart(2, "0")} ${tz})`);

  _scheduleTimer = setTimeout(() => {
    runDailyIQJob().catch((err) => {
      console.error("[dailyiq.job] runDailyIQJob threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runDailyIQJob().catch((err) => {
        console.error("[dailyiq.job] runDailyIQJob threw:", err?.message ?? err);
      });
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

export function stopDailyJobs(): void {
  if (_scheduleTimer) { clearTimeout(_scheduleTimer); _scheduleTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
