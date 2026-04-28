// @ts-nocheck
export {};
"use strict";
/**
 * Daily scheduled jobs Ã¢â‚¬â€ pure setTimeout/setInterval, no external scheduler needed.
 *
 * Schedule:
 *   Ã¢â‚¬Â¢ 6:00 AM EST (11:00 UTC)  Ã¢â‚¬â€ DailyIQ push notification to opted-in users
 *   Ã¢â‚¬Â¢ 00:00 UTC               Ã¢â‚¬â€ Midnight portfolio snapshot for all active users
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDailyJobs = startDailyJobs;
const notificationsRepository_1 = require("../repositories/notificationsRepository");
const portfolioRepository_1 = require("../repositories/portfolioRepository");
const portfolioSnapshotService_1 = require("../services/portfolioSnapshotService");
const achievementService_1 = require("../services/achievementService");
const dailyiqService_1 = require("../services/dailyiqService");
/** Compute ms until the next occurrence of UTC hour:minute. */
function msUntilNextUTC(hour, minute) {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
    if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
}
function scheduleDaily(label, utcHour, utcMinute, fn) {
    const delay = msUntilNextUTC(utcHour, utcMinute);
    const hh = String(utcHour).padStart(2, "0");
    const mm = String(utcMinute).padStart(2, "0");
    console.log(`[jobs] "${label}" scheduled in ${Math.round(delay / 60000)} min (next ${hh}:${mm} UTC)`);
    setTimeout(() => {
        fn();
        setInterval(fn, 24 * 60 * 60 * 1000);
    }, delay);
}
function msUntilNextTimeInZone(timeZone, targetHour, targetMinute) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    });
    const nowMs = Date.now();
    for (let i = 1; i <= 60 * 48; i++) {
        const t = new Date(nowMs + i * 60000);
        const parts = formatter.formatToParts(t);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
        if (hour === targetHour && minute === targetMinute) {
            return i * 60000;
        }
    }
    return 24 * 60 * 60 * 1000;
}
function scheduleDailyInTimeZone(label, timeZone, hour, minute, fn) {
    const delay = msUntilNextTimeInZone(timeZone, hour, minute);
    console.log(`[jobs] "${label}" scheduled in ${Math.round(delay / 60000)} min (next ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timeZone})`);
    setTimeout(() => {
        fn();
        setInterval(fn, 24 * 60 * 60 * 1000);
    }, delay);
}
// Ã¢â€â‚¬Ã¢â€â‚¬ DailyIQ job Ã¢â‚¬â€ 6 AM EST = 11:00 UTC Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function runDailyIQJob() {
    console.log("[jobs] runDailyIQJob Ã¢â‚¬â€ start");
    await (0, dailyiqService_1.refreshDailyRealData)(true);
    const today = new Date().toISOString().slice(0, 10);
    const prefs = notificationsRepository_1.notificationsRepository.getAllAlertPreferences();
    let sent = 0;
    for (const pref of prefs) {
        try {
            if (!pref.dailyIQAlerts)
                continue;
            // Deduplicate Ã¢â‚¬â€ only one DailyIQ notification per user per day
            if (notificationsRepository_1.notificationsRepository.hasNotificationForUserTypeOnDate(pref.userId, "dailyiq", today)) {
                continue;
            }
            notificationsRepository_1.notificationsRepository.createNotificationEvent({
                userId: pref.userId,
                type: "dailyiq",
                title: "Your DailyIQ is ready Ã°Å¸Å½Â¯",
                body: "Check your watch list, portfolio pulse, and today's card market moves.",
                data: { date: today },
                status: "queued",
            });
            sent++;
        }
        catch (err) {
            console.error(`[jobs] DailyIQ error for ${pref.userId}:`, err);
        }
    }
    console.log(`[jobs] runDailyIQJob Ã¢â‚¬â€ queued ${sent} notification(s)`);
}
// Ã¢â€â‚¬Ã¢â€â‚¬ Midnight snapshot job Ã¢â‚¬â€ 00:00 UTC Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function runMidnightSnapshotJob() {
    console.log("[jobs] runMidnightSnapshotJob Ã¢â‚¬â€ start");
    // Collect all distinct userIds from the portfolio data file
    const data = portfolioRepository_1.portfolioRepository.__getRawData?.() ?? null;
    let userIds = [];
    // Fallback: scan all prefs for known users
    const prefs = notificationsRepository_1.notificationsRepository.getAllAlertPreferences();
    userIds = prefs.map((p) => p.userId);
    let count = 0;
    for (const userId of userIds) {
        try {
            const cards = portfolioRepository_1.portfolioRepository.getActiveInventory(userId);
            if (cards.length === 0)
                continue;
            (0, portfolioSnapshotService_1.takeSnapshot)(userId);
            (0, achievementService_1.evaluateAchievements)(userId);
            count++;
        }
        catch (err) {
            console.error(`[jobs] Snapshot error for ${userId}:`, err);
        }
    }
    console.log(`[jobs] runMidnightSnapshotJob Ã¢â‚¬â€ snapshots taken for ${count} user(s)`);
}
// Ã¢â€â‚¬Ã¢â€â‚¬ Public entry point Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function startDailyJobs() {
    scheduleDailyInTimeZone("DailyIQ notification", "America/New_York", 6, 0, runDailyIQJob);
    scheduleDaily("Midnight portfolio snapshot", 0, 0, runMidnightSnapshotJob);
}
