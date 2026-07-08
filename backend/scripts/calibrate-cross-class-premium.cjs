#!/usr/bin/env node
/**
 * CF-CROSS-CLASS-PREMIUM-CALIBRATION (2026-07-07, Drew):
 *
 * Empirical calibration of the cross-class auto premium used by
 * siblingCardPriceFallback when a player has no Base Auto SKU but
 * does have a plain Base card in the same set. The current fallback
 * hardcodes 10× as a hobby-consensus anchor:
 *
 *    baseCardMedian × 10 → baseAutoAnchor → × parallelFloor → target
 *
 * This script computes the empirical median-of-medians ratio across
 * player-set pairs where BOTH Base Auto AND Base card comps exist,
 * so we can validate or replace the 10× guess.
 *
 * Algorithm:
 *   1. Iterate over a curated seed list of (year, set) pairs where
 *      both variants ship (Bowman Chrome, Bowman Draft Chrome, Topps
 *      Chrome, Panini Prizm, etc.).
 *   2. For each seed, search CH for players with published Base Auto
 *      SKUs (variant="Base" + auto signal in description).
 *   3. For each such player, look up the Base card (variant="Base",
 *      no auto signal) in the same set.
 *   4. When both exist AND both have Raw 90d avg price > 0, record
 *      ratio = baseAutoPrice / basePrice.
 *   5. Aggregate: trimmed-median across all pairs = empirical
 *      cross-class premium. Report distribution (min/p10/p25/median/
 *      p75/p90/max) so we can size the tail.
 *
 * Output: backend/data/cross-class-auto-premium-latest.json
 *
 * When empirical median >= 10, the current 10× guess is CONSERVATIVE
 * (safe; may under-estimate hot players). When empirical median < 10,
 * the guess is OVERSTATING and we should lower it. Distribution tail
 * (p90+) tells us how much to trust a single-player floor value.
 *
 * Secrets: reads CARD_HEDGE_API_KEY from env. Never echoes to stdout.
 */

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.cardhedger.com/v1";

// Seed list of high-yield (year, set) pairs for cross-class ratio
// sampling. Chosen for products where BOTH Base card and Base Auto
// SKUs ship for a large fraction of the checklist.
const SEEDS = [
  { year: 2025, set: "Bowman Chrome Prospects" },
  { year: 2025, set: "Bowman Draft Chrome" },
  { year: 2024, set: "Bowman Chrome Prospects" },
  { year: 2024, set: "Bowman Draft Chrome" },
  { year: 2023, set: "Bowman Chrome Prospects" },
  { year: 2024, set: "Topps Chrome" },
  { year: 2023, set: "Topps Chrome" },
  { year: 2024, set: "Panini Prizm" },
  { year: 2023, set: "Panini Prizm" },
  { year: 2024, set: "Panini Select" },
];

async function postJson(p, body, apiKey) {
  const res = await fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `${p} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res.json();
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function trimmedMedian(arr, trimPct = 0.1) {
  if (arr.length < 3) return median(arr);
  const s = arr.slice().sort((a, b) => a - b);
  const trim = Math.floor(s.length * trimPct);
  return median(s.slice(trim, s.length - trim));
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[idx];
}

// Fetch base autos across a set (up to 5 pages of 100).
async function findBaseAutosInSet(year, set, apiKey) {
  const search = `${year} ${set} auto`;
  const all = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const r = await postJson(
        "/cards/90day-prices-by-grade-search",
        { search, category: "Baseball", grade: "Raw", page, page_size: 100 },
        apiKey,
      );
      const cards = Array.isArray(r?.cards) ? r.cards : [];
      if (!cards.length) break;
      for (const c of cards) {
        const variantBase = (c.variant ?? "").toLowerCase() === "base";
        if (!variantBase) continue;
        const blob = `${c.description ?? ""} ${c.variant ?? ""} ${c.search_text ?? ""}`.toLowerCase();
        const isAuto = blob.includes(" auto") || blob.includes("autograph");
        if (!isAuto) continue;
        const player = (c.player ?? "").trim();
        if (!player) continue;
        const price = parseFloat(c.price);
        const sales = Number(c["90_day_sales"] ?? 0);
        if (!Number.isFinite(price) || price <= 0 || sales < 1) continue;
        all.push({ card_id: c.card_id, player, price, sales });
      }
      if (cards.length < 100) break;
    } catch (err) {
      console.warn(`  page ${page} of "${search}" failed: ${err.message}`);
      break;
    }
  }
  return all;
}

async function findBaseForPlayer(player, year, set, apiKey) {
  const search = `${year} ${set} ${player}`;
  try {
    const r = await postJson(
      "/cards/90day-prices-by-grade-search",
      { search, category: "Baseball", grade: "Raw", page: 1, page_size: 20 },
      apiKey,
    );
    const cards = Array.isArray(r?.cards) ? r.cards : [];
    const bases = cards.filter((c) => {
      const variantBase = (c.variant ?? "").toLowerCase() === "base";
      const blob = `${c.description ?? ""} ${c.search_text ?? ""}`.toLowerCase();
      const isAuto = blob.includes(" auto") || blob.includes("autograph");
      const playerMatch = (c.player ?? "").toLowerCase() === player.toLowerCase();
      return variantBase && !isAuto && playerMatch;
    });
    if (bases.length === 0) return null;
    const bc = bases[0];
    const price = parseFloat(bc.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      card_id: bc.card_id,
      price,
      sales: Number(bc["90_day_sales"] ?? 0),
    };
  } catch {
    return null;
  }
}

async function calibrateSeed(seed, apiKey) {
  console.log(`\n[seed] ${seed.year} ${seed.set}`);
  const baseAutos = await findBaseAutosInSet(seed.year, seed.set, apiKey);
  console.log(`  found ${baseAutos.length} base-auto SKUs`);

  const pairs = [];
  // Cap to bound API calls per seed. 40 pairs × 10 seeds = 400 pairs
  // is plenty of statistical power for the median-of-medians.
  for (const ba of baseAutos.slice(0, 40)) {
    const base = await findBaseForPlayer(ba.player, seed.year, seed.set, apiKey);
    if (!base) continue;
    if (base.price <= 0 || ba.price <= 0) continue;
    const ratio = ba.price / base.price;
    // Guard against pathological ratios (data quality issue on one side).
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 200) continue;
    pairs.push({
      player: ba.player,
      basePrice: base.price,
      baseAutoPrice: ba.price,
      ratio: Math.round(ratio * 100) / 100,
    });
  }
  console.log(`  paired ${pairs.length} (base + base-auto both have comps)`);
  return { seed, pairs };
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) {
    console.error("CARD_HEDGE_API_KEY missing");
    process.exit(1);
  }

  const outDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "cross-class-auto-premium-latest.json");

  const perSeed = [];
  for (const seed of SEEDS) {
    perSeed.push(await calibrateSeed(seed, apiKey));
  }

  // Global aggregate — median-of-medians AND flat-pooled distribution.
  const perSeedMedians = perSeed
    .map((s) => {
      const rs = s.pairs.map((p) => p.ratio);
      return {
        seed: s.seed,
        sampleSize: rs.length,
        median: median(rs),
        trimmedMedian: trimmedMedian(rs, 0.1),
        min: rs.length ? Math.min(...rs) : null,
        max: rs.length ? Math.max(...rs) : null,
      };
    })
    .filter((s) => s.sampleSize >= 5);

  const allRatios = perSeed.flatMap((s) => s.pairs.map((p) => p.ratio));
  const globalMedianOfMedians = median(
    perSeedMedians.map((s) => s.trimmedMedian).filter((v) => v !== null),
  );
  const globalTrimmedFlat = trimmedMedian(allRatios, 0.1);

  const output = {
    calibratedAt: new Date().toISOString(),
    method: "cross_class_base_auto_over_base_empirical",
    currentHardcodedPremium: 10,   // what the engine uses today
    globalMedianOfMedians: globalMedianOfMedians !== null
      ? Math.round(globalMedianOfMedians * 100) / 100
      : null,
    globalTrimmedFlatMedian: globalTrimmedFlat !== null
      ? Math.round(globalTrimmedFlat * 100) / 100
      : null,
    distribution: {
      totalPairs: allRatios.length,
      min: allRatios.length ? Math.min(...allRatios) : null,
      p10: percentile(allRatios, 0.10),
      p25: percentile(allRatios, 0.25),
      median: percentile(allRatios, 0.50),
      p75: percentile(allRatios, 0.75),
      p90: percentile(allRatios, 0.90),
      max: allRatios.length ? Math.max(...allRatios) : null,
    },
    bySeed: perSeedMedians.map((s) => ({
      year: s.seed.year,
      set: s.seed.set,
      sampleSize: s.sampleSize,
      trimmedMedianRatio: s.trimmedMedian !== null
        ? Math.round(s.trimmedMedian * 100) / 100
        : null,
      medianRatio: s.median !== null ? Math.round(s.median * 100) / 100 : null,
      range: [s.min, s.max],
    })),
    pairs: perSeed.flatMap((s) =>
      s.pairs.map((p) => ({
        year: s.seed.year,
        set: s.seed.set,
        player: p.player,
        basePrice: p.basePrice,
        baseAutoPrice: p.baseAutoPrice,
        ratio: p.ratio,
      })),
    ),
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n[calibrate-cross-class] DONE → ${outPath}`);
  console.log(`Total pairs: ${allRatios.length}`);
  console.log(`Global median-of-medians: ${output.globalMedianOfMedians}×`);
  console.log(`Global trimmed flat median: ${output.globalTrimmedFlatMedian}×`);
  console.log(
    `Distribution: p10=${output.distribution.p10}× p25=${output.distribution.p25}× ` +
    `median=${output.distribution.median}× p75=${output.distribution.p75}× ` +
    `p90=${output.distribution.p90}×`,
  );
  console.log(`Current hardcoded engine value: 10×`);
  if (output.globalMedianOfMedians !== null) {
    const delta = output.globalMedianOfMedians - 10;
    const verdict =
      Math.abs(delta) < 1.5
        ? "10× is close to empirical — no change needed"
        : delta > 0
          ? `Empirical is HIGHER than 10× — engine is CONSERVATIVE (under-estimates hot players)`
          : `Empirical is LOWER than 10× — engine is OVERSTATING; consider lowering`;
    console.log(`Verdict: ${verdict}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
