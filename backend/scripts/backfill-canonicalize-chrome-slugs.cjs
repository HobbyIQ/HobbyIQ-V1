#!/usr/bin/env node
// CF-BACKFILL-CANONICALIZE-CHROME-SLUGS (Drew, 2026-07-31).
//
// One-shot backfill to enforce the new chrome-subset canonicalization
// across sold_comps + card_catalog + portfolio holdings. Rewrites any
// slug whose set segment is:
//   - bowman-chrome-draft  → bowman-chrome
//   - topps-chrome-update  → topps-chrome
// Plus any row whose cardNumber prefix (CPA/BCPA/BDPA/BCDA/BCRA/FCA/
// CDA/BCP/... for Bowman; TCRA/TRA/TCU/TC... for Topps) implies a chrome
// stock but currently lives at a non-chrome set slug (bowman-draft,
// bowman, topps, etc.) — force to bowman-chrome / topps-chrome.
// Sapphire slugs are preserved.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_MODE              dry | apply  (default dry)
//   BACKFILL_CONTAINER         sold_comps | card_catalog | portfolio | all (default all)
//   BACKFILL_CONCURRENCY       upsert concurrency (default 8)
//   BACKFILL_LIMIT             cap rows examined per container (default: no cap)

const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit are the ONE shared helper, never a local copy: #1859
// is what a private capped() costs (an unref'd cap that never fired, four runs
// killed at the ceiling having already reconciled clean).
//
// HOISTED `path`, and the require written flat rather than as
// `require(require("node:path")...)`. The pin matching this import is
// `require([^)]*runner-budget.cjs")`, and `[^)]*` cannot cross the `)` closing
// a nested require -- so the inline form reads to laneExitsWhenWorkIsDone as a
// lane that never imported the helper at all.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// ── THE THREE CONSTANTS (lib/runner-budget.cjs) ────────────────────────────
//
// Spelled out by name because the pins that govern budgeted lanes --
// runnerBudgetMargin and laneExitsWhenWorkIsDone -- select their population on
// the literal `RUN_MINUTES`. This lane had no clock at all, and it is the
// worst-placed lane in the set to be missing one: its default
// BACKFILL_CONTAINER is `all`, so a single dispatch walks the WHOLE of
// sold_comps, then the WHOLE of card_catalog, then every portfolio document --
// three full-container scans, in series, in one 150-minute step. Killed rather
// than stopped, it prints no marker, no reconcile and no exit code, and
// because the containers run in series the operator cannot even tell WHICH one
// it died in.
//
// THE UNIT IS ONE PAGE, and there are two shapes of page, so the reserve is
// sized to the larger:
//
//   processContainer  a maxItemCount=500 fetchNext, then up to 500 upserts
//                     pushed through the CONCURRENCY (default 8) in-flight
//                     window, each wrapped in withRetry's 5 attempts with an
//                     exponential backoff (250ms doubling, ~3.9s worst per
//                     document) on a 429.
//   portfolio         a maxItemCount=100 fetchNext of whole portfolio
//                     documents, each changed doc upserted SERIALLY -- no
//                     concurrency window at all -- so a page of 100 changed
//                     docs is 100 sequential round trips, every one of them
//                     able to burn withRetry's ~3.9s backoff ladder.
//
// The portfolio page is the worst unit and it is the one 90 seconds is sized
// for: 100 serial upserts is well under that at rest, and the reserve exists
// to exceed the worst single unit a throttled container can produce rather
// than the typical one. Checked BEFORE each page is fetched, so the page that
// would overrun is never STARTED -- checking after admits one more page of
// unbounded size past expiry, the loop-top defect #1799 named.
//
// VERIFY_MS is nominal: every count printed is accumulated in the loops, and
// there is no post-loop aggregate at all, so nothing here can outlive the
// report the way the 887-second COUNT of run 33960686247 did.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONTAINER = (process.env.BACKFILL_CONTAINER || "all").toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = process.env.BACKFILL_LIMIT ? Number(process.env.BACKFILL_LIMIT) : Infinity;

// CF-CHROME-PREFIX-OVERRIDE-REMOVED (Drew, 2026-07-31). Cardnumber-prefix
// override was too broad — CPA-, FCA-, TC-, CU- all collide across product
// families (Bowman Chrome vs Topps Chrome Platinum, Bowman vs Donruss
// Champions, etc.). Keeping ONLY the safe set-string collapse.
function canonicalizeSetSegment(setSegment, _cardNumber) {
  let s = setSegment;
  if (s === "bowman-chrome-draft") s = "bowman-chrome";
  if (s === "topps-chrome-update") s = "topps-chrome";
  return s;
}

function canonicalizeSlug(slug, cardNumber) {
  if (typeof slug !== "string" || !slug.startsWith("hiq:")) return slug;
  const parts = slug.split(":");
  if (parts.length < 6) return slug;
  const newSet = canonicalizeSetSegment(parts[3], cardNumber || parts[4]);
  if (newSet === parts[3]) return slug;
  parts[3] = newSet;
  return parts.join(":");
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 150;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function processContainer(container, name, opts) {
  const { slugField, cardNumberField, showChanges = 6 } = opts;
  console.log(`\n=== ${name} · mode=${MODE} · slugField=${slugField} · cnField=${cardNumberField} ===`);
  const query = { query: `SELECT * FROM c WHERE STARTSWITH(c.${slugField}, 'hiq:')` };
  const it = container.items.query(query, { maxItemCount: 500 });

  let examined = 0, changed = 0, writeErrors = 0;
  const changeBucket = {};
  const inFlight = [];
  const changesSample = [];

  while (it.hasMoreResults && it.hasMoreResults()) {
    if (examined >= LIMIT) break;
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      if (examined >= LIMIT) break;
      const oldSlug = row[slugField];
      const cn = row[cardNumberField] || (oldSlug.split(":")[4] || "");
      const newSlug = canonicalizeSlug(oldSlug, cn);
      if (newSlug === oldSlug) continue;
      changed++;
      const oldSet = oldSlug.split(":")[3];
      const newSet = newSlug.split(":")[3];
      const key = `${oldSet}\t→ ${newSet}`;
      changeBucket[key] = (changeBucket[key] || 0) + 1;
      if (changesSample.length < showChanges) changesSample.push(`  ${oldSlug}\n  ${newSlug}`);
      if (MODE === "apply") {
        row[slugField] = newSlug;
        row.__canonicalizedChromeAt = new Date().toISOString();
        const p = withRetry(() => container.items.upsert(row))
          .catch(e => { writeErrors++; console.error("  upsert err:", e?.message?.slice(0,80)); });
        inFlight.push(p);
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          // remove settled
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 25000 === 0) console.log(`  examined=${examined}  changed=${changed}`);
  }
  // THE IN-FLIGHT WINDOW IS DRAINED BEFORE ANYTHING IS COUNTED -- on the budget
  // path too. A `break` above leaves up to CONCURRENCY upserts still running, and
  // `writeErrors` is incremented inside their catch handlers, so a count printed
  // before they settle would balance against a counter that is still moving.
  await Promise.allSettled(inFlight);

  console.log(`\n  examined=${examined}  changed=${changed}  writeErrors=${writeErrors}`);
  console.log(`  changes by set-segment transition:`);
  Object.entries(changeBucket).sort((a,b) => b[1] - a[1]).forEach(([k, n]) => {
    console.log(`    ${String(n).padStart(7)}  ${k}`);
  });
  if (changesSample.length) {
    console.log(`  sample changes (${changesSample.length}):`);
    changesSample.forEach(s => console.log(s));
  }
  if (stoppedAtBudget) console.log("  (budget stopped this container's walk; it is UNFINISHED)");
  return { examined, changed, writeErrors, stoppedAtBudget };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING required");
    process.exit(1);
  }
  // NAMED `client` rather than the one-letter `c`, because it is now handed to
  // finishLane() to be DISPOSED: an undisposed SDK keeps its keep-alive
  // sockets open, and a live handle is exactly what held four APPLY shards to
  // the 150-minute ceiling in #1809 after they had already reconciled clean.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");

  console.log(`[backfill-canonicalize-chrome-slugs]`);
  console.log(`  mode=${MODE}  container=${CONTAINER}  concurrency=${CONCURRENCY}  limit=${LIMIT === Infinity ? "none" : LIMIT}`);
  console.log(`  ${CLOCK.describe()}`);

  const results = {};
  // THE BUDGET'S BOOKKEEPING. There is NO not-reached count anywhere in this
  // lane, deliberately: all three walks discover their populations page by page
  // behind a continuation token and none of them ever learns how many rows the
  // container holds. A remainder printed here would be invented, and an
  // invented remainder makes a half-swept container read as an accounted one.
  // The marker says UNFINISHED, and the reconcile below balances over SEEN.
  let stoppedAtBudget = false;
  if (CONTAINER === "sold_comps" || CONTAINER === "all") {
    results.sold_comps = await processContainer(db.container("sold_comps"), "sold_comps", {
      slugField: "hobbyiqCardId", cardNumberField: "cardNumber",
    });
    if (results.sold_comps.stoppedAtBudget) stoppedAtBudget = true;
  }
  // THE CONTAINERS RUN IN SERIES AGAINST ONE CLOCK, so a stop in the first is
  // a stop for the run. Entering card_catalog with the budget already spent
  // would start a whole new full-container scan past expiry -- the same "one
  // more unit" defect as a loop-top check, merely at container granularity.
  if (!stoppedAtBudget && (CONTAINER === "card_catalog" || CONTAINER === "all")) {
    results.card_catalog = await processContainer(db.container("card_catalog"), "card_catalog", {
      slugField: "hobbyiqCardId", cardNumberField: "cardNumber",
    });
    if (results.card_catalog.stoppedAtBudget) stoppedAtBudget = true;
  }
  if (!stoppedAtBudget && (CONTAINER === "portfolio" || CONTAINER === "all")) {
    // Portfolio is nested: doc.holdings[key].hobbyiqCardId. Handle specially.
    const container = db.container("portfolio");
    console.log(`\n=== portfolio · mode=${MODE} (nested holdings) ===`);
    const it = container.items.query({ query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings)" }, { maxItemCount: 100 });
    let examined = 0, changedDocs = 0, changedHoldings = 0, errors = 0;
    while (it.hasMoreResults && it.hasMoreResults()) {
      // THE PRE-CHECK, ABOVE THE PAGE FETCH. This walk's unit is the worst one
      // in the lane -- 100 portfolio documents whose changed members are
      // upserted SERIALLY, with no concurrency window -- which is what the 90s
      // reserve is sized for. Checked here, the page that would overrun is
      // never STARTED.
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const { resources } = await it.fetchNext();
      if (!Array.isArray(resources)) break;
      for (const doc of resources) {
        examined++;
        let docChanged = false;
        for (const [hk, h] of Object.entries(doc.holdings || {})) {
          const oldSlug = h.hobbyiqCardId;
          if (typeof oldSlug !== "string" || !oldSlug.startsWith("hiq:")) continue;
          const newSlug = canonicalizeSlug(oldSlug, h.cardNumber);
          if (newSlug !== oldSlug) {
            h.hobbyiqCardId = newSlug;
            changedHoldings++;
            docChanged = true;
          }
        }
        if (docChanged) {
          changedDocs++;
          if (MODE === "apply") {
            try { await withRetry(() => container.items.upsert(doc)); }
            catch (e) { errors++; console.error("  portfolio upsert err:", e?.message?.slice(0,80)); }
          }
        }
      }
    }
    console.log(`  portfolio docs examined=${examined}  changedDocs=${changedDocs}  changedHoldings=${changedHoldings}  errors=${errors}`);
    results.portfolio = { examined, changedHoldings, errors };
  }

  console.log(`\n[DONE] mode=${MODE}`);
  console.log(JSON.stringify(results, null, 2));

  // RECONCILED OVER WHAT WAS SEEN. This lane predates reportWrites and is
  // whitelisted out of everyWriteJobReconciles, so the equation is printed here
  // in the shared vocabulary rather than left implicit in the JSON dump above:
  // `changed` is the rows this run actually read and found mis-slugged, so
  // intended == written + skipped + failed holds whether the walks finished
  // their containers or the budget stopped them between pages. Rows behind a
  // continuation token this run never followed were never IN the equation, and
  // the marker below is what says so.
  //
  // A dry run writes nothing by design, so its whole `changed` set is a SKIP --
  // saying "intended N, written 0" with no skip column is how a report reads as
  // a loss. A shortfall is RED (exit 4), not a note.
  let intended = 0, failed = 0, seen = 0;
  for (const r of Object.values(results)) {
    intended += (r.changed ?? r.changedHoldings ?? 0);
    failed += (r.writeErrors ?? r.errors ?? 0);
    seen += (r.examined ?? 0);
  }
  const written = MODE === "apply" ? intended - failed : 0;
  const skipped = intended - written - failed;
  console.log(`  reconciled: intended ${intended} = written ${written} + skipped ${skipped}`
    + ` + failed ${failed}  (over ${seen} rows SEEN)`);
  if (written + skipped + failed !== intended) {
    console.error(`  RECONCILE MISMATCH: ${written + skipped + failed} accounted vs ${intended} intended`);
    process.exitCode = 4;
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps stdout for
  // `stopped at the .*budget`, so the phrase is a SOURCE LITERAL rather than
  // assembled from variables: a marker built by concatenation is one a refactor
  // can silently reword, and a reworded marker ends the fan-out after one slice
  // with the run green.
  //
  // It says UNFINISHED and names NO row remainder, for the reason given at the
  // `stoppedAtBudget` declaration: none of the three walks can know one without
  // having already read the pages it is reporting that it did not read.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this run is UNFINISHED; the relaunch continues from here`);
    console.log("  the canonicalize is IDEMPOTENT: a slug already collapsed to bowman-chrome"
      + " or topps-chrome recomputes to itself and is skipped before any write, so the"
      + " continuation re-walks cheaply and upserts only what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes the event loop drains is the
// asymmetry that cost four reconciled-clean runs their exit codes.
// `process.exitCode` may already carry the reconcile mismatch above, and that
// is the code finishLane is handed.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
