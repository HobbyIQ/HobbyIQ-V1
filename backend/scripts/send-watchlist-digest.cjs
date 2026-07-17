#!/usr/bin/env node
/**
 * CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). Nightly: fan out the
 * daily watchlist digest push to every opted-in user.
 *
 * Runs after cascade-detect (04:45 UTC) at 05:00 UTC so it sees the
 * latest player_trends snapshot the 03:45 job wrote.
 *
 * Runbook (local dry-run):
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/send-watchlist-digest.cjs
 *
 * Exit codes:
 *   0 completed (regardless of sent count)
 *   1 Cosmos connection or dist build missing
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
  const { sendWatchlistDigestsForOptedInUsers } = require(
    path.join(distRoot, "services", "portfolioiq", "watchlistDigestNotify.service.js"),
  );

  const t0 = Date.now();
  console.log(JSON.stringify({ event: "watchlist_digest_start" }));

  let result = { usersScanned: 0, usersWithMovers: 0, sent: 0, failed: 0 };
  try {
    result = await sendWatchlistDigestsForOptedInUsers();
  } catch (err) {
    console.error(JSON.stringify({
      event: "watchlist_digest_failed",
      error: (err && err.message) || String(err),
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    event: "watchlist_digest_complete",
    usersScanned: result.usersScanned,
    usersWithMovers: result.usersWithMovers,
    pushSent: result.sent,
    pushFailed: result.failed,
    elapsedMs: Date.now() - t0,
  }));
  process.exit(0);
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
    event: "watchlist_digest_fatal",
    error: (err && err.message) || String(err),
  }));
  process.exit(1);
});
