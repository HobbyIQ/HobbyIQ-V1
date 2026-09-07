#!/usr/bin/env node
// CF-REFRESH-CALIBRATION-MULTIPLIERS (Drew, 2026-07-30). Weekly refit
// of per-axis premium multipliers from a 90-day rolling window.
//
// v2 (2026-07-30): PER-CARD RATIO calibration. Prior version compared
// cohort-of-Golds vs cohort-of-Bases, which mixed different players/
// eras and produced 160-1800× ratios (mix effect, not premium). This
// version matches Gold vs Base FOR THE SAME CARD (same year+cardNumber+
// sport+product), computes a per-identity ratio, then takes the median
// of ratios across identities — the true "typical premium" independent
// of card mix.
//
// Dimensions:
//   colorLadderMultiplier   — per product; e.g. Gold /50 ≈ 5-8× BASE
//                             for bowman-chrome (product-scoped)
//   editionPremium          — global; Sapphire ≈ 1.5-2× vs non-edition
//   finishPremium           — global; SHIMMER ≈ 2-4× same-color-no-finish
//   autoStylePremium        — global; on-card ≈ 1.2-1.6× sticker
//   gradeTierMultiplier     — global; PSA_10 ≈ 3-8× raw (varies by era)
//
// Confidence (based on IDENTITY count, not row count):
//   verified: >= 30 identities contributed a ratio
//   probable: >= 10
//   unverified: < 10 (still stored; flag-only downstream)
//
// Env:
//   COSMOS_CONNECTION_STRING       — required
//   CALIBRATION_APPLY=true         — write (default true)
//   CALIBRATION_WINDOW_DAYS=90     — window for ratio fits

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { upsertCalibration } = require(path.join(backend, "dist/services/portfolioiq/marketMomentum.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes the GRADE AND COLOUR
// MULTIPLIERS the pricing engine applies -- the empirical calibration doctrine's
// only sanctioned source -- and declared no budget at all. Its scan reads every
// composite-bearing sale in a 90-day window, so before this it could only ever
// end by being KILLED at the 150-minute ceiling: no marker, no reconcile, no
// finishLane line, and #1913's KILLED branch then withholding the re-dispatch.
//
// >>> THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP. <<<
//
// This is the sharpest instance of #1947's lesson on this wave, because the
// output IS the statistic and the statistic prices real cards. Every multiplier
// is `median of per-identity ratios` -- median(target) / median(baseline)
// within a (sport, year, product, cardNumber) identity, then the median across
// identities. A window read HALF WAY THROUGH does not produce half a ratio: it
// produces a DIFFERENT ratio, computed over whichever identities the scan
// happened to reach, and it is written as the calibration.
//
// AND THE GUARDS THAT LOOK LIKE THEY SAVE IT DO NOT. `identityN < 3` and the
// per-product `productRows.length < 30` are ROW FLOORS: a partial scan can put
// three identities and thirty rows into a product and still misstate its Gold
// premium, exactly as #1951 found for auto-quarantine-contaminated-pools'
// MIN_SAMPLES. Worse, `confidence` is derived from the same partial count, so a
// wrong multiplier can be stamped "verified" -- a well-formed wrong row that
// nothing downstream can tell from a correct one, and that the engine then
// multiplies every affected card's FMV by until the next weekly refit.
//
// So a scan stop exits 5 having written NOTHING, and still prints the marker --
// the relaunch's marker arm runs BEFORE its outcome check, so a refusal
// re-dispatches and the next run re-reads the window from the top.
//
// THE UNIT IS ONE PAGE of up to 5,000 rows of a TWELVE-FIELD PROJECTION. Once
// the scan completes, the five compute passes are in-memory apart from a
// handful of small upsertCalibration writes -- one per product plus four
// globals -- so the reserve is sized to the scan page: 60 seconds.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its work.
// Worst case 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). Default-on meant `apply=false`
// under the runner still wrote — the runner exports BACKFILL_APPLY, not
// CALIBRATION_APPLY. Precedence: an explicit CALIBRATION_APPLY (the cron
// workflows set "true"); else the runner's BACKFILL_APPLY when it is present;
// else the old default, on.
const APPLY = process.env.CALIBRATION_APPLY !== undefined
  ? process.env.CALIBRATION_APPLY !== "false"
  : process.env.BACKFILL_APPLY !== undefined
    ? process.env.BACKFILL_APPLY === "true"
    : true;
// Reconciled (D18): intended = calibration docs handed to upsertCalibration,
// written = calls that resolved. A call that throws aborts the run (exit 1).
const writes = { intended: 0, written: 0 };
const WINDOW_DAYS = Number(process.env.CALIBRATION_WINDOW_DAYS || "90");

async function fetchSample(sc, sinceIso) {
  const query = `
    SELECT c.soldAt, c.price, c.sport, c.isAuto, c.autoStyle, c.hobbyiqCardId,
           c.gradeCompany, c.gradeValue, c.composite, c.cardNumber, c.year
    FROM c
    WHERE c.soldAt >= @since AND c.price > 0
      AND IS_DEFINED(c.composite) AND c.composite != null
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@since", value: sinceIso }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  let stopped = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is
    // buffered. A stop here is FATAL to the calibration -- see THE CLOCK above
    // -- not merely a shorter run, so the flag travels back to main().
    if (CLOCK.outOfClock()) { stopped = true; break; }
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
  }
  return { rows, stopped };
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function confidence(identityN) {
  return identityN >= 30 ? "verified" : identityN >= 10 ? "probable" : "unverified";
}

// Parse (product, year, cardNumber, sport) identity from a row.
// Identity is used to match "same card, different color" pairs.
function identityOf(r, includeProduct = true) {
  const parts = String(r.hobbyiqCardId || "").split(":");
  const sport = parts[1] ?? r.sport ?? null;
  const year = parts[2] ?? (r.year != null ? String(r.year) : null);
  const product = parts[3] ?? null;
  const cardNumber = parts[4] ?? r.cardNumber ?? null;
  if (!year || !cardNumber || !sport) return null;
  return includeProduct
    ? (product ? `${sport}|${year}|${product}|${cardNumber}` : null)
    : `${sport}|${year}|${cardNumber}`;
}

// Generic per-identity ratio calibration.
// For each identity: bucket rows by keyFn.  If baseline bucket + target
// bucket both have >=1 row, compute ratio = median(target) / median(baseline).
// Emit multiplier[K] = median of ratios across identities.
async function computePerIdentityMultiplier({
  rows,
  dimension,
  scope,
  keyFn,          // returns bucket key ("BASE", "GOLD", "SHIMMER", ...) or null
  baselineKey,    // string that identifies the baseline bucket (or fn returning true if row is baseline)
  identityFn,     // returns identity string (product+year+cardNumber etc.) or null
  computedAt,
}) {
  const byIdentity = new Map();
  for (const r of rows) {
    const id = identityFn(r);
    if (!id) continue;
    const k = keyFn(r);
    if (k == null) continue;
    if (!byIdentity.has(id)) byIdentity.set(id, new Map());
    const buckets = byIdentity.get(id);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(Number(r.price));
  }

  // Per-target-key: list of per-identity ratios
  const ratiosByKey = new Map();
  const identityContributionByKey = new Map();
  for (const [id, buckets] of byIdentity.entries()) {
    const baseArr = buckets.get(baselineKey);
    if (!baseArr || baseArr.length === 0) continue;
    const baseMed = median(baseArr);
    if (!baseMed || baseMed <= 0) continue;
    for (const [key, prices] of buckets.entries()) {
      if (key === baselineKey) continue;
      const m = median(prices);
      if (m == null || m <= 0) continue;
      const ratio = m / baseMed;
      if (!Number.isFinite(ratio) || ratio <= 0) continue;
      if (!ratiosByKey.has(key)) ratiosByKey.set(key, []);
      if (!identityContributionByKey.has(key)) identityContributionByKey.set(key, new Set());
      ratiosByKey.get(key).push(ratio);
      identityContributionByKey.get(key).add(id);
    }
  }

  const multipliers = { [baselineKey]: 1.00 };
  let maxIdentityN = 0;
  for (const [key, ratios] of ratiosByKey.entries()) {
    const identityN = identityContributionByKey.get(key).size;
    if (identityN < 3) continue;                    // require min 3 identities per key
    multipliers[key] = median(ratios);
    if (identityN > maxIdentityN) maxIdentityN = identityN;
  }

  if (Object.keys(multipliers).length <= 1) return 0;

  if (APPLY) {
    writes.intended++;
    await upsertCalibration({
      dimension,
      scope,
      windowDays: WINDOW_DAYS,
      computedAt,
      multipliers,
      sampleSize: maxIdentityN,
      confidence: confidence(maxIdentityN),
    });
    writes.written++;
  }
  return 1;
}

// Per-product color-ladder multipliers.
// Identity = (product, year, cardNumber, sport). Baseline bucket = BASE.
async function computeColorLadder(rows, computedAt) {
  const byProduct = new Map();
  for (const r of rows) {
    const parts = String(r.hobbyiqCardId || "").split(":");
    const product = parts[3];
    if (!product) continue;
    if (!byProduct.has(product)) byProduct.set(product, []);
    byProduct.get(product).push(r);
  }
  let emitted = 0;
  for (const [product, productRows] of byProduct.entries()) {
    if (productRows.length < 30) continue;         // per-product sample floor
    const ok = await computePerIdentityMultiplier({
      rows: productRows,
      dimension: "colorLadderMultiplier",
      scope: product,
      keyFn: r => r.composite?.colorFamily ?? null,
      baselineKey: "BASE",
      identityFn: r => identityOf(r, true),
      computedAt,
    });
    emitted += ok;
  }
  console.log(`  colorLadderMultiplier: ${emitted} products calibrated`);
}

// Global finish-premium (SHIMMER, WAVE, LAVA, ...).
// Identity = (product, year, cardNumber, sport). Baseline = rows with
// finishModifier == null but same color as target row would be an
// impossible constraint (finish is INDEPENDENT of color). We treat
// baseline as "same identity, no finish". So identity is per-product
// and we key on finishModifier or "NONE".
async function computeFinishPremium(rows, computedAt) {
  const ok = await computePerIdentityMultiplier({
    rows,
    dimension: "finishPremium",
    scope: "global",
    keyFn: r => r.composite?.finishModifier ?? "NONE",
    baselineKey: "NONE",
    identityFn: r => identityOf(r, true),
    computedAt,
  });
  console.log(`  finishPremium: ${ok ? "written" : "insufficient data"}`);
}

// Global edition premium (SAPPHIRE, MEGA_BOX, FIRST_EDITION, COSMIC, ...).
// Sapphire vs regular is a CROSS-PRODUCT comparison — bowman-chrome-sapphire
// vs bowman-chrome. So identity excludes product; matches on
// (sport, year, cardNumber) only.
async function computeEditionPremium(rows, computedAt) {
  const ok = await computePerIdentityMultiplier({
    rows,
    dimension: "editionPremium",
    scope: "global",
    keyFn: r => r.composite?.edition ?? "REGULAR",
    baselineKey: "REGULAR",
    identityFn: r => identityOf(r, false),
    computedAt,
  });
  console.log(`  editionPremium: ${ok ? "written" : "insufficient data"}`);
}

// Global autoStyle premium (on-card vs sticker).
// Only auto rows contribute. Identity = product+year+cardNumber+sport.
async function computeAutoStylePremium(rows, computedAt) {
  const autoRows = rows.filter(r => r.isAuto === true);
  const ok = await computePerIdentityMultiplier({
    rows: autoRows,
    dimension: "autoStylePremium",
    scope: "global",
    keyFn: r => r.autoStyle ?? null,   // "on-card" or "sticker"
    baselineKey: "sticker",
    identityFn: r => identityOf(r, true),
    computedAt,
  });
  console.log(`  autoStylePremium: ${ok ? "written" : "insufficient data"}`);
}

// Global grade-tier multiplier (PSA_10, PSA_9, PSA_8 vs raw).
// Grade multiplier is applied to raw, so baseline = raw (no grader).
// Identity spans product because grader premium is largely product-
// independent — same-card raw vs same-card graded is the pair.
async function computeGradeTierMultiplier(rows, computedAt) {
  const ok = await computePerIdentityMultiplier({
    rows,
    dimension: "gradeTierMultiplier",
    scope: "global",
    keyFn: r => {
      if (!r.gradeCompany || r.gradeValue == null) return "RAW";
      return `${String(r.gradeCompany).toUpperCase()}_${r.gradeValue}`;
    },
    baselineKey: "RAW",
    identityFn: r => identityOf(r, false),
    computedAt,
  });
  console.log(`  gradeTierMultiplier: ${ok ? "written" : "insufficient data"}`);
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[refresh-calibration-multipliers v2 (per-card ratios)]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  window: ${WINDOW_DAYS} days`);
  console.log(`  ${CLOCK.describe()}\n`);

  const now = Date.now();
  const computedAt = new Date(now).toISOString();
  const sinceIso = new Date(now - WINDOW_DAYS * 86400000).toISOString();
  const { rows, stopped: scanStoppedAtBudget } = await fetchSample(sc, sinceIso);
  console.log(`  ${rows.length} sales with composite in window\n`);

  // -- THE REFUSAL -----------------------------------------------------------
  //
  // A ratio over part of a window is a DIFFERENT ratio, not a smaller one, and
  // this lane's output is nothing BUT ratios -- written as the multipliers the
  // pricing engine applies to every affected card until the next weekly refit,
  // with a `confidence` label derived from the same partial count. The row
  // floors (identityN >= 3, productRows.length >= 30) do not save it: a partial
  // scan can clear both and still misstate the premium.
  //
  // Exit 5 is a VERDICT, not a crash (#1955's outcome (d)). The marker is
  // printed FIRST, because the relaunch's marker arm runs BEFORE its outcome
  // check -- so this re-dispatches and the next run re-reads the window from
  // the top with a full clock.
  if (scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the ${WINDOW_DAYS}-day window scan is UNFINISHED; the relaunch continues from here`);
    console.error("  REFUSING TO FIT: every multiplier here is a median of per-identity price"
      + " RATIOS, and a ratio computed over part of the window is a DIFFERENT number rather than"
      + " a less precise one. Writing it would stamp a wrong premium -- possibly labelled"
      + " `verified`, since confidence reads the same partial count -- onto the calibration the"
      + " engine multiplies FMVs by. Nothing was written.");
    if (APPLY) {
      reportWrites({ job: "refresh-calibration-multipliers", intended: 0, written: 0, skipped: 0, failed: 0 });
    }
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  await computeColorLadder(rows, computedAt);
  await computeFinishPremium(rows, computedAt);
  await computeEditionPremium(rows, computedAt);
  await computeAutoStylePremium(rows, computedAt);
  await computeGradeTierMultiplier(rows, computedAt);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  computedAt: ${computedAt}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set CALIBRATION_APPLY=true to write. ***`);
  if (APPLY) {
    // The existing reconciliation (D18) is unchanged: intended = calibration
    // docs handed to upsertCalibration, written = calls that resolved. It
    // BALANCES BY CONSTRUCTION here because a throwing call aborts the run, and
    // the refusal above is the only path that can reduce the fit -- and it
    // returns before any of this.
    console.log(`  reconciled: intended ${writes.intended} = written ${writes.written} + failed 0`);
    if (writes.written !== writes.intended) {
      console.error("  !! RECONCILE MISMATCH -- a calibration doc was handed over but never landed");
      process.exitCode = 4;
    }
    reportWrites({ job: "refresh-calibration-multipliers", ...writes });
  }

  // NO BUDGET MARKER ON THE SUCCESS PATH, DELIBERATELY. The only way this lane
  // stops early is the refusal above, which prints the marker itself and exits
  // 5. Once the window is fully read the five compute passes are in-memory
  // apart from a handful of small upserts, so there is no partial-fit state to
  // continue from: the run either fits the whole window or fits none of it.

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
