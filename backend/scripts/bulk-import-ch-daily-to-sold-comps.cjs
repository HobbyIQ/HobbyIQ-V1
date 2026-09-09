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
//   BULK_SLICE_DAYS=1            — days per unit. ONE for the nightly/manual
//                                  walk; only the explicit historical bulk
//                                  mode widens it. See THE UNIT below.

const path = require("path");
const backend = __dirname + "/..";

// CF-THE-MODULE-MUST-BE-EVALUABLE-WITHOUT-A-BUILD (2026-09-08). Everything this
// lane needs out of dist/ is used inside main() and nowhere else, so the
// requires are DEFERRED into loadDist(). Two things follow, and the second is
// the reason:
//
//  1. `node scripts/...` behaves exactly as before -- main() calls loadDist()
//     as its first statement, so a genuinely missing build still fails loudly
//     and at the same point in the run.
//  2. runnerBudgetTdz.test.ts can EVALUATE this module's whole top level under
//     BUDGET_DRY_PARSE=1 without `npm run build` first. That matters because
//     the defect this file just carried -- a `const budget` required BELOW its
//     own first use -- is a TemporalDeadZone error, and `node --check` parses a
//     TDZ clean. Only evaluation catches it. If the dist/ requires stayed at
//     the top the test would die on MODULE_NOT_FOUND before ever reaching the
//     budget block, and would have passed against the broken file.
let CosmosClient, recordSoldComp, getEmitFailureCount, judgeCardNumber, logCardNumberVerdict, normSport, reportWrites;
function loadDist() {
  ({ CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos")));
  // CF-A-SWALLOWED-429-IS-NOT-A-WRITE (2026-09-08). `getEmitFailureCount` comes
  // from the same module as recordSoldComp, and it is how this lane learns
  // about a write that did not happen. See THE 429 COLUMN below.
  ({ recordSoldComp, getEmitFailureCount } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js")));
  // D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). This script keeps its OWN copy of the
  // CH mapping -- the copy that wrote ~4.2M of the current sold_comps rows -- so
  // the guard has to be applied here too. Applying it only in
  // chRowToSoldComp.ts would leave the biggest writer of the defect untouched.
  ({ judgeCardNumber, logCardNumberVerdict } = require(path.join(backend, "dist/services/portfolioiq/cardNumberIntegrity.js")));
  // CF-THE-VENDOR-STATES-THE-VERTICAL (2026-09-07). This script used to carry
  // its OWN copy of normSport, and the copy is how a fix reaches one ingest lane
  // and not the other: the shared mapper learned `pokemon` and this literal
  // would have gone on returning null for 1,525,994 rows. Imported from the one
  // implementation instead, so the two lanes cannot disagree about what
  // CardHedge's `group` field means. Same require root as recordSoldComp above.
  ({ normSport } = require(path.join(backend, "dist/services/portfolioiq/chRowToSoldComp.js")));
  ({ reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js")));
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BULK_LIMIT || "500000");
// CF-THE-UNIT-IS-ONE-DAY (2026-09-08). ONE, not seven and not fourteen. Run
// 34234951079 is what a unit wider than the window costs: dispatched with the
// defaults, BULK_SLICE_DAYS=14 spanned the whole 10-day window, so the entire
// walk was a SINGLE unit and the budget loop -- whose only seam is BETWEEN
// units -- had nowhere to stop. It ran 5h39m and was cancelled by the job's
// 340-minute timeout with no finishLane, no budget marker and no reconcile.
// See THE UNIT AND THE RESERVE below for the measurement.
const SLICE_DAYS = Number(process.env.BULK_SLICE_DAYS || "1");
// The largest number of rows handed to recordSoldComp between two clock
// checks. A day is the RESUME unit; this is the BUDGET unit inside it, because
// a whole day is far too big to reserve for -- see THE UNIT AND THE RESERVE.
const WRITE_BATCH = Number(process.env.BULK_WRITE_BATCH || "1000");
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
// -- THE UNIT AND THE RESERVE, MEASURED (2026-09-08) ---------------------------
//
// The reserve above used to read "THE UNIT IS ONE SLICE: BULK_SLICE_DAYS(14) of
// dates ... so the reserve is FIVE MINUTES". Both halves were wrong, and run
// 34234951079 measured by how much.
//
// THE DEFECT. The nightly window is NIGHTLY_WINDOW_DAYS(10) and the slice was
// FOURTEEN. A slice wider than the window makes the whole walk ONE unit, and
// `outOfClock()` is a BETWEEN-units pre-check by contract -- so there was no
// second unit at which it could ever fire. The run printed `slice days: 14`,
// `budget 300m loop + 5m unit reserve`, opened `Slice 2026-08-29 -> 2026-09-08`
// and never reached another clock check. It was cancelled at 19:36Z, 5h39m in,
// by the job's own timeout-minutes: 340. No finishLane, no budget marker, no
// reconcile -- exactly the killed-job silence the whole budget exists to
// prevent, arrived at through the budget's own blind spot.
//
// THE MEASUREMENT, from that run's log:
//
//   267,603 rows for the 10-day window at the default sport filter
//   267,561 writes prepared; 179,500 landed in 337.5 minutes before the kill
//   => 8.86 rows/s sustained at CONCURRENCY 8 (8.3-9.0 over every 10/30/60
//      minute window sampled, so this is a rate, not a warm-up artefact)
//   => ~26,760 filtered rows/day  ->  ~50 MINUTES to drain ONE day
//   => ch_daily_sales holds 75-100k rows/day unfiltered -> up to ~188 MINUTES
//
// So A DAY CANNOT BE THE RESERVE. Fifty to a hundred and eighty minutes does
// not fit under the runner's 150-minute step at all, and sizing the reserve to
// a day would fail the margin pin by construction rather than by accident.
//
// THE TWO UNITS. The DAY is the RESUME unit: the walk is strictly backwards by
// date, newest first, and `next start date` names a date, so a stop between
// days is the only stop the relaunch can express. The WRITE BATCH --
// WRITE_BATCH(1000) rows -- is the BUDGET unit inside it, with an
// `outOfClock()` pre-check before each batch. At the measured 8.86 rows/s a
// batch is ~1.9 minutes, and the largest work committed past a pre-check is
// one batch plus one day's fetch (~30s even for a 100k-row unfiltered day).
//
// THE RESERVE IS THEREFORE FOUR MINUTES: 1.9 for the batch in flight, ~0.5 for
// the fetch, and the rest as headroom for a slower runner or a 429 backoff. It
// is sized to what a pre-check actually commits, which is the only quantity a
// reserve has ever meant.
//
// A WITHIN-DAY STOP IS SAFE, and this is why the batch may be the budget unit
// while the day stays the resume unit. Nothing is derived across rows; each row
// becomes one recordSoldComp call decided from its own CH fields; dedup is by
// contentHash inside the store. So resuming at the START of a partially-drained
// day re-reads the rows already imported and writes nothing for them. The
// marker names that day, and the overlap costs a hash comparison.
//
// VERIFY_MS is nominal: this lane reads nothing after its loop.
// Worst case 110 + 4 + 1 + 1 = 116m under the runner's 150m ceiling, and the
// cron's own 300 override still sits under its 340m job -- with the difference
// that the 300 can now actually be OBSERVED, because there is a clock check
// every ~1000 rows instead of one per fourteen-day slice.
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
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
//
// CF-A-CONST-IS-NOT-A-HOISTED-FUNCTION (2026-09-08). This require used to sit
// FOURTEEN LINES BELOW the `const CLOCK = budget(...)` call that needs it. A
// `const` binding is in its temporal dead zone until its own line evaluates, so
// the very first statement of this lane threw
//
//   ReferenceError: Cannot access 'budget' before initialization
//
// and the cron died at module load every night from 2026-09-06 -- long before
// any banner, budget marker or `finishLane` could say so. Run 34200832460 read
// as a plain red X. sold_comps took 42k cardhedge rows for sold-day 09-07 and 4
// for 09-08 against a normal 75-90k/day.
//
// It is ABOVE the budget constants deliberately: everything below this line may
// call `budget()`, and nothing above it does. Moving it back down restores the
// crash, which is why runnerBudgetTdz.test.ts EVALUATES this module rather than
// only parsing it -- `node --check` is clean on a TDZ.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const TIME_BUDGET_MIN = Number(process.env.BULK_TIME_BUDGET_MIN || "0") || 0;
// ch-fanout-to-sold-comps.yml still sets BULK_TIME_BUDGET_MIN=300 under its
// 340-minute job. Honour it by seeding RUN_MINUTES, so that workflow keeps
// working unchanged and every reader of RUN_MINUTES sees one number.
if (TIME_BUDGET_MIN > 0 && !process.env.RUN_MINUTES) {
  process.env.RUN_MINUTES = String(TIME_BUDGET_MIN);
}
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 4 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// CF-A-CONST-IS-NOT-A-HOISTED-FUNCTION, the CI half. Under BUDGET_DRY_PARSE the
// process stops HERE: the whole top level above has been evaluated -- including
// the `budget()` call one line up, which is the statement that threw for three
// nights -- and nothing below it runs, so no Cosmos client is constructed and
// no row is read or written. Exit 0 means "this lane's module scope is sound".
// A TDZ, a typo'd require path or a throwing constant all exit non-zero instead.
if (process.env.BUDGET_DRY_PARSE === "1") {
  console.log(`dry-parse OK: ${path.basename(__filename)} RUN_MINUTES=${CLOCK.RUN_MINUTES}`);
  process.exit(0);
}

let stoppedOnBudget = false;
// ── THE WRITE LEDGER LIVES AT MODULE SCOPE ────────────────────────────────
//
// CF-EVERY-PATH-RECONCILES (2026-09-08). These three used to be locals in
// main(), so a throw anywhere in the walk took the only copy of them with it:
// the catch printed a stack and called finishLane, and the run said nothing
// about the writes it had already made. A partial run's ledger is exactly the
// thing an operator needs after a crash. `reportLedger()` below is called on
// the normal path AND from the catch, so no exit prints a bare stack.
let emitted = 0;         // recordSoldComp resolved without throwing
let intendedWrites = 0;  // rows actually handed to recordSoldComp
let failedWrites = 0;    // threw in the worker, or threw inside recordSoldComp
let currentEnd = null;   // the resume date, whatever ended the walk
const SPORT_FILTER = (process.env.BULK_SPORT_FILTER || "").trim();


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

/**
 * THE RECONCILE AND THE MARKER, ON EVERY PATH.
 *
 * CF-EVERY-PATH-RECONCILES (2026-09-08). Run 34234951079 ended with none of
 * this -- no reconcile, no marker, no finishLane -- because the job timeout
 * killed it mid-unit. The unit is now bounded (THE UNIT AND THE RESERVE), so
 * the budget path reaches here; and this function is called from the catch as
 * well, so a THROW reaches it too. Idempotent: `reported` makes a
 * double-call (normal return, then a throw in finishLane) print once.
 */
let reported = false;
function reportLedger() {
  if (reported) return;
  reported = true;

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
  //
  // `currentEnd` is the day the walk stopped ON, not the day after it: a
  // mid-day budget stop leaves it pointing at the partially-drained day so the
  // relaunch redoes that day. The overlap is free (contentHash dedup).
  if (stoppedOnBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the walk did NOT reach ${END_DATE}; the relaunch continues from here`);
    console.log(`  resume from BULK_START_DATE=${currentEnd} to continue backwards. The`
      + ` continuation is free to re-read the overlap: recordSoldComp dedups by contentHash,`
      + ` so a row already imported costs a hash comparison and writes nothing.`);
  }
}

async function main() {
  // The deferred dist/ + Cosmos requires, resolved before anything uses them.
  // A missing build still fails here, loudly, exactly as it did when these were
  // top-level requires -- only the LINE moved, never the requirement.
  loadDist();
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
  // emitted / intendedWrites / failedWrites are MODULE-scope now (the write
  // ledger, above) so the crash path can reconcile them too.
  let skippedRaw = 0;   // no grade info at all (still emit but flag)
  let skippedNoPrice = 0;
  let skippedNoPlayer = 0;
  let skippedSport = 0;
  // D28: the title overrode CardHedge's number, and the number CH gave that
  // the title showed to be a grade / print run / year / ordinal / lot.
  let cardNumberVendorDisagreed = 0;
  let cardNumberRefused = 0;
  const graderDist = {};
  const yearDist = {};

  currentEnd = START_DATE;
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
    let batchStopped = false;
    // ── THE BUDGET UNIT IS THE BATCH, THE RESUME UNIT IS THE DAY ────────────
    //
    // The pre-check at the loop top can only fire between DAYS, and a day is
    // 50-188 minutes of writing (THE UNIT AND THE RESERVE above). A budget
    // whose finest seam is longer than the reserve is not a budget, which is
    // precisely how run 34234951079 ran 5h39m under a 300-minute clock. So the
    // clock is also checked BEFORE each batch of WRITE_BATCH rows -- still a
    // PRE-check, never a loop-top `Date.now() - t0 >` test.
    //
    // Stopping mid-day is safe and does not need a finer resume address: the
    // marker names THIS day, and re-reading the rows already drained costs a
    // contentHash comparison and writes nothing.
    for (let b = 0; b < writes.length; b += WRITE_BATCH) {
      if (CLOCK.outOfClock()) {
        batchStopped = true;
        stoppedOnBudget = true;
        console.log(`\r      ${landed}/${writes.length} - budget reached mid-day, stopping before the next batch`);
        break;
      }
      const batch = writes.slice(b, b + WRITE_BATCH);
      // The emit-failure counter is monotonic across the process, so the DELTA
      // across this batch is this batch's swallowed-write count.
      const failBefore = getEmitFailureCount();
      const { err } = await runInParallel(batch, async (w) => {
        await recordSoldComp(w);
        landed++;
        if (landed % 500 === 0) {
          process.stdout.write(`\r      ${landed}/${writes.length}`);
        }
      });
      // ── THE 429 COLUMN ────────────────────────────────────────────────────
      //
      // CF-A-SWALLOWED-429-IS-NOT-A-WRITE (2026-09-08). Run 34234951079 logged
      //
      //   {"event":"sold_comps_upsert_error", ...
      //    "error":"The request rate is too large ... 429",
      //    "cumulativeEmitFailures":1}
      //
      // and this lane counted that row as LANDED. recordSoldComp catches the
      // upsert throw, warns, and then falls through to
      // `return { written: true, ... }` -- so the caller cannot tell a
      // throttled write from a successful one, `err` stays 0, and the
      // reconcile balances while the sale is not in the pool. A reconcile that
      // cannot be wrong is not a reconcile.
      //
      // The service already keeps the honest number: `_emitFailureCounter`,
      // exported as getEmitFailureCount(). Reading its delta per batch turns
      // the swallowed throw back into a countable failure at the one place
      // that has both numbers. The rows are NOT lost silently: they are
      // reported in the reconcile's `failed` column and re-attempted by the
      // next run, which re-reads the day and finds no contentHash for them.
      //
      // CF-A-THROTTLED-WRITE-IS-NOT-A-WRITE (2026-09-09). The follow-up this
      // comment filed IS NOW MADE: recordSoldComp's catch returns
      // `{ written: false, reason: "error" }` instead of falling through to
      // `written: true`, so the caller can finally tell a throttled write from
      // a landed one directly.
      //
      // THIS LEDGER IS UNCHANGED ANYWAY, AND DELIBERATELY SO. The two signals
      // report the SAME rows: a swallowed upsert increments the counter AND
      // returns `written: false`, one row, both facts. Adding a `written`
      // check here on top of the delta below would count every throttled sale
      // TWICE and drive `emitted` negative under a real 429 storm -- an
      // imbalance that looks like a missing outcome but is an invented one.
      //
      // So this lane keeps counting via the delta, which is exact, and does
      // not also read the return value. One of the two, never their sum. The
      // invariant that makes either one sufficient (delta === the number of
      // `written: false` / "error" results) is pinned in
      // tests/aThrottledWriteIsNotAWrite.test.ts.
      const swallowed = getEmitFailureCount() - failBefore;
      landed -= swallowed;
      emitted += batch.length - err - swallowed;
      intendedWrites += batch.length;
      failedWrites += err + swallowed;
      if (swallowed > 0) {
        console.log(`\r      !! ${swallowed} write(s) in this batch threw inside recordSoldComp `
          + `(429 / throttle) and were counted as FAILED, not written`);
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\r      ${landed}/${writes.length} in ${secs}s (landed=${landed})`);

    // Advance the window -- but ONLY when the day actually finished. A
    // budget stop mid-day must leave `currentEnd` on THIS day, so the marker
    // and `next start date` name the day the relaunch has to redo.
    if (batchStopped) break;
    currentEnd = currentStart;
    currentStart = addDays(currentEnd, -SLICE_DAYS);

    // The BETWEEN-days stop lives at the TOP of this loop as a PRE-check --
    // see THE PRE-CHECK above and #1799 -- and the BETWEEN-batches stop is the
    // one just above it.
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
  // The 429 column. Zero is a real reading here, not an unmeasured one: it is
  // the delta of the store's own emit-failure counter across every batch.
  console.log(`  writes that threw inside recordSoldComp (429 / throttle): ${failedWrites.toLocaleString()}`
    + `  <- counted as FAILED, re-attempted by the next run`);
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
  // per-BATCH `batch.length` -- the rows that survived every filter and were
  // actually handed to recordSoldComp -- so the identity holds whether the walk
  // reached END_DATE, the budget stopped it between days, or the budget stopped
  // it between batches inside a day. A day whose batches were never started
  // contributes NOTHING to `intended`, which is what makes a mid-day stop
  // reconcile rather than appear as a mismatch. The filtered-out rows (no
  // player, no price, sport filter) are NOT in it: they were never intended
  // writes, and folding them in would make the banner describe the scan rather
  // than the writes (a slice is not a sibling counter).
  //
  // `failed` now carries the swallowed 429s (THE 429 COLUMN above) as well as
  // the throws runInParallel caught. Before this, a throttled write landed in
  // NEITHER column -- recordSoldComp returned written:true for it -- so the
  // identity balanced on a row that was never in the pool.
  reportLedger();
  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    // A crash still owes the operator its write ledger and, if the clock ran
    // out, its marker -- see CF-EVERY-PATH-RECONCILES. Wrapped because a throw
    // BEFORE loadDist() leaves `reportWrites` undefined, and a reporting
    // failure must never replace the real error above.
    try { reportLedger(); }
    catch (reportErr) { console.error("  !! could not print the write ledger:", reportErr?.message ?? reportErr); }
    await finishLane(1, { budget: CLOCK });
  });
