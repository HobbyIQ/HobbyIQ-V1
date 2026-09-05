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
  {
    let token;
    do {
      const page = await queryWithRetry(sc, {
        query: `SELECT c.hobbyiqCardId AS s FROM c WHERE IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
                AND (CONTAINS(c.hobbyiqCardId,':psa-') OR CONTAINS(c.hobbyiqCardId,':bgs-')
                  OR CONTAINS(c.hobbyiqCardId,':sgc-') OR CONTAINS(c.hobbyiqCardId,':cgc-')
                  OR CONTAINS(c.hobbyiqCardId,':raw'))`,
      }, { maxItemCount: 1000, continuationToken: token });
      token = page.continuationToken;
      for (const r of page.resources) if (r.s) protectedSlugs.add(r.s);
    } while (token);
  }
  console.log(`  ${f(protectedSlugs.size)} graded slugs are referenced by at least one sale — these will be SKIPPED\n`);

  let scanned = 0, attempted = 0, deleted = 0, failed = 0, gone = 0, kept = 0;
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
        try { await cat.item(r.id, r.cardId).delete(); deleted++; }
        catch (e) {
          if (e.code === 404) { gone++; return; }
          failed++;
          if (failed <= 5) console.error("  delete failed " + String(r.id).slice(0, 60) + ": " + String(e.message || e).slice(0, 70));
        }
      }));
      if (LIMIT && deleted >= LIMIT) { token = undefined; break; }
    }
    if (++pages % 20 === 0) process.stderr.write(`\r  scanned ${f(scanned)}  deleted ${f(deleted)}  kept ${f(kept)}   `);
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
  console.log(`  failed                    ${f(failed)}`);
  if (!APPLY) console.log(`\n  manifest written to ${MANIFEST}  — read it before running with APPLY=true`);
  if (APPLY) reportWrites({ job: "retire-unreferenced-graded-rows", intended: attempted, written: deleted, skipped: gone, failed });
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
