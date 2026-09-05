#!/usr/bin/env node
/**
 * CF-SAME-YEAR-SET-NUMBER-NAME-IS-THE-SAME-CARD (Drew, 2026-08-27:
 * "the card needs to be added to the correct card, if it isn't by year set and
 * card number and name, idk how much easier it can get").
 *
 * That is the rule, and the catalog breaks it in the parallel field. Same year,
 * same set, same card number, same player -- and two different names:
 *
 *     catalog:  parallel="Chrome Prospects Lava Refractor"  subsetName="Base"
 *     sale:     parallel="Lava Refractor"
 *
 * The subset got folded into the parallel, so the sale computes
 * `...:lava-refractor:...`, the catalog only holds
 * `...:chrome-prospects-lava-refractor:...`, nothing exists at the sale's slug,
 * and pricing falls back to BASE comps. That is a Gold parallel priced off base
 * sales, which is how this was reported.
 *
 * SAFE, AND MEASURED SAFE. Collapsing reunites one card's pool rather than
 * merging two cards, because the stripped form already dominates:
 *
 *     "Chrome Prospects Gold Refractor"   443   vs  "Gold Refractor"  118,877
 *     "Chrome Prospects Blue Refractor"   410   vs  "Blue Refractor"  103,561
 *
 * The folded form is a splinter. This is the OPPOSITE of the BCP- case, where
 * bowman and bowman-chrome are genuinely different cards and merging would
 * destroy them -- the difference is that here both names denote one card.
 *
 * THE PRINT RUN GOT EATEN TOO. A parser glued the run into the name and
 * truncated the plural:
 *
 *     "Chrome Prospects X Fractor: 725 Copie"      -> X Fractor, printRun 725
 *     "Chrome Prospects Popcorn: Ten Copie"        -> Popcorn,   printRun 10
 *
 * Print run is the one field no sale title can be made to yield, so it is
 * recovered rather than discarded.
 *
 * `Base ` IS DELIBERATELY NOT TOUCHED. "Base Cards" (12,493) and "Base
 * Autograph" (10,969) are category names sitting in the parallel field, not
 * parallels, and "Base Refractor" may be legitimate. The same prefix rule
 * would corrupt 47,332 rows. That group needs its own analysis.
 *
 * CHANGING parallel CHANGES THE SLUG, so a repaired row MOVES. Copy to the new
 * slug first, verify, then delete the original -- a crash leaves a duplicate
 * the next pass collapses, where the reverse order would lose the only copy.
 * When a canonical row already sits at the target slug, the folded row is
 * simply retired: that is the pool reuniting.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SLOT / SLOTS              shard by prefix
 *   CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { upsertCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
const { computeHobbyIqCardId, slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "repair-parallel-subset-fold" });
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
 * Subset prefixes the sources fold into the parallel. Ordered longest-first so
 * "Chrome Prospects " wins over "Prospects ". `Base ` is NOT here -- see above.
 */
const FOLDED_PREFIXES = [
  "Chrome Prospects ",
  "Chrome Prospect ",
  "Paper Prospects ",
  "Paper Prospect ",
  "Prospects ",
];

// CF-THE-GLUE-IS-NOT-ONLY-ON-PREFIXED-ROWS (Drew, 2026-08-27: "is x fractor
// down to colored x fractors?").
//
// The first pass only SCANNED rows starting with a subset prefix, so a run
// glued onto a row without one was never looked at:
//
//     "X Fractor: 5625 Copies"    539 rows, untouched
//
// unfold() always handled it; the scan simply never fed it those rows. The
// prefix scan is index-friendly (STARTSWITH); this one is not, so it is a
// separate MODE rather than a widening of the same query.
const GLUE_PREDICATE = "CONTAINS(c.parallel, ' Copies') OR CONTAINS(c.parallel, ' Copie')";

/** Words the source spells out instead of writing a number. */
const WORD_RUN = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, twentyfive: 25,
  fifty: 50, hundred: 100,
};

/**
 * Split a folded parallel into its real name, the subset it was folded with,
 * and any print run the parser ate. Returns null when nothing needs changing,
 * so a caller can leave the row alone.
 */
function unfold(parallel) {
  const raw = String(parallel ?? "").trim();
  if (!raw) return null;

  let name = raw;
  let subset = null;
  let printRun = null;

  // "...: 725 Copie" / "...: Ten Copies" -- the run the parser swallowed.
  const run = name.match(/:\s*([A-Za-z0-9,]+)\s+Copie?s?\.?\s*$/i);
  if (run) {
    const tok = run[1].replace(/,/g, "").toLowerCase();
    const n = /^\d+$/.test(tok) ? Number(tok) : WORD_RUN[tok];
    if (Number.isFinite(n) && n > 0) printRun = n;
    name = name.slice(0, run.index).trim();
  }

  for (const p of FOLDED_PREFIXES) {
    if (name.toLowerCase().startsWith(p.toLowerCase())) {
      subset = p.trim();
      name = name.slice(p.length).trim();
      break;
    }
  }

  // Nothing was folded, or stripping leaves nothing to name the card with. A
  // parallel we cannot name is left exactly as it is.
  if (!subset && printRun === null) return null;
  if (!name || name.length < 2) return null;
  return { parallel: name, subsetName: subset, printRun };
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

  // STARTSWITH is index-friendly; a field-to-field or function-wrapped
  // predicate is a full scan of 31.6M documents.
  // MODE=glue sweeps the print-run glue wherever it sits, including rows with
  // no subset prefix. MODE=prefix (default) is the index-friendly pass.
  const MODE = String(process.env.MODE || "prefix").toLowerCase();
  const mine = MODE === "glue"
    ? [null]
    : (SLOTS > 1 ? FOLDED_PREFIXES.filter((_, i) => i % SLOTS === SLOT) : FOLDED_PREFIXES);
  if (!mine.length) { console.log(`slot ${SLOT}/${SLOTS} owns no prefix — nothing to do`); return; }
  console.log(`slot ${SLOT}/${SLOTS}  mode=${MODE}  ${MODE === "glue" ? "print-run glue, any row" : "prefixes: " + mine.join(", ")}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, moved = 0, mergedIntoExisting = 0, unchanged = 0, failed = 0, runsRecovered = 0;
  let stopReason = null;

  for (const prefix of mine) {
    if (stopReason) break;
    let token;
    do {
      const spec = prefix === null
        ? { query: `SELECT * FROM c WHERE ${GLUE_PREDICATE}` }
        : { query: `SELECT * FROM c WHERE STARTSWITH(c.parallel, @p)`, parameters: [{ name: "@p", value: prefix }] };
      const page = await retry(() => cat.items.query(spec,
        { maxItemCount: 400, continuationToken: token }).fetchNext());
      token = page.continuationToken;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (row) => {
          scanned++;
          const fix = unfold(row.parallel);
          if (!fix) { unchanged++; return; }
          try {
            const slug = computeHobbyIqCardId({
              sport: row.sport, year: Number(row.year),
              setKey: row.setKey ?? row.setName,
              cardNumber: String(row.cardNumber),
              parallel: fix.parallel,
              isAuto: Boolean(row.isAuto),
              printRun: fix.printRun ?? row.printRun ?? null,
              authoritativeSetKey: true,   // the row already knows its set
            });
            if (!slug || !slug.startsWith("hiq:") || slug === row.id) { unchanged++; return; }
            if (fix.printRun !== null && (row.printRun === null || row.printRun === undefined)) runsRecovered++;

            const twin = await retry(() => cat.item(slug, slug).read().catch((e) => {
              if (e.code === 404) return { resource: undefined };
              throw e;
            }));

            if (!APPLY) { twin.resource ? mergedIntoExisting++ : moved++; return; }

            if (!twin.resource) {
              const { _rid, _self, _etag, _attachments, _ts, id: _i, cardId: _c, ...rest } = row;
              const w = await retry(() => upsertCatalogEntry({
                ...rest, id: slug, cardId: slug, hobbyiqCardId: slug,
                parallel: fix.parallel, parallelSlug: slugify(fix.parallel),
                subsetName: fix.subsetName ?? rest.subsetName ?? null,
                printRun: fix.printRun ?? rest.printRun ?? null,
                unfoldedFrom: row.parallel,
              }, { known: null }));
              if (!w) { failed++; return; }
              moved++;
            } else {
              // The canonical row already exists — this IS the pool reuniting.
              mergedIntoExisting++;
            }
            await retry(() => cat.item(row.id, row.cardId ?? row.id).delete()).catch((e) => {
              if (e.code !== 404) throw e;
            });
          } catch (e) {
            failed++;
            if (failed <= 5) console.error(`  failed ${String(row.id).slice(0, 62)}: ${String(e.message || e).slice(0, 60)}`);
          }
        }));
        if (LIMIT && (moved + mergedIntoExisting) >= LIMIT) { stopReason = "limit"; break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
      }
      if (stopReason) break;
    } while (token);
  }

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written or deleted"}`);
  console.log(`  scanned                      ${f(scanned)}`);
  console.log(`  moved to the unfolded slug   ${f(moved)}`);
  console.log(`  merged into an existing row  ${f(mergedIntoExisting)}   <- the pool reuniting`);
  console.log(`  print runs recovered         ${f(runsRecovered)}   <- the parser had eaten these`);
  console.log(`  left alone                   ${f(unchanged)}`);
  console.log(`  failed                       ${f(failed)}`);
  if (APPLY) {
    reportWrites({
      job: "repair-parallel-subset-fold",
      intended: scanned, written: moved + mergedIntoExisting, skipped: unchanged, failed,
    });
  }
}

module.exports = { unfold, FOLDED_PREFIXES };

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
