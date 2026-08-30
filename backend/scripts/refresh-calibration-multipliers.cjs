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
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
  }
  return rows;
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
  console.log(`  window: ${WINDOW_DAYS} days\n`);

  const now = Date.now();
  const computedAt = new Date(now).toISOString();
  const sinceIso = new Date(now - WINDOW_DAYS * 86400000).toISOString();
  const rows = await fetchSample(sc, sinceIso);
  console.log(`  ${rows.length} sales with composite in window\n`);

  await computeColorLadder(rows, computedAt);
  await computeFinishPremium(rows, computedAt);
  await computeEditionPremium(rows, computedAt);
  await computeAutoStylePremium(rows, computedAt);
  await computeGradeTierMultiplier(rows, computedAt);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  computedAt: ${computedAt}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set CALIBRATION_APPLY=true to write. ***`);
  if (APPLY) reportWrites({ job: "refresh-calibration-multipliers", ...writes });
}

main().catch(e => { console.error(e); process.exit(1); });
