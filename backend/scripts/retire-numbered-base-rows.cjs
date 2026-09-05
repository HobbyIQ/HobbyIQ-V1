#!/usr/bin/env node
/**
 * CF-A-NUMBERED-CARD-IS-NOT-BASE (Drew, 2026-08-28: "just want to make sure NO
 * parallel is marked as a base").
 *
 * Retires catalog rows that claim parallel="Base" while carrying a serial
 * print run. Base cards are not serial numbered: a /1 is a Superfractor, a /5
 * or /150 or /499 is a numbered parallel whose NAME the source failed to give
 * us. 828,893 rows carried this contradiction, 140,991 of them minted by the
 * checklist ingest in one night via `r.parallel || "Base"` (stopped in #1324).
 *
 * WHY DELETE RATHER THAN RENAME. We cannot name the parallel -- that is the
 * whole problem -- and inventing a name ("Unknown /150") mints an identity no
 * sale will ever be spelled as. The row's facts (set, number, print run) remain
 * recoverable from the source checklists, and the fixed ingest declines to
 * re-create the row. Deletion removes a wrong identity; it does not lose a card:
 * the plain base row lives at a DIFFERENT slug (no :num- suffix) and is not
 * touched.
 *
 * SALES-SAFE BY CHECK, NOT BY ASSUMPTION. A row with sales pointing at it is
 * NOT deleted -- it is reported. Stranding comps to tidy a label is the wrong
 * trade, and those rows need a re-point, not a delete.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually delete (default: report only)
 *   MAX_RUN=5000              only runs a hobby serial could plausibly be
 *   SLOT/SLOTS  CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MAX_RUN = Number(process.env.MAX_RUN || 5000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
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
const SHARD_SCOPE = runnerShardScope({ label: "retire-numbered-base-rows" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

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
const f = (n) => Number(n).toLocaleString();

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), comps = db.container("sold_comps");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  console.log(`slot ${SLOT}/${SLOTS}  MAX_RUN=${MAX_RUN}  ${APPLY ? "APPLY (deletes)" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, retired = 0, keptHasSales = 0, keptOddRun = 0, failed = 0, notReached = 0;
  const salesEx = [];
  let stopReason = null;
  let token;

  do {
    const page = await retry(() => cat.items.query({
      query: `SELECT c.id, c.cardId, c.printRun, c.year, c.setKey, c.cardNumber, c.playerName
              FROM c WHERE c.parallel = 'Base' AND c.printRun > 0`,
    }, { maxItemCount: 400, continuationToken: token }).fetchNext());
    token = page.continuationToken;

    const mine = SLOTS > 1 ? page.resources.filter((_, i) => (i + scanned) % SLOTS === SLOT) : page.resources;

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          if (!(d.printRun <= MAX_RUN)) {
            // A "print run" of 1368310399850795000 is a Twitter id, and runs
            // beyond MAX_RUN are data errors of another class. Left for the
            // prose pass; deleting on garbage evidence deletes garbage-ly.
            keptOddRun++;
            return;
          }
          const { resources: s } = await retry(() => comps.items.query({
            query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s",
            parameters: [{ name: "@s", value: d.id }],
          }).fetchAll());
          if (s[0] > 0) {
            keptHasSales++;
            if (salesEx.length < 6) salesEx.push(`${f(s[0]).padStart(5)} sales  ${String(d.id).slice(0, 76)}`);
            return;
          }
          if (!APPLY) { retired++; return; }
          const pk = d.cardId === undefined || d.cardId === null ? undefined : d.cardId;
          await retry(() => cat.item(d.id, pk).delete()).catch((e) => { if (e.code !== 404) throw e; });
          retired++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 60)}: ${String(e.message || e).slice(0, 60)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && retired >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (stopReason) break;
  } while (token);

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing deleted"}`);
  console.log(`  rows scanned                   ${f(scanned)}`);
  console.log(`  RETIRED — numbered "Base"      ${f(retired)}   <- a parallel was wearing the Base label`);
  console.log(`  kept — sales point here        ${f(keptHasSales)}   <- need a re-point, not a delete`);
  console.log(`  kept — run beyond ${String(MAX_RUN).padEnd(6)}       ${f(keptOddRun)}   <- garbage evidence; the prose pass owns these`);
  console.log(`  failed                         ${f(failed)}`);
  if (salesEx.length) {
    console.log(`\n  rows with sales, for the re-point pass:`);
    for (const e of salesEx) console.log(`    ${e}`);
  }
  if (APPLY) {
    reportWrites({
      job: "retire-numbered-base-rows", intended: scanned, written: retired,
      skipped: keptHasSales + keptOddRun + notReached, failed,
    });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
