#!/usr/bin/env node
// CF-BULK-IMPORT-CH-DAILY-TO-SOLD-COMPS (Drew, 2026-07-30). Sold_comps
// is currently seeded ONLY via user queries — CH-daily bulk historical
// data enters sold_comps just for cards a user has looked up. This
// leaves the FMV comp pool thin for long-tail cards + graded tiers
// nobody has queried yet. Proactive: iterate ch_daily_sales rows and
// upsert into sold_comps preserving vendor-canonical grader/grade.
//
// recordSoldComp handles the identity + dedup work:
//   - contentHash dedup (existing rows with same hash are skipped)
//   - hobbyiqCardId slug computation
//   - composite emission (per Phase 3+4)
//   - cross-source canonical scoring
//
// Idempotent: safe to re-run. Dedup by contentHash ensures no dupes.
//
// Resumable: checkpoint on sale_date + price_history_id so multi-day
// bulk drains via self-relaunch continue from where the last run left.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=8       — parallel recordSoldComp calls
//   BULK_START_DATE=2026-07-30   — process rows with sale_date <= this
//   BULK_END_DATE=2018-01-01     — stop at this date
//   BULK_SPORT_FILTER=baseball   — comma-separated; default all sports
//   BULK_LIMIT=500000            — rows per iteration (cap)
//   BULK_SLICE_DAYS=7            — how many days per query (RU budget)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { recordSoldComp } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
// D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). This script keeps its OWN copy of the
// CH mapping -- the copy that wrote ~4.2M of the current sold_comps rows -- so
// the guard has to be applied here too. Applying it only in
// chRowToSoldComp.ts would leave the biggest writer of the defect untouched.
const { judgeCardNumber, logCardNumberVerdict } = require(path.join(backend, "dist/services/portfolioiq/cardNumberIntegrity.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BULK_LIMIT || "500000");
const SLICE_DAYS = Number(process.env.BULK_SLICE_DAYS || "7");
const START_DATE = process.env.BULK_START_DATE || new Date().toISOString().slice(0, 10);
const END_DATE = process.env.BULK_END_DATE || "2018-01-01";
// CF-CH-FANOUT-TIME-BUDGET (2026-08-22). Stop cleanly before the workflow
// timeout instead of being killed by it.
//
// The scheduled run passes no BULK_END_DATE, so it took the 2018-01-01
// default and walked EIGHT YEARS of dates every night - while the workflow
// header documented "Default: 30-day slice ending yesterday". As sold_comps
// grew, that walk crossed the job timeout-minutes: 340 and the run was
// cancelled at 5h41m on 2026-08-19, -20 and -21, three nights running.
//
// A cancelled job prints no summary, so it looked like "CH fan-out is
// broken" rather than "the window is too wide". Budget in MINUTES, set
// below the workflow timeout, so the run always reports where it reached
// and which window to resume from.
//
// -- WHAT THE LOCAL BUDGET ABOVE COULD NOT DO, AND WHY THE SHARED ONE REPLACES
// -- IT (the #1944 ratchet, wave 4) --------------------------------------------
//
// The reasoning above is right and the mechanism was wrong in three ways that
// only bite on the RUNNER, which is where this lane is dispatched from the
// `script` dropdown as well as from ch-fanout-to-sold-comps.yml.
//
//   1. IT DEFAULTED TO OFF. `Number(env || "0") || 0` is zero unless the caller
//      supplies a number, and the guard below reads `TIME_BUDGET_MIN > 0`. The
//      cron sets 300; the RUNNER sets NOTHING. So every dispatch from the
//      dropdown ran this eight-year-capable walk with NO CLOCK AT ALL and could
//      only ever end by being KILLED at the 150-minute ceiling.
//
//   2. ITS MARKER WAS NOT THE MARKER. It printed "TIME BUDGET REACHED (300m)".
//      The runner greps `stopped at the .*budget` (CF-RELAUNCH-ONLY-ON-BUDGET,
//      #1361) and nothing else, so even the CRON's budgeted stop was invisible
//      to every relaunch gate: the lane announced exactly which window to
//      resume from, and no step read it.
//
//   3. IT RESERVED NOTHING. The check sat AFTER a whole slice had been fetched
//      and drained -- BULK_SLICE_DAYS(14) of ch_daily_sales through a
//      CONCURRENCY-wide window of recordSoldComp calls. Stopping after a unit
//      is what #1799 fixed; it grants one whole slice of unbounded size past
//      expiry.
//
// So the shared clock takes over, and BULK_TIME_BUDGET_MIN keeps working as an
// override for the cron that already sets it.
//
// >>> A PARTIAL RUN HERE IS SHORTER, NOT WRONG, so this lane does not refuse.
//
// Nothing is derived across slices. Each row becomes one recordSoldComp call
// decided from that row's own CH fields, and dedup is by contentHash inside
// the store, so a re-read costs a hash comparison and writes nothing. The walk
// is strictly backwards through dates, so the resume point is a single date --
// which the summary already prints as `next start date`.
//
// THE UNIT IS ONE SLICE: BULK_SLICE_DAYS(14) of dates fetched at maxItemCount
// 500 and drained through a CONCURRENCY-wide (default 8) window of
// recordSoldComp calls, each of which computes a slug, a composite and a
// cross-source canonical score. On the widest historical slices that is tens of
// thousands of rows, so the reserve is FIVE MINUTES -- by far the largest in
// the ratchet, and sized to the unit rather than to a house style.
//
// VERIFY_MS is nominal: this lane reads nothing after its loop.
// Worst case 110 + 5 + 1 + 1 + 1 = 118m under the runner's 150m ceiling, and
// the cron's own 300 override still sits under its 340m job.
//
// THE DEFAULT IS A SOURCE LITERAL, and the legacy override is folded into the
// ENV rather than into the expression. runnerBudgetMargin.test.ts computes this
// lane's worst case by READING the default out of the source, so a
// `Number(process.env.RUN_MINUTES || SOMETHING_ELSE || 110)` chain is not a
// budget the pin can size -- it falls through every known spelling and lands on
// whatever integer it finds next, which here was the `timeout-minutes: 340`
// quoted in the prose fifty lines above. A budget nobody can compute the margin
// of is the thing this whole file exists to prevent, so the compatibility shim
// happens BEFORE the declaration and the declaration stays canonical.
const TIME_BUDGET_MIN = Number(process.env.BULK_TIME_BUDGET_MIN || "0") || 0;
// ch-fanout-to-sold-comps.yml still sets BULK_TIME_BUDGET_MIN=300 under its
// 340-minute job. Honour it by seeding RUN_MINUTES, so that workflow keeps
// working unchanged and every reader of RUN_MINUTES sees one number.
if (TIME_BUDGET_MIN > 0 && !process.env.RUN_MINUTES) {
  process.env.RUN_MINUTES = String(TIME_BUDGET_MIN);
}
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 5 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });
let stoppedOnBudget = false;
const SPORT_FILTER = (process.env.BULK_SPORT_FILTER || "").trim();

// CF-THE-VENDOR-STATES-THE-VERTICAL (2026-09-07). This script used to carry
// its OWN copy of normSport, and the copy is how a fix reaches one ingest lane
// and not the other: the shared mapper learned `pokemon` and this literal
// would have gone on returning null for 1,525,994 rows. Imported from the one
// implementation instead, so the two lanes cannot disagree about what
// CardHedge's `group` field means. Same require root as recordSoldComp above.
const { normSport } = require(path.join(backend, "dist/services/portfolioiq/chRowToSoldComp.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

function normGrader(grader) {
  const g = String(grader || "").trim().toUpperCase();
  if (!g || g === "RAW" || g === "UNGRADED") return null;
  if (["PSA", "BGS", "SGC", "CGC", "BVG"].includes(g)) return g;
  return null;
}

function parseGrade(gradeStr) {
  if (!gradeStr || String(gradeStr).trim().toLowerCase() === "raw") return null;
  const n = parseFloat(String(gradeStr).trim());
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : null;
}

function inferIsAutoFromCH(row) {
  // Look for auto tokens in variant OR description
  const combined = `${row.variant || ""} ${row.description || ""}`.toLowerCase();
  if (/\bauto(graph)?\b/.test(combined)) return true;
  if (/\bautographed\b/.test(combined)) return true;
  // Check cardNumber for known auto prefixes (from curated list)
  const num = String(row.number || "").toUpperCase();
  const AUTO_PREFIXES = /^(CPA|BCPA|BCDA|BDPA|BDA|BPA|CPALD|CPATWH|APDCA|54FAV|FFDA|CUSA|SCCA|CCAR|RODA|ROTA|TTAR|DPPA|BSPA|BCRA|TCRA|B96A|BGA|MRA|UAC|BSA|FSA|CDA|CRA|CBA|CCA|USA|DAS|NTS|SSM|DCA|CAA|GQA|AGA|ROA|FAR|FFA|BOA|T1A|SCA|PPA|ODA|IAP|UAR|BA|PA|RA|FA|TA|AA|AP|WT)-/;
  if (AUTO_PREFIXES.test(num)) return true;
  return false;
}

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]  `);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const chContainer = client.database("hobbyiq").container("ch_daily_sales");

  console.log(`[bulk-import-ch-daily-to-sold-comps]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  slice days: ${SLICE_DAYS}`);
  console.log(`  start date (newest, walk backward): ${START_DATE}`);
  console.log(`  end date (stop): ${END_DATE}`);
  console.log(`  sport filter: ${SPORT_FILTER || "(all)"}`);
  console.log(`  ${CLOCK.describe()}\n`);

  const sportFilters = SPORT_FILTER
    ? SPORT_FILTER.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  let processed = 0;
  let emitted = 0;      // recordSoldComp succeeded (may be no-op via dedup)
  let skippedRaw = 0;   // no grade info at all (still emit but flag)
  let skippedNoPrice = 0;
  let skippedNoPlayer = 0;
  let skippedSport = 0;
  // D28: the title overrode CardHedge's number, and the number CH gave that
  // the title showed to be a grade / print run / year / ordinal / lot.
  let cardNumberVendorDisagreed = 0;
  let cardNumberRefused = 0;
  // The reconciliation's own two counters. `emitted` is reused as the written
  // count, and these give it the denominator and the failure column it never
  // had -- before this the summary printed `emitted to sold_comps` alone, with
  // nothing to compare it against.
  let intendedWrites = 0;
  let failedWrites = 0;
  const graderDist = {};
  const yearDist = {};

  let currentEnd = START_DATE;
  let currentStart = addDays(currentEnd, -SLICE_DAYS);

  while (processed < LIMIT && currentEnd > END_DATE) {
    // THE PRE-CHECK, before the slice is fetched rather than after its rows
    // have been fetched AND drained through recordSoldComp. That ordering is
    // the whole point (#1799): a slice costing more than the reserve is stopped
    // BEFORE it starts, so the run always ends on the clean date boundary the
    // summary reports as `next start date`.
    if (CLOCK.outOfClock()) { stoppedOnBudget = true; break; }
    // Clamp start to END_DATE
    if (currentStart < END_DATE) currentStart = END_DATE;
    console.log(`\n  Slice ${currentStart} → ${currentEnd}`);

    const params = [
      { name: "@from", value: currentStart },
      { name: "@to", value: currentEnd },
    ];
    let sportClause = "";
    if (sportFilters && sportFilters.length > 0) {
      const chGroupNames = sportFilters.map(s =>
        s === "baseball" ? "Baseball"
        : s === "basketball" ? "Basketball"
        : s === "football" ? "Football"
        : s === "hockey" ? "Hockey"
        : s === "soccer" ? "Soccer"
        : s);
      const inClause = chGroupNames.map((_, i) => `@sp${i}`).join(", ");
      sportClause = ` AND c["group"] IN (${inClause})`;
      chGroupNames.forEach((g, i) => params.push({ name: `@sp${i}`, value: g }));
    }

    const query = `
      SELECT c.price_history_id, c.source, c.description, c.price, c.image_url,
             c.sale_date, c.card_id, c.card_description, c.number, c.player,
             c.grade, c.grader, c["group"], c.card_set, c.card_set_type,
             c.variant, c.year
      FROM c
      WHERE c.sale_date >= @from AND c.sale_date < @to ${sportClause}
        AND IS_STRING(c.card_id) AND c.price > 0
      ORDER BY c.sale_date DESC
    `;

    const it = chContainer.items.query({ query, parameters: params }, { maxItemCount: 500 });
    const slice = [];
    while (it.hasMoreResults() && slice.length + processed < LIMIT) {
      const page = await fetchWithRetry(it);
      if (page && Array.isArray(page.resources)) slice.push(...page.resources);
      process.stdout.write(`\r    fetched ${slice.length}`);
    }
    console.log(`\r    ${slice.length} rows in slice.                     `);

    if (slice.length === 0) {
      // Advance the window
      currentEnd = currentStart;
      currentStart = addDays(currentEnd, -SLICE_DAYS);
      continue;
    }

    // Build the writes
    const writes = [];
    for (const row of slice) {
      processed++;
      const sport = normSport(row["group"]);
      if (sportFilters && sportFilters.length > 0 && (!sport || !sportFilters.includes(sport))) {
        skippedSport++;
        continue;
      }
      const player = String(row.player || "").trim();
      if (!player) { skippedNoPlayer++; continue; }
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) { skippedNoPrice++; continue; }

      const gradeCompany = normGrader(row.grader);
      const gradeValue = parseGrade(row.grade);
      if (!gradeCompany) skippedRaw++;

      if (gradeCompany) {
        graderDist[gradeCompany] = (graderDist[gradeCompany] ?? 0) + 1;
      }
      if (row.year) yearDist[row.year] = (yearDist[row.year] ?? 0) + 1;

      // D28: CardHedge's `number` is their PRODUCT's number and their
      // `description` is the source listing's title line. When the title
      // states an explicit "#X" it wins; when it shows the number to be a
      // grade / print run / year / ordinal / lot, the number is refused.
      const chTitle = row.description || row.card_description || null;
      const numberVerdict = judgeCardNumber(row.number ?? null, chTitle);
      if (numberVerdict.vendorDisagrees) cardNumberVendorDisagreed++;
      if (numberVerdict.rejected) cardNumberRefused++;
      logCardNumberVerdict("ch-daily-bulk", numberVerdict, { candidate: row.number ?? null, title: chTitle, cardId: String(row.card_id).trim() });

      writes.push({
        cardId: String(row.card_id).trim(),
        playerName: player,
        cardYear: Number.isFinite(Number(row.year)) ? Number(row.year) : null,
        setName: row.card_set || row.card_set_type || null,
        parallel: row.variant || "Base",
        cardNumber: numberVerdict.cardNumber,
        isAuto: inferIsAutoFromCH(row),
        sport,
        gradeCompany,
        gradeValue,
        price,
        soldAt: row.sale_date,
        source: "cardhedge",
        sourceExternalId: `ch-daily::${row.price_history_id}`,
        contributorUserId: null,
        title: chTitle,
        imageUrl: row.image_url || null,
        sellerHandle: null,
        verifiedByUser: false,
        confidence: 0.9,   // CH-daily is authoritative for sale existence
      });
    }

    console.log(`    writes prepared: ${writes.length.toLocaleString()}`);

    if (!APPLY) {
      // Advance window and continue for full survey
      emitted += writes.length;
      currentEnd = currentStart;
      currentStart = addDays(currentEnd, -SLICE_DAYS);
      continue;
    }

    // Actually apply
    console.log(`    applying at concurrency ${CONCURRENCY}...`);
    const t0 = Date.now();
    // A REAL success counter: incremented AFTER recordSoldComp resolves, not by
    // runInParallel's `ok`, which counts a worker callback that did not throw.
    let landed = 0;
    const { err } = await runInParallel(writes, async (w) => {
      await recordSoldComp(w);
      landed++;
      if (landed % 500 === 0) {
        process.stdout.write(`\r      ${landed}/${writes.length}`);
      }
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\r      ${landed}/${writes.length} in ${secs}s (landed=${landed} err=${err})`);
    emitted += landed;
    intendedWrites += writes.length;
    failedWrites += err;

    // Advance the window
    currentEnd = currentStart;
    currentStart = addDays(currentEnd, -SLICE_DAYS);

    // The BETWEEN-slices stop now lives at the TOP of this loop as a PRE-check,
    // which is the same clean date boundary reached one slice earlier -- see
    // THE PRE-CHECK above and #1799.
  }

  console.log(`\n════════════════ SUMMARY ════════════════`);
  // Never let a budgeted stop read as a finished walk.
  if (stoppedOnBudget) {
    console.log(`  !! STOPPED ON THE BUDGET - this run did NOT reach ${END_DATE}.`);
  }
  console.log(`  rows processed:          ${processed.toLocaleString()}`);
  console.log(`  emitted to sold_comps:   ${emitted.toLocaleString()} ${APPLY ? "" : "(dry-run count)"}`);
  console.log(`  skipped (raw grade):     ${skippedRaw.toLocaleString()} (still emitted with null grade)`);
  console.log(`  skipped (no player):     ${skippedNoPlayer.toLocaleString()}`);
  console.log(`  card number: title overrode CH  ${cardNumberVendorDisagreed.toLocaleString()}   <- D28, card_number_vendor_disagrees`);
  console.log(`  card number: refused (grade / print run / year / ordinal / lot)  ${cardNumberRefused.toLocaleString()}`);
  console.log(`  skipped (no price):      ${skippedNoPrice.toLocaleString()}`);
  console.log(`  skipped (sport filter):  ${skippedSport.toLocaleString()}`);
  console.log(`  next start date:         ${currentEnd}`);
  console.log(`\n  Grader distribution (of graded emits):`);
  Object.entries(graderDist).sort((a,b) => b[1] - a[1]).forEach(([g, c]) => {
    console.log(`    ${String(c).padStart(8).toLocaleString()}  ${g}`);
  });
  console.log(`\n  Year distribution (top 15):`);
  Object.entries(yearDist).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([y, c]) => {
    console.log(`    ${String(c).padStart(8).toLocaleString()}  ${y}`);
  });

  // RECONCILE OVER THE WRITES THIS RUN PREPARED. `intended` accumulates the
  // per-slice `writes.length` -- the rows that survived every filter and were
  // handed to recordSoldComp -- so the identity holds whether the walk reached
  // END_DATE or the budget stopped it at a slice boundary. The filtered-out
  // rows (no player, no price, sport filter) are NOT in it: they were never
  // intended writes, and folding them in would make the banner describe the
  // scan rather than the writes (a slice is not a sibling counter).
  if (APPLY) {
    console.log(`  reconciled: intended ${intendedWrites.toLocaleString()} = written ${emitted.toLocaleString()} + failed ${failedWrites.toLocaleString()}`);
    if (emitted + failedWrites !== intendedWrites) {
      console.error("  !! RECONCILE MISMATCH -- a prepared write was neither recorded nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "bulk-import-ch-daily-to-sold-comps",
      intended: intendedWrites, written: emitted, skipped: 0, failed: failedWrites,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables. This REPLACES "TIME BUDGET REACHED (300m)", which no gate in
  // this repository has ever matched -- the lane named its own resume date and
  // nothing read it. See THE CLOCK above.
  if (stoppedOnBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the walk did NOT reach ${END_DATE}; the relaunch continues from here`);
    console.log(`  resume from BULK_START_DATE=${currentEnd} to continue backwards. The`
      + ` continuation is free to re-read the overlap: recordSoldComp dedups by contentHash,`
      + ` so a row already imported costs a hash comparison and writes nothing.`);
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
