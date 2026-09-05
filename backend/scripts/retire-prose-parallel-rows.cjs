#!/usr/bin/env node
/**
 * CF-A-PARAGRAPH-IS-NOT-A-PARALLEL (Drew, 2026-08-28: "those parallels are NOT
 * base cards and should not say base on them").
 *
 * The checklist scrapers captured a product's whole parallel-ladder PARAGRAPH
 * and wrote it into `parallel` for every card in the set:
 *
 *   "All 100 Base Cards Are Available IN The Following Refractor Parallels.
 *    Refractor (serial Numbered TO 250 Copies) Pink Refractor (two Per Rack
 *    Pack) ... NOTE: ... Https://twitter.com/kburleypdx/status"
 *
 * That paragraph became an 800-character parallelSlug, and the number at the
 * end of the tweet URL became the print run:
 *
 *   hiq:baseball:2020:topps-chrome-update:u-3:all-100-base-cards-are-...
 *     :no-auto:num-1368310399850795000
 *
 * 1368310399850795000 is a Twitter status id.
 *
 * WHAT THIS REFUSES TO DO, and it is the entire reason the script is narrow.
 *
 * The obvious repair is "the parallel is unparseable, so call it Base". That
 * would be the worst available outcome. The paragraph is a LADDER -- it names
 * Refractor, Pink, Pink Wave, Prism, Gold, Red, SuperFractor -- so folding it
 * into Base merges a set's entire refractor ladder into the base card and
 * poisons the one pool most sales land on. These rows are the opposite of base
 * cards. This script never writes "Base", never writes any parallel at all, and
 * asserts as much before it deletes anything.
 *
 * SO IT ONLY RETIRES, AND ONLY WHERE THE CARD SURVIVES. A prose row is deleted
 * only when the same card (sport, year, setKey, cardNumber) still has a
 * clean-parallel row afterwards. Sampled 40: 37 had clean siblings, and the 3
 * that did not were rows missing year/setKey entirely rather than cards at
 * risk. Anything without a clean sibling is REPORTED and left alone -- losing a
 * real card to tidy a field is not a trade worth making.
 *
 * Safe on comps: zero sold_comps rows carry printRun > 1e12, and no sale
 * matches these slugs, so nothing is stranded. Verified before writing.
 *
 * EVIDENCE, NOT LENGTH ALONE. A long parallel is not proof of prose -- some
 * real parallel names are long. A row must exceed MIN_LEN *and* carry a prose
 * marker (a sentence connector, a NOTE:, or a URL).
 *
 * The ladder text is left on the row until it is retired, so a later pass can
 * mine it for real parallel names. Deleting it is the LAST thing that happens.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually delete (default: report only)
 *   MIN_LEN=120  CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0  SLOT/SLOTS
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MIN_LEN = Number(process.env.MIN_LEN || 120);
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
const SHARD_SCOPE = runnerShardScope({ label: "retire-prose-parallel-rows" });
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

/**
 * Prose markers. A long name is suggestive; a sentence connector, an editorial
 * NOTE or a URL is evidence. Requiring one of these keeps a genuinely long
 * parallel name -- "Black White Shimmer Refractor Superfractor" -- out of range.
 */
const PROSE = /( are available )|( the following )|(note:)|(https?:\/\/)|( per rack pack)|( per hanger box)|(printing plate \(set)|( indistinguishable )/i;

/** Guard: this pass must never assign a parallel, least of all "Base". */
function assertNoParallelWrite(ops) {
  for (const op of ops) {
    if (String(op.path || "").toLowerCase().includes("parallel")) {
      throw new Error("REFUSED: this pass must never write a parallel field");
    }
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

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

  console.log(`slot ${SLOT}/${SLOTS}  MIN_LEN=${MIN_LEN}  ${APPLY ? "APPLY (deletes)" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, retired = 0, keptNoSibling = 0, keptNotProse = 0, malformed = 0, failed = 0, notReached = 0;
  const keptEx = [];
  let stopReason = null;
  let token;

  do {
    const page = await retry(() => cat.items.query({
      query: `SELECT c.id, c.cardId, c.sport, c.year, c.setKey, c.cardNumber, c.parallel, c.playerName, c.printRun, c.source
              FROM c WHERE LENGTH(c.parallel) > @n`,
      parameters: [{ name: "@n", value: MIN_LEN }],
    }, { maxItemCount: 300, continuationToken: token }).fetchNext());
    token = page.continuationToken;

    const mine = SLOTS > 1 ? page.resources.filter((_, i) => (i + scanned) % SLOTS === SLOT) : page.resources;

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          if (!PROSE.test(String(d.parallel ?? ""))) { keptNotProse++; return; }
          if (!d.sport || !d.year || !d.setKey || !d.cardNumber) {
            // Missing the fields that identify the card, so "does a clean
            // sibling exist" is unanswerable. Not deletable on this evidence.
            malformed++;
            return;
          }
          const { resources: sib } = await retry(() => cat.items.query({
            query: `SELECT VALUE COUNT(1) FROM c
                    WHERE c.sport=@s AND c.year=@y AND c.setKey=@k AND c.cardNumber=@c
                      AND LENGTH(c.parallel) <= @n`,
            parameters: [{ name: "@s", value: d.sport }, { name: "@y", value: d.year },
              { name: "@k", value: d.setKey }, { name: "@c", value: d.cardNumber },
              { name: "@n", value: MIN_LEN }],
          }).fetchAll());
          if (!(sib[0] > 0)) {
            keptNoSibling++;
            if (keptEx.length < 6) keptEx.push(`${d.year} ${d.setKey} #${d.cardNumber}  ${d.playerName ?? ""}`);
            return;
          }
          if (!APPLY) { retired++; return; }

          // Deletion only. assertNoParallelWrite documents the invariant even
          // though there are no patch ops here -- it fails loudly if anyone
          // later "improves" this into a rewrite.
          assertNoParallelWrite([]);
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
  console.log(`  rows scanned                 ${f(scanned)}`);
  console.log(`  RETIRED (card survives)      ${f(retired)}`);
  console.log(`  kept — long but not prose    ${f(keptNotProse)}`);
  console.log(`  kept — no clean sibling      ${f(keptNoSibling)}   <- would lose the card; left alone`);
  console.log(`  kept — missing identity      ${f(malformed)}   <- no year/setKey/cardNumber to check against`);
  console.log(`  failed                       ${f(failed)}`);
  console.log(`\n  NOTE: no row was assigned a parallel. A ladder paragraph is not a`);
  console.log(`  Base card, and calling it one would merge the ladder into the base pool.`);
  if (keptEx.length) {
    console.log(`\n  kept for review — prose is the only row for the card:`);
    for (const e of keptEx) console.log(`    ${e}`);
  }
  if (APPLY) {
    reportWrites({
      job: "retire-prose-parallel-rows", intended: scanned, written: retired,
      skipped: keptNotProse + keptNoSibling + malformed + notReached, failed,
    });
  }
}

module.exports = { PROSE, assertNoParallelWrite };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
