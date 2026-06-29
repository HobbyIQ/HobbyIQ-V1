// CF-PARALLEL-PREMIUM-CALIBRATION (2026-06-28) — empirical calibration of
// the chromeDraftMultipliers worksheet from CardHedge data. Same loop
// pattern as auto-multiplier-calibrate, but for parallel-over-base-auto
// ratios per (year, set, parallel, printRun).
//
// Algorithm:
//   1. For each target (year+set+parallel+printRun) combo:
//      a. Find all cards in CH matching that combo (search-by-grade or by
//         description token match)
//      b. For each card, also fetch the base-auto's raw 90d avg price
//      c. Compute parallel_raw / base_auto_raw ratio
//   2. Aggregate per combo: trimmed-median ratio + sample size + range
//   3. Output: parallel-premiums-latest.json
//
// Engine reads this file in getBuildBPremium and prefers it over the
// hand-maintained chromeDraftMultipliers static entries when present.

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.cardhedger.com/v1";

// Target combos — full prospect-auto rainbow for the active years. Expand
// over time. Untraded parallels (Devin Taylor Green Auto class) get
// priced via Build B's base-auto × empirical parallel-premium derivation.
//
// `isAuto` (CF-PARALLEL-FILTER-FIX 2026-06-29): when true, search/filter
// for autograph cards (CPA-XX) and ratio against the base auto. When
// false, search/filter for non-auto base parallels and ratio against
// the vanilla base SKU. Bowman Chrome Prospects' rainbow parallels are
// dominantly autograph (CPA-XX), so isAuto=true. Bowman Draft Chrome's
// standard refractors (Green/Blue/Gold/Orange /99/150/50/25) exist as
// BOTH base and autograph variants — these combos calibrate the base
// variant. Pre-fix the script silently dropped these (looksAuto filter
// hardcoded to require autograph signal) → all 4 BDC combos returned
// "no_parallel_cards_found" despite the catalog having plenty of data.
const TARGETS = [
  // 2025 Bowman Chrome Prospects — Lava series (autograph-dominant)
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Green Lava Refractor", printRun: "/150", searchToken: "Green Lava", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Yellow Lava Refractor", printRun: "/75", searchToken: "Yellow Lava", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Orange Lava Refractor", printRun: "/25", searchToken: "Orange Lava", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Red Lava Refractor",  printRun: "/5",   searchToken: "Red Lava", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Speckle Refractor",   printRun: "/299", searchToken: "Speckle Refractor", isAuto: false },
  // 2025 Bowman Chrome Prospects — regular rainbow refractors (autograph-dominant in this set)
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Green Refractor",     printRun: "/99",  searchToken: "Green Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Blue Refractor",      printRun: "/150", searchToken: "Blue Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Aqua Refractor",      printRun: "/125", searchToken: "Aqua Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Purple Refractor",    printRun: "/250", searchToken: "Purple Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Gold Refractor",      printRun: "/50",  searchToken: "Gold Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Orange Refractor",    printRun: "/25",  searchToken: "Orange Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Red Refractor",       printRun: "/5",   searchToken: "Red Refractor", isAuto: true },
  { year: 2025, set: "Bowman Chrome Prospects", parallel: "Black Refractor",     printRun: "/1",   searchToken: "Black Refractor", isAuto: true },
  // 2025 Bowman Draft Chrome — base variants (NOT autograph). 4 BDC
  // combos pre-CF returned "no_parallel_cards_found" despite catalog
  // returning 25 cards each on the probe; isAuto:false lets them pair.
  { year: 2025, set: "Bowman Draft Chrome", parallel: "Green Refractor",         printRun: "/99",  searchToken: "Green Refractor", isAuto: false },
  { year: 2025, set: "Bowman Draft Chrome", parallel: "Blue Refractor",          printRun: "/150", searchToken: "Blue Refractor", isAuto: false },
  { year: 2025, set: "Bowman Draft Chrome", parallel: "Gold Refractor",          printRun: "/50",  searchToken: "Gold Refractor", isAuto: false },
  { year: 2025, set: "Bowman Draft Chrome", parallel: "Orange Refractor",        printRun: "/25",  searchToken: "Orange Refractor", isAuto: false },
];

async function postJson(p, body, apiKey) {
  const res = await fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

async function findCardsForCombo(combo, apiKey) {
  // Search by the combo's distinctive parallel token + year + set.
  const search = `${combo.year} ${combo.set} ${combo.searchToken}`;
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
      // Keep cards whose description/variant contains the parallel token
      // AND have non-zero 90d sales.
      //
      // CF-PARALLEL-FILTER-FIX (2026-06-29): per-combo isAuto. When the
      // combo is autograph-class (Bowman Chrome Prospects rainbow),
      // require an auto signal in the card. When non-auto (Bowman Draft
      // Chrome base parallels, Speckle /299), require ABSENCE of auto
      // so we calibrate the base parallel ratio, not the auto. Pre-fix,
      // the looksAuto check was hardcoded as a required gate — silently
      // dropped non-auto base parallels and produced 0-sample combos.
      const wantsAuto = combo.isAuto !== false;
      for (const c of cards) {
        const blob = `${c.description ?? ""} ${c.variant ?? ""} ${c.search_text ?? ""}`.toLowerCase();
        const looksAuto = blob.includes(" auto") || blob.includes("autograph");
        if (wantsAuto && !looksAuto) continue;
        if (!wantsAuto && looksAuto) continue;
        if (!blob.includes(combo.searchToken.toLowerCase())) continue;
        const price = parseFloat(c.price);
        const sales = Number(c["90_day_sales"] ?? 0);
        if (!Number.isFinite(price) || price <= 0 || sales < 1) continue;
        all.push({
          card_id: c.card_id,
          description: c.description,
          player: c.player,
          variant: c.variant,
          parallelPrice: price,
          parallelSales: sales,
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

async function findBaseAutoForPlayer(player, year, setHint, apiKey) {
  // Find the base-auto card for this player + year + set. The base auto
  // for prospects is the CPA-XX or BCPA-XX with variant "Base".
  const search = `${year} ${setHint} ${player} auto`;
  try {
    const r = await postJson(
      "/cards/90day-prices-by-grade-search",
      { search, category: "Baseball", grade: "Raw", page: 1, page_size: 20 },
      apiKey,
    );
    const cards = Array.isArray(r?.cards) ? r.cards : [];
    // Filter to base autos: variant === "Base" + player matches.
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
    return { card_id: bc.card_id, price, sales: Number(bc["90_day_sales"] ?? 0) };
  } catch {
    return null;
  }
}

/**
 * CF-PARALLEL-FILTER-FIX (2026-06-29): non-auto base lookup. For combos
 * where isAuto=false (Bowman Draft Chrome base refractors, Speckle /299),
 * the parallel-over-base ratio is computed against the vanilla BASE
 * insert SKU (BCP-XX with variant="Base"), NOT the base auto. Mirror of
 * findBaseAutoForPlayer with auto-rejection instead of auto-requirement.
 */
async function findBaseForPlayer(player, year, setHint, apiKey) {
  const search = `${year} ${setHint} ${player}`;
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
    return { card_id: bc.card_id, price, sales: Number(bc["90_day_sales"] ?? 0) };
  } catch {
    return null;
  }
}

async function calibrateCombo(combo, apiKey) {
  console.log(`\n[combo] ${combo.year} ${combo.set} ${combo.parallel} ${combo.printRun}`);
  const parallelCards = await findCardsForCombo(combo, apiKey);
  console.log(`  found ${parallelCards.length} parallel cards`);
  if (parallelCards.length === 0) {
    return { combo, ratios: [], skipped: "no_parallel_cards_found" };
  }

  // For each parallel card, find the base reference for the same player.
  // CF-PARALLEL-FILTER-FIX (2026-06-29): branch on combo.isAuto so non-
  // auto combos compare against the vanilla base insert, not the base auto.
  const wantsAuto = combo.isAuto !== false;
  const ratios = [];
  for (const pc of parallelCards.slice(0, 30)) {  // cap at 30 per combo to bound API calls
    const baseRef = wantsAuto
      ? await findBaseAutoForPlayer(pc.player, combo.year, combo.set, apiKey)
      : await findBaseForPlayer(pc.player, combo.year, combo.set, apiKey);
    if (!baseRef || baseRef.price <= 0) continue;
    const ratio = pc.parallelPrice / baseRef.price;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) continue;
    ratios.push({
      player: pc.player,
      parallelPrice: pc.parallelPrice,
      basePrice: baseRef.price,
      ratio,
    });
  }

  const numbers = ratios.map((r) => r.ratio);
  const med = trimmedMedian(numbers, 0.1);
  const fullMed = median(numbers);
  console.log(`  paired ${ratios.length}, trimmed-median ratio = ${med?.toFixed(3) ?? "n/a"} (full-median ${fullMed?.toFixed(3) ?? "n/a"})`);

  return {
    combo,
    sampleSize: ratios.length,
    trimmedMedianRatio: med != null ? Math.round(med * 1000) / 1000 : null,
    fullMedianRatio: fullMed != null ? Math.round(fullMed * 1000) / 1000 : null,
    minRatio: numbers.length ? Math.round(Math.min(...numbers) * 1000) / 1000 : null,
    maxRatio: numbers.length ? Math.round(Math.max(...numbers) * 1000) / 1000 : null,
    p25: numbers.length ? Math.round(trimmedMedian(numbers, 0.25) * 1000) / 1000 : null,
    p75: numbers.length ? Math.round(trimmedMedian(numbers, 0.75) * 1000) / 1000 : null,
    pairs: ratios,
  };
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) { console.error("CARD_HEDGE_API_KEY missing"); process.exit(1); }

  console.log(`[parallel-calibrate] processing ${TARGETS.length} target combos`);
  const results = [];
  for (const t of TARGETS) {
    results.push(await calibrateCombo(t, apiKey));
  }

  // Build the output table — same structure pattern as auto-multipliers
  const output = {
    calibratedAt: new Date().toISOString(),
    method: "parallel_over_base_auto_empirical",
    sampleSize: { totalCombos: results.length, totalPairs: results.reduce((s, r) => s + (r.sampleSize ?? 0), 0) },
    entries: results.map((r) => ({
      year: r.combo.year,
      set: r.combo.set,
      parallel: r.combo.parallel,
      printRun: r.combo.printRun,
      baseRelativePremium: r.trimmedMedianRatio,
      sampleSize: r.sampleSize ?? 0,
      ratioRange: [r.minRatio, r.maxRatio],
      p25: r.p25,
      p75: r.p75,
      provenance: r.sampleSize >= 5 ? "empirical" : "thin_provisional",
      skippedReason: r.skipped ?? null,
    })),
  };

  const outPath = path.join(__dirname, "parallel-premiums-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[parallel-calibrate] DONE → ${outPath}`);
  console.log(`Total pairs: ${output.sampleSize.totalPairs}`);
  console.log();
  console.log("=== Calibrated entries ===");
  output.entries.forEach((e) => {
    if (e.baseRelativePremium != null) {
      console.log(`  ${e.year} ${e.set} ${e.parallel} ${e.printRun}: ${e.baseRelativePremium}× (n=${e.sampleSize}, [${e.ratioRange[0]}, ${e.ratioRange[1]}], ${e.provenance})`);
    } else {
      console.log(`  ${e.year} ${e.set} ${e.parallel} ${e.printRun}: NO DATA (${e.skippedReason ?? "no pairs"})`);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(99); });
