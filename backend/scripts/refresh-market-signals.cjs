#!/usr/bin/env node
// CF-REFRESH-MARKET-SIGNALS (Drew, 2026-07-30). Nightly compute that
// writes momentum signals per (dimension, key) to the market_signals
// container. Runs at 5:30 AM ET via daily-market-signals.yml — after
// the 5:00 AM CH ingest completes so the freshest sales are in the
// pool.
//
// Dimensions computed (all use last 30d vs prior 30d):
//   colorFamily     — BLUE / GOLD / SPECKLE / etc.
//   edition         — SAPPHIRE / MEGA_BOX / etc.
//   finishModifier  — WAVE / SHIMMER / VINYL / etc.
//   insertSet       — scouts-top-100 / home-run-challenge / etc.
//   sport           — baseball / basketball / football / hockey
//   productLine     — bowman-chrome / topps-heritage / etc.
//   isAuto          — true / false
//   autoStyle       — on-card / sticker
//   gradeTier       — PSA 10, BGS 9.5, raw, etc.
//
// Env:
//   COSMOS_CONNECTION_STRING       — required
//   MARKET_SIGNALS_APPLY=true       — actually write (default true; set
//                                      "false" for dry-run diagnostics)
//   MARKET_SIGNALS_WINDOW_DAYS=30   — rolling window
//   MARKET_SIGNALS_MIN_VOLUME=20    — min combined sample size to emit
//                                      a signal (avoids noisy micro-groups)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { upsertMomentumSignal } = require(path.join(backend, "dist/services/portfolioiq/marketMomentum.service.js"));

const APPLY = process.env.MARKET_SIGNALS_APPLY !== "false";
const WINDOW_DAYS = Number(process.env.MARKET_SIGNALS_WINDOW_DAYS || "30");
const MIN_VOLUME = Number(process.env.MARKET_SIGNALS_MIN_VOLUME || "20");

async function fetchRecentSales(sc, sinceIso) {
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
    if (rows.length % 25000 < 5000) process.stdout.write(`\r  fetching ${rows.length}`);
  }
  console.log(`\r  ${rows.length} sales with composite since ${sinceIso}                     `);
  return rows;
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function groupBy(rows, keyFn) {
  const groups = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null || k === "") continue;
    if (!groups[k]) groups[k] = [];
    groups[k].push(Number(r.price));
  }
  return groups;
}

async function emitDimension(name, currGroups, priorGroups, computedAt) {
  const allKeys = new Set([...Object.keys(currGroups), ...Object.keys(priorGroups)]);
  let emitted = 0;
  for (const key of allKeys) {
    const curr = currGroups[key] ?? [];
    const prior = priorGroups[key] ?? [];
    const combined = curr.length + prior.length;
    if (combined < MIN_VOLUME) continue;
    const currMed = median(curr);
    const priorMed = median(prior);
    const volumeMomentum = prior.length > 0 ? (curr.length / prior.length - 1) : null;
    const priceMomentum = (currMed != null && priorMed != null && priorMed > 0)
      ? (currMed / priorMed - 1) : null;
    const metrics = {
      currVolume: curr.length,
      priorVolume: prior.length,
      volumeMomentum,
      currMedian: currMed,
      priorMedian: priorMed,
      priceMomentum,
      sampleSize: combined,
    };
    if (APPLY) {
      await upsertMomentumSignal({
        dimension: name,
        key: String(key),
        windowDays: WINDOW_DAYS,
        computedAt,
        metrics,
      });
    }
    emitted++;
  }
  console.log(`  ${name}: ${emitted} signals emitted`);
  return emitted;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[refresh-market-signals]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  window: ${WINDOW_DAYS} days`);
  console.log(`  min volume: ${MIN_VOLUME}\n`);

  const now = Date.now();
  const computedAt = new Date(now).toISOString();
  const currStart = now - WINDOW_DAYS * 86400000;
  const priorStart = now - 2 * WINDOW_DAYS * 86400000;
  const rows = await fetchRecentSales(sc, new Date(priorStart).toISOString());
  const curr = rows.filter(r => new Date(r.soldAt).getTime() >= currStart);
  const prior = rows.filter(r => new Date(r.soldAt).getTime() < currStart);
  console.log(`\n  Current ${WINDOW_DAYS}d: ${curr.length} sales`);
  console.log(`  Prior ${WINDOW_DAYS}d:   ${prior.length} sales\n`);

  const productFromSlug = (r) => {
    const parts = String(r.hobbyiqCardId || "").split(":");
    return parts[3] ?? null;
  };
  const gradeKey = (r) => r.gradeCompany && r.gradeValue != null ? `${r.gradeCompany}_${r.gradeValue}` : "raw";

  let total = 0;
  total += await emitDimension("colorFamily",
    groupBy(curr, r => r.composite?.colorFamily),
    groupBy(prior, r => r.composite?.colorFamily),
    computedAt);
  total += await emitDimension("edition",
    groupBy(curr, r => r.composite?.edition),
    groupBy(prior, r => r.composite?.edition),
    computedAt);
  total += await emitDimension("finishModifier",
    groupBy(curr, r => r.composite?.finishModifier),
    groupBy(prior, r => r.composite?.finishModifier),
    computedAt);
  total += await emitDimension("insertSet",
    groupBy(curr, r => r.composite?.insertSet),
    groupBy(prior, r => r.composite?.insertSet),
    computedAt);
  total += await emitDimension("sport",
    groupBy(curr, r => (r.sport || "unknown").toLowerCase()),
    groupBy(prior, r => (r.sport || "unknown").toLowerCase()),
    computedAt);
  total += await emitDimension("productLine",
    groupBy(curr, productFromSlug),
    groupBy(prior, productFromSlug),
    computedAt);
  total += await emitDimension("isAuto",
    groupBy(curr, r => r.isAuto === true ? "true" : "false"),
    groupBy(prior, r => r.isAuto === true ? "true" : "false"),
    computedAt);
  total += await emitDimension("autoStyle",
    groupBy(curr, r => r.autoStyle),
    groupBy(prior, r => r.autoStyle),
    computedAt);
  total += await emitDimension("gradeTier",
    groupBy(curr, gradeKey),
    groupBy(prior, gradeKey),
    computedAt);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  Signals emitted: ${total}`);
  console.log(`  computedAt:      ${computedAt}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set MARKET_SIGNALS_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
