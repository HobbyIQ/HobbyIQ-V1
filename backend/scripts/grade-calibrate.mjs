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
// CF-CALIBRATION-LOOKBACK-V2 (Drew, 2026-07-26). Baseline stays 365d
// (baseball is thick — 500k+ rows/mo, ratios are stable). Sport overlays
// bump to 730d because FB/BB/Pokemon pool volume is 2-10× thinner per
// family × grader × tier cell — doubling the window nearly doubles n
// without any code risk. Slight staleness trade-off in fast-moving
// sports; still net-positive vs the small-sample noise the shorter
// window produced.
const BASELINE_CUTOFF = new Date(Date.now() - 365 * 86400000).toISOString();
const SPORT_OVERLAY_CUTOFF = new Date(Date.now() - 730 * 86400000).toISOString();

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

// Per-sport family sets. Runs against c["group"] = @sport rather than
// blanket query. Football/Basketball share the Panini + Topps/Bowman
// Chrome family set (both are Panini-dominant since ~2016). Pokemon has
// completely different product families — separate list below.
const PANINI_SPORT_FAMILIES = [
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
  // CF-FAMILY-EXPANSION-V2 (Drew, 2026-07-26). Additional premium /
  // scarcity lines missing from v1 that carry real per-family grade
  // premiums (specifically BB Court Kings + Illusions + Zenith are
  // very different value curves from Prizm/Select). More families =
  // more (family × grader × tier) cells populated at the sport-specific
  // level instead of falling through to the coarse "other" bucket.
  { family: "panini-court-kings", token: "Court Kings" },
  { family: "panini-illusions", token: "Illusions" },
  { family: "panini-zenith", token: "Zenith" },
  { family: "panini-crown-royale", token: "Crown Royale" },
  { family: "panini-encased", token: "Encased" },
  { family: "panini-noir", token: "Noir" },
  { family: "panini-eminence", token: "Eminence" },
  { family: "panini-elite", token: "Elite" },
  { family: "panini-luminance", token: "Luminance" },
  { family: "panini-rookies-stars", token: "Rookies & Stars" },
  { family: "topps-inception", token: "Topps Inception" },
  { family: "topps-transcendent", token: "Topps Transcendent" },
  { family: "topps-finest", token: "Topps Finest" },
  { family: "bowman-university", token: "Bowman University" },
];

// CF-POKEMON-CALIBRATION (Drew, 2026-07-26). Pokemon TCG has entirely
// different product families than modern sports. Grade math also differs
// materially — Pokemon PSA 10 vs 9 is often 10-30× (vs baseball's 2-3×) —
// so we MUST calibrate Pokemon separately, not fall back to baseline.
//
// Family tokens ordered vintage → modern (rough era grouping). CH's
// card_set field for Pokemon looks like "2003 Pokemon Aquapolis",
// "2016 Pokemon XY BREAKpoint", "2025 Pokemon Scarlet & Violet White
// Flare" — the token match is CONTAINS(LOWER(...)), so partial names
// hit the right expansion set families.
//
// "pokemon" catch-all at the end so any Pokemon row lands SOMEWHERE
// even if its expansion isn't in the specific-family list.
const POKEMON_FAMILIES = [
  { family: "pokemon-base",            token: "Pokemon Base" },
  { family: "pokemon-jungle",          token: "Pokemon Jungle" },
  { family: "pokemon-fossil",          token: "Pokemon Fossil" },
  { family: "pokemon-team-rocket",     token: "Pokemon Team Rocket" },
  { family: "pokemon-neo",             token: "Pokemon Neo" },
  { family: "pokemon-ex",              token: "Pokemon EX" },
  { family: "pokemon-diamond-pearl",   token: "Pokemon Diamond" },
  { family: "pokemon-platinum",        token: "Pokemon Platinum" },
  { family: "pokemon-heartgold",       token: "Pokemon HeartGold" },
  { family: "pokemon-black-white",     token: "Pokemon Black & White" },
  { family: "pokemon-xy",              token: "Pokemon XY" },
  { family: "pokemon-sun-moon",        token: "Pokemon Sun & Moon" },
  { family: "pokemon-sword-shield",    token: "Pokemon Sword" },
  { family: "pokemon-scarlet-violet",  token: "Pokemon Scarlet" },
  // CF-POKEMON-FAMILY-EXPANSION-V2 (Drew, 2026-07-26). Specific hot
  // expansion sets that carry disproportionate PSA-graded volume — each
  // one has its own grade-value curve worth calibrating separately.
  // Ordered rough-chronologically within era.
  { family: "pokemon-legendary-collection", token: "Pokemon Legendary Collection" },
  { family: "pokemon-shining-legends",      token: "Pokemon Shining Legends" },
  { family: "pokemon-hidden-fates",         token: "Pokemon Hidden Fates" },
  { family: "pokemon-shining-fates",        token: "Pokemon Shining Fates" },
  { family: "pokemon-vivid-voltage",        token: "Pokemon Vivid Voltage" },
  { family: "pokemon-brilliant-stars",      token: "Pokemon Brilliant Stars" },
  { family: "pokemon-astral-radiance",      token: "Pokemon Astral Radiance" },
  { family: "pokemon-lost-origin",          token: "Pokemon Lost Origin" },
  { family: "pokemon-silver-tempest",       token: "Pokemon Silver Tempest" },
  { family: "pokemon-crown-zenith",         token: "Pokemon Crown Zenith" },
  { family: "pokemon-evolving-skies",       token: "Pokemon Evolving Skies" },
  { family: "pokemon-fusion-strike",        token: "Pokemon Fusion Strike" },
  { family: "pokemon-celebrations",         token: "Pokemon Celebrations" },
  { family: "pokemon-obsidian-flames",      token: "Pokemon Obsidian Flames" },
  { family: "pokemon-paldea-evolved",       token: "Pokemon Paldea Evolved" },
  { family: "pokemon-151",                  token: "Pokemon 151" },
  { family: "pokemon-japanese",             token: "Pokemon Japanese" },   // huge Japanese-market slice
  { family: "pokemon",                      token: "Pokemon" },            // catch-all fallback (keep LAST)
];

const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
// CF-POKEMON-CALIBRATION (Drew, 2026-07-26): "Pokemon" added.
// SPORT_FAMILIES resolution moved to per-sport dispatch in the loop below.
const SPORTS = ["Football", "Basketball", "Pokemon"];

// Sport → family set. Each sport pulls only families that make sense
// for it. Football/Basketball share the Panini + Topps/Bowman Chrome
// set; Pokemon has its own family list.
function familiesForSport(sport) {
  if (sport === "Pokemon") return POKEMON_FAMILIES;
  return PANINI_SPORT_FAMILIES;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function fetchYearWithRetry(token, year, sport, cutoffOverride = null, attempt = 1) {
  // CF-CALIBRATION-LOOKBACK-V2: sport overlays get the longer window
  // (BASELINE_CUTOFF used when no override passed, for backwards compat
  // with any direct caller). calibrateFamilySet passes its own cutoff.
  const effectiveCutoff = cutoffOverride ?? BASELINE_CUTOFF;
  const params = [
    { name: "@cutoff", value: effectiveCutoff },
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
    return fetchYearWithRetry(token, year, sport, cutoffOverride, attempt + 1);
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

// CF-VALUE-BAND-V2 (Drew, 2026-07-26). Sport-level + sport+family-level
// value-band accumulators. bySport pools all families within a sport;
// bySportFamily is the finest cell we emit. Consumers walk the ladder:
//   sport+family+band → sport+band → baseline+band → null
// at read time (lookupValueBandMultiplier). Sport tagging: when a
// calibrateFamilySet call passes sport=null, we treat those pairs as
// "baseball" for the bySport dimension (baseline pool is baseball-
// implicit per the script's design note).
const valueBandBySportAcc = new Map();  // sport → bucket → tier → acc
function bandAccSport(sport, bucket, tier) {
  let s = valueBandBySportAcc.get(sport);
  if (!s) { s = new Map(); valueBandBySportAcc.set(sport, s); }
  let m = s.get(bucket);
  if (!m) { m = new Map(); s.set(bucket, m); }
  let a = m.get(tier);
  if (!a) { a = { ratios: [], raws: [], gradeds: [] }; m.set(tier, a); }
  return a;
}
const valueBandBySportFamilyAcc = new Map();  // "sport|family" → bucket → tier → acc
function bandAccSportFamily(sport, family, bucket, tier) {
  const key = `${sport}|${family}`;
  let sf = valueBandBySportFamilyAcc.get(key);
  if (!sf) { sf = new Map(); valueBandBySportFamilyAcc.set(key, sf); }
  let m = sf.get(bucket);
  if (!m) { m = new Map(); sf.set(bucket, m); }
  let a = m.get(tier);
  if (!a) { a = { ratios: [], raws: [], gradeds: [] }; m.set(tier, a); }
  return a;
}

async function calibrateFamilySet(families, sport, minSampleSize) {
  // CF-CALIBRATION-LOOKBACK-V2 (Drew, 2026-07-26): baseline pool (sport
  // is null) uses 365d, sport overlays use 730d — see BASELINE_CUTOFF /
  // SPORT_OVERLAY_CUTOFF definitions at top of file for rationale.
  const cutoffForSet = sport ? SPORT_OVERLAY_CUTOFF : BASELINE_CUTOFF;
  // Two-level accumulator:
  //   ratios[family::grader]           = [ratio, ...] (company-level, for medianRatio)
  //   perTierRatios[family::grader][t] = [ratio, ...] (per-tier, for byTier)
  const ratios = new Map();
  const perTierRatios = new Map();
  const sportLabel = sport ?? "baseline";
  console.error(`\n═══ ${sportLabel} (lookback ${sport ? "730d" : "365d"}) ═══`);
  for (const { family, token } of families) {
    const familyRows = [];
    for (const year of YEARS) {
      const yearRows = await fetchYearWithRetry(token, year, sport, cutoffForSet);
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
        // Value-band accumulators. gradeKey format from ch_daily_sales:
        // "PSA 10" | "BGS 9.5" | "SGC 9" etc.
        //
        // CF-VALUE-BAND-V2 (Drew, 2026-07-26). Every pair contributes to
        // three tables at once: baseline (all-sports pooled),
        // bySport[effectiveSport], bySportFamily[effectiveSport|family].
        // Consumers walk the ladder at read time.
        if (bucket !== null && tier !== null) {
          const effectiveSport = sport ?? "baseball";
          // baseline (existing behavior — pooled across everything)
          const acc = bandAcc(bucket, gradeKey);
          acc.ratios.push(ratio);
          acc.raws.push(raw.avgPrice);
          acc.gradeds.push(stats.avgPrice);
          // bySport
          const sAcc = bandAccSport(effectiveSport, bucket, gradeKey);
          sAcc.ratios.push(ratio);
          sAcc.raws.push(raw.avgPrice);
          sAcc.gradeds.push(stats.avgPrice);
          // bySportFamily
          const sfAcc = bandAccSportFamily(effectiveSport, family, bucket, gradeKey);
          sfAcc.ratios.push(ratio);
          sfAcc.raws.push(raw.avgPrice);
          sfAcc.gradeds.push(stats.avgPrice);
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

const bySport = { baseball: {}, hockey: {}, pokemon: {} };
for (const sport of SPORTS) {
  // CF-POKEMON-CALIBRATION (Drew, 2026-07-26): route each sport to its
  // matching family set (Panini/Chrome for FB/BB, Pokemon-specific for
  // Pokemon TCG). Both use the n>=3 sport threshold.
  bySport[sport.toLowerCase()] = await calibrateFamilySet(familiesForSport(sport), sport, 3);
}

// CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22, issue #693). Emit the
// baseline value-band table. All families + all sports pooled — v1 is
// the "all cards, all grade tiers" baseline. Future v2+ layers add
// sport / product / year / player segmentation.
//
// CF-VALUE-BAND-MIN-SAMPLE-COVERAGE (Drew, 2026-07-23). Lowered from
// 20 → 5 to maximize bucket × tier cell coverage. 5 is the minimum
// non-noise threshold — below that a single outlier moves the median
// too much. Trade-off: more populated cells but with wider p25/p75
// bands on the small-sample ones. Consumers (hot-Raw rung) still cap
// against gradeMultiplier so an outlier ratio can't fully hijack FMV.
const MIN_SAMPLE_VALUE_BAND = 5;

// Extract the sorted-percentile compute so we can reuse it across
// baseline, bySport, and bySportFamily tables.
function tiersFromAcc(tierMap) {
  const out = {};
  for (const [tier, acc] of tierMap) {
    if (acc.ratios.length < MIN_SAMPLE_VALUE_BAND) continue;
    const sortedRatios = acc.ratios.slice().sort((a, b) => a - b);
    const sortedRaws = acc.raws.slice().sort((a, b) => a - b);
    const sortedGrs = acc.gradeds.slice().sort((a, b) => a - b);
    const at = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    out[tier] = {
      medianRatio: Math.round(at(sortedRatios, 0.5) * 100) / 100,
      p25:         Math.round(at(sortedRatios, 0.25) * 100) / 100,
      p75:         Math.round(at(sortedRatios, 0.75) * 100) / 100,
      sampleSize:  acc.ratios.length,
      rawMedian:   Math.round(at(sortedRaws, 0.5) * 100) / 100,
      gradedMedian: Math.round(at(sortedGrs, 0.5) * 100) / 100,
    };
  }
  return out;
}

// Baseline: bucket → tier
const valueBandBaseline = {};
for (const [bucket, tierMap] of valueBandAcc) {
  const tiers = tiersFromAcc(tierMap);
  if (Object.keys(tiers).length > 0) valueBandBaseline[bucket] = tiers;
}

// CF-VALUE-BAND-V2: bySport (sport → bucket → tier)
const valueBandBySport = {};
for (const [sport, bucketMap] of valueBandBySportAcc) {
  const bucketOut = {};
  for (const [bucket, tierMap] of bucketMap) {
    const tiers = tiersFromAcc(tierMap);
    if (Object.keys(tiers).length > 0) bucketOut[bucket] = tiers;
  }
  if (Object.keys(bucketOut).length > 0) valueBandBySport[sport] = bucketOut;
}

// CF-VALUE-BAND-V2: bySportFamily ("sport|family" → bucket → tier)
const valueBandBySportFamily = {};
for (const [sportFamily, bucketMap] of valueBandBySportFamilyAcc) {
  const bucketOut = {};
  for (const [bucket, tierMap] of bucketMap) {
    const tiers = tiersFromAcc(tierMap);
    if (Object.keys(tiers).length > 0) bucketOut[bucket] = tiers;
  }
  if (Object.keys(bucketOut).length > 0) valueBandBySportFamily[sportFamily] = bucketOut;
}

// Human-visible progress log for CI runs.
console.error(`\n═══ Value-band calibration ═══`);
console.error(`  baseline (all-pool):`);
for (const [lo, hi, label] of VALUE_BANDS) {
  const cell = valueBandBaseline[label];
  const nTiers = cell ? Object.keys(cell).length : 0;
  console.error(`    ${label.padEnd(16)} ${nTiers} tier${nTiers === 1 ? "" : "s"}${nTiers ? " calibrated" : " (thin)"}`);
}
console.error(`  bySport: ${Object.keys(valueBandBySport).length} sports covered`);
for (const [sport, buckets] of Object.entries(valueBandBySport)) {
  const totalTiers = Object.values(buckets).reduce((s, b) => s + Object.keys(b).length, 0);
  console.error(`    ${sport.padEnd(12)} ${Object.keys(buckets).length} buckets / ${totalTiers} tier-cells`);
}
console.error(`  bySportFamily: ${Object.keys(valueBandBySportFamily).length} sport|family cells covered`);

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
const valueBandBySportSorted = sortObj(valueBandBySport);
const valueBandBySportFamilySorted = sortObj(valueBandBySportFamily);

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
  bySport: Record<string, Record<string, Record<string, ValueBandTierEntry>>>;
  bySportFamily: Record<string, Record<string, Record<string, ValueBandTierEntry>>>;
} = {
  baseline: ${JSON.stringify(valueBandBaselineSorted, null, 2)},
  bySport: ${JSON.stringify(valueBandBySportSorted, null, 2)},
  bySportFamily: ${JSON.stringify(valueBandBySportFamilySorted, null, 2)},
};
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
console.error(`  value-band bySport: ${Object.keys(valueBandBySportSorted).length} sports`);
console.error(`  value-band bySportFamily: ${Object.keys(valueBandBySportFamilySorted).length} sport|family cells`);
