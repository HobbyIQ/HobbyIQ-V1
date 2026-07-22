// CF-GRADE-CALIBRATE (Drew, 2026-07-20 rewrite). Generates
// gradeCalibrationData.ts (baseline baseball + per-sport overlays for
// football & basketball) from 365d of ch_daily_sales.
//
// Design:
//   - Per-family per-year partitioned queries (each ~100-500 rows) to
//     stay under Cosmos serverless RU. Unbounded GROUP BY on big
//     families (topps, bowman, panini-prizm) 429s.
//   - Baseline calibration = baseball-implicit (queried without
//     sport filter, since ch_daily_sales is 99.7% baseball).
//   - Per-sport overlays query WHERE c["group"] = @sport, populate
//     GRADE_CALIBRATION_BY_SPORT.football + .basketball.
//   - Baseline threshold: n>=5 per (family, grader). Sport threshold:
//     n>=3 (smaller pools).
//   - Generic "other" family = sample-size-weighted average of the 19
//     named baseline families. Ensures ~100% pool coverage — every
//     card gets a real multiplier, not "unavailable".
//
// Output: rewrites backend/src/services/compiq/gradeCalibrationData.ts.
// Human-maintained code (lookupGradeRatio, classifyFamily) lives in
// gradeCalibrationConfig.ts and is UNTOUCHED by this script.
//
// Workflow: run manually via `node backend/scripts/grade-calibrate.mjs`
// OR via the "Grade Calibration Refresh (weekly)" GH Actions workflow
// (Sundays 10 UTC).
import { CosmosClient } from "@azure/cosmos";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const connStr = process.env.COSMOS_CONNECTION_STRING;
if (!connStr) { console.error("COSMOS_CONNECTION_STRING missing"); process.exit(1); }

const client = new CosmosClient(connStr);
const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const container = db.container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");
const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();

// Baseline (baseball-implicit) family tokens — includes the full
// baseball catalog + long-tail brands worth calibrating.
const BASELINE_FAMILIES = [
  { family: "bowman-chrome-draft", token: "Bowman Chrome Draft" },
  { family: "bowman-chrome", token: "Bowman Chrome" },
  { family: "bowman-sterling", token: "Bowman Sterling" },
  { family: "bowman", token: "Bowman" },
  { family: "topps-chrome-update", token: "Topps Chrome Update" },
  { family: "topps-chrome", token: "Topps Chrome" },
  { family: "topps-update", token: "Topps Update" },
  { family: "topps-heritage", token: "Topps Heritage" },
  { family: "topps-finest", token: "Topps Finest" },
  { family: "topps-pristine", token: "Topps Pristine" },
  { family: "topps-allen-ginter", token: "Allen & Ginter" },
  { family: "topps-stadium-club", token: "Topps Stadium Club" },
  { family: "topps", token: "Topps" },
  { family: "panini-prizm", token: "Prizm" },
  { family: "panini-select", token: "Select" },
  { family: "panini-mosaic", token: "Mosaic" },
  { family: "panini-donruss", token: "Donruss" },
  { family: "panini-optic", token: "Optic" },
  { family: "panini-contenders", token: "Contenders" },
  { family: "panini-immaculate", token: "Immaculate" },
  { family: "panini-flawless", token: "Flawless" },
  { family: "panini-national-treasures", token: "National Treasures" },
  { family: "upper-deck", token: "Upper Deck" },
];

// Per-sport overlays — FB/BB product lines. Runs against
// c["group"] = @sport rather than blanket query.
const SPORT_FAMILIES = [
  { family: "panini-prizm", token: "Prizm" },
  { family: "panini-select", token: "Select" },
  { family: "panini-mosaic", token: "Mosaic" },
  { family: "panini-donruss", token: "Donruss" },
  { family: "panini-optic", token: "Optic" },
  { family: "panini-contenders", token: "Contenders" },
  { family: "panini-national-treasures", token: "National Treasures" },
  { family: "panini-immaculate", token: "Immaculate" },
  { family: "panini-flawless", token: "Flawless" },
  { family: "panini-chronicles", token: "Chronicles" },
  { family: "panini-obsidian", token: "Obsidian" },
  { family: "panini-phoenix", token: "Phoenix" },
  { family: "panini-spectra", token: "Spectra" },
  { family: "panini-absolute", token: "Absolute" },
  { family: "panini-score", token: "Score" },
  { family: "panini-hoops", token: "Hoops" },
  { family: "panini-prestige", token: "Prestige" },
  { family: "panini-certified", token: "Certified" },
  { family: "panini-playoff", token: "Playoff" },
  { family: "panini-revolution", token: "Revolution" },
  { family: "topps-chrome", token: "Topps Chrome" },
  { family: "bowman-chrome", token: "Bowman Chrome" },
];

const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const SPORTS = ["Football", "Basketball"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function fetchYearWithRetry(token, year, sport, attempt = 1) {
  const params = [
    { name: "@cutoff", value: cutoff },
    { name: "@year", value: year },
    { name: "@token", value: token },
  ];
  let sportClause = "";
  if (sport) {
    params.push({ name: "@sport", value: sport });
    sportClause = " AND c[\"group\"] = @sport";
  }
  // CF-GRADE-CALIBRATE-PER-TIER (Drew, 2026-07-22). Group by full `grade`
  // string ("PSA 10", "PSA 9", "BGS 9.5") instead of just company. The
  // consumer computes both a company-level (aggregated) medianRatio AND
  // a per-tier byTier map, letting observedGradeCurve use empirical per-
  // grade ratios when data is thick (~2M sold_comps rows available) and
  // fall back to company × subTierScaling when a specific tier is thin.
  const iter = container.items.query({
    query: `SELECT c.card_id, c.grader, c.grade, AVG(c.price) AS avgPrice, COUNT(1) AS n
             FROM c
             WHERE c.sale_date >= @cutoff
               AND c.price > 0
               AND c.year = @year
               AND CONTAINS(LOWER(c.card_set), LOWER(@token))${sportClause}
             GROUP BY c.card_id, c.grader, c.grade`,
    parameters: params,
  }, { maxItemCount: 100 });
  const rows = [];
  try {
    for await (const batch of iter.getAsyncIterator()) {
      for (const r of batch.resources) rows.push(r);
    }
    return rows;
  } catch (err) {
    const isRateLimit = /request rate is too large|429/i.test(err.message ?? "");
    if (!isRateLimit || attempt > 4) return [];
    const delayMs = 3000 * Math.pow(2, attempt - 1);
    console.error(`  429 ${sport ?? "baseline"}/${year} attempt ${attempt}, ${delayMs}ms`);
    await sleep(delayMs);
    return fetchYearWithRetry(token, year, sport, attempt + 1);
  }
}

// Parse full grade string like "PSA 10" or "BGS 9.5" into a numeric tier.
// Returns null for "Raw" or unparseable strings.
function parseTier(gradeStr) {
  const m = String(gradeStr ?? "").match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

// CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22, issue #693). Raw-price
// buckets for the empirical GRADE_MULTIPLIER_BY_VALUE_BAND table.
// Format: [minInclusive, maxExclusive, label]. Order matters — buckets
// are checked in order; first match wins.
const VALUE_BANDS = [
  [0, 25, "Under $25"],
  [25, 50, "$25-49"],
  [50, 100, "$50-99"],
  [100, 250, "$100-249"],
  [250, 500, "$250-499"],
  [500, 1000, "$500-999"],
  [1000, 2500, "$1,000-2,499"],
  [2500, 5000, "$2,500-4,999"],
  [5000, 10000, "$5,000-9,999"],
  [10000, Infinity, "$10,000+"],
];
function bucketOf(rawPrice) {
  for (const [lo, hi, label] of VALUE_BANDS) {
    if (rawPrice >= lo && rawPrice < hi) return label;
  }
  return null;
}

// Global-across-all-families accumulator for value-band calibration.
// Every call to calibrateFamilySet contributes into this shared map,
// so the final baseline table pools all sports + all families.
//   valueBandRatios[bucket][gradeTier] = { ratios: [...], raws: [...], gradeds: [...] }
const valueBandAcc = new Map();
function bandAcc(bucket, tier) {
  let m = valueBandAcc.get(bucket);
  if (!m) { m = new Map(); valueBandAcc.set(bucket, m); }
  let a = m.get(tier);
  if (!a) { a = { ratios: [], raws: [], gradeds: [] }; m.set(tier, a); }
  return a;
}

async function calibrateFamilySet(families, sport, minSampleSize) {
  // Two-level accumulator:
  //   ratios[family::grader]           = [ratio, ...] (company-level, for medianRatio)
  //   perTierRatios[family::grader][t] = [ratio, ...] (per-tier, for byTier)
  const ratios = new Map();
  const perTierRatios = new Map();
  const sportLabel = sport ?? "baseline";
  console.error(`\n═══ ${sportLabel} ═══`);
  for (const { family, token } of families) {
    const familyRows = [];
    for (const year of YEARS) {
      const yearRows = await fetchYearWithRetry(token, year, sport);
      familyRows.push(...yearRows);
      await sleep(800);
    }
    if (familyRows.length === 0) {
      console.error(`  ${family.padEnd(28)} skipped (0 rows)`);
      continue;
    }
    // Group per card: card_id → { "Raw": {avgPrice, n}, "PSA 10": {...}, "PSA 9": {...}, ... }
    const byCard = new Map();
    for (const r of familyRows) {
      if (r.n < 2) continue;
      // Use the full `grade` string as the bucket key; Raw doesn't have a
      // grade string in ch_daily_sales but we get grader="Raw" alongside.
      const gradeKey = r.grader === "Raw" ? "Raw" : (r.grade ?? r.grader);
      if (!byCard.has(r.card_id)) byCard.set(r.card_id, {});
      byCard.get(r.card_id)[gradeKey] = { avgPrice: r.avgPrice, n: r.n, grader: r.grader };
    }
    let cardsWithRatio = 0;
    for (const [, gradesByCard] of byCard) {
      const raw = gradesByCard["Raw"];
      if (!raw || raw.avgPrice <= 0) continue;
      cardsWithRatio++;
      // CF-VALUE-BAND-CALIBRATION: which Raw-price bucket does this
      // card's raw fall into? Bucket key is the same for every graded
      // pair on this card.
      const bucket = bucketOf(raw.avgPrice);
      for (const [gradeKey, stats] of Object.entries(gradesByCard)) {
        if (gradeKey === "Raw") continue;
        const ratio = stats.avgPrice / raw.avgPrice;
        if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 300) continue;
        const grader = stats.grader;
        // Company-level accumulator (unchanged behavior)
        const cKey = `${family}::${grader}`;
        if (!ratios.has(cKey)) ratios.set(cKey, []);
        ratios.get(cKey).push(ratio);
        // Per-tier accumulator
        const tier = parseTier(gradeKey);
        if (tier !== null) {
          const tKey = `${family}::${grader}`;
          if (!perTierRatios.has(tKey)) perTierRatios.set(tKey, {});
          const tierMap = perTierRatios.get(tKey);
          const tierStr = String(tier);
          if (!tierMap[tierStr]) tierMap[tierStr] = [];
          tierMap[tierStr].push(ratio);
        }
        // Value-band accumulator (NEW, v1: baseline dimension only).
        // gradeKey format from ch_daily_sales: "PSA 10" | "BGS 9.5" |
        // "SGC 9" etc. Cross-sport cross-product pooled — v2+ will
        // segment by sport / product / etc.
        if (bucket !== null && tier !== null) {
          const acc = bandAcc(bucket, gradeKey);
          acc.ratios.push(ratio);
          acc.raws.push(raw.avgPrice);
          acc.gradeds.push(stats.avgPrice);
        }
      }
    }
    console.error(`  ${family.padEnd(28)} ${familyRows.length.toString().padStart(6)} rows  ${cardsWithRatio.toString().padStart(4)} pairs`);
  }
  const grouped = {};
  for (const [key, arr] of ratios) {
    if (arr.length < minSampleSize) continue;
    const [family, grader] = key.split("::");
    const med = median(arr);
    const sorted = arr.slice().sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    if (!grouped[family]) grouped[family] = {};
    grouped[family][grader] = {
      medianRatio: Math.round(med * 100) / 100,
      p25: Math.round(p25 * 100) / 100,
      p75: Math.round(p75 * 100) / 100,
      sampleSize: arr.length,
    };
    // Attach byTier when we have at least 20 samples at a specific tier
    // (smaller pools have unreliable medians for a specific grade tier).
    const tierMap = perTierRatios.get(key);
    if (tierMap) {
      const byTier = {};
      for (const [tierStr, tierArr] of Object.entries(tierMap)) {
        if (tierArr.length < 20) continue;
        byTier[tierStr] = {
          medianRatio: Math.round(median(tierArr) * 100) / 100,
          sampleSize: tierArr.length,
        };
      }
      if (Object.keys(byTier).length > 0) {
        grouped[family][grader].byTier = byTier;
      }
    }
  }
  return grouped;
}

// Weighted-average "other" fallback across the baseline families.
// Also computes a per-tier "other" fallback (byTier map) so that
// observedGradeCurve can pull an empirical multiplier for a specific
// grade tier when the resolved family lacks direct byTier data.
function computeOtherFallback(baseline) {
  const perGrader = new Map();   // grader → { sumRatioN, sumN, sumP25N, sumP75N }
  const perGraderTier = new Map(); // grader → tier → { sumRatioN, sumN }
  for (const graders of Object.values(baseline)) {
    for (const [grader, entry] of Object.entries(graders)) {
      const cur = perGrader.get(grader) ?? { sumRatioN: 0, sumN: 0, sumP25N: 0, sumP75N: 0 };
      cur.sumRatioN += entry.medianRatio * entry.sampleSize;
      cur.sumP25N += entry.p25 * entry.sampleSize;
      cur.sumP75N += entry.p75 * entry.sampleSize;
      cur.sumN += entry.sampleSize;
      perGrader.set(grader, cur);
      if (entry.byTier) {
        const tierMap = perGraderTier.get(grader) ?? new Map();
        for (const [tierStr, tierEntry] of Object.entries(entry.byTier)) {
          const t = tierMap.get(tierStr) ?? { sumRatioN: 0, sumN: 0 };
          t.sumRatioN += tierEntry.medianRatio * tierEntry.sampleSize;
          t.sumN += tierEntry.sampleSize;
          tierMap.set(tierStr, t);
        }
        perGraderTier.set(grader, tierMap);
      }
    }
  }
  const out = {};
  for (const [grader, s] of perGrader) {
    if (s.sumN === 0) continue;
    out[grader] = {
      medianRatio: Math.round((s.sumRatioN / s.sumN) * 100) / 100,
      p25: Math.round((s.sumP25N / s.sumN) * 100) / 100,
      p75: Math.round((s.sumP75N / s.sumN) * 100) / 100,
      sampleSize: s.sumN,
    };
    const tierMap = perGraderTier.get(grader);
    if (tierMap && tierMap.size > 0) {
      const byTier = {};
      for (const [tierStr, t] of tierMap) {
        if (t.sumN < 50) continue; // "other" is coarse; require broader support
        byTier[tierStr] = {
          medianRatio: Math.round((t.sumRatioN / t.sumN) * 100) / 100,
          sampleSize: t.sumN,
        };
      }
      if (Object.keys(byTier).length > 0) out[grader].byTier = byTier;
    }
  }
  return out;
}

const baseline = await calibrateFamilySet(BASELINE_FAMILIES, null, 5);
baseline["other"] = computeOtherFallback(baseline);

const bySport = { baseball: {}, hockey: {} };
for (const sport of SPORTS) {
  bySport[sport.toLowerCase()] = await calibrateFamilySet(SPORT_FAMILIES, sport, 3);
}

// CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22, issue #693). Emit the
// baseline value-band table. All families + all sports pooled — v1 is
// the "all cards, all grade tiers" baseline. Future v2+ layers add
// sport / product / year / player segmentation.
//
// MIN_SAMPLE_BASELINE = 20 — need at least 20 paired sales in a
// (bucket, tier) cell to trust the median. Cells below this are
// dropped from the table; the consumer falls through to next-broader
// scope or the interim 3-tier cap.
const MIN_SAMPLE_VALUE_BAND = 20;
const valueBandBaseline = {};
for (const [bucket, tierMap] of valueBandAcc) {
  const tiers = {};
  for (const [tier, acc] of tierMap) {
    if (acc.ratios.length < MIN_SAMPLE_VALUE_BAND) continue;
    const sortedRatios = acc.ratios.slice().sort((a, b) => a - b);
    const sortedRaws = acc.raws.slice().sort((a, b) => a - b);
    const sortedGrs = acc.gradeds.slice().sort((a, b) => a - b);
    const at = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    tiers[tier] = {
      medianRatio: Math.round(at(sortedRatios, 0.5) * 100) / 100,
      p25:         Math.round(at(sortedRatios, 0.25) * 100) / 100,
      p75:         Math.round(at(sortedRatios, 0.75) * 100) / 100,
      sampleSize:  acc.ratios.length,
      rawMedian:   Math.round(at(sortedRaws, 0.5) * 100) / 100,
      gradedMedian: Math.round(at(sortedGrs, 0.5) * 100) / 100,
    };
  }
  if (Object.keys(tiers).length > 0) valueBandBaseline[bucket] = tiers;
}
// Human-visible progress log for CI runs.
console.error(`\n═══ Value-band calibration ═══`);
for (const [lo, hi, label] of VALUE_BANDS) {
  const cell = valueBandBaseline[label];
  const nTiers = cell ? Object.keys(cell).length : 0;
  console.error(`  ${label.padEnd(16)} ${nTiers} tier${nTiers === 1 ? "" : "s"}${nTiers ? " calibrated" : " (thin)"}`);
}

// Sort output for stable diffs
function sortObj(o) {
  return Object.keys(o).sort().reduce((acc, k) => {
    acc[k] = typeof o[k] === "object" && o[k] !== null && !Array.isArray(o[k]) ? sortObj(o[k]) : o[k];
    return acc;
  }, {});
}
const baselineSorted = sortObj(baseline);
const bySportSorted = { baseball: {}, football: {}, basketball: {}, hockey: {} };
for (const s of Object.keys(bySport)) bySportSorted[s] = sortObj(bySport[s]);
const valueBandBaselineSorted = sortObj(valueBandBaseline);

const ts = `// AUTO-GENERATED by backend/scripts/grade-calibrate.mjs
// Do not hand-edit; overwritten by the Grade Calibration Refresh workflow.
// Human-maintained code (lookupGradeRatio, classifyFamily) lives in
// gradeCalibrationConfig.ts and imports the constants exported here.

export interface GradeCalibrationTierEntry {
  medianRatio: number;
  sampleSize: number;
}

export interface GradeCalibrationEntry {
  medianRatio: number;
  p25: number;
  p75: number;
  sampleSize: number;
  // Empirical per-grade-tier ratios keyed by numeric grade as string
  // (e.g. "10", "9.5", "9"). Optional; present only when we have >=20
  // paired-sale samples at that specific tier. When absent, consumers
  // fall back to the company-level medianRatio × subTierScaling.
  // See CF-GRADE-CALIBRATE-PER-TIER.
  byTier?: Record<string, GradeCalibrationTierEntry>;
}

/** CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22, issue #693). Empirical
 *  grade-tier / Raw multiplier bucketed by Raw price. v1 = baseline
 *  (all cards pooled across sports + products). Future v2+ layers add
 *  sport, product, year, player segmentation with fall-through. */
export interface ValueBandTierEntry {
  medianRatio:  number;
  p25:          number;
  p75:          number;
  sampleSize:   number;
  rawMedian:    number;
  gradedMedian: number;
}

export const GRADE_CALIBRATION: Record<string, Record<string, GradeCalibrationEntry>> = ${JSON.stringify(baselineSorted, null, 2)};

export const GRADE_CALIBRATION_BY_SPORT: Record<string, Record<string, Record<string, GradeCalibrationEntry>>> = ${JSON.stringify(bySportSorted, null, 2)};

/** Bucket → grade-tier → empirical ratio entry. Buckets keyed as
 *  "Under $25" | "$25-49" | ... | "$10,000+"; grade tiers keyed as
 *  "PSA 10" | "PSA 9.5" | "PSA 9" | "BGS 10" | ... — exact strings CH
 *  emits in ch_daily_sales.grade. Absent cells fall through to the
 *  hardcoded value-tier cap in canonicalFmv.tryHotRawSameCardAnchor. */
export const GRADE_MULTIPLIER_BY_VALUE_BAND: {
  baseline: Record<string, Record<string, ValueBandTierEntry>>;
} = { baseline: ${JSON.stringify(valueBandBaselineSorted, null, 2)} };
`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outPath = join(__dirname, "..", "src", "services", "compiq", "gradeCalibrationData.ts");
writeFileSync(outPath, ts, "utf-8");
console.error(`\n✓ Wrote ${outPath}`);
console.error(`  baseline: ${Object.keys(baselineSorted).length} families`);
console.error(`  football: ${Object.keys(bySportSorted.football ?? {}).length} families`);
console.error(`  basketball: ${Object.keys(bySportSorted.basketball ?? {}).length} families`);
console.error(`  value-band baseline: ${Object.keys(valueBandBaselineSorted).length} buckets covered`);
