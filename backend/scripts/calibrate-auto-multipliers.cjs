// CF-AUTO-AWARE-MULTIPLIERS — calibrate autograph-specific PSA/BGS/SGC
// premiums from CardHedge's all-prices-by-card endpoint, binned by raw
// price tier. Output: a JSON file consumed by the engine.
//
// Method:
//   1. Search 90day-prices-by-grade-search for "Chrome Prospect
//      Autograph" with grade=Raw across N pages → list of card_ids
//      with non-zero Raw 90d activity
//   2. For each card, all-prices-by-card → all grades in one call
//   3. Pair each graded price with the card's Raw price → ratio
//   4. Bin pairs by RAW PRICE TIER (matching the existing tier keys:
//      <25, 25-50, 50-100, 100+)
//   5. Per (company, grade, tier), compute trimmed median ratio +
//      sample size, with outlier trim (Q5/Q95)
//   6. Output a new auto-aware GRADER_PREMIUMS table
//
// Per Drew "ML to get better and better with time": this script's
// output gets persisted to Cosmos (next CF) and a weekly Azure Function
// re-runs the same calibration with fresh data. Engine reads the
// latest table on each call → multipliers self-tune over time as
// market dynamics shift.

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.cardhedger.com/v1";

const TIERS = [
  { label: "<25",    lo: 0,    hi: 25 },
  { label: "25-50",  lo: 25,   hi: 50 },
  { label: "50-100", lo: 50,   hi: 100 },
  { label: "100-250", lo: 100, hi: 250 },
  { label: "250-500", lo: 250, hi: 500 },
  { label: "500-1000", lo: 500, hi: 1000 },
  { label: "1000+",  lo: 1000, hi: Infinity },
];

function tierFor(rawPrice) {
  return TIERS.find((t) => rawPrice >= t.lo && rawPrice < t.hi)?.label ?? null;
}

async function postJson(path, body, apiKey) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Statistical helpers
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function trimmedMedian(arr, trimPct = 0.1) {
  if (arr.length < 3) return median(arr);
  const s = arr.slice().sort((a, b) => a - b);
  const trimN = Math.floor(s.length * trimPct);
  const trimmed = s.slice(trimN, s.length - trimN);
  return median(trimmed);
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) {
    console.error("CARD_HEDGE_API_KEY missing");
    process.exit(1);
  }

  console.log("[calibrate] phase 1: collect card_ids from search");
  const seenCardIds = new Set();
  const PAGES = 8;            // 800 cards target — big enough for tier stats
  const PAGE_SIZE = 100;
  const SEARCH_QUERIES = [
    "Chrome Prospect Autograph",
    "Chrome Draft Autograph",
    "Bowman Sterling Prospect",
  ];
  for (const search of SEARCH_QUERIES) {
    console.log(`  search: "${search}"`);
    for (let p = 1; p <= PAGES; p++) {
      try {
        const r = await postJson(
          "/cards/90day-prices-by-grade-search",
          { search, category: "Baseball", grade: "Raw", page: p, page_size: PAGE_SIZE },
          apiKey,
        );
        const cards = Array.isArray(r?.cards) ? r.cards : [];
        if (!cards.length) break;
        for (const c of cards) {
          const px = parseFloat(c.price);
          const sales = Number(c["90_day_sales"] ?? 0);
          if (Number.isFinite(px) && px > 0 && sales >= 1) {
            seenCardIds.add(c.card_id);
          }
        }
        console.log(`    page ${p}: +${cards.length} (total uniq: ${seenCardIds.size})`);
        if (cards.length < PAGE_SIZE) break;
      } catch (err) {
        console.warn(`    page ${p} failed: ${err.message}`);
        break;
      }
    }
  }
  console.log(`[calibrate] phase 1 done: ${seenCardIds.size} unique card_ids`);

  // PHASE 2: per-card all-prices-by-card, build paired observations.
  console.log("[calibrate] phase 2: collect per-card multi-grade prices");
  const observations = []; // { cardId, raw, byCompanyGrade: { "PSA 10": price, ... } }
  const cardIds = Array.from(seenCardIds);
  const BATCH = 10;
  for (let i = 0; i < cardIds.length; i += BATCH) {
    const batch = cardIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (cardId) => {
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
            observations.push({ cardId, raw: rawPx, byCG });
          }
        } catch {
          // skip card
        }
      }),
    );
    if (i % 100 === 0) {
      console.log(`    progress: ${Math.min(i + BATCH, cardIds.length)}/${cardIds.length}, valid obs: ${observations.length}`);
    }
  }
  console.log(`[calibrate] phase 2 done: ${observations.length} valid observations`);

  // PHASE 3: bin pairs by raw tier, compute (graded/raw) ratios.
  console.log("[calibrate] phase 3: compute per-tier ratios");
  // ratiosByCompanyGradeTier["PSA"]["10"]["<25"] = [ratio1, ratio2, ...]
  //
  // CF-AUTO-MULTIPLIER-HIGH-GRADE-FLOOR (2026-06-29): the prior filter
  // accepted ANY positive ratio. For PSA 8+ (and BGS/SGC equivalents)
  // a sub-1.0 ratio is structurally impossible — the slab can't be
  // cheaper than the raw because the slab includes a guaranteed-clean
  // raw plus the grading service value. Sub-1 observations are bad
  // data (single-comp outliers, mis-tagged variants, freshness gaps in
  // CH's price aggregator) and skew the trimmed median below the true
  // value when they survive into the median bucket.
  //
  // Pre-fix engine impact: PSA 8 autographs at $500-1000 Raw got ratio
  // 0.234 → engine priced them at $175 instead of $1500+. Class A bug,
  // opposite-direction of the Mantle $2.28M case.
  //
  // Lower grades (≤7.5) keep the prior > 0 floor: a beat-up PSA 5 can
  // genuinely sell for less than Raw because the slab signals
  // "professionally certified damage" rather than open-market upside.
  const HIGH_GRADE_FLOOR_GRADES = new Set([
    "8", "8.5", "9", "9.5", "10",
    "AUTH",  // PSA AUTH on an auto = certified autograph, must be ≥ Raw
  ]);
  let droppedSubOneFloor = 0;
  const ratios = {};
  for (const obs of observations) {
    const tier = tierFor(obs.raw);
    if (!tier) continue;
    for (const [gradeKey, price] of Object.entries(obs.byCG)) {
      const m = gradeKey.match(/^(PSA|BGS|SGC)\s+(.+)$/);
      if (!m) continue;
      const company = m[1], grade = m[2];
      const ratio = price / obs.raw;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 50) continue;  // filter wild outliers
      if (HIGH_GRADE_FLOOR_GRADES.has(grade) && ratio < 1.0) {
        // Reject: high-grade slab priced below its own raw is bad data.
        droppedSubOneFloor++;
        continue;
      }
      ratios[company] ??= {};
      ratios[company][grade] ??= {};
      ratios[company][grade][tier] ??= [];
      ratios[company][grade][tier].push(ratio);
    }
  }
  console.log(`[calibrate] phase 3: dropped ${droppedSubOneFloor} sub-1.0 observations on high-grade slabs (bad data hygiene)`);

  // Build the output table
  const output = {
    calibratedAt: new Date().toISOString(),
    method: "auto_aware_empirical",
    sampleSize: { total: observations.length },
    table: {},
    diagnostics: {},
  };
  for (const [company, grades] of Object.entries(ratios)) {
    output.table[company] = {};
    output.diagnostics[company] = {};
    for (const [grade, tiers] of Object.entries(grades)) {
      output.table[company][grade] = {};
      output.diagnostics[company][grade] = {};
      for (const tierLabel of TIERS.map((t) => t.label)) {
        const arr = tiers[tierLabel] ?? [];
        if (arr.length < 3) {
          output.diagnostics[company][grade][tierLabel] = { n: arr.length, ratio: null };
          continue;
        }
        const r = trimmedMedian(arr, 0.1);
        const fullMed = median(arr);
        output.table[company][grade][tierLabel] = Math.round(r * 1000) / 1000;
        output.diagnostics[company][grade][tierLabel] = {
          n: arr.length,
          trimmedMedian: Math.round(r * 1000) / 1000,
          fullMedian: Math.round(fullMed * 1000) / 1000,
          min: Math.round(Math.min(...arr) * 1000) / 1000,
          max: Math.round(Math.max(...arr) * 1000) / 1000,
        };
      }
      // Fallback: overall median across all tiers if any tier missing
      const allRatios = Object.values(tiers).flat();
      if (allRatios.length >= 3) {
        output.table[company][grade].fallback = Math.round(trimmedMedian(allRatios, 0.1) * 1000) / 1000;
      }
    }
  }

  // Persist to scratchpad
  const outPath = path.join(__dirname, `auto-multipliers-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[calibrate] DONE → ${outPath}`);
  console.log(`[calibrate] sample size: ${observations.length} cards`);

  // Print a compact preview
  console.log("");
  console.log("=== Calibrated table preview ===");
  for (const [company, grades] of Object.entries(output.table)) {
    console.log(`${company}:`);
    for (const [grade, tiers] of Object.entries(grades)) {
      const parts = [];
      for (const t of [...TIERS.map((tr) => tr.label), "fallback"]) {
        if (tiers[t] != null) parts.push(`${t}=${tiers[t]}`);
      }
      console.log(`  ${grade}: ${parts.join(" | ")}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(99); });
