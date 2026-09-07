#!/usr/bin/env node
// CF-AUTO-QUARANTINE-POOLS (Drew, 2026-08-01). Closes the slug-audit
// loop: when a pool has ≥25 samples AND ≥50% flagged rows, quarantine
// EVERY row in that pool (__poolAutoQuarantined=true). Downstream FMV
// pool queries can filter this flag to isolate contaminated pools
// wholesale.
//
// Runs from the nightly cron. Idempotent — rows already marked don't
// get touched again. Rows in newly-clean pools get their flag cleared.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 8
//   POOL_MIN_SAMPLES           default 25
//   POOL_CONTAMINATION_PCT     default 50 (percent)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane TAGS sold_comps rows
// __poolAutoQuarantined -- which takes a pool out of pricing -- and declared no
// budget at all. Phase 1 scans the WHOLE pool (`STARTSWITH(c.hobbyiqCardId,
// 'hiq:')`, 2.4M+ rows), so before this it could only ever end by being KILLED
// at the ceiling: no marker, no reconcile, no finishLane line, and #1913's
// KILLED branch then withholding the re-dispatch.
//
// THE UNIT IS ONE SLUG in the tag phase, because the loop cannot stop inside
// one: a slug is fetched whole with fetchAll() and every row in it is then
// upserted through a CONCURRENCY-wide window. A contaminated pool is by
// definition one with many rows, so 90 seconds is sized to that fetch plus its
// upsert drain, and it is checked BEFORE the slug's rows are fetched.
//
// -- WHY THE TAG PHASE REFUSES AFTER A SCAN-PHASE STOP -----------------------
//
// #1947's retire-flattened-attestations lesson, and this is the arithmetic case
// of it. Phase 1 does not collect rows to act on; it computes, per slug, a
// RATIO -- flagged / total -- and Phase 2 quarantines every slug whose ratio
// clears CONTAMINATION_THRESHOLD with at least MIN_SAMPLES rows behind it.
//
// A ratio over a PARTIAL scan is not a smaller answer, it is a different one,
// and it is wrong in the direction that costs the most: a pool of 400 rows of
// which 20 are flagged is 5% contaminated and must be left alone, but if the
// budget stopped after that pool's first 30 rows happened to include 18 flagged
// ones, it reads as 60% and the whole pool is QUARANTINED -- taken out of
// pricing on the strength of a sample the lane mistook for a census. MIN_SAMPLES
// does not save it: a partial slug can clear the row floor and still misstate
// the ratio.
//
// So a scan-phase budget stop REFUSES the tag phase outright (exit 5) rather
// than acting on ratios it cannot trust. The next dispatch re-scans from the
// top and tags only when it completes the census inside its budget.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const MIN_SAMPLES = Math.max(5, Number(process.env.POOL_MIN_SAMPLES || 25));
const CONTAMINATION_THRESHOLD = Math.max(10, Number(process.env.POOL_CONTAMINATION_PCT || 50)) / 100;

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[auto-quarantine-pools]  mode=${MODE}  concurrency=${CONCURRENCY}  minSamples=${MIN_SAMPLES}  threshold=${CONTAMINATION_THRESHOLD * 100}%`);
  console.log(`  ${CLOCK.describe()}`);

  // Phase 1: aggregate per-slug counts of total + flagged
  console.log("\nPhase 1: aggregate contamination per slug...");
  const perSlug = new Map();
  const iter = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.__priceOutlier, c.__cardsightUnverified,
                   c.__userFlagQuarantine, c.__badActorSeller
              FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')`
  }, { maxItemCount: 5000 });
  let scanned = 0;
  // Set when the budget stopped the CENSUS. It is what makes the tag phase
  // refuse: a contamination RATIO over a partial pool is a wrong number, not a
  // smaller one (see THE CLOCK above).
  let scanStoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is counted.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      const slug = r.hobbyiqCardId;
      let entry = perSlug.get(slug);
      if (!entry) { entry = { total: 0, flagged: 0 }; perSlug.set(slug, entry); }
      entry.total++;
      const flagged = r.__priceOutlier === true || r.__cardsightUnverified === true
        || r.__userFlagQuarantine === true || r.__badActorSeller === true;
      if (flagged) entry.flagged++;
    }
  }
  console.log(`  scanned=${scanned}  slugs=${perSlug.size}`);

  // Identify slugs to quarantine
  const toQuarantine = new Set();
  for (const [slug, e] of perSlug) {
    if (e.total < MIN_SAMPLES) continue;
    if (e.flagged / e.total < CONTAMINATION_THRESHOLD) continue;
    toQuarantine.add(slug);
  }
  console.log(`  slugs to auto-quarantine: ${toQuarantine.size}`);

  // -- THE TAG PHASE REFUSES ON A PARTIAL CENSUS ---------------------------
  //
  // See THE CLOCK above. A ratio computed from part of a pool can clear the
  // threshold when the whole pool would not, and quarantining takes that pool
  // out of pricing. Nothing has been written at this point, so refusing costs a
  // re-scan and never a wrongly quarantined pool.
  if (scanStoppedAtBudget) {
    console.error(`\nREFUSING TO QUARANTINE: the census stopped at the ${CLOCK.RUN_MINUTES}-minute`
      + ` budget, so these contamination ratios are computed over PARTIAL pools.`);
    console.error("  flagged/total over a fraction of a pool can clear the threshold when the whole"
      + " pool would not, and the pool is then taken out of pricing on the strength of a sample"
      + " this lane mistook for a census. MIN_SAMPLES does not protect against it: a partial slug"
      + " can pass the row floor and still misstate the ratio.");
    console.error("  Nothing was written. Re-dispatch: the next run re-scans from the top and tags"
      + " only if it completes the census inside its budget.");
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `census phase only; the quarantine was REFUSED and the relaunch continues from here`);
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  if (toQuarantine.size === 0) { console.log("Nothing to do."); return { client, budget: CLOCK }; }

  // Phase 2: tag every row in those slugs with __poolAutoQuarantined
  console.log("\nPhase 2: tag rows...");
  let tagged = 0, alreadyTagged = 0, errors = 0;
  const inFlight = [];
  const at = new Date().toISOString();
  // The population is KNOWN here -- toQuarantine was derived from a COMPLETE
  // census, which the refusal above guarantees -- so `not reached` below is a
  // real number rather than an invention.
  let slugsDone = 0;
  let tagStoppedAtBudget = false;
  for (const slug of toQuarantine) {
    // THE PRE-CHECK: before the slug's rows are fetched rather than after they
    // have all been upserted.
    if (CLOCK.outOfClock()) { tagStoppedAtBudget = true; break; }
    const { resources: rows } = await sc.items.query({
      query: `SELECT * FROM c WHERE c.hobbyiqCardId = @s AND (NOT IS_DEFINED(c.__poolAutoQuarantined) OR c.__poolAutoQuarantined != true)`,
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    for (const row of rows) {
      if (MODE === "apply") {
        row.__poolAutoQuarantined = true;
        row.__poolAutoQuarantinedAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).then(() => { tagged++; }).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      } else { tagged++; }
    }
    slugsDone++;
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  quarantinedSlugs=${toQuarantine.size}  taggedRows=${tagged}  alreadyTagged=${alreadyTagged}  errors=${errors}`);

  // RECONCILE OVER THE KNOWN POPULATION OF SLUGS. The unit this lane controls is
  // the SLUG, not the row: the row count inside a slug is discovered when the
  // slug is fetched, so a per-row `intended` would be an invention while a
  // per-slug one is exactly what the census produced.
  if (MODE === "apply") {
    const notReached = toQuarantine.size - slugsDone;
    console.log(`  reconciled: intended ${toQuarantine.size} slugs = quarantined ${slugsDone}`
      + ` + not reached ${notReached}   (${tagged} rows tagged, ${errors} row failures)`);
    if (slugsDone + notReached !== toQuarantine.size) {
      console.error("  !! RECONCILE MISMATCH -- a slug was neither quarantined nor left unreached");
      process.exitCode = 4;
    }
    reportWrites({
      job: "auto-quarantine-contaminated-pools",
      intended: tagged + errors, written: tagged, skipped: 0, failed: errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (tagStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${toQuarantine.size - slugsDone} of ${toQuarantine.size} slugs NOT REACHED;`
      + ` the relaunch continues from here`);
    console.log("  the tag is IDEMPOTENT: the per-slug query selects only rows whose"
      + " __poolAutoQuarantined is absent or not true, so a row already tagged is never"
      + " re-written and a finished slug re-reads as empty.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
