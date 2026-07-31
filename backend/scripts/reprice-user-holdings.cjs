#!/usr/bin/env node
// CF-REPRICE-USER-HOLDINGS (Drew, 2026-07-30). Server-side batch reprice
// for a single user's holdings, bypassing the HTTP endpoint throttle.
// Use to force fresh FMVs after a code / calibration / flag change.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   AUTH_SESSION_SECRET        required (transitive imports)
//   REPRICE_USER_ID            required (which user's holdings to reprice)
//   REPRICE_MAX_HOLDINGS       optional (default 200)

const path = require("path");
const backend = __dirname + "/..";
const { repriceHoldingsForUser } = require(path.join(backend, "dist/services/portfolioiq/portfolioStore.service.js"));

const USER_ID = process.env.REPRICE_USER_ID || process.env.DREW_USER_ID;
const MAX_HOLDINGS = Number(process.env.REPRICE_MAX_HOLDINGS || "200");

async function main() {
  if (!USER_ID) {
    console.error("REPRICE_USER_ID required");
    process.exit(1);
  }
  console.log(`[reprice-user-holdings]`);
  console.log(`  userId:      ${USER_ID}`);
  console.log(`  maxHoldings: ${MAX_HOLDINGS}`);
  console.log(`  composite:   ${process.env.HOBBYIQFMV_COMPOSITE_ENABLED === "true" ? "ENABLED" : "DISABLED"}\n`);

  const t0 = Date.now();
  const result = await repriceHoldingsForUser(USER_ID, "batch-reprice", {
    userThrottleMs: 0,     // bypass 60s HTTP throttle
    minHoldingAgeMs: 0,    // reprice everything, even if fresh
    maxHoldings: MAX_HOLDINGS,
  });
  const t1 = Date.now();
  console.log(`\nDone in ${((t1 - t0) / 1000).toFixed(1)}s\n`);
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
}

main().catch(e => { console.error(e); process.exit(1); });
