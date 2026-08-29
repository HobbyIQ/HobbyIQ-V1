#!/usr/bin/env node
/**
 * CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). Nightly: fan out grade-
 * worthy push notifications for every opted-in user, one push per
 * qualifying holding.
 *
 * Runs at 05:00 UTC in parallel with watchlist-digest — both consume
 * the same player_trends snapshot from the 03:45 job.
 *
 * Runbook (local dry-run):
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/send-grade-worthy-push.cjs
 *
 * Exit codes:
 *   0 completed (a zero send count with a CONFIGURED provider is fine)
 *   1 Cosmos connection or dist build missing
 *   1 push provider NOT configured on a scheduled run (D13, 2026-08-29:
 *     GITHUB_EVENT_NAME=schedule, or REQUIRE_PUSH_PROVIDER=1) — every send
 *     no-ops without APNS_*, and a green zero was hiding that.
 */

const path = require("path");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }
  const { sendGradeWorthyPushesForOptedInUsers } = require(
    path.join(distRoot, "services", "portfolioiq", "gradeWorthyPushNotify.service.js"),
  );

  const t0 = Date.now();
  console.log(JSON.stringify({ event: "grade_worthy_push_start" }));

  let result = {
    usersScanned: 0,
    holdingsScanned: 0,
    holdingsFired: 0,
    sent: 0,
    failed: 0,
    pushProviderConfigured: false,
  };
  try {
    result = await sendGradeWorthyPushesForOptedInUsers();
  } catch (err) {
    console.error(JSON.stringify({
      event: "grade_worthy_push_failed",
      error: (err && err.message) || String(err),
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    event: "grade_worthy_push_complete",
    usersScanned: result.usersScanned,
    holdingsScanned: result.holdingsScanned,
    holdingsFired: result.holdingsFired,
    pushSent: result.sent,
    pushFailed: result.failed,
    pushProviderConfigured: result.pushProviderConfigured === true,
    elapsedMs: Date.now() - t0,
  }));
  process.exit(pushProviderExitCode(result.pushProviderConfigured === true, process.env));
}

/**
 * D13 (2026-08-29) — alert gates prove delivery. A scheduled run whose
 * sender does not exist is red; a manual dispatch only warns.
 */
function pushProviderExitCode(configured, env) {
  if (configured) return 0;
  const scheduled = env.GITHUB_EVENT_NAME === "schedule" || env.REQUIRE_PUSH_PROVIDER === "1";
  const line = "push provider NOT configured — every send no-op'd (need APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_KEY_P8 in the env)";
  if (scheduled) { console.error(`::error::${line}`); return 1; }
  console.warn(`::warning::${line}`);
  return 0;
}

async function pathExists(p) {
  try {
    const fs = require("fs/promises");
    await fs.access(p);
    return true;
  } catch { return false; }
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "grade_worthy_push_fatal",
    error: (err && err.message) || String(err),
  }));
  process.exit(1);
});
