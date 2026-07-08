#!/usr/bin/env node
/**
 * CF-CALIBRATE-MULTI-SET-PARALLELS (2026-07-08, Drew):
 *
 * Targeted parallel-premium calibration against prod CH for a
 * curated list of (year, set) tuples. Complements
 * `scripts/discover-ch-parallels.cjs` (the exhaustive 17hr enumeration)
 * with a fast, editable, 5-10 min run for specific products.
 *
 * ## Why this exists
 *
 * The full discover-ch-parallels.cjs script probes ~600 (year, product)
 * combos and takes ~17 hours. Useful for periodic re-baselines. But when
 * we just want to fill a coverage gap for one recently-shipped product
 * (concrete case: 2026 Bowman Chrome Prospects on 2026-07-08 which was
 * missing from parallel-premiums-latest.json entirely), 17 hours is
 * absurd. This script does a targeted run: hand-edit the TARGETS list,
 * run, get an output JSON that merges cleanly into the empirical table.
 *
 * ## What was fixed (2026-07-08 promotion)
 *
 * Earlier scratchpad variant of this script (2026-07-08 first run)
 * fell over on non-Bowman sets:
 *   - "2026 Topps Chrome" returned 800 Topps Heritage / 1991 retro
 *     Chrome inserts instead of Topps Chrome baseball
 *   - "2026 Panini Prizm" returned 800 FIFA World Cup 2026 soccer
 *   - "2026 Bowman's Best" returned Pokemon and Bowman Mega Box
 *
 * CH's `/cards/90day-prices-by-grade-search` is fuzzy on set names —
 * matches loose tokens rather than exact product boundaries. When the
 * actual target product has zero inventory (2026 baseball flagships
 * don't drop until Jan-Mar 2027), the search falls back to any card
 * whose description contains the search tokens.
 *
 * ## The fix
 *
 * Post-search set-name filter: after CH returns cards, keep only those
 * whose `card.set` field starts with (or contains, case-insensitive) a
 * normalized version of the target set name. Drops fuzzy junk — FIFA
 * cards don't have `set` starting with "Bowman's Best", so they get
 * dropped even though they matched the search token.
 *
 * Also drops:
 *   - Cards with null `set` (no proper product attribution)
 *   - Cards where the description contains sport tokens for a
 *     different sport (soccer, football, basketball, pokemon — the
 *     categories CH cross-matches into) as a defense-in-depth check
 *
 * ## Usage
 *
 *   export CARD_HEDGE_API_KEY=$(az webapp config appsettings list \
 *     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='CARD_HEDGE_API_KEY'].value | [0]" -o tsv | tr -d '\r\n')
 *   node backend/scripts/calibrate-multi-set-parallels.cjs
 *
 * Edit the TARGETS array below to change which sets are calibrated.
 * Runtime: ~2-5 min per target-set on prod CH.
 *
 * Output: written to `backend/data/multi-set-calibration-latest.json`.
 * Merge into `parallel-premiums-latest.json` via a follow-up step
 * (see the merge script in scratchpad or hand-merge for one-offs).
 */

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.cardhedger.com/v1";

// Edit this list to change targets. Each (year, set) pair triggers one
// search + calibration pass. Runtime ~2-5 min per pair.
const TARGETS = [
  // 2026 Bowman Chrome Prospects already calibrated 2026-07-08 (PR #312).
  //
  // Add here when a specific product needs coverage. Runtime is ~2-5 min
  // per (year, set). The set-filter (matchesTarget below) drops CH's
  // fuzzy-search junk automatically, so listing a set whose product
  // hasn't shipped yet is safe — it just returns "0 cards after
  // set-filter" and moves on.
  //
  // Example targets (uncomment as products hit market volume):
  // { year: 2027, set: "Topps Chrome" },          // when Q1 2027 baseball drops
  // { year: 2027, set: "Panini Prizm" },          // baseball version — Q1 2027
  // { year: 2026, set: "Bowman Draft Chrome" },   // Q4 draft product
  // { year: 2026, set: "Topps Chrome Update" },   // late-year product
];

// Sport-token blacklist for defense-in-depth junk filtering. CH
// occasionally returns other categories when a baseball product's
// inventory is empty (e.g. soccer FIFA World Cup / Pokemon TCG). We
// filter by category="Baseball" in the search but CH's category filter
// is soft — extra sanity check on the description here.
const NON_BASEBALL_TOKENS = [
  "soccer", "fifa", "world cup", "pokemon", "mtg", "yugioh",
  "yu-gi-oh", "one piece", "basketball", "football", "hockey",
  "nba", "nfl", "nhl", "mma", "ufc",
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
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[idx];
}

/**
 * Post-search filter. Drops fuzzy CH results that don't actually belong
 * to the target product.
 *
 * Returns true when card is a match for the target.
 * Returns false when the card should be excluded (wrong set, wrong sport,
 * no set attribution, invalid price, etc.).
 */
function matchesTarget(card, target) {
  // Baseline data hygiene
  if (!card.player || !card.variant) return false;
  const price = parseFloat(card.price);
  const sales = Number(card["90_day_sales"] ?? 0);
  if (!Number.isFinite(price) || price <= 0 || sales < 1) return false;

  // Set-name check — the primary fix. Card's `set` field must contain
  // the target set name (case-insensitive). Rejects Pokemon/FIFA/etc.
  // that leaked through CH's fuzzy search.
  const cardSet = String(card.set ?? "").trim().toLowerCase();
  if (!cardSet) return false;   // no set → can't verify → drop
  const targetSetNorm = target.set.toLowerCase();
  if (!cardSet.includes(targetSetNorm)) return false;

  // Sport-token blacklist. Even if the set field matches, defense-in-
  // depth check the description for other-sport tokens (very rare but
  // catches edge cases where CH duplicates a "Bowman" token into a
  // different-sport product).
  const desc = String(card.description ?? "").toLowerCase();
  const searchText = String(card.search_text ?? "").toLowerCase();
  const combined = `${desc} ${searchText}`;
  if (NON_BASEBALL_TOKENS.some((t) => combined.includes(t))) return false;

  return true;
}

async function searchAll(searchStr, target, apiKey, maxPages = 8) {
  const all = [];
  let dropped = 0;
  for (let page = 1; page <= maxPages; page++) {
    try {
      const r = await postJson(
        "/cards/90day-prices-by-grade-search",
        { search: searchStr, category: "Baseball", grade: "Raw", page, page_size: 100 },
        apiKey,
      );
      const cards = Array.isArray(r?.cards) ? r.cards : [];
      if (!cards.length) break;
      for (const c of cards) {
        if (matchesTarget(c, target)) all.push(c);
        else dropped++;
      }
      if (cards.length < 100) break;
    } catch (err) {
      console.warn(`  page ${page} failed: ${err.message}`);
      break;
    }
  }
  return { matched: all, droppedByFilter: dropped };
}

function classify(card) {
  const variant = (card.variant ?? "").trim();
  const player = (card.player ?? "").trim();
  const blob = `${card.description ?? ""} ${card.search_text ?? ""}`.toLowerCase();
  const isAuto = blob.includes("auto") || blob.includes("autograph");
  const price = parseFloat(card.price);
  const sales = Number(card["90_day_sales"] ?? 0);
  return {
    card_id: card.card_id, variant, player, isAuto, price, sales,
  };
}

async function calibrateTarget(target, apiKey) {
  const search = `${target.year} ${target.set}`;
  console.log(`\n=== ${search} ===`);
  const { matched: cardsRaw, droppedByFilter } = await searchAll(search, target, apiKey);
  console.log(`  ${cardsRaw.length} cards passed the set-filter (dropped ${droppedByFilter} fuzzy hits)`);
  if (cardsRaw.length === 0) {
    return { target, entries: [], zeroAfterFilter: true };
  }

  const cards = cardsRaw.map(classify).filter((c) => c.player && c.variant);
  const byKey = new Map();
  for (const c of cards) {
    const key = `${c.variant}|${c.isAuto}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const baseAutoByPlayer = new Map();
  const baseByPlayer = new Map();
  for (const c of cards) {
    if (c.variant.toLowerCase() !== "base") continue;
    const map = c.isAuto ? baseAutoByPlayer : baseByPlayer;
    const cur = map.get(c.player);
    if (!cur || c.sales > cur.sales) map.set(c.player, c);
  }

  const results = [];
  for (const [key, group] of byKey.entries()) {
    const [variant, isAutoStr] = key.split("|");
    const isAuto = isAutoStr === "true";
    if (variant.toLowerCase() === "base") continue;
    const anchorMap = isAuto ? baseAutoByPlayer : baseByPlayer;
    const pairs = [];
    for (const c of group) {
      const anchor = anchorMap.get(c.player);
      if (!anchor || anchor.price <= 0) continue;
      const ratio = c.price / anchor.price;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 200) continue;
      pairs.push({ ratio: Math.round(ratio * 100) / 100 });
    }
    if (pairs.length === 0) continue;
    const ratios = pairs.map((p) => p.ratio);
    const trimmed = trimmedMedian(ratios, 0.1);
    results.push({
      year: target.year,
      set: target.set,
      parallel: variant,
      printRun: "(unspecified)",
      isAuto,
      baseRelativePremium: trimmed !== null ? Math.round(trimmed * 100) / 100 : null,
      sampleSize: pairs.length,
      ratioRange: [
        Math.round(Math.min(...ratios) * 100) / 100,
        Math.round(Math.max(...ratios) * 100) / 100,
      ],
      p25: Math.round(percentile(ratios, 0.25) * 100) / 100,
      p75: Math.round(percentile(ratios, 0.75) * 100) / 100,
      provenance: pairs.length >= 5 ? "empirical" : "thin_provisional",
    });
  }
  return { target, entries: results, zeroAfterFilter: false };
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) { console.error("CARD_HEDGE_API_KEY missing"); process.exit(1); }
  if (TARGETS.length === 0) {
    console.error("TARGETS list is empty. Edit the top of this script to add (year, set) pairs.");
    process.exit(1);
  }

  console.log(`=== Multi-set calibration — ${TARGETS.length} target(s) ===`);

  const allResults = [];
  for (const target of TARGETS) {
    try {
      const r = await calibrateTarget(target, apiKey);
      allResults.push(r);
      const nEmpirical = r.entries.filter((e) => e.provenance === "empirical").length;
      if (r.zeroAfterFilter) {
        console.log(`  → 0 cards after set-filter (product not shipping in volume yet)`);
      } else {
        console.log(`  → ${r.entries.length} combos (${nEmpirical} n>=5)`);
      }
    } catch (err) {
      console.warn(`  FAILED: ${target.year} ${target.set}: ${err.message}`);
    }
  }

  const allEntries = allResults.flatMap((r) => r.entries);
  const empiricalOnly = allEntries.filter((e) => e.provenance === "empirical");

  const out = {
    calibratedAt: new Date().toISOString(),
    method: "calibrate_multi_set_parallels_targeted",
    targetsAttempted: TARGETS.length,
    targetsCompleted: allResults.filter((r) => !r.zeroAfterFilter).length,
    totalCombos: allEntries.length,
    empiricalCombos: empiricalOnly.length,
    entries: empiricalOnly,
    thinCombos: allEntries.filter((e) => e.provenance !== "empirical"),
  };
  const outDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "multi-set-calibration-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\n[DONE] ${outPath}`);
  console.log(`Total combos: ${allEntries.length} | Empirical: ${empiricalOnly.length}`);
  if (empiricalOnly.length > 0) {
    console.log(`\nTop 15 by sample size:`);
    empiricalOnly.sort((a, b) => b.sampleSize - a.sampleSize).slice(0, 15).forEach((e) => {
      console.log(
        `  ${String(e.year).padEnd(5)} ${e.set.padEnd(28)} ${e.parallel.padEnd(28)} ` +
        `auto=${String(e.isAuto).padStart(5)} n=${String(e.sampleSize).padStart(3)} ${String(e.baseRelativePremium).padStart(6)}x`,
      );
    });
  }
}

main().catch((e) => { console.error(e); process.exit(99); });
