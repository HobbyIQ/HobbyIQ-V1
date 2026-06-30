#!/usr/bin/env node
// CF-CH-PARALLEL-DISCOVERY (2026-06-29) — enumerate what CardHedge
// ACTUALLY catalogs for each target set, instead of hand-crafting
// TARGETS from Bowman product vocabulary that may not match CH naming.
//
// Drew's insight 2026-06-29: "we need to probe CH for ALL parallel
// names, follow ch search formats". Pre-CF the calibrate-parallel-
// premiums.cjs TARGETS list was guess-built from Bowman product
// names ("Aqua Refractor /125") that don't always exist as a single
// canonical entry in CH's catalog. CH catalogs by specific named
// variants ("Aqua Geometric Refractor", "Aqua Pulsar Refractor")
// without explicit print-run fields.
//
// This tool:
//   1. For each target SET, page through CH's search to collect every
//      card listing
//   2. Group by variant name; count cards + sum 90-day sales
//   3. Classify each variant as auto (number prefix CPA/BCPA/etc) vs
//      base (BCP/BC) — used to set the isAuto field downstream
//   4. Filter to variants with meaningful trade volume (totalSales >= 5)
//   5. Emit a TARGETS proposal (JavaScript snippet) that can replace
//      the hand-crafted list in calibrate-parallel-premiums.cjs
//
// Usage:
//   node scripts/discover-ch-parallels.cjs
//
// Reads CARD_HEDGE_API_KEY from env; never echoes the key.

const API_BASE = "https://api.cardhedger.com/v1";

// CF-CH-PARALLEL-DISCOVERY-FULL (2026-06-29): enumerate every (year,
// product) combo for all major Bowman + Topps families since 1990.
// Programmatic enumeration: one PRODUCT_CONFIGS entry per product
// with its start/end year window; the script generates the (year,
// product) tuples and skips any that return 0 cards from CH.
//
// Runtime estimate:
//   ~22 products × ~28 years average = ~600 (year, product) tuples
//   Per tuple: 100-120 sec of CH probing (20 pages × 5s/page average)
//   Total discovery: ~17 hours sequential
//
// Resumability: the script writes a `progress.json` checkpoint after
// each (year, set) probe. On restart, it skips already-probed tuples.
// Run multiple times to complete the full enumeration; each run
// extends coverage.
//
// Per-session usage:
//   node scripts/discover-ch-parallels.cjs
//   # Run for as long as you have, kill with Ctrl+C when done.
//   # Re-run to continue from where it stopped.
//   # When all tuples processed, the proposal is emitted.
const PRODUCT_CONFIGS = [
  // ── Bowman family ──
  { product: "Bowman Chrome Prospects", startYear: 1997, endYear: 2025 },
  { product: "Bowman Chrome",           startYear: 1997, endYear: 2025 },
  { product: "Bowman Draft Chrome",     startYear: 1999, endYear: 2025 },
  { product: "Bowman Draft",            startYear: 1995, endYear: 2025 },
  { product: "Bowman",                  startYear: 1989, endYear: 2025 },
  { product: "Bowman Sterling",         startYear: 2004, endYear: 2025 },
  { product: "Bowman's Best",           startYear: 1994, endYear: 2025 },
  { product: "Bowman Platinum",         startYear: 2010, endYear: 2025 },
  { product: "Bowman Heritage",         startYear: 2001, endYear: 2025 },
  { product: "Bowman Mega Box",         startYear: 2018, endYear: 2025 },
  // ── Topps family ──
  { product: "Topps Chrome",            startYear: 1996, endYear: 2025 },
  { product: "Topps Chrome Update",     startYear: 2014, endYear: 2025 },
  { product: "Topps Series 1",          startYear: 1990, endYear: 2025 },
  { product: "Topps Series 2",          startYear: 1990, endYear: 2025 },
  { product: "Topps Update",            startYear: 1990, endYear: 2025 },
  { product: "Topps Heritage",          startYear: 2001, endYear: 2025 },
  { product: "Topps Finest",            startYear: 1993, endYear: 2025 },
  { product: "Topps Stadium Club",      startYear: 1991, endYear: 2025 },
  { product: "Topps Stadium Club Chrome", startYear: 2017, endYear: 2025 },
  { product: "Topps Gold Label",        startYear: 2017, endYear: 2025 },
  { product: "Topps Tier One",          startYear: 2007, endYear: 2025 },
  { product: "Topps Tribute",           startYear: 2003, endYear: 2025 },
  { product: "Topps Allen & Ginter",    startYear: 2006, endYear: 2025 },
  { product: "Topps Gypsy Queen",       startYear: 2009, endYear: 2025 },
  // ── Fleer family (exited baseball 2007 after license loss) ──
  { product: "Fleer",                   startYear: 1981, endYear: 2007 },
  { product: "Fleer Ultra",             startYear: 1991, endYear: 2007 },
  { product: "Fleer Tradition",         startYear: 1998, endYear: 2006 },
  { product: "Fleer Flair",             startYear: 1993, endYear: 2005 },
  { product: "Fleer Flair Showcase",    startYear: 1996, endYear: 2003 },
  { product: "Fleer EX",                startYear: 1996, endYear: 2003 },
  { product: "Fleer Metal Universe",    startYear: 1996, endYear: 2003 },
  { product: "Fleer Greats of the Game", startYear: 1999, endYear: 2007 },
  // ── Upper Deck family (lost MLB license 2010, exited) ──
  { product: "Upper Deck",              startYear: 1989, endYear: 2010 },
  { product: "Upper Deck SP",           startYear: 1993, endYear: 2010 },
  { product: "Upper Deck SP Authentic", startYear: 1998, endYear: 2010 },
  { product: "Upper Deck SPx",          startYear: 1996, endYear: 2009 },
  { product: "Upper Deck Black Diamond", startYear: 1999, endYear: 2010 },
  { product: "Upper Deck Ultimate Collection", startYear: 2002, endYear: 2010 },
  { product: "Upper Deck Sweet Spot",   startYear: 2001, endYear: 2010 },
  { product: "Upper Deck Goudey",       startYear: 2007, endYear: 2010 },
  // ── Donruss / Panini family (Donruss 1981-2005 licensed,
  //     Panini revived 2014+ unlicensed) ──
  { product: "Donruss",                 startYear: 1981, endYear: 2025 },
  { product: "Donruss Optic",           startYear: 2018, endYear: 2025 },
  { product: "Donruss Elite",           startYear: 1991, endYear: 2025 },
  { product: "Donruss Studio",          startYear: 1991, endYear: 2005 },
  { product: "Donruss Diamond Kings",   startYear: 1982, endYear: 2025 },
  // ── Score / Pinnacle family ──
  { product: "Score",                   startYear: 1988, endYear: 2005 },
  { product: "Pinnacle",                startYear: 1992, endYear: 1998 },
  { product: "Pinnacle Inside",         startYear: 1997, endYear: 1998 },
  // ── Pacific family (lost license ~2002) ──
  { product: "Pacific",                 startYear: 1993, endYear: 2001 },
  { product: "Pacific Crown Collection", startYear: 1997, endYear: 2000 },
  { product: "Pacific Invincible",      startYear: 1997, endYear: 2000 },
  { product: "Pacific Aurora",          startYear: 1998, endYear: 2000 },
];

// Generate the full TARGET_SETS list from PRODUCT_CONFIGS
const TARGET_SETS = [];
for (const cfg of PRODUCT_CONFIGS) {
  for (let year = cfg.startYear; year <= cfg.endYear; year++) {
    TARGET_SETS.push({ year, set: cfg.product });
  }
}
// Recent years first — most-traded inventory benefits sooner; resume
// after interruption still completes the higher-value sets first.
TARGET_SETS.sort((a, b) => b.year - a.year);

// Auto-detection: card number prefixes that indicate autograph SKU.
// Mirrors AUTO_NUMBER_PREFIXES in backend/src/services/compiq/cardhedge.client.ts
const AUTO_PREFIXES = [
  "CPA", "BCP-A", "BCPA", "BPA", "CRA", "BCRA", "BSA", "BCA",
  "TCA", "USA", "BBA", "BSPA", "FA", "ROA",
];
function isAutoNumber(num) {
  const n = String(num || "").toUpperCase().trim();
  if (!n) return false;
  return AUTO_PREFIXES.some(p => n.startsWith(p + "-") || n.startsWith(p));
}

async function fetchPage(search, page, apiKey) {
  const res = await fetch(`${API_BASE}/cards/90day-prices-by-grade-search`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ search, category: "Baseball", grade: "Raw", page, page_size: 100 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.cards) ? body.cards : [];
}

async function discoverSet(target, apiKey) {
  const search = `${target.year} ${target.set}`;
  console.log(`\n=== Discovering: ${search} ===`);
  const cards = [];
  for (let page = 1; page <= 20; page++) {
    try {
      const pageCards = await fetchPage(search, page, apiKey);
      cards.push(...pageCards);
      if (pageCards.length < 100) break;
    } catch (err) {
      console.warn(`  page ${page} failed: ${err.message}`);
      break;
    }
  }
  console.log(`  collected ${cards.length} cards`);

  // Group by (variant, isAuto)
  const groups = new Map();
  for (const c of cards) {
    const v = (c.variant || "").trim();
    if (!v || v.toLowerCase() === "base") continue;  // skip the base SKUs
    const auto = isAutoNumber(c.number);
    const setHit = (c.set || "").includes(target.set);  // double-check set matches
    if (!setHit) continue;
    const key = `${v}|${auto ? "auto" : "base"}`;
    const sales = Number(c["90_day_sales"] ?? 0);
    const price = parseFloat(c.price);
    if (!groups.has(key)) {
      groups.set(key, { variant: v, isAuto: auto, cardCount: 0, totalSales: 0, sampleCardIds: [], sumPrice: 0 });
    }
    const g = groups.get(key);
    g.cardCount++;
    g.totalSales += sales;
    g.sumPrice += Number.isFinite(price) ? price : 0;
    if (g.sampleCardIds.length < 3) g.sampleCardIds.push(c.card_id);
  }
  return { target, groups };
}

function emitTargetsProposal(allDiscoveries) {
  console.log("\n=== TARGETS PROPOSAL ===");
  console.log("// Auto-generated by discover-ch-parallels.cjs (2026-06-29).");
  console.log("// These entries reflect what CardHedge ACTUALLY catalogs");
  console.log("// for each set, filtered to variants with totalSales >= 5.");
  console.log("// Print runs marked '(unspecified)' because CH does not");
  console.log("// surface print-run metadata; the variant name is the");
  console.log("// canonical lookup key.");
  console.log("const TARGETS = [");
  for (const { target, groups } of allDiscoveries) {
    const ordered = [...groups.values()]
      .filter(g => g.totalSales >= 5)
      .sort((a, b) => b.totalSales - a.totalSales);
    if (ordered.length === 0) {
      console.log(`  // (no qualifying variants found for ${target.year} ${target.set})`);
      continue;
    }
    console.log(`  // === ${target.year} ${target.set} (${ordered.length} variants with totalSales >= 5) ===`);
    for (const g of ordered) {
      // Build a searchToken from the most distinctive part of the variant
      // (drop common suffix "Refractor" if present, leave the prefix)
      const tok = g.variant.replace(/\s+Refractor$/i, "").trim() || g.variant;
      console.log(`  { year: ${target.year}, set: "${target.set}", parallel: "${g.variant}", printRun: "(unspecified)", searchToken: "${tok}", isAuto: ${g.isAuto} },  // ${g.cardCount} cards, ${g.totalSales} 90d sales, avg $${(g.sumPrice / g.cardCount).toFixed(2)}`);
    }
  }
  console.log("];");
}

// CF-CH-PARALLEL-DISCOVERY-RESUMABLE (2026-06-29): checkpoint after
// each (year, set) probe so multi-hour runs can be killed + restarted
// without losing progress. State stored in `discovery-progress.json`
// in the script dir. Each restart skips already-completed tuples.
const fsLib = require("fs");
const pathLib = require("path");
const CHECKPOINT_PATH = pathLib.join(__dirname, "discovery-progress.json");

function loadCheckpoint() {
  try {
    if (!fsLib.existsSync(CHECKPOINT_PATH)) return { completed: {}, results: [] };
    const raw = JSON.parse(fsLib.readFileSync(CHECKPOINT_PATH, "utf8"));
    return {
      completed: raw.completed ?? {},
      // Reconstruct Map from serialized array of [key, val] pairs
      results: (raw.results ?? []).map((r) => ({
        target: r.target,
        groups: new Map((r.groups ?? []).map((g) => [g.key, g.value])),
      })),
    };
  } catch (err) {
    console.warn(`[checkpoint] load failed (${err.message}), starting fresh`);
    return { completed: {}, results: [] };
  }
}

function saveCheckpoint(state) {
  try {
    const serialized = {
      completed: state.completed,
      results: state.results.map((r) => ({
        target: r.target,
        groups: [...r.groups.entries()].map(([k, v]) => ({ key: k, value: v })),
      })),
      savedAt: new Date().toISOString(),
    };
    fsLib.writeFileSync(CHECKPOINT_PATH, JSON.stringify(serialized, null, 2));
  } catch (err) {
    console.warn(`[checkpoint] save failed: ${err.message}`);
  }
}

async function main() {
  const apiKey = process.env.CARD_HEDGE_API_KEY;
  if (!apiKey) { console.error("CARD_HEDGE_API_KEY missing"); process.exit(1); }

  const state = loadCheckpoint();
  const total = TARGET_SETS.length;
  const alreadyDone = Object.keys(state.completed).length;
  console.log(`[discovery] ${total} total target sets; ${alreadyDone} already completed; ${total - alreadyDone} to go`);

  let processed = 0;
  for (const target of TARGET_SETS) {
    const key = `${target.year}|${target.set}`;
    if (state.completed[key]) {
      processed++;
      continue;
    }
    const result = await discoverSet(target, apiKey);
    state.results.push(result);
    state.completed[key] = { at: new Date().toISOString(), groupsFound: result.groups.size };
    processed++;
    // Checkpoint after every probe — survives kill mid-stream
    saveCheckpoint(state);
    if (processed % 10 === 0) {
      console.log(`[checkpoint] ${processed}/${total} processed`);
    }
  }

  // Top-10 variants per set summary
  console.log("\n=== TOP VARIANTS PER SET BY 90D SALES ===");
  for (const { target, groups } of state.results) {
    console.log(`\n${target.year} ${target.set}:`);
    const ordered = [...groups.values()]
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 15);
    for (const g of ordered) {
      console.log(`  ${g.totalSales.toString().padStart(5)} sales · ${g.cardCount.toString().padStart(4)} cards · ${g.isAuto ? "AUTO" : "base"} · ${g.variant}`);
    }
  }
  emitTargetsProposal(state.results);
}

main().catch(e => { console.error(e); process.exit(99); });
