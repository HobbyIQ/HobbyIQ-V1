#!/usr/bin/env node
// CF-REPRICE-USER-HOLDINGS (Drew, 2026-07-30). Server-side batch reprice
// for a single user's holdings, bypassing the HTTP endpoint throttle.
// Use to force fresh FMVs after a code / calibration / flag change.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   AUTH_SESSION_SECRET        required (transitive imports)
//   REPRICE_USER_ID            which user's holdings to reprice (required
//                              unless MODE=all)
//   MODE=all                   sweep EVERY user. PRECEDENCE: MODE=all WINS —
//                              it is tested first, so a REPRICE_USER_ID set
//                              alongside it is ignored, not honoured.
//   REPRICE_MAX_HOLDINGS       optional (default 200)
//   REPRICE_CONCURRENCY        optional (default 1). Read and VALIDATED; only
//                              1 is accepted — see the refusal below.
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

// CF-A-THE-NIGHTLY-BILL-IS-PROPORTIONAL-TO-CHANGE (C-2 verifier, 2026-09-03).
//
// This script passed `minHoldingAgeMs: 0` on BOTH lanes, so the nightly
// corpus sweep repriced every holding of every user every night regardless of
// whether anything about that card had changed. That is defensible at 130
// holdings and indefensible as a standing design: the work is proportional to
// CORPUS, and the audit's own growth note (100x corpus -> ~100 kRU) is the
// shape of a bill that only ever goes up.
//
// The honest split, stated rather than buried:
//
//   NIGHTLY (MODE=all)   skip a holding priced within the last 20h WHOSE
//                        EXACT POOL HAS NOT GROWN. Not age alone — the
//                        service re-checks the pool count for every holding
//                        the age filter would skip and reprices it anyway if
//                        a sale landed (skipFreshOnlyWhenPoolUnchanged). So a
//                        card the market moved is ALWAYS repriced; a card
//                        nobody traded is not repriced twice for nothing.
//                        20h < 24h deliberately: the daily cadence must never
//                        skip a holding merely because yesterday's run was a
//                        little late.
//
//   MANUAL (a userId)    keeps the full bypass. A human dispatching a reprice
//                        after a calibration or code change is explicitly
//                        asking for every number to be recomputed, and a
//                        freshness skip there would silently defeat the very
//                        purpose of the dispatch.
const NIGHTLY_MIN_HOLDING_AGE_MS = 20 * 60 * 60 * 1000;

// CF-A-DECORATIVE-KNOB-IS-A-LIE (C-2 verifier, 2026-09-03). `REPRICE_CONCURRENCY`
// was set in daily-refresh.yml and read by NOTHING. A knob that appears to
// bound the blast radius of a corpus sweep, and does not, is worse than no
// knob: the next person to worry about RU pressure would turn it, watch the
// run stay green, and conclude the sweep was bounded.
//
// The script reads it now, and the value it accepts is 1. Serial execution is
// the deliberate design — the sweep shares the sold_comps 10k RU/s floor with
// live user traffic at 5AM ET, and a parallel sweep is exactly the shape that
// produces 429s on the read path a collector is using. Rather than silently
// ignoring a larger value (the same lie in a new place) or quietly honouring
// one (shipping an untested parallel path), it REFUSES: the run exits 1 and
// says that implementing parallelism is a code change, not a config change.
const CONCURRENCY = Number(process.env.REPRICE_CONCURRENCY || "1");
if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1) {
  console.error(`FATAL: REPRICE_CONCURRENCY=${process.env.REPRICE_CONCURRENCY} is not a positive integer.`);
  process.exit(1);
}
if (CONCURRENCY !== 1) {
  console.error(
    `FATAL: REPRICE_CONCURRENCY=${CONCURRENCY} but this script executes SERIALLY (a plain for-loop over users, `
    + `and repriceHoldingsForUser walks holdings serially inside each).\n`
    + `  Serial is deliberate: the sweep shares the sold_comps 10,000 RU/s floor with live user traffic at 5AM ET, `
    + `and a parallel sweep is the shape that produces 429s on a collector's read path.\n`
    + `  Refusing rather than ignoring the value, so nobody believes they have bounded something they have not. `
    + `Parallelism here is a code change, not a config change.`,
  );
  process.exit(1);
}

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
    console.log(`[reprice-user-holdings] MODE=all -> ${resources.length} users  ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`  concurrency:    ${CONCURRENCY} (serial for-loop; see REPRICE_CONCURRENCY below)`);
    console.log(`  freshness skip: holdings priced within ${(NIGHTLY_MIN_HOLDING_AGE_MS / 3600000).toFixed(0)}h whose exact pool has NOT grown`);
    console.log("");
    if (!APPLY) {
      console.log(`DRY-RUN — ${resources.length} users would be repriced (up to ${MAX_HOLDINGS} holdings each). Dispatch with apply=true to write.`);
      return;
    }
    const totals = {};
    for (const uid of resources) {
      const t0 = Date.now();
      const r = await repriceHoldingsForUser(uid, "batch-reprice", {
        userThrottleMs: 0,
        // The nightly lane's freshness rule. Pool-growth aware: a fresh
        // holding whose pool GREW is repriced anyway, so this never hides a
        // real market move — it only stops re-deriving unchanged numbers.
        minHoldingAgeMs: NIGHTLY_MIN_HOLDING_AGE_MS,
        skipFreshOnlyWhenPoolUnchanged: true,
        maxHoldings: MAX_HOLDINGS,
      });
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
