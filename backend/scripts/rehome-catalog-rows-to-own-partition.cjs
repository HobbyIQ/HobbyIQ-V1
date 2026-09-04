#!/usr/bin/env node
// CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW (Drew, 2026-08-25).
//
// card_catalog partitions on /cardId. ~17.7M rows carry a CORRECT canonical
// slug in `id` and a VENDOR id in `cardId`:
//
//   id     hiq:baseball:2025:bowman-chrome:cpa-csc:base:auto:bgs-8
//   cardId 1775832219776x807179689237410600          <- Bubble vendor id
//   source cardhedge-graded
//
// The data is right. The address is wrong. `cat.item(slug, slug)` -- the ~1 RU
// point read the entire match path uses -- cannot see any of them, so a whole
// grade ladder is invisible to the thing that prices it.
//
// WHY dedupe-catalog-partition-shadows DOES NOT COVER THIS. That script groups
// by id and acts only on groups of MORE THAN ONE row. These are SINGLETONS: a
// sample of 25 found 12/12 with no row at (id, id) at all. There is nothing to
// merge and no keeper to choose -- the row simply needs to be at its own
// address. Running the dedupe job on these would report zero work forever.
//
// WRITE FIRST, THEN DELETE. A partition key is immutable, so this is
// copy-and-remove, and the copy-and-remove is catalogRowOps.moveCatalogRow's
// rehome (D5 PR 4): the row is upserted at (slug, slug) -- a write Cosmos has
// acknowledged, or the call throws and no delete follows -- and only then is
// the original removed from the vendor partition. Interrupted between the two
// you have a duplicate, which the next run finishes (below). Nothing about the
// card changes on a rehome, so its sales and its own graded ladder are left
// exactly where they are.
//
// The old partition key was a vendor id and is preserved in vendorIds -- a CH
// lookup resolves by vendor cardId and losing that is a silent break.
//
// CF-FINISH-THE-HALF-MOVED-ROWS (Drew, 2026-08-26). This used to skip whenever
// a row already sat at (id,id), on the reasoning that a twin belongs to the
// dedupe job. That reasoning strands the row forever, and the stranded
// population GROWS every time a run is interrupted -- because "canonical
// written, original not yet deleted" is exactly the state a cancelled run
// leaves behind, and this job was cancelled repeatedly that night. One 2013
// slot found 180 such rows and moved 0 of them. So a twin at (id,id) is
// finished: the helper decides it by authority (a same-content twin folds,
// its vendor id crossing over into vendorIds) and removes the redundant copy.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   APPLY=true                actually write (default dry-run)
//   YEARS=2025,2026           years to sweep (default: all)
//   SETKEY_LIKE=bowman        substring the setKey must contain (default: any)
//   PARENTS_ONLY=true         identity rows only; graded rows are regenerable
//                             from their parent (the runner's parents_only)
//   CONCURRENCY=16
//   LIMIT=0                   stop after N re-homes (0 = no limit)
//   RUN_MINUTES=140           stop at this budget and PRINT the marker the
//                             runner's relaunch step greps (D18, 2026-08-29)
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS (D18). This used to run until the
// runner's 150-minute step ceiling SIGKILLed it. A killed process prints no
// summary, so the relaunch step — which read "re-homed N" from the log — saw
// nothing and stopped the fleet, green. The job now owns a clock under the
// ceiling: it stops at RUN_MINUTES, prints its summary, reconciles, and prints
// "stopped at the … budget" so the marker-keyed relaunch continues the slot.

const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const LIMIT = Number(process.env.LIMIT || 0);
const YEARS = String(process.env.YEARS || "").split(",").map((y) => Number(y.trim())).filter(Boolean);
const SETKEY_LIKE = String(process.env.SETKEY_LIKE || "").toLowerCase();
const PARENTS_ONLY = String(process.env.PARENTS_ONLY || "") === "true";
// Cap the SCAN itself, so a dry-run can size a slice without walking all of it.
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 0);

// CF-REHOME-SPLITS-A-YEAR (Drew, 2026-08-25). 95% of the remaining rows sit in
// ~28 years and one worker moves ~1,875 rows/min, so 2025 alone (3.4M) needs a
// dozen sequential 150-minute runs. Dispatching more YEARS does not help: the
// 58 untouched years hold 733,121 rows between them, 5% of the job. So split a
// YEAR, the way normalize-catalog-format splits a mega-year -- bound the scan by
// setKey letter range, server-side, so slots never overlap and need no
// coordination. SLOTS=1 (the default) is the old single-pass behaviour exactly.
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "rehome-catalog-rows-to-own-partition" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();

/**
 * Split the setKey space into SLOTS contiguous ranges that tile it with no gap
 * and no overlap: slot 0 starts open-ended below "a" so setKeys beginning with
 * a digit are not stranded, and the last slot runs to "~" so nothing past "z"
 * is either.
 */
function slotRange(slot, slots) {
  if (!Number.isFinite(slots) || slots <= 1) return null;
  const A = "abcdefghijklmnopqrstuvwxyz".split("");
  const per = Math.ceil(A.length / slots);
  const lo = slot === 0 ? "" : (A[slot * per] ?? "~");
  const hi = slot === slots - 1 ? "~" : (A[(slot + 1) * per] ?? "~");
  return { lo, hi };
}

// CF-THE-REHOME-SCAN-CAN-BE-THROTTLED-TOO (Drew, 2026-08-25). The per-row
// read/write/delete already retry through the connection policy -- a 429
// there is counted and moved past. The SCAN did not, so a single throttled
// page killed the whole run with FATAL and abandoned every row it had not
// reached yet. Run 32910343326 died exactly that way mid-2021.
//
// normalize-catalog-format learned this same lesson hours earlier and carries
// the same wrapper. Same claim from the server, same answer: not now, ask
// again. The per-row moves go through it too.
const retry = async (fn) => {
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const throttled = /request rate is too large|429/i.test(String(e?.message));
      if (!throttled || attempt >= 12) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 30000);
    }
  }
};

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  let scanned = 0, candidates = 0, rehomed = 0, alreadyThere = 0, failed = 0;
  // CF-COUNT-WHAT-THE-LOOP-TOUCHES. `candidates` counts rows the SCAN found;
  // `attempted` counts rows the work loop actually took up. They differ the
  // moment LIMIT stops the run mid-page: the remainder of that page was seen
  // but never tried, and charging it to `intended` reports a shortfall that
  // did not happen (88 phantom rows on the first 5,000-row slice). This is the
  // same mistake dedupe-catalog-partition-shadows made -- taking intent from
  // the scan rather than from the loop -- so it gets the same fix.
  let attempted = 0;
  const samples = [];
  // "limit" or "budget": why the run stopped before the scan drained.
  let stopReason = null;

  const where = ["STARTSWITH(c.id,'hiq:')", "c.id != c.cardId", "IS_DEFINED(c.cardId)", "c.cardId != null"];
  if (YEARS.length) where.push(`c.year IN (${YEARS.join(",")})`);
  if (SETKEY_LIKE) where.push(`CONTAINS(LOWER(c.setKey ?? ''), '${SETKEY_LIKE.replace(/'/g, "")}')`);
  if (PARENTS_ONLY) where.push("NOT IS_DEFINED(c.gradeTier)");
  const range = slotRange(SLOT, SLOTS);
  if (range) {
    where.push(`c.setKey >= '${range.lo}' AND c.setKey < '${range.hi}'`);
    console.log(`slot ${SLOT}/${SLOTS}  setKey range [${range.lo || "''"} .. ${range.hi})`);
    console.log(`  ${SHARD_SCOPE.banner()}`);
  }

  let token, pages = 0;
  do {
    const page = await retry(() => cat.items.query(
      { query: `SELECT * FROM c WHERE ${where.join(" AND ")}` },
      { maxItemCount: 200, continuationToken: token },
    ).fetchNext());
    token = page.continuationToken;

    const work = [];
    for (const r of page.resources) {
      scanned++;
      candidates++;
      if (samples.length < 6) samples.push(`${r.id}\n        was in partition ${r.cardId}  (src ${r.source})`);
      work.push(r);
    }

    if (APPLY && work.length) {
      for (let i = 0; i < work.length; i += CONCURRENCY) {
        await Promise.all(work.slice(i, i + CONCURRENCY).map(async (r) => {
          attempted++;
          try {
            // Same slug, foreign partition: the helper's rehome. It copies to
            // (id, id), keeps the vendor partition key in vendorIds, and deletes
            // the original last. A row already at (id, id) is the half-moved
            // twin, decided by authority and finished (see the header).
            const res = await moveCatalogRow(cat, r, r.id, {}, {
              reason: "re-homed from a foreign partition (CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW)",
              retry,
            });
            if (res.action !== "move") alreadyThere++;
            rehomed++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.error("  rehome failed " + String(r.id).slice(0, 60) + ": " + String(e.message || e).slice(0, 80));
          }
        }));
        if (LIMIT && rehomed >= LIMIT) { stopReason = "limit"; token = undefined; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; token = undefined; break; }
      }
    }
    pages++;
    if (pages % 25 === 0) {
      process.stderr.write(`\r  scanned ${scanned}  rehomed ${rehomed}  already ${alreadyThere}  failed ${failed}   `);
    }
    if (SCAN_LIMIT && scanned >= SCAN_LIMIT) break;
    // The dry-run scan can outlive the ceiling too; the clock applies to both.
    if (!stopReason && Date.now() - STARTED > RUN_MS) { stopReason = "budget"; break; }
  } while (token);
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget with work left — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${LIMIT.toLocaleString()} — a bounded run`);

  const scope = (YEARS.length ? "years=" + YEARS.join(",") : "years=all") +
                (SETKEY_LIKE ? "  setKey~" + SETKEY_LIKE : "") +
                (PARENTS_ONLY ? "  parents-only" : "");
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}  ${scope}`);
  console.log(`  rows in a foreign partition   ${candidates.toLocaleString()}`);
  console.log(`  re-homed to their own slug    ${rehomed.toLocaleString()}`);
  console.log(`  ...of those, leftover twins    ${alreadyThere.toLocaleString()}   (canonical already present; decided by authority, redundant copy removed)`);
  console.log(`  failed                        ${failed.toLocaleString()}`);
  if (APPLY && candidates > attempted) {
    console.log(`  not attempted                 ${(candidates - attempted).toLocaleString()}   (${stopReason === "budget" ? "budget" : "LIMIT"} reached; seen, not tried)`);
  }
  if (samples.length) {
    console.log(`\n  sample:`);
    for (const s of samples) console.log("     " + s);
  }
  if (APPLY) {
    // `alreadyThere` is a sub-total of `rehomed`, not a sibling of it: it goes
    // on its own line above, never into `skipped`, or the equation over-counts.
    reportWrites({ job: "rehome-catalog-rows-to-own-partition", intended: attempted, written: rehomed, failed });
  }
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
