// CF-PARALLEL-PREMIUM-FROM-POOL (Drew, 2026-08-07). Replaces
// calibrate-parallel-premiums.cjs which pulls prices from CardHedge
// (deprecated 2026-08-02, subscription lapses in ~25 days). This
// version computes parallel-over-base ratios directly from our own
// sold_comps pool, matching Drew's doctrine [[calibration-from-our-pool-only]]:
// every calibration constant derives from sold_comps grouped by
// identity, never keyed by a vendor.
//
// Algorithm (mirrors the CH-based script's shape so downstream
// consumers of parallel-premiums-latest.json see the same output
// structure):
//   For each combo (year, setNameHint, parallel, printRun, isAuto):
//     1. Resolve setNameHint → canonical setKey via computeHobbyIqCardId
//     2. Query sold_comps for parallel sales in the window:
//          WHERE year=Y AND setKey=K AND parallel≈P AND isAuto=A
//        Group by playerName; take median price per player.
//     3. Query sold_comps for the base counterpart per player:
//          WHERE year=Y AND setKey=K AND parallel="Base" AND
//                isAuto=A AND playerName=<same>
//        Median price per player.
//     4. Pair by playerName → compute parallelPrice / basePrice per player
//     5. Trimmed-median over the ratios → baseRelativePremium
//
// Output shape is IDENTICAL to the CH-based version so nothing
// downstream needs to change.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 write to parallel-premiums-latest.json
//                              (else writes to parallel-premiums-latest.dry.json
//                              so we can diff before swap)
//   WINDOW_DAYS=180            comp-recency window (default 180)
//   MIN_PAIRED=3               drop combos with fewer pairs than this
//                              from empirical to thin_provisional
//   MAX_COMBOS=0               cap for smoke-test runs; 0 = process all
//   RESUME=true                keep prior entries in output; only
//                              recompute new / stale combos (checkpoint
//                              behavior — matches prior script)
//   SETS_ONLY=<csv>            filter TARGETS to setNames containing any
//                              of these substrings (case-insensitive)

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const APPLY = process.env.APPLY === "true";
const WINDOW_DAYS = Math.max(30, Number(process.env.WINDOW_DAYS || 180));
const MIN_PAIRED = Math.max(1, Number(process.env.MIN_PAIRED || 3));
const MAX_COMBOS = Math.max(0, Number(process.env.MAX_COMBOS || 0));
const RESUME = process.env.RESUME !== "false";
const SETS_ONLY = (process.env.SETS_ONLY || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function loadNormalizer() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) {
    throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` in backend/ first`);
  }
  const mod = require(p);
  return {
    computeHobbyIqCardId: mod.computeHobbyIqCardId,
    normalizeSetKey: mod.normalizeSetKey,
    normalizeParallel: mod.normalizeParallel,
  };
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
function round3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }

function comboKey(c) {
  return `${c.year}|${c.set}|${c.parallel}|${c.isAuto !== false}`;
}

// Query all sold_comps rows for a (year, setKey) window with playerName
// bucketing done in-code (avoids one query per player). Returns:
//   Map<playerName, { parallelPrices: number[], basePrices: number[] }>
// Filters to rows with isAuto matching the combo + parallel matching
// the combo's slug OR "base" for the base group.
async function fetchPairedPrices(sc, combo, parallelSlug, cutoffIso) {
  // Grab all sold_comps rows for (year, setKey) that are either the
  // target parallel OR base — single scan, split in-code.
  const q = {
    query: `
      SELECT c.playerName, c.parallel, c.isAuto, c.price, c.soldAt
      FROM c
      WHERE c.cardYear = @year
        AND c.setKey = @setKey
        AND (c.parallel = @parallelSlug OR c.parallel = "base" OR c.parallel = "Base")
        AND c.isAuto = @isAuto
        AND c.soldAt >= @cutoff
        AND IS_DEFINED(c.playerName)
        AND c.price > 0
    `,
    parameters: [
      { name: "@year", value: combo.year },
      { name: "@setKey", value: combo.setKey },
      { name: "@parallelSlug", value: parallelSlug },
      { name: "@isAuto", value: combo.isAuto !== false },
      { name: "@cutoff", value: cutoffIso },
    ],
  };
  const iter = sc.items.query(q, { maxItemCount: 5000 });
  const buckets = new Map(); // playerName → { parallelPrices, basePrices }
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      const name = String(r.playerName || "").trim().toLowerCase();
      if (!name) continue;
      let b = buckets.get(name);
      if (!b) { b = { parallelPrices: [], basePrices: [] }; buckets.set(name, b); }
      const isBase = /^base$/i.test(String(r.parallel || ""));
      if (isBase) b.basePrices.push(Number(r.price));
      else b.parallelPrices.push(Number(r.price));
    }
  }
  return buckets;
}

async function calibrateCombo(sc, combo, normalize, cutoffIso) {
  const parallelSlug = normalize.normalizeParallel
    ? normalize.normalizeParallel(combo.parallel)
    : String(combo.parallel).toLowerCase().replace(/\s+/g, "-");
  const setKey = normalize.normalizeSetKey
    ? normalize.normalizeSetKey(combo.set)
    : String(combo.set).toLowerCase().replace(/\s+/g, "-");
  const c = { ...combo, setKey };

  let buckets;
  try {
    buckets = await fetchPairedPrices(sc, c, parallelSlug, cutoffIso);
  } catch (err) {
    console.warn(`  query failed: ${err?.message ?? err}`);
    return { combo, sampleSize: 0, skipped: "query_failed" };
  }

  const ratios = [];
  const pairs = [];
  for (const [player, b] of buckets) {
    if (!b.parallelPrices.length || !b.basePrices.length) continue;
    const pMed = median(b.parallelPrices);
    const bMed = median(b.basePrices);
    if (!(pMed > 0) || !(bMed > 0)) continue;
    const ratio = pMed / bMed;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) continue;
    ratios.push(ratio);
    pairs.push({ player, parallelPrice: pMed, basePrice: bMed, ratio: round3(ratio) });
  }

  const med = trimmedMedian(ratios, 0.1);
  const fullMed = median(ratios);
  return {
    combo,
    setKey,
    parallelSlug,
    sampleSize: ratios.length,
    trimmedMedianRatio: round3(med),
    fullMedianRatio: round3(fullMed),
    minRatio: ratios.length ? round3(Math.min(...ratios)) : null,
    maxRatio: ratios.length ? round3(Math.max(...ratios)) : null,
    p25: ratios.length ? round3(trimmedMedian(ratios, 0.25)) : null,
    p75: ratios.length ? round3(trimmedMedian(ratios, 0.75)) : null,
    pairs: pairs.slice(0, 30),
  };
}

function buildOutput(results, sourceLabel) {
  return {
    calibratedAt: new Date().toISOString(),
    method: "parallel_over_base_from_sold_comps_pool",
    source: sourceLabel,
    windowDays: WINDOW_DAYS,
    sampleSize: {
      totalCombos: results.length,
      totalPairs: results.reduce((s, r) => s + (r.sampleSize ?? 0), 0),
    },
    entries: results.map((r) => ({
      year: r.combo.year,
      set: r.combo.set,
      parallel: r.combo.parallel,
      printRun: r.combo.printRun,
      isAuto: r.combo.isAuto !== false,
      baseRelativePremium: r.trimmedMedianRatio,
      sampleSize: r.sampleSize ?? 0,
      ratioRange: [r.minRatio, r.maxRatio],
      p25: r.p25,
      p75: r.p75,
      provenance: (r.sampleSize ?? 0) >= MIN_PAIRED ? "empirical" : "thin_provisional",
      skippedReason: r.skipped ?? null,
      setKey: r.setKey,
      parallelSlug: r.parallelSlug,
    })),
  };
}

function entryToResult(e) {
  return {
    combo: {
      year: e.year, set: e.set, parallel: e.parallel,
      printRun: e.printRun, isAuto: e.isAuto,
    },
    setKey: e.setKey ?? null,
    parallelSlug: e.parallelSlug ?? null,
    trimmedMedianRatio: e.baseRelativePremium,
    sampleSize: e.sampleSize ?? 0,
    minRatio: e.ratioRange?.[0] ?? null,
    maxRatio: e.ratioRange?.[1] ?? null,
    p25: e.p25 ?? null,
    p75: e.p75 ?? null,
    skipped: e.skippedReason ?? null,
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const normalize = loadNormalizer();
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const targetsPath = path.join(__dirname, "parallel-premium-targets.json");
  const raw = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  let TARGETS = raw.targets;
  if (SETS_ONLY.length) {
    TARGETS = TARGETS.filter((t) => SETS_ONLY.some((s) => t.set.toLowerCase().includes(s)));
  }
  if (MAX_COMBOS > 0) TARGETS = TARGETS.slice(0, MAX_COMBOS);
  console.log(`[from-pool] TARGETS: ${TARGETS.length}  window: ${WINDOW_DAYS}d  apply: ${APPLY}`);

  const outPath = path.join(__dirname, APPLY
    ? "parallel-premiums-latest.json"
    : "parallel-premiums-latest.dry.json");
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();

  const results = [];
  const calibratedKeys = new Set();
  if (RESUME && fs.existsSync(outPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(outPath, "utf8"));
      for (const e of (prior.entries || [])) {
        results.push(entryToResult(e));
        calibratedKeys.add(comboKey(e));
      }
      console.log(`[from-pool] resumed ${calibratedKeys.size} prior entries`);
    } catch (err) {
      console.warn(`[from-pool] resume load failed (${err.message}); starting fresh`);
    }
  }

  const toProcess = TARGETS.filter((t) => !calibratedKeys.has(comboKey(t)));
  const CHECKPOINT = 25;
  let processed = 0;
  const startMs = Date.now();
  for (const t of toProcess) {
    const r = await calibrateCombo(sc, t, normalize, cutoffIso);
    results.push(r);
    processed++;
    if (processed % CHECKPOINT === 0) {
      fs.writeFileSync(outPath, JSON.stringify(buildOutput(results, "sold_comps"), null, 2));
      const secs = (Date.now() - startMs) / 1000;
      const rate = processed / secs;
      const remain = toProcess.length - processed;
      const etaMin = rate > 0 ? Math.round(remain / rate / 60) : 0;
      console.log(`[checkpoint] ${processed}/${toProcess.length}  rate=${rate.toFixed(2)}/s  ETA ${etaMin}m  last=${t.year} ${t.set} ${t.parallel}`);
    }
  }

  const output = buildOutput(results, "sold_comps");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[from-pool] DONE → ${outPath}`);
  console.log(`  totalCombos: ${output.sampleSize.totalCombos}`);
  console.log(`  totalPairs:  ${output.sampleSize.totalPairs}`);

  // Coverage summary: empirical vs thin_provisional vs 0-pair
  const empirical = output.entries.filter((e) => e.provenance === "empirical").length;
  const thin = output.entries.filter((e) => e.provenance === "thin_provisional").length;
  const zeroPair = output.entries.filter((e) => (e.sampleSize ?? 0) === 0).length;
  console.log(`  empirical: ${empirical}   thin_provisional: ${thin}   zero-pair: ${zeroPair}`);
}

main().catch((e) => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
