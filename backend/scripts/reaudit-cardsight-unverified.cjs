#!/usr/bin/env node
// CF-REAUDIT-CS-UNVERIFIED (Drew, 2026-08-02).
//
// The 529K rows carrying __cardsightUnverified were flagged when the
// CS pipeline was less trusted (before cross-source consensus, learned
// weights, and image probes were in place). This job re-evaluates
// each and clears the flag when current signals now support the row.
//
// A row's __cardsightUnverified flag CLEARS if ANY of:
//   1. Same slug has >= 3 non-CS sales in a ±30% price band around
//      this row's price (peer confirmation)
//   2. Row already carries __consensusVerified = true (cross-source
//      already agreed)
//   3. Row's __confidenceScore >= 0.60 (learned scorer trusts it)
//
// Otherwise flag stays.
//
// Idempotent via __cardsightReauditedAt marker.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// -- THE CLOCK --------------------------------------------------------------
//
// THIS LANE WAS NOT UNCLOCKED -- IT WAS CLOCKED WRONG, which is the distinction
// the wave-2 census (#1951) made for five others and which applies here
// verbatim. It carried a LOCAL `BACKFILL_MAX_MINUTES` (default 25) with a
// `timeExpired()` read at the loop TOP -- reserving nothing for the page and
// its concurrency window already in flight -- and signalled continuation with
// `RELAUNCH_NEEDED=true|false` rather than the marker.
//
// THAT PROTOCOL HAS TWO ARMS AND NO THIRD. `true` re-dispatches, `false` stops,
// and ANYTHING ELSE -- including the empty string a KILLED step leaves, because
// a killed step prints no line at all -- reaches a `::warning::` that does NOT
// fail the job. So a lane killed at the 150-minute ceiling went GREEN with its
// work half done: #1906's "a killed run is not a finished run" living in a
// second protocol, where relaunchNeverCallsAKilledRunFinished.test.ts was not
// looking (its population is the MARKER-keyed steps). Taking the shared clock
// and the marker puts this lane inside that pin's population, and it is REMOVED
// from the RELAUNCH_NEEDED gate rather than left on both -- two steps reacting
// to one stop would re-dispatch it twice.
//
// THE UNIT IS ONE PAGE of up to 200 rows, drained through a CONCURRENCY-wide
// (default 8) window where each item may issue a cross-partition peer COUNT
// (cached per slug + $10 bucket) and then a WHOLE-DOCUMENT upsert. Two round
// trips per uncached row, the first of them a cross-partition aggregate, so the
// reserve is generous: 120 seconds, checked BEFORE the page is fetched.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: each row's verdict reads its own
// __consensusVerified / __confidenceScore, or a peer count keyed on its own
// slug and price -- no group, no vote, no ratio over the scanned set. A stop
// costs coverage, never correctness.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 2 + 1 + 1 = 114m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 120 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[reaudit-cardsight-unverified] apply=${APPLY} concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  const query = "SELECT * FROM c WHERE c.__cardsightUnverified = true " +
                "AND (NOT IS_DEFINED(c.__cardsightReauditedAt))";
  const iter = sc.items.query({ query }, { maxItemCount: 200 });

  // Cache non-CS peer counts per (slug, priceBand)
  const peerCache = new Map();
  async function nonCsPeersAgree(slug, price) {
    if (!slug || !Number.isFinite(price) || price <= 0) return 0;
    const bandLow = price * 0.7;
    const bandHigh = price * 1.3;
    const key = `${slug}|${Math.round(price/10)*10}`;   // 10-dollar buckets
    if (peerCache.has(key)) return peerCache.get(key);
    try {
      const { resources } = await sc.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @slug " +
               "AND c.source != 'cardsight' AND c.price >= @lo AND c.price <= @hi",
        parameters: [{ name: "@slug", value: slug }, { name: "@lo", value: bandLow }, { name: "@hi", value: bandHigh }],
      }).fetchAll();
      const n = Number(resources[0]) || 0;
      peerCache.set(key, n);
      return n;
    } catch { peerCache.set(key, 0); return 0; }
  }

  // `written` did not exist: the lane counted VERDICTS (cleared / keptFlagged)
  // and errors, but nothing at all counted how many of those verdicts actually
  // reached the container. Every row gets an upsert in APPLY mode -- a cleared
  // one and a kept one alike -- so intended is cleared + keptFlagged, and this
  // is the other side of it.
  const stats = { scanned: 0, cleared: 0, keptFlagged: 0, errors: 0, written: 0, reasons: { peers: 0, consensus: 0, score: 0 } };
  const inFlight = [];
  let stoppedAtBudget = false;

  async function processRow(row) {
    try {
      const nowIso = new Date().toISOString();
      let clearReason = null;

      // Rule 1: cross-source consensus already set
      if (row.__consensusVerified === true) {
        clearReason = "consensus";
      }
      // Rule 2: confidence score is trusted
      else if (typeof row.__confidenceScore === "number" && row.__confidenceScore >= 0.60) {
        clearReason = "score";
      }
      // Rule 3: non-CS peer confirmation
      else {
        const peers = await nonCsPeersAgree(row.hobbyiqCardId, Number(row.price));
        if (peers >= 3) clearReason = "peers";
      }

      if (clearReason) {
        stats.cleared++;
        stats.reasons[clearReason]++;
        if (APPLY) {
          row.__cardsightUnverified = false;
          row.__cardsightReauditedAt = nowIso;
          row.__cardsightReauditReason = clearReason;
          await withRetry(() => sc.items.upsert(row));
          stats.written++;
        }
      } else {
        stats.keptFlagged++;
        if (APPLY) {
          row.__cardsightReauditedAt = nowIso;
          row.__cardsightReauditReason = "no-supporting-evidence";
          await withRetry(() => sc.items.upsert(row));
          stats.written++;
        }
      }
    } catch { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: BEFORE the page is fetched, and it reserves the whole
    // page's drain rather than reading a bare over-budget test at the loop top.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 2000 === 0) {
        console.log(`  scanned=${stats.scanned} cleared=${stats.cleared} kept=${stats.keptFlagged} err=${stats.errors} reasons: peers=${stats.reasons.peers} consensus=${stats.reasons.consensus} score=${stats.reasons.score} peerCache=${peerCache.size}`);
      }
      // The inner break too: a 200-row page whose peer counts are all uncached
      // is 200 cross-partition aggregates, which is not a unit the reserve is
      // meant to swallow whole.
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    }
    if (stoppedAtBudget) break;
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:            ${stats.scanned}`);
  console.log(`  cleared (flag off):  ${stats.cleared}`);
  console.log(`    by peer confirm:   ${stats.reasons.peers}`);
  console.log(`    by consensus:      ${stats.reasons.consensus}`);
  console.log(`    by score:          ${stats.reasons.score}`);
  console.log(`  kept flagged:        ${stats.keptFlagged}`);
  console.log(`  errors:              ${stats.errors}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);

  // RECONCILE OVER WHAT WAS DECIDED. Every scanned row that did not error gets
  // exactly one upsert in APPLY mode, so the identity holds whether the loop
  // finished or the budget stopped it.
  if (APPLY) {
    const intended = stats.cleared + stats.keptFlagged;
    console.log(`  reconciled: intended ${intended} = written ${stats.written} + failed ${stats.errors}`);
    if (stats.written + stats.errors !== intended) {
      console.error("  !! RECONCILE MISMATCH -- a decided row was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "reaudit-cardsight-unverified",
      intended, written: stats.written, skipped: 0, failed: stats.errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, and it REPLACES the
  // `RELAUNCH_NEEDED=` line this lane used to print -- see THE CLOCK above for
  // why that protocol could not tell a budget stop from a kill. The lane is
  // removed from the RELAUNCH_NEEDED gate in backfill-runner.yml in the same
  // change; printing both would double-dispatch every stop.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this re-audit is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: the scan selects only"
      + " rows with no __cardsightReauditedAt, and every row this pass decided -- cleared or"
      + " kept -- carries one.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
//
// AND A CRASH IS NO LONGER GREEN. The old tail was
// `.catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); })`
// -- it swallowed a fatal into exit 0 and asked to be re-dispatched, so a lane
// that could not reach Cosmos at all reported success and re-queued itself
// forever. It exits 1 now, which the relaunch step reads as a VERDICT (#1955's
// outcome (d)): named, re-dispatch withheld, chain red.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
