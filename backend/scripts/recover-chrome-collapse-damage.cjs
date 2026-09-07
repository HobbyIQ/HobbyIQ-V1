#!/usr/bin/env node
// CF-RECOVER-CHROME-COLLAPSE-DAMAGE (Drew, 2026-07-31).
//
// The 2026-07-31 chrome-collapse apply run had a too-broad cardNumber
// prefix override that reclassified ~184 rows into the wrong product
// family (CPA-XX Topps Chrome Platinum → bowman-chrome, TC-XX Donruss
// Champions → topps-chrome, FCA-XX Topps Finest → bowman-chrome).
//
// This script recovers by re-canonicalizing every row marked with
// __canonicalizedChromeAt using ONLY the setName field (unchanged by
// the bad apply) and the safe set-string collapse. No cardNumber
// override. Idempotent: rows that were already correct stay correct.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   RECOVER_MODE               dry | apply (default: the runner's BACKFILL_APPLY,
//                              else dry)
//   RECOVER_CONCURRENCY        default 8

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows the apply branch handed to an upsert
//   written  = upserts acknowledged (rewritten); failed = upserts that threw
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit are the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). The runner exports BACKFILL_APPLY
// and never RECOVER_MODE, so under the runner this was PERMANENTLY DRY: an
// "APPLY" dispatch printed plausible would-change counters and wrote nothing.
// An explicit RECOVER_MODE still wins (the manual runbook); otherwise the
// runner's flag decides; with neither, dry.
const MODE = (process.env.RECOVER_MODE || (process.env.BACKFILL_APPLY === "true" ? "apply" : "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.RECOVER_CONCURRENCY || 8));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES sold_comps
// identities -- it moves a sale's hobbyiqCardId from one product family to
// another -- and declared no budget at all, so a marked population larger than
// one 150-minute step holds could only end by being KILLED at the ceiling with
// half the pool recovered and no marker, no reconcile and no finishLane line to
// say which half.
//
// THE UNIT IS ONE ROW: one `sc.items.upsert(r)` of a whole sold_comps document,
// wrapped in withRetry (5 attempts, exponential 250ms base). CONCURRENCY (8) is
// an in-flight WINDOW, not a batch -- the loop admits one row at a time and only
// waits when the window is full -- so the largest thing the budget can be asked
// to admit is a single upsert plus, at worst, the wait for one slot to free.
// withRetry's own ceiling on a throttled row is roughly 250+500+1000+2000+4000ms
// of backoff plus the requests themselves; 60 seconds exceeds that by a wide
// margin, and is checked BEFORE the row is queued rather than after it is
// written.
//
// VERIFY_MS is nominal: the post-loop report reads NOTHING, it only prints the
// transition tallies the loop accumulated. Worst case 110 + 1 + 1 + 1 = 113m
// under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// Set-string canonicalization ONLY (safe rules — no cardNumber prefix override).
// Mirrors the trimmed normalizeSetKey collapse rules that are now the ONLY chrome
// canonicalization: bowman-chrome-draft → bowman-chrome, topps-chrome-update → topps-chrome.
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Approximate normalizeSetKey — matches enough of the production regexes
// to recover correctly for the affected rows. Includes: sapphire (preserved),
// bowman-chrome (with draft collapse), bowman-draft (paper), bowman-paper,
// bowman-sterling, bowman, topps-chrome (with update collapse), topps-finest,
// topps-heritage, topps-chrome-platinum (Topps Chrome Platinum is its own product,
// NOT collapsed to topps-chrome per Drew's guidance), plain topps,
// panini-* variants, donruss-champions, etc.
function normalizeSetKey(setName) {
  const s = slugify(setName);
  // Sapphire — distinct product line, preserved
  if (/(bowman-chrome-sapphire|bowman-sapphire)/.test(s)) return "bowman-chrome-sapphire";
  if (/topps-chrome-sapphire/.test(s)) return "topps-chrome-sapphire";
  // Bowman family
  if (/bowman-(chrome-draft|draft-chrome)/.test(s)) return "bowman-chrome";
  if (/bowman-chrome/.test(s)) return "bowman-chrome";
  if (/chrome-prospects?(-autographs?)?/.test(s)) return "bowman-chrome";
  if (/bowman-draft-paper/.test(s)) return "bowman-draft-paper";
  if (/bowman-draft/.test(s)) return "bowman-draft";
  if (/bowman-paper/.test(s)) return "bowman-paper";
  if (/bowman-sterling/.test(s)) return "bowman-sterling";
  if (/bowman/.test(s)) return "bowman";
  // Topps family — Chrome Platinum is a distinct line, matched first
  if (/topps-chrome-platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps-chrome-update/.test(s)) return "topps-chrome";
  if (/topps-chrome/.test(s)) return "topps-chrome";
  if (/topps-heritage/.test(s)) return "topps-heritage";
  if (/topps-finest/.test(s)) return "topps-finest";
  if (/topps-pristine/.test(s)) return "topps-pristine";
  if (/topps-transcendent/.test(s)) return "topps-transcendent";
  if (/topps-dynasty/.test(s)) return "topps-dynasty";
  if (/topps-tribute/.test(s)) return "topps-tribute";
  if (/topps-museum/.test(s)) return "topps-museum-collection";
  if (/topps-stadium-club/.test(s)) return "topps-stadium-club";
  if (/topps-allen-ginter|allen-(and-)?ginter/.test(s)) return "topps-allen-ginter";
  if (/topps-gypsy-queen/.test(s)) return "topps-gypsy-queen";
  if (/topps-archives/.test(s)) return "topps-archives";
  if (/topps/.test(s)) return "topps";
  // Panini
  if (/panini-prizm|prizm/.test(s)) return "panini-prizm";
  if (/panini-select/.test(s)) return "panini-select";
  if (/panini-mosaic/.test(s)) return "panini-mosaic";
  if (/panini-donruss-optic|donruss-optic|panini-optic/.test(s)) return "panini-optic";
  if (/donruss-champions/.test(s)) return "donruss-champions";
  if (/panini-donruss|donruss/.test(s)) return "panini-donruss";
  if (/panini-contenders/.test(s)) return "panini-contenders";
  if (/panini-immaculate/.test(s)) return "panini-immaculate";
  if (/panini-flawless/.test(s)) return "panini-flawless";
  if (/national-treasures/.test(s)) return "panini-national-treasures";
  if (/panini-absolute/.test(s)) return "panini-absolute";
  if (/panini-chronicled|panini-chronicles/.test(s)) return "panini-chronicles";
  if (/panini-illusions/.test(s)) return "panini-illusions";
  if (/panini-prestige/.test(s)) return "panini-prestige";
  if (/panini-diamond-kings/.test(s)) return "panini-diamond-kings";
  if (/panini-phoenix/.test(s)) return "panini-phoenix";
  if (/panini/.test(s)) return "panini";
  // Other
  if (/finest/.test(s)) return "topps-finest";
  return s;
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

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED and unchained so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[recover-chrome-collapse-damage]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  const { resources: rows } = await sc.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.__canonicalizedChromeAt)`
  }).fetchAll();
  console.log(`Marked rows: ${rows.length}`);

  // Only recover when the true set is a DISTINCT product line (not a
  // paper/chrome cousin). "2026 Bowman Baseball" seller text on a
  // CPA-EHA card is a mistype — real card is Bowman Chrome — so keep
  // bowman-chrome. But Topps Chrome Platinum, Donruss Champions,
  // Topps Finest are truly different products — recover those.
  const DISTINCT_PRODUCTS_TO_RECOVER = new Set([
    "donruss-champions",
    "topps-chrome-platinum",
    "topps-finest",
    "topps-heritage",
    "topps-pristine",
    "topps-transcendent",
    "topps-dynasty",
    "topps-tribute",
    "topps-museum-collection",
    "topps-stadium-club",
    "topps-allen-ginter",
    "topps-gypsy-queen",
    "topps-archives",
    "bowman-sterling",
    "bowman-chrome-sapphire",
    "topps-chrome-sapphire",
    "panini-prizm",
    "panini-select",
    "panini-mosaic",
    "panini-optic",
    "panini-donruss",
    "panini-contenders",
    "panini-immaculate",
    "panini-flawless",
    "panini-national-treasures",
    "panini-absolute",
    "panini-chronicles",
    "panini-illusions",
    "panini-prestige",
    "panini-diamond-kings",
    "panini-phoenix",
    "panini",
    "upper-deck",
    "fleer",
  ]);

  const transitions = {};
  const skipped = {};
  const inFlight = [];
  let rewritten = 0, unchanged = 0, errored = 0, keptAsIs = 0, attempted = 0;
  // THE POPULATION IS KNOWN UP FRONT -- `rows` is one fetchAll() of every marked
  // row -- so a budget stop CAN name exactly what it did not reach, unlike a
  // lane that discovers its rows page by page.
  let stoppedAtBudget = false, notReached = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    // THE PRE-CHECK: above the unit's work and above every branch fork below,
    // so the row whose upsert would overrun is never CLASSIFIED, let alone
    // queued. Checking after the classification would still admit one whole
    // upsert past expiry -- the loop-top defect #1799 named.
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      notReached = rows.length - ri;
      break;
    }
    const r = rows[ri];
    const oldSlug = r.hobbyiqCardId;
    if (typeof oldSlug !== "string" || !oldSlug.startsWith("hiq:")) { unchanged++; continue; }
    const parts = oldSlug.split(":");
    if (parts.length < 6) { unchanged++; continue; }
    const currentSet = parts[3];
    const correctSet = normalizeSetKey(r.setName || "");
    if (!correctSet || correctSet === currentSet) { unchanged++; continue; }
    // Skip if the "correct set" isn't a distinct product — the override
    // may have been the right call (seller mistyped set name).
    if (!DISTINCT_PRODUCTS_TO_RECOVER.has(correctSet)) {
      keptAsIs++;
      const k = `${currentSet}  ←KEEP←  ${correctSet}   (setName=${(r.setName || '').slice(0,40)})`;
      skipped[k] = (skipped[k] || 0) + 1;
      continue;
    }
    const key = `${currentSet}  →  ${correctSet}   (setName=${(r.setName || '').slice(0,40)})`;
    transitions[key] = (transitions[key] || 0) + 1;
    parts[3] = correctSet;
    const newSlug = parts.join(":");
    if (MODE === "apply") {
      r.hobbyiqCardId = newSlug;
      r.__recoveredChromeAt = new Date().toISOString();
      attempted++;
      inFlight.push(
        withRetry(() => sc.items.upsert(r))
          .then(() => { rewritten++; })
          .catch(e => { errored++; console.error("  upsert err:", e?.message?.slice(0,80)); })
      );
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
    } else {
      rewritten++;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\ntotal marked=${rows.length}  would-change=${rewritten}  unchanged=${unchanged}  kept-as-is=${keptAsIs}  errored=${errored}`);
  if (notReached) console.log(`  not reached (budget)=${f(notReached)}`);
  console.log(`\nRecovery transitions applied (top 30):`);
  Object.entries(transitions).sort((a,b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  });
  console.log(`\nSkipped (chrome-override kept as more accurate than raw setName) (top 15):`);
  Object.entries(skipped).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  });
  // RECONCILIATION. `attempted` counts only rows this run actually handed to an
  // upsert, so `intended = written + failed` holds whether the loop finished or
  // the budget stopped it. The rows the budget never reached are reported
  // SEPARATELY as `skipped` rather than folded into `intended`: they were never
  // classified, so they are not yet known to be rows this lane would have
  // written at all. A shortfall sets process.exitCode = 4 -- red, not green.
  if (MODE === "apply") {
    console.log(`  reconciled: attempted ${f(attempted)} = written ${f(rewritten)} + failed ${f(errored)}`);
    if (rewritten + errored !== attempted) {
      console.error("  !! RECONCILE MISMATCH -- a queued upsert was neither acknowledged nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "recover-chrome-collapse-damage",
      intended: attempted, written: rewritten, skipped: notReached, failed: errored,
      notes: `unchanged ${unchanged}; kept-as-is ${keptAsIs}; not reached ${notReached}`,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${f(notReached)} of ${f(rows.length)} marked rows not reached; the relaunch continues from here`);
    console.log("  the recovery is IDEMPOTENT: a row whose slug already carries the corrected"
      + " set reads as `unchanged` on the next pass, so the continuation re-derives cheaply"
      + " and writes only what is left.");
  }

  return { client, budget: CLOCK };
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
