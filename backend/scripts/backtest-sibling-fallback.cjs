#!/usr/bin/env node
/**
 * CF-SIBLING-FALLBACK-BACKTEST (2026-07-07, Drew):
 *
 * Backtest the sibling-card price fallback against ground truth. For
 * each target parallel that HAS observed sales, we:
 *   1. Predict via the sibling path AS IF the target had no comps
 *      (fetch sibling's Base Auto median × parallel-premium floor)
 *   2. Compare to the target's ACTUAL Raw weighted median
 *   3. Report per-target error + distribution
 *
 * This validates whether the hobby-consensus floors (Orange = 15×,
 * Gold = 8×, Blue = 3×, etc.) and the cross-class 10× premium track
 * real market prices — critical because these are hand-tuned constants
 * that will govern estimated prices for THIN-market cards where no
 * ground truth exists.
 *
 * Algorithm:
 *   1. Pick target parallel cards from CH catalog (Orange /25, Gold /50,
 *      Blue /150, etc.) that HAVE Raw sales in the 90-day window.
 *   2. For each target, fetch the player's Base Auto in the same set.
 *   3. Compute sibling estimate = baseAuto.rawMedian × floor multiplier.
 *   4. Fetch target's actual raw weighted median.
 *   5. Error = (estimate - actual) / actual.
 *   6. Aggregate: median-absolute-percentage-error (MAPE), median
 *      signed error (bias), distribution buckets.
 *
 * Output: backend/data/sibling-fallback-backtest-latest.json
 *
 * Interpretation:
 *   - MAPE < 20% → floors are well-tuned; ship confidence
 *   - Signed bias > +25% → floors OVERSTATE — recalibrate downward
 *   - Signed bias < -25% → floors UNDERSTATE — recalibrate upward
 *     (matches Willits case that motivated PR #303)
 *
 * Secrets: reads CARD_HEDGE_API_KEY from env. Never echoes to stdout.
 */

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.cardhedger.com/v1";

// Print-run inference — MUST mirror
// backend/src/services/compiq/parallelPremiumFloors.ts. Duplicated
// intentionally (this is a diagnostic script; adding a `dist/` compile
// step for one .cjs script isn't worth the CI wiring).
const PARALLEL_TO_FLOOR = [
  { rx: /superfractor|printing[\s-]?plate/i,             floor: 100, printRun: 1 },
  { rx: /(^|\s)red(\s|$|\s+refractor|\s+x-fractor)/i,   floor: 40,  printRun: 5 },
  { rx: /orange\s+shimmer/i,                             floor: 30,  printRun: 10 },
  { rx: /(^|\s)orange(\s|$|\s+refractor|\s+x-fractor)/i, floor: 15, printRun: 25 },
  { rx: /(^|\s)gold(\s|$|\s+refractor|\s+x-fractor)/i,   floor: 8,   printRun: 50 },
  { rx: /aqua/i,                                          floor: 5,   printRun: 75 },
  { rx: /(^|\s)blue(\s|$|\s+refractor|\s+x-fractor)/i,  floor: 3,   printRun: 150 },
  { rx: /purple\s+(refractor|x-fractor)/i,               floor: 2,   printRun: 250 },
  { rx: /green\s+(refractor|x-fractor)/i,                floor: 1.5, printRun: 499 },
];

// (year, set, parallelToken) triples with strong closed-sale coverage
// so backtesting has ground truth to compare against.
const TARGETS = [
  { year: 2024, set: "Bowman Chrome Prospects", parallelToken: "Orange",   isAuto: true },
  { year: 2024, set: "Bowman Chrome Prospects", parallelToken: "Gold",     isAuto: true },
  { year: 2024, set: "Bowman Chrome Prospects", parallelToken: "Blue",     isAuto: true },
  { year: 2023, set: "Bowman Chrome Prospects", parallelToken: "Orange",   isAuto: true },
  { year: 2023, set: "Bowman Chrome Prospects", parallelToken: "Gold",     isAuto: true },
  { year: 2023, set: "Bowman Chrome Prospects", parallelToken: "Blue",     isAuto: true },
  { year: 2023, set: "Bowman Chrome Prospects", parallelToken: "Aqua",     isAuto: true },
  { year: 2024, set: "Bowman Draft Chrome",     parallelToken: "Orange",   isAuto: true },
  { year: 2024, set: "Bowman Draft Chrome",     parallelToken: "Blue",     isAuto: true },
  { year: 2024, set: "Topps Chrome",             parallelToken: "Orange",  isAuto: false },
  { year: 2024, set: "Topps Chrome",             parallelToken: "Blue",    isAuto: false },
];

async function postJson(p, body, apiKey) {
  const res = await fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function inferFloor(parallelToken) {
  for (const rule of PARALLEL_TO_FLOOR) {
    if (rule.rx.test(parallelToken)) return rule;
  }
  return null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[idx];
}

async function findParallelCards(target, apiKey) {
  const search = `${target.year} ${target.set} ${target.parallelToken}`;
  const all = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const r = await postJson(
        "/cards/90day-prices-by-grade-search",
        { search, category: "Baseball", grade: "Raw", page, page_size: 100 },
        apiKey,
      );
      const cards = Array.isArray(r?.cards) ? r.cards : [];
      if (!cards.length) break;
      for (const c of cards) {
        const blob = `${c.description ?? ""} ${c.variant ?? ""} ${c.search_text ?? ""}`.toLowerCase();
        const isAuto = blob.includes(" auto") || blob.includes("autograph");
        if (target.isAuto !== isAuto) continue;
        if (!blob.includes(target.parallelToken.toLowerCase())) continue;
        const price = parseFloat(c.price);
        const sales = Number(c["90_day_sales"] ?? 0);
        // We need REAL ground truth — target must have actual sales.
        if (!Number.isFinite(price) || price <= 0 || sales < 2) continue;
        all.push({
          card_id: c.card_id,
          player: c.player,
          variant: c.variant,
          actualRawMedian: price,
          actualSales: sales,
        });
      }
      if (cards.length < 100) break;
    } catch (err) {
      console.warn(`  page ${page} of "${search}" failed: ${err.message}`);
      break;
    }
  }
  return all;
}

async function findBaseAutoForPlayer(player, year, set, apiKey) {
  const search = `${year} ${set} ${player} auto`;
  try {
    const r = await postJson(
      "/cards/90day-prices-by-grade-search",
      { search, category: "Baseball", grade: "Raw", page: 1, page_size: 20 },
      apiKey,
    );
    const cards = Array.isArray(r?.cards) ? r.cards : [];
    const baseAutos = cards.filter((c) => {
      const variantBase = (c.variant ?? "").toLowerCase() === "base";
      const blob = `${c.description ?? ""} ${c.search_text ?? ""}`.toLowerCase();
      const isAuto = blob.includes(" auto") || blob.includes("autograph");
      const playerMatch = (c.player ?? "").toLowerCase() === player.toLowerCase();
      return variantBase && isAuto && playerMatch;
    });
    if (baseAutos.length === 0) return null;
    const bc = baseAutos[0];
    const price = parseFloat(bc.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { card_id: bc.card_id, rawMedian: price };
  } catch {
    return null;
  }
}

async function backtestTarget(target, apiKey) {
  console.log(`\n[target] ${target.year} ${target.set} ${target.parallelToken} auto=${target.isAuto}`);
  const floor = inferFloor(target.parallelToken);
  if (!floor) {
    console.log(`  no floor for parallel "${target.parallelToken}" — skipping`);
    return { target, results: [], skipped: "no_floor_match" };
  }
  const parallelCards = await findParallelCards(target, apiKey);
  console.log(`  found ${parallelCards.length} target cards with actual sales`);

  const results = [];
  // Cap at 25 per target to bound API calls.
  for (const pc of parallelCards.slice(0, 25)) {
    const baseAuto = await findBaseAutoForPlayer(pc.player, target.year, target.set, apiKey);
    if (!baseAuto) continue;
    // Sibling-fallback estimate — mirrors what the engine would produce
    // for a thin-market card: baseAuto median × floor multiplier.
    const estimated = baseAuto.rawMedian * floor.floor;
    const actual = pc.actualRawMedian;
    const errorPct = ((estimated - actual) / actual) * 100;
    results.push({
      player: pc.player,
      cardId: pc.card_id,
      variant: pc.variant,
      baseAutoRawMedian: baseAuto.rawMedian,
      floorMultiplier: floor.floor,
      estimatedRawPrice: Math.round(estimated * 100) / 100,
      actualRawMedian: actual,
      errorPct: Math.round(errorPct * 10) / 10,
      absErrorPct: Math.round(Math.abs(errorPct) * 10) / 10,
    });
  }
  console.log(`  backtested ${results.length} pairs`);
  return { target, floor, results };
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) {
    console.error("CARD_HEDGE_API_KEY missing");
    process.exit(1);
  }

  const outDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "sibling-fallback-backtest-latest.json");

  const perTarget = [];
  for (const t of TARGETS) {
    perTarget.push(await backtestTarget(t, apiKey));
  }

  const allResults = perTarget.flatMap((t) => t.results);
  const signedErrors = allResults.map((r) => r.errorPct);
  const absErrors = allResults.map((r) => r.absErrorPct);

  const output = {
    backtestedAt: new Date().toISOString(),
    totalPairs: allResults.length,
    mape: median(absErrors),  // median absolute percentage error
    medianSignedBias: median(signedErrors),  // positive = engine overstates
    absErrorDistribution: {
      p25: percentile(absErrors, 0.25),
      p50: percentile(absErrors, 0.50),
      p75: percentile(absErrors, 0.75),
      p90: percentile(absErrors, 0.90),
    },
    signedErrorDistribution: {
      p10: percentile(signedErrors, 0.10),
      p25: percentile(signedErrors, 0.25),
      p50: percentile(signedErrors, 0.50),
      p75: percentile(signedErrors, 0.75),
      p90: percentile(signedErrors, 0.90),
    },
    perTarget: perTarget.map((t) => ({
      year: t.target.year,
      set: t.target.set,
      parallel: t.target.parallelToken,
      isAuto: t.target.isAuto,
      floorMultiplier: t.floor?.floor ?? null,
      printRun: t.floor?.printRun ?? null,
      pairs: t.results.length,
      mape: median(t.results.map((r) => r.absErrorPct)),
      medianSignedBias: median(t.results.map((r) => r.errorPct)),
    })),
    allPairs: allResults,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n[backtest-sibling-fallback] DONE → ${outPath}`);
  console.log(`Total pairs backtested: ${allResults.length}`);
  console.log(`Overall MAPE: ${output.mape}%`);
  console.log(`Overall median signed bias: ${output.medianSignedBias}% (positive = engine overstates)`);
  console.log(`\nPer-parallel breakdown:`);
  for (const t of output.perTarget) {
    if (t.pairs === 0) continue;
    console.log(
      `  ${t.year} ${t.set} ${t.parallel} (auto=${t.isAuto}, /${t.printRun}, floor=${t.floorMultiplier}×): ` +
      `n=${t.pairs}, MAPE=${t.mape}%, bias=${t.medianSignedBias}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
