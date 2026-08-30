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
//   BACKFILL_APPLY=true        the runner's switch; anything else is a dry run
//
// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). This read no flag at all, so an
// `apply=false` dispatch repriced (and persisted) the portfolio anyway. It
// honours the runner's BACKFILL_APPLY now: a dry dispatch says which users and
// how many holdings it would reprice, and exits. The sanctioned dispatch —
// `-f script=reprice-user-holdings -f apply=true` — is unchanged.
//
// NOT reconciled, on purpose (D18). repriceHoldingsForUser returns
// `requested` = ALL holdings, while repriced + skipped cover only the
// CANDIDATES it kept after the min-age filter and the maxHoldings slice — so
// no honest `intended` exists on this side of the call, and a wrong intended
// is worse than none (it fires WORK VANISHED on every portfolio over 200). The
// service would have to return the candidate count; until then the JSON it
// prints is the record. A call that throws aborts the run (exit 1), not green.

const path = require("path");
const backend = __dirname + "/..";
const { repriceHoldingsForUser } = require(path.join(backend, "dist/services/portfolioiq/portfolioStore.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";

const USER_ID = process.env.REPRICE_USER_ID || process.env.DREW_USER_ID;
// CF-LOOK-AT-EVERY-HOLDING (Drew, 2026-08-29): MODE=all reprices every user
// in the portfolio container, not just the one REPRICE_USER_ID names.
const ALL_USERS = String(process.env.MODE || "").toLowerCase() === "all";
const MAX_HOLDINGS = Number(process.env.REPRICE_MAX_HOLDINGS || "200");

async function main() {
  if (!USER_ID && !ALL_USERS) {
    console.error("REPRICE_USER_ID required (or MODE=all)");
    process.exit(1);
  }
  if (ALL_USERS) {
    const { CosmosClient } = require("@azure/cosmos");
    if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
    const portfolio = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq").container("portfolio");
    const { resources } = await portfolio.items.query("SELECT DISTINCT VALUE c.userId FROM c WHERE IS_DEFINED(c.holdings)").fetchAll();
    console.log(`[reprice-user-holdings] MODE=all -> ${resources.length} users  ${APPLY ? "APPLY" : "DRY-RUN"}
`);
    if (!APPLY) {
      console.log(`DRY-RUN — ${resources.length} users would be repriced (up to ${MAX_HOLDINGS} holdings each). Dispatch with apply=true to write.`);
      return;
    }
    const totals = {};
    for (const uid of resources) {
      const t0 = Date.now();
      const r = await repriceHoldingsForUser(uid, "batch-reprice", { userThrottleMs: 0, minHoldingAgeMs: 0, maxHoldings: MAX_HOLDINGS });
      console.log(`  ${uid}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${JSON.stringify(r).slice(0, 300)}`);
      for (const [k, v] of Object.entries(r || {})) if (typeof v === "number") totals[k] = (totals[k] || 0) + v;
    }
    console.log(`
ALL USERS DONE  ${JSON.stringify(totals)}`);
    return;
  }
  console.log(`[reprice-user-holdings]`);
  console.log(`  userId:      ${USER_ID}`);
  console.log(`  maxHoldings: ${MAX_HOLDINGS}`);
  console.log(`  composite:   ${process.env.HOBBYIQFMV_COMPOSITE_ENABLED === "true" ? "ENABLED" : "DISABLED"}`);
  console.log(`  mode:        ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  if (!APPLY) {
    console.log(`DRY-RUN — would reprice up to ${MAX_HOLDINGS} holdings for ${USER_ID}. Dispatch with apply=true to write.`);
    return;
  }

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
