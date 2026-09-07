#!/usr/bin/env node
// CF-BACKFILL-SUB-CHANNEL-VOCAB (Drew, 2026-08-01).
//
// Populates __subChannel on historical sold_comps rows by detecting
// retail-channel vocabulary (Mega Box, Blaster, HTA, etc.) in the
// setName + title. Pools stay collapsed at slug level; this only
// adds the LANGUAGE tag so downstream views can surface + filter by
// channel.
//
// SAFE: only writes __subChannel + __subChannelBackfilledAt.

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane TAGS __subChannel onto
// sold_comps rows and declared no budget at all. Its scan is every row in the
// container without the tag -- the whole historical corpus, millions of rows --
// so before this it could only ever end by being KILLED at the 150-minute
// ceiling: no marker, no reconcile, no finishLane line, and #1913's KILLED
// branch then withholding the re-dispatch.
//
// THE UNIT IS ONE PAGE of up to 500 sold_comps rows (maxItemCount: 500) --
// fetched whole, then drained through a CONCURRENCY-wide (default 12) window
// of WHOLE-DOCUMENT upserts, and the loop cannot stop inside one. 90 seconds
// comfortably exceeds that drain against a container that throttles, and it is
// checked BEFORE the page is fetched.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: the channel is read out of the
// ROW IN HAND's own setName + title by SUB_CHANNEL_PATTERNS, with no reference
// to any other row. A stop costs coverage, never correctness.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));

const SUB_CHANNEL_PATTERNS = [
  [/\bmega\s*box\b/i,  "mega-box"],
  [/\bblaster\b/i,     "blaster"],
  [/\bhta\s+choice\b/i, "hta-choice"],
  [/\bhta\b/i,         "hta"],
  [/\bhanger\b/i,      "hanger"],
  [/\bfat\s*pack\b/i,  "fat-pack"],
  [/\bcello\b/i,       "cello"],
  [/\bjumbo\b/i,       "jumbo"],
  [/\bhobby\b/i,       "hobby"],
  [/\bretail\b/i,      "retail"],
];

function extractSubChannel(setName, title) {
  const combined = `${setName ?? ""} ${title ?? ""}`;
  for (const [re, tag] of SUB_CHANNEL_PATTERNS) {
    if (re.test(combined)) return tag;
  }
  return null;
}

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
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[backfill-sub-channel-vocab]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE (NOT IS_DEFINED(c.__subChannel)) AND (IS_DEFINED(c.setName) OR IS_DEFINED(c.title))`
  }, { maxItemCount: 500 });

  let examined = 0, wouldChange = 0, errors = 0;
  // `written` did not exist: only failures were counted, so a run reported
  // `wouldChange: N` and said nothing about how many of those N landed.
  let written = 0;
  const byChannel = {};
  const inFlight = [];
  const at = new Date().toISOString();
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count: the loop DISCOVERS rows page by page.
  let stoppedAtBudget = false;

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: BEFORE the page is fetched, never after its upserts have
    // been issued.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const channel = extractSubChannel(row.setName, row.title);
      if (!channel) continue;
      wouldChange++;
      byChannel[channel] = (byChannel[channel] || 0) + 1;
      if (MODE === "apply") {
        row.__subChannel = channel;
        row.__subChannelBackfilledAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).then(() => { written++; }).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) console.log(`  examined=${examined}  wouldChange=${wouldChange}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  examined=${examined}  wouldChange=${wouldChange}  errors=${errors}`);
  console.log(`\nBy channel:`);
  Object.entries(byChannel).sort((a,b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));

  // RECONCILE OVER WHAT WAS SEEN. Every row this run planned to tag is one it
  // matched a channel pattern against, so the identity holds whether the loop
  // finished or the budget stopped it.
  if (MODE === "apply") {
    console.log(`  reconciled: intended ${wouldChange} = written ${written} + failed ${errors}`);
    if (written + errors !== wouldChange) {
      console.error("  !! RECONCILE MISMATCH -- a planned tag was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-sub-channel-vocabulary",
      intended: wouldChange, written, skipped: 0, failed: errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: the scan selects only rows"
      + " whose __subChannel is not defined, and a tagged row has it.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
