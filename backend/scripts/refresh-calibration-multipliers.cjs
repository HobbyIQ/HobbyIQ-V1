#!/usr/bin/env node
// CF-REFRESH-CALIBRATION-MULTIPLIERS (Drew, 2026-07-30). Weekly refit
// of per-axis premium multipliers from a 90-day rolling window.
// Consumed by hobbyIqFmv to adjust the projected next sale by axis:
//
//   colorLadderMultiplier   — per product; e.g. Gold /50 ≈ 6.2× BASE
//                             for bowman-chrome
//   editionPremium          — global; Sapphire ≈ 1.8× regular, etc.
//   finishPremium           — global; WAVE ≈ 1.3× same-color-no-finish
//   autoStylePremium        — global; on-card ≈ 1.20× sticker
//   gradeTierMultiplier     — global; PSA_10 ≈ 4.5× raw
//
// Uses ratio-to-BASE per group when computable; falls back to
// unverified when sample size is too small. Confidence:
//   verified: sampleSize >= 100
//   probable: sampleSize >= 20
//   unverified: below (flag-only downstream; never gate FMV)
//
// Env:
//   COSMOS_CONNECTION_STRING       — required
//   CALIBRATION_APPLY=true         — write (default true)
//   CALIBRATION_WINDOW_DAYS=90     — window for ratio fits

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { upsertCalibration } = require(path.join(backend, "dist/services/portfolioiq/marketMomentum.service.js"));

const APPLY = process.env.CALIBRATION_APPLY !== "false";
const WINDOW_DAYS = Number(process.env.CALIBRATION_WINDOW_DAYS || "90");

async function fetchSample(sc, sinceIso) {
  const query = `
    SELECT c.soldAt, c.price, c.sport, c.isAuto, c.autoStyle, c.hobbyiqCardId,
           c.gradeCompany, c.gradeValue, c.composite
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

function confidence(n) {
  return n >= 100 ? "verified" : n >= 20 ? "probable" : "unverified";
}

// Compute per-product color-ladder multipliers.
// Multiplier[color] = median(price | color) / median(price | color=BASE)
async function computeColorLadder(rows, computedAt) {
  const productFromSlug = (r) => {
    const parts = String(r.hobbyiqCardId || "").split(":");
    return parts[3] ?? null;
  };
  const byProduct = new Map();
  for (const r of rows) {
    const p = productFromSlug(r);
    const c = r.composite?.colorFamily;
    if (!p || !c) continue;
    if (!byProduct.has(p)) byProduct.set(p, new Map());
    const colors = byProduct.get(p);
    if (!colors.has(c)) colors.set(c, []);
    colors.get(c).push(Number(r.price));
  }
  let emitted = 0;
  for (const [product, colors] of byProduct.entries()) {
    const baseArr = colors.get("BASE") ?? colors.get("REFRACTOR"); // fallback baseline
    if (!baseArr || baseArr.length < 20) continue;                  // need baseline sample
    const baseMed = median(baseArr);
    if (!baseMed || baseMed <= 0) continue;
    const multipliers = { BASE: 1.00 };
    let sampleSize = baseArr.length;
    for (const [color, prices] of colors.entries()) {
      if (color === "BASE") continue;
      const m = median(prices);
      if (m == null || m <= 0) continue;
      multipliers[color] = m / baseMed;
      sampleSize += prices.length;
    }
    if (APPLY) {
      await upsertCalibration({
        dimension: "colorLadderMultiplier",
        scope: product,
        windowDays: WINDOW_DAYS,
        computedAt,
        multipliers,
        sampleSize,
        confidence: confidence(sampleSize),
      });
    }
    emitted++;
  }
  console.log(`  colorLadderMultiplier: ${emitted} products calibrated`);
}

// Global multipliers (edition, finish, autoStyle, gradeTier).
async function computeGlobalMultipliers(rows, computedAt) {
  const emit = async (dimension, keyFn, baselineKeyFn) => {
    const groups = new Map();
    const baseline = [];
    for (const r of rows) {
      const k = keyFn(r);
      const b = baselineKeyFn(r);
      if (k) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(Number(r.price));
      }
      if (b) baseline.push(Number(r.price));
    }
    if (baseline.length < 20) return 0;
    const baseMed = median(baseline);
    if (!baseMed || baseMed <= 0) return 0;
    const multipliers = {};
    let sampleSize = baseline.length;
    for (const [k, prices] of groups.entries()) {
      const m = median(prices);
      if (m == null || m <= 0) continue;
      multipliers[k] = m / baseMed;
      sampleSize += prices.length;
    }
    if (Object.keys(multipliers).length === 0) return 0;
    if (APPLY) {
      await upsertCalibration({
        dimension,
        scope: "global",
        windowDays: WINDOW_DAYS,
        computedAt,
        multipliers,
        sampleSize,
        confidence: confidence(sampleSize),
      });
    }
    console.log(`  ${dimension}: ${Object.keys(multipliers).length} keys calibrated`);
    return 1;
  };

  await emit("editionPremium",
    r => r.composite?.edition,
    r => r.composite?.edition == null ? true : null);  // baseline = non-edition rows
  await emit("finishPremium",
    r => r.composite?.finishModifier,
    r => r.composite?.finishModifier == null ? true : null);
  await emit("autoStylePremium",
    r => r.autoStyle,
    r => r.autoStyle == null ? true : null);
  await emit("gradeTierMultiplier",
    r => r.gradeCompany && r.gradeValue != null ? `${String(r.gradeCompany).toUpperCase()}_${r.gradeValue}` : null,
    r => !r.gradeCompany ? true : null);  // baseline = raw
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[refresh-calibration-multipliers]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  window: ${WINDOW_DAYS} days\n`);

  const now = Date.now();
  const computedAt = new Date(now).toISOString();
  const sinceIso = new Date(now - WINDOW_DAYS * 86400000).toISOString();
  const rows = await fetchSample(sc, sinceIso);
  console.log(`  ${rows.length} sales with composite in window\n`);

  await computeColorLadder(rows, computedAt);
  await computeGlobalMultipliers(rows, computedAt);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  computedAt: ${computedAt}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set CALIBRATION_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
