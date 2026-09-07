#!/usr/bin/env node
// CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY (Drew, 2026-07-31).
//
// Retroactively applies the CF-CARDNUMBER-FROM-TITLE ingest fix to
// historical sold_comps rows written before the fix landed (PR #987).
//
// Scans every row from source=="cardsight" with a title, re-parses the
// title via parseListingIdentity, and REWRITES the row's identity
// fields (cardNumber, parallel, isAuto, hobbyiqCardId, contentHash)
// when the parsed identity differs from the stored one.
//
// Motivating case: Drew's Hartman Blue Refractor CPA-EHA pool had 19
// sub-$25 rows that were actually base BCP-102 sales (Reptilian,
// Purple Geometric, Sky Blue Border, Lazer). Their tiny prices dragged
// the raw anchor from a real $1,500+ market down to $550. This
// script relocates those rows to their true pools (Reptilian BCP-102,
// etc.), immediately cleaning up the Blue Refractor CPA-EHA pool.
//
// Idempotent: re-running skips rows whose stored identity already
// matches the parsed identity. Skips rows where title parsing can't
// derive a cardNumber (falls through — can't verify → don't touch).
//
// Modes:
//   BACKFILL_APPLY=false (default) — dry-run: reports what would change
//   BACKFILL_APPLY=true            — apply the writes
//
// Concurrency: BACKFILL_CONCURRENCY (default 8).

const path = require("path");
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES a sale's IDENTITY
// -- cardNumber, parallel, isAuto, hobbyiqCardId and contentHash, i.e. which
// FMV pool the sale belongs to -- and declared no budget at all. BACKFILL_LIMIT
// defaults to 0, "no cap", so the standing configuration is an unbounded walk
// of every Cardsight row with a title. Before this it could only ever end by
// being KILLED at the ceiling: no marker, no reconcile, no finishLane line, and
// #1913's KILLED branch then withholding the re-dispatch -- with some sales
// moved to their true pools and the rest still dragging the wrong ones, which
// is exactly the split-pool state the lane exists to end
// (feedback_one_card_one_row_one_pool).
//
// THIS LANE IS SCAN-THEN-WRITE, and both phases are on the clock.
//
//   THE SCAN builds the whole workQueue in memory before a single rewrite is
//   issued. Its unit is one page of up to 500 rows.
//
//   THE WRITE unit is ONE REWRITE, and it is expensive: a full document READ
//   followed by a full document REPLACE, each wrapped in a 5-attempt
//   exponential backoff, dispatched through a CONCURRENCY-wide (default 8)
//   worker pool. 90 seconds comfortably exceeds one such read/replace pair
//   through its backoff, and it is checked BEFORE the worker takes the item.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: every decision reads the ROW IN
// HAND -- parseListingIdentity on that row's own title, compared against that
// row's own stored fields -- with no reference to any other row, so a row the
// scan never reached is simply not in this pass's queue. The scan's own stop is
// still reported, so a short queue is never read as the whole population.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = String(process.env.BACKFILL_APPLY || "").toLowerCase() === "true";
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.BACKFILL_LIMIT || 0);   // 0 = no cap

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING not set");
  process.exit(1);
}

async function main() {
  const { CosmosClient } = require("@azure/cosmos");
  const { createHash } = require("crypto");

  // Load compiled title parser + slug computer.
  const backend = path.resolve(__dirname, "..");
  const { parseListingIdentity } = require(
    path.join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"),
  );
  const { computeHobbyIqCardId } = require(
    path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
  );

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-cardsight-title-identity]`);
  console.log(`  mode:        ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit:       ${LIMIT || "no cap"}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  // CF-BACKFILL-WIDEN-SOURCES (Drew, 2026-07-31). Originally scoped to
  // cardsight-source rows only (which pre-dated the CF-CARDNUMBER-FROM-
  // TITLE ingest fix). Widening to also cover cardhedge + ebay-user-
  // purchase because BOTH of those paths also wrote pre-title-parsing
  // rows to sold_comps before the parseListingIdentity call landed in
  // persistVendorSalesToPool on 2026-07-23. Historical rows from those
  // sources have the same wrong-parallel / wrong-cardNumber bug.
  //
  // Scope filter via BACKFILL_CARD_NUMBERS env var: comma-separated
  // list of cardNumbers (e.g. "CPA-EHA,CPA-JHA,BCP-102") — restricts
  // scan to matching rows only. Used for targeted, fast cleanup of
  // Drew's specific holdings before firing the full corpus grind.
  const cardNumbersFilter = String(process.env.BACKFILL_CARD_NUMBERS || "").trim();
  const cardNumberList = cardNumbersFilter
    ? cardNumbersFilter.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)
    : null;
  const sourceClause = "c.source IN ('cardsight', 'cardhedge', 'ebay-user-purchase')";
  const cardNumberClause = cardNumberList && cardNumberList.length > 0
    ? ` AND UPPER(c.cardNumber) IN (${cardNumberList.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ")})`
    : "";
  const topClause = LIMIT > 0 ? `TOP ${LIMIT} ` : "";
  const query = `SELECT ${topClause}c.id, c.cardId, c.title, c.parallel, c.cardNumber, c.isAuto, c.playerName, c.cardYear, c.setName, c.sport, c.hobbyiqCardId, c.contentHash, c.price, c.soldAt, c.source, c.url FROM c WHERE ${sourceClause}${cardNumberClause} AND IS_DEFINED(c.title) AND c.title != null`;
  console.log(`  sources:     cardsight, cardhedge, ebay-user-purchase`);
  console.log(`  cardNumbers: ${cardNumberList ? cardNumberList.join(",") : "(all)"}`);

  const stats = {
    scanned: 0,
    unchanged: 0,           // parser matched stored (no-op, most rows)
    unparseable: 0,         // title has no recognizable cardNumber
    identityMismatched: 0,  // parser differs from stored → will rewrite
    rewriteQueued: 0,
    rewriteOk: 0,
    rewriteErr: 0,
    samples: [],
  };

  const iterator = sc.items.query(query, { maxItemCount: 500 });
  const workQueue = [];

  let scanStoppedAtBudget = false;
  while (iterator.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is queued.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const page = await iterator.fetchNext();
    for (const row of page.resources) {
      stats.scanned++;
      const parsed = parseListingIdentity(String(row.title || ""));
      if (!parsed.cardNumber) {
        stats.unparseable++;
        continue;
      }
      const newCardNumber = String(parsed.cardNumber).toUpperCase();
      const oldCardNumber = String(row.cardNumber || "").toUpperCase();
      const newParallel = parsed.parallel ?? "Base";
      const oldParallel = String(row.parallel || "");
      const newIsAuto = Boolean(parsed.isAuto);
      const oldIsAuto = Boolean(row.isAuto);
      // CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY (Drew, 2026-07-31):
      // three-way mismatch check — cardNumber, parallel, isAuto. Every
      // one of them is a real data-quality signal worth correcting:
      //
      //   - cardNumber mismatch → sale in wrong FMV pool (Drew's Blue
      //     Refractor $550 case: stored CPA-EHA but title BCP-102)
      //   - parallel mismatch → sale in wrong sibling pool (Blue
      //     Refractor vs Blue X-Fractor are different variants)
      //   - isAuto mismatch → sale in wrong isAuto slot (base auto
      //     comparisons broken; grade multipliers apply the wrong tier)
      //   - null → Base parallel — legit correction that stops the
      //     "unknown parallel" bucket from polluting cross-parallel
      //     queries. Same physical card being labeled two ways is a bug.
      //
      // Normalize casing + hyphen/space for parallel comparison so
      // "blue-refractor" and "Blue Refractor" (same identity, different
      // spelling) don't flag; only genuine spelling differences do.
      const normalizeParallel = (s) =>
        String(s || "").toLowerCase().replace(/[-_\s]+/g, "-").replace(/^-|-$/g, "");
      const changed =
        newCardNumber !== oldCardNumber ||
        normalizeParallel(newParallel) !== normalizeParallel(oldParallel) ||
        newIsAuto !== oldIsAuto;
      if (!changed) {
        stats.unchanged++;
        continue;
      }
      stats.identityMismatched++;
      if (stats.samples.length < 12) {
        stats.samples.push({
          id: row.id,
          title: String(row.title || "").slice(0, 90),
          from: { cardNumber: row.cardNumber, parallel: row.parallel, isAuto: row.isAuto },
          to: { cardNumber: newCardNumber, parallel: newParallel, isAuto: newIsAuto },
        });
      }
      if (!APPLY) continue;
      workQueue.push({ row, parsed, newCardNumber, newParallel, newIsAuto });
    }
  }

  console.log(`\n=== Scan summary ===`);
  console.log(`  scanned:              ${stats.scanned}`);
  console.log(`  unchanged (skipped):  ${stats.unchanged}`);
  console.log(`  unparseable title:    ${stats.unparseable}`);
  console.log(`  identity mismatched:  ${stats.identityMismatched}`);

  if (stats.samples.length > 0) {
    console.log(`\n=== Sample mismatches (first ${stats.samples.length}) ===`);
    for (const s of stats.samples) {
      console.log(`  [${s.id.slice(0, 40)}...]`);
      console.log(`    title:  "${s.title}"`);
      console.log(`    from:   ${s.from.cardNumber} / ${s.from.parallel} / auto=${s.from.isAuto}`);
      console.log(`    to:     ${s.to.cardNumber} / ${s.to.parallel} / auto=${s.to.isAuto}`);
    }
  }

  if (scanStoppedAtBudget) {
    console.log(`\n  the scan was CUT SHORT by the budget: ${stats.scanned} rows were read, which is`
      + ` NOT the whole population. The counts above cover only those.`);
  }

  if (!APPLY) {
    console.log(`\n[dry-run] no writes. Re-run with BACKFILL_APPLY=true to apply.`);
    if (scanStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `the scan is UNFINISHED; the relaunch continues from here`);
    }
    return { client, budget: CLOCK };
  }

  // -- THE WRITE PHASE IS GATED ON THE CLOCK, NOT REFUSED ------------------
  //
  // See THE CLOCK above for why a partial scan is safe to write from here (each
  // row's answer comes from its own title). What is NOT safe is STARTING the
  // rewrite train past expiry: that is #1947's "one more unit" defect at phase
  // granularity, so entry is gated.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the scan consumed it; ${workQueue.length} rewrites were NOT STARTED and the relaunch`
      + ` continues from here`);
    console.log("  nothing was written. The next pass re-derives this same queue -- the comparison"
      + " is against stored fields, so an unwritten row still mismatches -- and spends its clock"
      + " on the rewrites.");
    return { client, budget: CLOCK };
  }

  console.log(`\n=== Applying ${workQueue.length} rewrites (concurrency ${CONCURRENCY}) ===`);

  // Worker pool
  let idx = 0;
  let writeStoppedAtBudget = false;
  let notReached = 0;
  const worker = async () => {
    while (idx < workQueue.length) {
      // THE PRE-CHECK, inside the worker so it governs the RUN and not one
      // item: a worker that finds the clock gone stops taking work instead of
      // draining the whole remaining queue past expiry. The remainder is
      // counted, not silently dropped -- the population is KNOWN here, so
      // `not reached` is a real number.
      if (CLOCK.outOfClock()) {
        writeStoppedAtBudget = true;
        notReached += workQueue.length - idx;
        idx = workQueue.length;
        return;
      }
      const my = idx++;
      const { row, parsed, newCardNumber, newParallel, newIsAuto } = workQueue[my];
      stats.rewriteQueued++;
      try {
        // Recompute slug + contentHash with the new identity.
        // hobbyIqCardId inputs: sport, year, setKey, cardNumber,
        // parallel, isAuto, printRun. We keep sport/year/setKey from
        // the stored row (title parsing doesn't derive them here —
        // the ingest path already inferred setKey from the FULL title
        // context, and year is server-supplied).
        const setKey = deriveSetKeyFromSlug(row.hobbyiqCardId) || null;
        const newSlug = computeHobbyIqCardId({
          sport: row.sport ?? "baseball",
          year: row.cardYear,
          setKey,
          cardNumber: newCardNumber,
          parallel: newParallel,
          isAuto: newIsAuto,
          printRun: parsed.printRun ?? null,
        });
        const newContentHash = createHash("sha256").update(
          `${newSlug}|${Number(row.price).toFixed(2)}|${String(row.soldAt).slice(0, 10)}|${row.source}|${row.url ?? ""}`,
        ).digest("hex").slice(0, 32);

        // Read the CURRENT full doc (fields not in the SELECT above),
        // then write it back with the updated identity fields.
        // CF-BACKFILL-429-RETRY (Drew, 2026-07-31). First apply run
        // hit 4,374 Cosmos 429s at concurrency 32. Wrap read+write in
        // exponential-backoff retry so throttled rows still land on
        // this pass rather than needing another whole re-run.
        const withRetry = async (op) => {
          let attempt = 0;
          while (true) {
            try {
              return await op();
            } catch (e) {
              const is429 = String((e && e.message) || "").includes("request rate is too large");
              if (!is429 || attempt >= 4) throw e;
              const backoffMs = 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
              await new Promise((r) => setTimeout(r, backoffMs));
              attempt++;
            }
          }
        };
        const { resource: full } = await withRetry(() => sc.item(row.id, row.cardId).read());
        if (!full) {
          stats.rewriteErr++;
          continue;
        }
        full.cardNumber = newCardNumber;
        full.parallel = newParallel;
        full.isAuto = newIsAuto;
        full.hobbyiqCardId = newSlug;
        full.contentHash = newContentHash;
        // Marker for retrospective audit — which rows this backfill touched.
        full.__migratedByBackfill = "CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY-20260731";
        await withRetry(() => sc.item(row.id, row.cardId).replace(full));
        stats.rewriteOk++;
        if (stats.rewriteOk % 50 === 0) {
          console.log(`  ...${stats.rewriteOk} rewrites applied`);
        }
      } catch (err) {
        stats.rewriteErr++;
        console.warn(`  ERR row ${row.id}: ${(err && err.message) || err}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n=== Apply summary ===`);
  console.log(`  queued:  ${stats.rewriteQueued}`);
  console.log(`  ok:      ${stats.rewriteOk}`);
  console.log(`  errors:  ${stats.rewriteErr}`);
  console.log(`  not reached: ${notReached}`);

  // RECONCILE OVER THE KNOWN QUEUE. workQueue was built before the first write,
  // so the population is known and `not reached` is a real number rather than an
  // invention (#1947: the two reconciliation shapes are not interchangeable).
  console.log(`  reconciled: intended ${workQueue.length} = written ${stats.rewriteOk}`
    + ` + failed ${stats.rewriteErr} + not reached ${notReached}`);
  if (stats.rewriteOk + stats.rewriteErr + notReached !== workQueue.length) {
    console.error("  !! RECONCILE MISMATCH -- a queued rewrite was neither written, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "backfill-cardsight-title-identity",
    intended: workQueue.length, written: stats.rewriteOk,
    skipped: notReached, failed: stats.rewriteErr,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (writeStoppedAtBudget || scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the rewrite is IDEMPOTENT, as this lane's own docblock states: a row whose stored"
      + " identity now matches its parsed identity re-reads as `unchanged` and is never queued"
      + " again, so the continuation re-walks cheaply and rewrites only what is left.");
  }

  return { client, budget: CLOCK };
}

// Given a slug like "hiq:baseball:2026:bowman-chrome:cpa-eha:blue-refractor:auto",
// return the setKey segment ("bowman-chrome"). Returns null when slug
// is malformed. Used to preserve setKey through the rewrite.
function deriveSetKeyFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.split(":");
  // hiq : sport : year : setKey : cardNumber : parallel : autoFlag [: num-N]
  if (parts.length < 7 || parts[0] !== "hiq") return null;
  return parts[3] || null;
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
