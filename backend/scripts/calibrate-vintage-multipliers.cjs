// CF-VINTAGE-GRADER-PREMIUMS (2026-06-29) — empirical calibration of the
// PSA 8/9/10 → Raw multipliers for VINTAGE HOF cards (pre-1990). The
// static GRADER_PREMIUMS at "100+" tier was calibrated for modern
// prospect-base cards (Prospects Live MiLB pitcher data); applying it
// in reverse for vintage produces 25-34000× breakdowns (the 1952
// Mantle $2.28M case from today's volume test).
//
// Method:
//   1. Search CH for cards across pre-1990 Topps / Bowman sets
//   2. For each card, all-prices-by-card → all grade prices
//   3. Pair each graded price with the card's Raw price → ratio
//   4. Bin pairs by RAW PRICE TIER + by ERA (1948-69 / 1970-89)
//   5. Per (era, company, grade, tier), trimmed median ratio + sample size
//
// Output: vintage-grader-premiums-latest.json, same shape as auto-
// multipliers-latest.json so the engine consumption mirrors the
// existing cardClass="autograph" path with cardClass="vintage".

const fs = require("fs");
const path = require("path");
const { applyMonotonicityPostprocess } = require("./lib/monotonicity-postprocess.cjs");

const API_BASE = "https://api.cardhedger.com/v1";

// Targeted searches across pre-1990 vintage. Many small searches cover
// more catalog corners than one huge sweep. Each query yields ~50-100
// cards; we de-dup card_ids.
const SEARCHES = [
  // 1950s Topps - HOF era
  "1952 Topps Baseball Mantle", "1952 Topps Baseball Mays", "1952 Topps Baseball Robinson",
  "1953 Topps Baseball", "1954 Topps Baseball Aaron", "1954 Topps Baseball Banks",
  "1955 Topps Baseball Clemente", "1955 Topps Baseball Koufax",
  "1956 Topps Baseball Mantle", "1957 Topps Baseball", "1958 Topps Baseball",
  "1959 Topps Baseball",
  // 1960s
  "1960 Topps Baseball", "1961 Topps Baseball Maris",
  "1962 Topps Baseball Mays", "1963 Topps Baseball Rose",
  "1964 Topps Baseball", "1965 Topps Baseball", "1966 Topps Baseball",
  "1967 Topps Baseball Seaver", "1968 Topps Baseball Ryan", "1968 Topps Baseball Bench",
  "1969 Topps Baseball Jackson",
  // 1970s
  "1970 Topps Baseball", "1971 Topps Baseball",
  "1972 Topps Baseball", "1973 Topps Baseball Schmidt", "1974 Topps Baseball",
  "1975 Topps Baseball Brett", "1975 Topps Baseball Yount",
  "1976 Topps Baseball", "1977 Topps Baseball", "1978 Topps Baseball Murray",
  "1979 Topps Baseball",
  // 1980s
  "1980 Topps Baseball Henderson", "1982 Topps Traded Ripken",
  "1984 Fleer Update Clemens", "1985 Topps McGwire",
  "1986 Topps Traded Bonds", "1989 Upper Deck Griffey",
  // 1951 Bowman classics
  "1951 Bowman Baseball Mantle", "1951 Bowman Baseball Mays",

  // CF-VINTAGE-CALIBRATION-PASS-2 (2026-06-29) — additions targeting
  // weak bins surfaced by scripts/audit-vintage-coverage.cjs:
  //   1948-1969 PSA 10 missing 500-1000, 1000-5000, 5000+ (n<3 each)
  //   1970-1989 PSA 8/9/10 missing 500-1000, 1000-5000, 5000+ (n<3 each)
  //   1948-1969 BGS/SGC at high grades sparse
  //
  // The 1948-1969 era is already strong on the low-grade end (PSA 8
  // <50 has n=2362). Missing tiers up top are intrinsic — there
  // genuinely aren't many $500+ raw vintage HOFs with Raw-paired
  // grade observations. These searches surface the cards that DO
  // pair: deep-HOF prospects and stars whose raw exists.
  //
  // 1948-1969 HOF deep-cuts (filling PSA 8/9/10 upper tiers)
  "1954 Topps Baseball Ernie Banks RC",
  "1955 Topps Baseball Killebrew RC",
  "1956 Topps Baseball Ford",
  "1957 Topps Baseball Drysdale RC",
  "1958 Topps Baseball Frank Robinson",
  "1960 Topps Baseball Yastrzemski RC",
  "1961 Topps Baseball Carew",
  "1963 Topps Baseball Stargell RC",
  "1964 Topps Baseball Niekro RC",
  "1965 Topps Baseball Carlton RC",
  "1966 Topps Baseball Palmer RC",
  "1968 Topps Baseball Bench RC",
  "1969 Topps Baseball Mantle Last Card",
  // 1970-1989 RCs (filling all three PSA 8/9/10 upper tiers — modern-
  // vintage HOFs that command higher raw prices than the base set)
  "1972 Topps Baseball Carlton",
  "1974 Topps Baseball Schmidt RC",
  "1976 Topps Baseball Eckersley RC",
  "1980 Topps Baseball Henderson RC",
  "1982 Topps Traded Cal Ripken RC",
  "1983 Topps Tony Gwynn RC",
  "1984 Donruss Mattingly RC",
  "1984 Fleer Update Clemens RC",
  "1985 Topps Mark McGwire RC",
  "1986 Donruss Canseco RC",
  "1986 Fleer Update Bonds RC",
  "1987 Topps Bo Jackson RC",
  "1988 Score Glavine RC",
  "1989 Bowman Griffey Jr RC",
  "1989 Donruss Randy Johnson RC",
];

const TIERS = [
  { label: "<50",     lo: 0,    hi: 50 },
  { label: "50-100",  lo: 50,   hi: 100 },
  { label: "100-500", lo: 100,  hi: 500 },
  { label: "500-1000",lo: 500,  hi: 1000 },
  { label: "1000-5000",lo: 1000,hi: 5000 },
  { label: "5000+",   lo: 5000, hi: Infinity },
];

function tierFor(rawPrice) {
  return TIERS.find((t) => rawPrice >= t.lo && rawPrice < t.hi)?.label ?? null;
}

function eraFor(year) {
  if (year >= 1948 && year <= 1969) return "1948-1969";
  if (year >= 1970 && year <= 1989) return "1970-1989";
  return null;
}

async function postJson(p, body, apiKey) {
  const res = await fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${p} ${res.status}: ${text.slice(0, 200)}`);
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

function extractYearFromSet(setStr) {
  const m = String(setStr ?? "").match(/(19|20)(\d{2})/);
  return m ? Number(m[0]) : null;
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) { console.error("CARD_HEDGE_API_KEY missing"); process.exit(1); }

  console.log(`[vintage-calibrate] phase 1: collect card_ids via ${SEARCHES.length} searches`);
  const seen = new Map();  // card_id → { year, setName }
  for (const search of SEARCHES) {
    for (let page = 1; page <= 3; page++) {
      try {
        const r = await postJson(
          "/cards/90day-prices-by-grade-search",
          { search, category: "Baseball", grade: "Raw", page, page_size: 50 },
          apiKey,
        );
        const cards = Array.isArray(r?.cards) ? r.cards : [];
        if (!cards.length) break;
        for (const c of cards) {
          const px = parseFloat(c.price);
          const sales = Number(c["90_day_sales"] ?? 0);
          if (!Number.isFinite(px) || px <= 0 || sales < 1) continue;
          const year = extractYearFromSet(c.set);
          if (!year || year < 1948 || year > 1989) continue;
          seen.set(c.card_id, { year, setName: c.set, player: c.player });
        }
        if (cards.length < 50) break;
      } catch (err) {
        console.warn(`  "${search}" p${page} failed: ${err.message}`);
        break;
      }
    }
  }
  console.log(`[vintage-calibrate] phase 1 done: ${seen.size} unique vintage card_ids`);

  console.log(`\n[vintage-calibrate] phase 2: collect per-card multi-grade prices`);
  const observations = [];  // { cardId, year, era, raw, byCG: {grade→price} }
  const cardIds = Array.from(seen.keys());
  const BATCH = 10;
  for (let i = 0; i < cardIds.length; i += BATCH) {
    const batch = cardIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (cardId) => {
      try {
        const r = await postJson("/cards/all-prices-by-card", { card_id: cardId }, apiKey);
        const prices = Array.isArray(r?.prices) ? r.prices : [];
        let rawPx = null;
        const byCG = {};
        for (const p of prices) {
          const price = parseFloat(p.price);
          const grade = String(p.grade ?? "");
          if (!Number.isFinite(price) || price <= 0 || !grade) continue;
          if (grade === "Raw") rawPx = price;
          else byCG[grade] = price;
        }
        if (rawPx && Object.keys(byCG).length > 0) {
          const meta = seen.get(cardId);
          const era = eraFor(meta.year);
          if (era) {
            observations.push({ cardId, year: meta.year, era, raw: rawPx, byCG });
          }
        }
      } catch { /* skip */ }
    }));
    if (i % 100 === 0) {
      console.log(`  ${Math.min(i + BATCH, cardIds.length)}/${cardIds.length}, valid obs: ${observations.length}`);
    }
  }
  console.log(`[vintage-calibrate] phase 2 done: ${observations.length} valid observations`);

  console.log(`\n[vintage-calibrate] phase 3: aggregate by (era, company, grade, tier)`);
  // ratios[era][company][grade][tier] = [ratio1, ratio2, ...]
  const ratios = {};
  for (const obs of observations) {
    const tier = tierFor(obs.raw);
    if (!tier) continue;
    for (const [gradeKey, price] of Object.entries(obs.byCG)) {
      const m = gradeKey.match(/^(PSA|BGS|SGC)\s+(.+)$/);
      if (!m) continue;
      const company = m[1], grade = m[2];
      const ratio = price / obs.raw;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1000) continue;  // hard outlier cap
      // CF-VINTAGE-HIGH-GRADE-FLOOR (2026-06-29): for non-AUTH high
      // grades (PSA/BGS/SGC 8+), the slab is structurally ≥ Raw. Sub-1.0
      // observations are bad data and skew the median down. AUTH on
      // vintage = "authenticated but ungradable" (trimmed/altered) which
      // LEGITIMATELY sells below Raw — so AUTH is EXCLUDED from the floor.
      //
      // Pre-fix anomalies caught: 1948-1969 SGC 10 / 5000+ = 0.23 (n=4);
      // 1948-1969 BGS 10 / 100-500 = 0.42 (n=3); etc. These would have
      // routed the engine to UNDERPRICE PSA 10 vintage HOFs by 60-80%.
      const isHighNumericGrade = /^(8|8\.5|9|9\.5|10)$/.test(grade);
      if (isHighNumericGrade && ratio < 1.0) continue;
      ratios[obs.era] ??= {};
      ratios[obs.era][company] ??= {};
      ratios[obs.era][company][grade] ??= {};
      ratios[obs.era][company][grade][tier] ??= [];
      ratios[obs.era][company][grade][tier].push(ratio);
    }
  }

  const output = {
    calibratedAt: new Date().toISOString(),
    method: "vintage_grader_premium_empirical",
    sampleSize: { totalObservations: observations.length, uniqueCards: seen.size },
    table: {},
    diagnostics: {},
  };
  for (const [era, companies] of Object.entries(ratios)) {
    output.table[era] = {};
    output.diagnostics[era] = {};
    for (const [company, grades] of Object.entries(companies)) {
      output.table[era][company] = {};
      output.diagnostics[era][company] = {};
      for (const [grade, tiers] of Object.entries(grades)) {
        output.table[era][company][grade] = {};
        output.diagnostics[era][company][grade] = {};
        for (const tierLabel of TIERS.map(t => t.label)) {
          const arr = tiers[tierLabel] ?? [];
          if (arr.length < 3) {
            output.diagnostics[era][company][grade][tierLabel] = { n: arr.length, ratio: null };
            continue;
          }
          const r = trimmedMedian(arr, 0.1);
          output.table[era][company][grade][tierLabel] = Math.round(r * 100) / 100;
          output.diagnostics[era][company][grade][tierLabel] = {
            n: arr.length,
            trimmedMedian: Math.round(r * 100) / 100,
            fullMedian: Math.round(median(arr) * 100) / 100,
            min: Math.round(Math.min(...arr) * 100) / 100,
            max: Math.round(Math.max(...arr) * 100) / 100,
          };
        }
        // fallback: overall trimmed median for the (era, company, grade)
        const allArr = Object.values(tiers).flat();
        if (allArr.length >= 3) {
          output.table[era][company][grade].fallback = Math.round(trimmedMedian(allArr, 0.1) * 100) / 100;
        }
      }
    }
  }

  // CF-MULTIPLIER-MONOTONICITY-ENFORCEMENT (2026-06-29): enforce
  // grade-monotonicity within each (era, company, tier). Low-sample
  // noise (n<5) is dropped → engine falls back to per-grade fallback;
  // sufficient samples with anomalous values are floored to prior-
  // grade. AUTH skipped (in vintage context = damaged-card class,
  // legitimately can be sub-Raw).
  const monoTiers = TIERS.map(t => t.label);
  const monoReport = applyMonotonicityPostprocess(output, monoTiers, true);
  output.monotonicityPostprocess = {
    adjustmentCount: monoReport.adjustments.length,
    drops: monoReport.adjustments.filter(a => a.action === "drop").length,
    promotes: monoReport.adjustments.filter(a => a.action === "promote").length,
    adjustments: monoReport.adjustments,
  };
  console.log(`[vintage-calibrate] monotonicity post-process: ${monoReport.adjustments.length} adjustments ` +
    `(${output.monotonicityPostprocess.drops} drops, ${output.monotonicityPostprocess.promotes} promotes)`);

  const outPath = path.join(__dirname, `vintage-multipliers-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[vintage-calibrate] DONE → ${outPath}`);
  console.log(`Total obs: ${observations.length}, unique cards: ${seen.size}`);

  // Preview
  console.log("\n=== Vintage premiums preview ===");
  for (const [era, companies] of Object.entries(output.table)) {
    console.log(`\n${era}:`);
    for (const [company, grades] of Object.entries(companies)) {
      for (const [grade, tiers] of Object.entries(grades)) {
        const parts = [];
        for (const t of [...TIERS.map(tr => tr.label), "fallback"]) {
          if (tiers[t] != null) parts.push(`${t}=${tiers[t]}`);
        }
        if (parts.length > 0) console.log(`  ${company} ${grade}: ${parts.join(" | ")}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(99); });
