#!/usr/bin/env node
/**
 * CF-RETIRE-UNREFERENCED-GRADED-ROWS (Drew, 2026-08-26).
 *
 * Removes the 16,273,427 graded catalog rows that sit under a foreign partition
 * key. They are unreferenced and unreachable, and they are over a third of a
 * 48M row container.
 *
 * WHY THEY ARE SAFE TO REMOVE, measured rather than assumed:
 *
 *   1. NOTHING LOOKS THEM UP. catalogMatcher never builds a graded slug -- it
 *      point-reads (slug, slug) on the base card. Pricing never reads them
 *      either: canonicalFmv derives a graded price as raw anchor x
 *      gradeMultiplier from GRADE_CALIBRATION.
 *
 *   2. SALES DO NOT POINT AT THEM. Of 15,673,468 slugged sales, 97 carry a
 *      grade suffix -- 0.0006%. Sales keep the grade in gradeCompany /
 *      gradeValue and slug to the BASE card.
 *
 *   3. THEY ARE ALREADY INVISIBLE. id != cardId means a point read on
 *      (slug, slug) cannot reach them at all. Anything depending on them by
 *      point read is already failing today.
 *
 *   4. THEY ARE REGENERABLE. explodeCatalogGrades rebuilds a graded row from
 *      its parent in one pass, now that it writes to the contract (#1278).
 *
 * THE 97 ARE PROTECTED ANYWAY. Every graded slug referenced by a sale is loaded
 * at startup and skipped, so the handful of rows that ARE pointed at survive
 * even though the arithmetic says they hardly matter. It costs one query.
 *
 * MANIFEST FIRST. A dry run writes every id it intends to delete to
 * /tmp/retire-graded-manifest.txt and deletes nothing. Two numbers I stated
 * confidently today were wrong -- a 2.7M "identity parents" figure and a 30,829
 * anime figure -- both because I read one predicate and reported another. This
 * is 16.3M irreversible deletes, so the list gets read before it gets run.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY=true                actually delete (default: manifest only)
 *   CONCURRENCY=64
 *   LIMIT=0                   stop after N deletes (0 = no limit)
 *   MANIFEST=/path            where to write the id list
 */
const fs = require("node:fs");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 64);
const LIMIT = Number(process.env.LIMIT || 0);
const MANIFEST = process.env.MANIFEST || "/tmp/retire-graded-manifest.txt";

// CF-RETIRE-SPLITS-ACROSS-SLOTS (Drew, 2026-08-26). One worker deletes ~22,100
// rows/min, so 15.4M is roughly 11 hours. Racing several unpartitioned workers
// over the same scan buys nothing -- one deletes, the rest collect 404s -- so
// split the setKey space server-side, exactly as the re-home does. Slots never
// overlap and need no coordination. SLOTS=1 is the previous behaviour.
// CF-RETIRE-BIGGER-PAGES (Drew, 2026-08-26). Four balanced workers deleted
// 18,675 rows/min -- about 2,500 RU/s against a container provisioned at
// 400,000. The job is not RU-bound, it is bound by scan round-trips: each
// page is a cross-partition scan of a 39M container and the deletes that
// follow finish long before the next page arrives. Bigger pages amortise the
// scan over more deletes.
const PAGE = Number(process.env.PAGE_SIZE || 2000);

// CF-RETIRE-EXITS-BEFORE-THE-CEILING (Drew, 2026-08-26). The workflow kills
// the step at 150 minutes, and the self-relaunch decides whether to continue
// by grepping the "deleted N" summary out of the log. That line prints only on
// normal completion, so a run that hits the ceiling is SIGKILLed before it,
// the relaunch reads MOVED=0, and logs "nothing deleted -- done, no
// re-dispatch."
//
// At 8 workers each owns ~880,000 rows and needs ~4.3h, so EVERY worker would
// hit the ceiling and the fleet would stop with millions of rows left -- eight
// green runs whose last log line says "done". Stop on our own clock instead,
// print the summary, and let the relaunch carry on.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();

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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
// TOCTOU (review finding, 2026-09-27). `protectedSlugs` (below) is a
// ONE-TIME snapshot taken before the sweep starts. The sweep itself is a
// multi-hour, 16.3M-row paginated walk -- a sale minted or re-pointed onto
// one of these slugs AFTER the snapshot and BEFORE that row's own delete is
// reached would be invisible to the snapshot and deleted-from-under. salesAtId
// (dual cross-partition + partition-scoped) is now re-run PER ROW,
// immediately before its delete, exactly as retire-flattened-attestations
// .cjs and retire-prose-parallel-rows.cjs do in this same program -- the
// snapshot remains as a cheap first-pass filter (it still skips the
// overwhelming majority of rows for free), but it is no longer the last
// word on any row that reaches the delete.
const { salesAtId } = require(path.join(__dirname, "lib", "sales-at-id.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "retire-unreferenced-graded-rows" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;


/** Graded rows stranded under a foreign partition key. */
const TARGET =
  "STARTSWITH(c.id,'hiq:') AND c.id != c.cardId AND IS_DEFINED(c.cardId) " +
  "AND c.cardId != null AND IS_DEFINED(c.gradeTier)";

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), sc = db.container("sold_comps");
  const f = (n) => Number(n).toLocaleString();

  const isThrottle = (e) => /request rate is too large|429/i.test(String(e?.message));

  // Generic retry, for salesAtId's per-row TOCTOU re-check (opts.retry) --
  // the same backoff shape as fetchAllWithRetry/queryWithRetry below, just
  // wrapping an arbitrary async fn rather than a fixed container.items.query
  // call, since salesAtId issues two queries (cross-partition + partition-
  // scoped) per invocation.
  const retry = async (fn) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (!isThrottle(e) || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const fetchAllWithRetry = async (container, spec) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await container.items.query(spec).fetchAll(); }
      catch (e) {
        if (!isThrottle(e) || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const queryWithRetry = async (container, spec, opts) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await container.items.query(spec, opts).fetchNext(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // ---- the protected set: every graded slug a sale actually points at -------
  console.log("loading graded slugs referenced by sales...");
  const protectedSlugs = new Set();
  // LANE-SAFETY (2026-09-27). This used to scan `hobbyiqCardId` alone --
  // exactly the single-form read lib/sales-at-id.cjs's own header documents
  // missing a real row 0.6% of the time (a sale RE-POINTED so hobbyiqCardId
  // was rewritten but cardId, the partition key, was not). At 16.3M
  // candidate deletes a 0.6% miss on the protected-set side is thousands of
  // graded rows a live sale still addresses. Both fields are unioned in the
  // SAME scan (still one full pass, not one query per row -- this container
  // is too large for a per-row salesAtId call) rather than adding a second
  // scan, so the cost stays a single page walk.
  {
    let token;
    do {
      const page = await queryWithRetry(sc, {
        query: `SELECT c.hobbyiqCardId AS s1, c.cardId AS s2 FROM c
                WHERE ((IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
                    AND (CONTAINS(c.hobbyiqCardId,':psa-') OR CONTAINS(c.hobbyiqCardId,':bgs-')
                      OR CONTAINS(c.hobbyiqCardId,':sgc-') OR CONTAINS(c.hobbyiqCardId,':cgc-')
                      OR CONTAINS(c.hobbyiqCardId,':raw')))
                  OR (IS_DEFINED(c.cardId) AND c.cardId != null
                    AND (CONTAINS(c.cardId,':psa-') OR CONTAINS(c.cardId,':bgs-')
                      OR CONTAINS(c.cardId,':sgc-') OR CONTAINS(c.cardId,':cgc-')
                      OR CONTAINS(c.cardId,':raw'))))`,
      }, { maxItemCount: 1000, continuationToken: token });
      token = page.continuationToken;
      for (const r of page.resources) {
        if (r.s1) protectedSlugs.add(r.s1);
        if (r.s2) protectedSlugs.add(r.s2);
      }
    } while (token);
  }
  console.log(`  ${f(protectedSlugs.size)} graded slugs are referenced by at least one sale (hobbyiqCardId OR cardId) — these will be SKIPPED\n`);

  let scanned = 0, attempted = 0, deleted = 0, failed = 0, gone = 0, kept = 0;
  let keptLiveSales = 0;
  let hitBudget = false;
  const out = APPLY ? null : fs.createWriteStream(MANIFEST, { flags: "w" });

  // CF-RETIRE-SHARDS-BY-GRADE-TIER (Drew, 2026-08-26). setKey was the wrong
  // axis. Measured over 9,281,956 target rows, the four letter ranges held
  // 887,326 / 1 / 8,245,353 / 0 -- 'o'..'v' is panini, prizm, topps, select,
  // so one worker did 89% of the work while two exited in 11 seconds. Worse,
  // 66,711 target rows carry no setKey at all and no letter range can ever
  // reach them.
  //
  // gradeTier is the right axis: TARGET already requires it to be defined, so
  // every target row is reachable, and it is measured uniform -- 11 tiers at
  // ~809,200 rows each, 9.0% apiece. Tiers are read at startup rather than
  // hardcoded so a tier we stop issuing cannot silently strand its rows.
  let scopedTarget = TARGET;
  let scopedParams = [];
  if (SLOTS > 1) {
    // CF-RETIRE-TIER-DISCOVERY-RETRIES (Drew, 2026-08-26). This GROUP BY is a
    // full scan of the target set, and every slot issues it at once on dispatch.
    // Unretried, one slot took a 429 and exited 3 within 36 seconds -- the only
    // query in the script that was not already behind a retry. Stagger the
    // starts so four full scans do not land on the same second, then retry.
    if (SLOT > 0) await new Promise((r) => setTimeout(r, SLOT * 20000));
    const { resources: tierRows } = await fetchAllWithRetry(cat,
      { query: `SELECT c.gradeTier AS t, COUNT(1) AS n FROM c WHERE ${TARGET} GROUP BY c.gradeTier` });
    // Deal biggest-first so the eleven ~809k tiers spread evenly instead of
    // landing alphabetically -- plain a-z order put 4 of them on one slot and
    // 2 on another, which is the same imbalance in a smaller costume.
    const all = tierRows
      .filter((r) => typeof r.t === "string")
      .sort((a, b) => b.n - a.n || a.t.localeCompare(b.t));
    const mine = all.filter((_, i) => i % SLOTS === SLOT);
    if (mine.length === 0) {
      console.log(`slot ${SLOT}/${SLOTS} owns none of ${all.length} tiers — nothing to do`);
      console.log(`  ${SHARD_SCOPE.banner()}`);
      return;
    }
    scopedParams = mine.map((r, i) => ({ name: `@t${i}`, value: r.t }));
    scopedTarget = `${TARGET} AND c.gradeTier IN (${scopedParams.map((p) => p.name).join(",")})`;
    const owned = mine.reduce((s, r) => s + r.n, 0);
    console.log(`slot ${SLOT}/${SLOTS}  ${mine.length} of ${all.length} tiers, ${f(owned)} rows`);
    console.log(`  ${mine.map((r) => `${r.t}=${f(r.n)}`).join("  ")}`);
  }

  let token, pages = 0;
  do {
    const page = await queryWithRetry(cat,
      { query: `SELECT c.id, c.cardId, c.gradeTier, c.source FROM c WHERE ${scopedTarget}`, parameters: scopedParams },
      { maxItemCount: PAGE, continuationToken: token });
    token = page.continuationToken;

    const work = [];
    for (const r of page.resources) {
      scanned++;
      if (protectedSlugs.has(r.id)) { kept++; continue; }
      if (!APPLY) { out.write(`${r.id}\t${r.cardId}\t${r.gradeTier}\t${r.source}\n`); continue; }
      work.push(r);
    }

    for (let i = 0; i < work.length; i += CONCURRENCY) {
      await Promise.all(work.slice(i, i + CONCURRENCY).map(async (r) => {
        attempted++;
        try {
          // TOCTOU RE-CHECK (review finding, 2026-09-27), LIVE, PER ROW,
          // IMMEDIATELY BEFORE THE DELETE. `protectedSlugs` was a snapshot
          // taken once before this multi-hour sweep began; this re-checks
          // THIS row's own id against the live pool, right here, by both
          // read forms, so a sale minted or re-pointed onto it since the
          // snapshot is caught rather than deleted out from under.
          const { total: livePointing } = await salesAtId(sc, r.id, { retry });
          if (livePointing > 0) {
            keptLiveSales++;
            return;
          }
          await cat.item(r.id, r.cardId).delete();
          deleted++;
        }
        catch (e) {
          if (e.code === 404) { gone++; return; }
          failed++;
          if (failed <= 5) console.error("  delete failed " + String(r.id).slice(0, 60) + ": " + String(e.message || e).slice(0, 70));
        }
      }));
      if (LIMIT && deleted >= LIMIT) { token = undefined; break; }
    }
    if (++pages % 20 === 0) process.stderr.write(`\r  scanned ${f(scanned)}  deleted ${f(deleted)}  kept ${f(kept)}  live-sales ${f(keptLiveSales)}   `);
    if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { hitBudget = true; token = undefined; }
  } while (token);
  process.stderr.write("\n");
  if (out) out.end();

  if (hitBudget) console.log(`
stopped at the ${RUN_MS / 60000}-minute budget with work left — the relaunch continues from here`);
  console.log(`\n${APPLY ? "APPLY" : "MANIFEST ONLY — nothing deleted"}`);
  console.log(`  matched the target        ${f(scanned)}`);
  console.log(`  protected (a sale uses it) ${f(kept)}`);
  console.log(`  deleted                   ${f(deleted)}`);
  console.log(`  already gone (404)        ${f(gone)}`);
  console.log(`  kept — live sale (TOCTOU) ${f(keptLiveSales)}   <- protectedSlugs was a one-time snapshot; caught per-row, immediately before this delete`);
  console.log(`  failed                    ${f(failed)}`);
  if (!APPLY) console.log(`\n  manifest written to ${MANIFEST}  — read it before running with APPLY=true`);
  if (APPLY) reportWrites({ job: "retire-unreferenced-graded-rows", intended: attempted, written: deleted, skipped: gone + keptLiveSales, failed });
})()
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
// process.exitCode set by the body above is HONOURED, never overwritten.
  .then(() => finishLane(process.exitCode || 0))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); 
    await finishLane(3);
  });
