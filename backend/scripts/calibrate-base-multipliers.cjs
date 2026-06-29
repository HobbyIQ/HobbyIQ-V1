// CF-BASE-MULTIPLIER-CALIBRATION (2026-06-29 scoping; not yet run) —
// empirical calibration for the modern (1990+) BASE graded-vs-raw
// multipliers that currently live as hand-curated values in
// compiqEstimate.service.ts:734-774 (GRADER_PREMIUMS).
//
// Coverage gap analysis (post 2026-06-29 PR #180 + #185):
//   - vintage-multipliers-latest.json:    pre-1990 (vintage table)
//   - auto-multipliers-latest.json:       modern autograph (auto table)
//   - parallel-premiums-latest.json:      parallel-over-base ratios
//   - STATIC GRADER_PREMIUMS:              modern BASE graded → calibration gap
//
// Engine consumes GRADER_PREMIUMS as the fallback when neither vintage
// nor autograph paths match. For modern base graded cards (e.g., a
// 2024 Topps Chrome Cabrera PSA 9 with $80 raw), the engine uses the
// hand-curated table values from a 2018 Prospects Live article. Market
// has shifted since 2018; an empirical refresh would tighten pricing
// for any modern-base-graded holding.
//
// Method (mirror of calibrate-auto-multipliers.cjs):
//   1. Search CH for popular modern BASE inserts (1990+, not autograph)
//   2. For each card_id, all-prices-by-card → pair raw vs each grade
//   3. Bin by (company, grade, raw_price_tier); compute trimmed median
//   4. Apply CF-AUTO-MULTIPLIER-HIGH-GRADE-FLOOR (PR #187) and
//      CF-MULTIPLIER-MONOTONICITY-ENFORCEMENT (PR #188) post-processes
//   5. Emit data/base-multipliers-latest.json
//
// Engine change needed (separate PR after first calibration lands):
//   - getGraderPremium adds a base-table lookup BEFORE the static
//     GRADER_PREMIUMS fallback. Same precedence pattern as vintage/auto
//
// Run with CARD_HEDGE_API_KEY set:
//   $env:CARD_HEDGE_API_KEY = (az webapp config appsettings list ...)
//   node scripts/calibrate-base-multipliers.cjs

const fs = require("fs");
const path = require("path");
const { applyMonotonicityPostprocess } = require("./lib/monotonicity-postprocess.cjs");

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

// Search queries targeting popular modern BASE inserts. Filter at the
// per-card level to non-autograph SKUs. Year filter (>=1990) at the
// per-card level too — keeps the script targeted to the modern era
// where the static GRADER_PREMIUMS table is the canonical fallback.
const SEARCH_QUERIES = [
  // Modern Topps Chrome (popular base inserts)
  "2024 Topps Chrome", "2023 Topps Chrome", "2022 Topps Chrome",
  "2021 Topps Chrome", "2020 Topps Chrome",
  // Topps Chrome Update (high-volume rookie set)
  "2024 Topps Chrome Update", "2023 Topps Chrome Update",
  "2022 Topps Chrome Update", "2021 Topps Chrome Update",
  // Topps Series (mainstream base)
  "2024 Topps Series 1", "2024 Topps Series 2",
  "2023 Topps Series 1", "2023 Topps Series 2",
  // Bowman Chrome (base prospects, not autos)
  "2024 Bowman Chrome Prospects", "2023 Bowman Chrome Prospects",
  "2024 Bowman Draft Chrome", "2023 Bowman Draft Chrome",
  // 1990s vintage-modern HOFs (still graded heavily)
  "1989 Upper Deck Griffey", "1992 Bowman Mariano Rivera",
  "1993 SP Derek Jeter", "1998 Bowman Chrome",
  "2001 Bowman Chrome", "2003 Bowman Chrome Cabrera",
  // 2000s-2010s rookies
  "2011 Topps Update Trout", "2017 Topps Chrome Aaron Judge",
  "2018 Topps Chrome Ohtani", "2019 Bowman Chrome Acuna",
  "2020 Bowman Chrome Tatis", "2022 Bowman Chrome Witt",
];

// Autograph prefix detection — same list as
// calibrate-auto-multipliers.cjs + discover-ch-parallels.cjs.
const AUTO_PREFIXES = [
  "CPA", "BCP-A", "BCPA", "BPA", "CRA", "BCRA", "BSA", "BCA",
  "TCA", "USA", "BBA", "BSPA", "FA", "ROA",
];
function isAutoNumber(num) {
  const n = String(num || "").toUpperCase().trim();
  if (!n) return false;
  return AUTO_PREFIXES.some(p => n.startsWith(p + "-") || n.startsWith(p));
}

function extractYearFromSet(setStr) {
  const m = String(setStr ?? "").match(/(19|20)(\d{2})/);
  return m ? Number(m[0]) : null;
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
  const trimN = Math.floor(s.length * trimPct);
  return median(s.slice(trimN, s.length - trimN));
}

// High-grade floor: same as CF-AUTO-MULTIPLIER-HIGH-GRADE-FLOOR.
// Note: AUTH is INCLUDED here because base-context cards are graded
// inserts; AUTH on a base insert = certified-genuine (≥ Raw expected).
// Same handling as auto-multipliers (which calibrates autographs).
const HIGH_GRADE_FLOOR = new Set(["8", "8.5", "9", "9.5", "10", "AUTH"]);

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) { console.error("CARD_HEDGE_API_KEY missing"); process.exit(1); }

  console.log(`[base-calibrate] phase 1: collect card_ids across ${SEARCH_QUERIES.length} searches`);
  const seen = new Map(); // card_id → { year, set, player }
  for (const search of SEARCH_QUERIES) {
    for (let page = 1; page <= 4; page++) {
      try {
        const r = await postJson(
          "/cards/90day-prices-by-grade-search",
          { search, category: "Baseball", grade: "Raw", page, page_size: 100 },
          apiKey,
        );
        const cards = Array.isArray(r?.cards) ? r.cards : [];
        if (!cards.length) break;
        for (const c of cards) {
          const px = parseFloat(c.price);
          const sales = Number(c["90_day_sales"] ?? 0);
          if (!Number.isFinite(px) || px <= 0 || sales < 1) continue;
          // BASE only: skip autograph SKUs
          if (isAutoNumber(c.number)) continue;
          // Modern only: 1990+
          const year = extractYearFromSet(c.set);
          if (!year || year < 1990) continue;
          seen.set(c.card_id, { year, set: c.set, player: c.player });
        }
        if (cards.length < 100) break;
      } catch (err) {
        console.warn(`  "${search}" p${page}: ${err.message}`);
        break;
      }
    }
  }
  console.log(`[base-calibrate] phase 1 done: ${seen.size} unique base modern card_ids`);

  console.log(`\n[base-calibrate] phase 2: per-card all-grades collection`);
  const observations = [];
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
          observations.push({ cardId, raw: rawPx, byCG });
        }
      } catch { /* skip */ }
    }));
    if (i % 100 === 0) {
      console.log(`  ${Math.min(i + BATCH, cardIds.length)}/${cardIds.length}, valid obs: ${observations.length}`);
    }
  }
  console.log(`[base-calibrate] phase 2 done: ${observations.length} valid observations`);

  console.log(`\n[base-calibrate] phase 3: bin (company, grade, tier) + apply high-grade floor`);
  let droppedSubOne = 0;
  const ratios = {};
  for (const obs of observations) {
    const tier = tierFor(obs.raw);
    if (!tier) continue;
    for (const [gradeKey, price] of Object.entries(obs.byCG)) {
      const m = gradeKey.match(/^(PSA|BGS|SGC|CGC)\s+(.+)$/);
      if (!m) continue;
      const company = m[1], grade = m[2];
      const ratio = price / obs.raw;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 50) continue;
      if (HIGH_GRADE_FLOOR.has(grade) && ratio < 1.0) {
        droppedSubOne++;
        continue;
      }
      ratios[company] ??= {};
      ratios[company][grade] ??= {};
      ratios[company][grade][tier] ??= [];
      ratios[company][grade][tier].push(ratio);
    }
  }
  console.log(`[base-calibrate] dropped ${droppedSubOne} sub-1.0 observations on high-grade slabs`);

  const output = {
    calibratedAt: new Date().toISOString(),
    method: "base_modern_graded_empirical",
    sampleSize: { totalObservations: observations.length, uniqueCards: seen.size },
    table: {},
    diagnostics: {},
  };
  for (const [company, grades] of Object.entries(ratios)) {
    output.table[company] = {};
    output.diagnostics[company] = {};
    for (const [grade, tiers] of Object.entries(grades)) {
      output.table[company][grade] = {};
      output.diagnostics[company][grade] = {};
      for (const tierLabel of TIERS.map(t => t.label)) {
        const arr = tiers[tierLabel] ?? [];
        if (arr.length < 3) {
          output.diagnostics[company][grade][tierLabel] = { n: arr.length, ratio: null };
          continue;
        }
        const r = trimmedMedian(arr, 0.1);
        output.table[company][grade][tierLabel] = Math.round(r * 1000) / 1000;
        output.diagnostics[company][grade][tierLabel] = {
          n: arr.length,
          trimmedMedian: Math.round(r * 1000) / 1000,
          fullMedian: Math.round(median(arr) * 1000) / 1000,
          min: Math.round(Math.min(...arr) * 1000) / 1000,
          max: Math.round(Math.max(...arr) * 1000) / 1000,
        };
      }
      const allArr = Object.values(tiers).flat();
      if (allArr.length >= 3) {
        output.table[company][grade].fallback = Math.round(trimmedMedian(allArr, 0.1) * 1000) / 1000;
      }
    }
  }

  // Apply monotonicity post-process (drop-only) per PR #188
  const monoReport = applyMonotonicityPostprocess(output, TIERS.map(t => t.label), false);
  output.monotonicityPostprocess = {
    adjustmentCount: monoReport.adjustments.length,
    drops: monoReport.adjustments.filter(a => a.action === "drop").length,
    promotes: monoReport.adjustments.filter(a => a.action === "promote").length,
    adjustments: monoReport.adjustments,
  };
  console.log(`[base-calibrate] monotonicity: ${output.monotonicityPostprocess.drops} drops`);

  const outPath = path.join(__dirname, `base-multipliers-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[base-calibrate] DONE → ${outPath}`);
  console.log(`Sample: ${observations.length} obs across ${seen.size} unique modern base cards`);
}

main().catch(e => { console.error(e); process.exit(99); });
