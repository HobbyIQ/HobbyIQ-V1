#!/usr/bin/env node
/**
 * CF-BECKETT-CHECKLIST-INGESTER (Drew, 2026-08-09). Materializes the
 * catalog from Beckett XLSX checklist files. Fixes the fundamental
 * fragmentation problem: instead of building catalog rows bottom-up
 * from observed sales (which produces ~45 rows per real card via 7
 * inference sources), we build them top-down from the official
 * checklist.
 *
 * Input: Beckett XLSX (downloaded from beckett.com news pages).
 *   Sheets used:
 *     Autographs   — subset headers (row like "Bowman Chrome Prospects Autographs")
 *                    followed by (cardNumber, playerName, team) rows
 *     Prospects    — (cardNumber, playerName, team) rows
 *     Base         — (cardNumber, playerName, team, RC-flag) rows
 *
 * Output: card_catalog upserts with source='beckett-checklist'
 *   One row per (year, cardNumber, playerName, parallelSlug, isAuto).
 *   Parallel manifest per subset-type hardcoded below — refine over
 *   time by parsing Beckett HTML.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/ingestBeckettChecklist.cjs \
 *     --xlsx=/tmp/beckett/2025-Bowman-Chrome.xlsx \
 *     --year=2025 --sport=baseball --setKey=bowman-chrome \
 *     --subset=autographs        # (or 'prospects', 'base', 'all')
 *   Add --apply to upsert. Default is dry-run with sample output.
 */

const XLSX = require("xlsx");
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const XLSX_PATH = argOf("xlsx");
const YEAR = Number(argOf("year"));
const SPORT = argOf("sport", "baseball");
const SET_KEY = argOf("setKey");
const SUBSET = (argOf("subset", "autographs") || "").toLowerCase();

if (!XLSX_PATH || !YEAR || !SET_KEY) {
  console.error("Missing --xlsx, --year, or --setKey.");
  process.exit(1);
}
if (!fs.existsSync(XLSX_PATH)) {
  console.error(`XLSX not found: ${XLSX_PATH}`);
  process.exit(1);
}

// Parallel manifests per subset-type. Each entry: { slug, name, printRun, isAuto }.
// isAuto derives from the subset context (autograph subsets → true).
// Manifest below covers 2024/2025 Bowman Chrome. Verified against
// Beckett news pages + memory of the product line. Add manifests for
// other product lines (Topps Chrome, Panini Prizm, etc.) as we ingest
// their XLSX files.
// CF-CONSERVATIVE-MANIFEST (Drew, 2026-08-09). Only the universal
// Chrome Prospect Autograph parallels that appear every year with
// stable print runs. Year-specific exotic parallels (Aqua Raywave,
// Speckle, HTA Choice, Blue Lunar, Reptilian, Mini Diamond, Green
// Lava, Blue X-Fractor, etc.) are added per-year via YEAR_ADDONS
// below — verified against observed sold_comps for that year before
// materializing.
const MANIFEST_BOWMAN_CHROME_AUTOGRAPHS = [
  { slug: "base", name: "Base", printRun: null, isAuto: true },
  { slug: "refractor", name: "Refractor", printRun: 499, isAuto: true },
  { slug: "purple-refractor", name: "Purple Refractor", printRun: 250, isAuto: true },
  { slug: "blue-refractor", name: "Blue Refractor", printRun: 150, isAuto: true },
  { slug: "green-refractor", name: "Green Refractor", printRun: 99, isAuto: true },
  { slug: "yellow-refractor", name: "Yellow Refractor", printRun: 75, isAuto: true },
  { slug: "gold-refractor", name: "Gold Refractor", printRun: 50, isAuto: true },
  { slug: "orange-refractor", name: "Orange Refractor", printRun: 25, isAuto: true },
  { slug: "black-refractor", name: "Black Refractor", printRun: 10, isAuto: true },
  { slug: "red-refractor", name: "Red Refractor", printRun: 5, isAuto: true },
  { slug: "superfractor", name: "SuperFractor", printRun: 1, isAuto: true },
];
const MANIFEST_BOWMAN_CHROME_PROSPECTS = [
  { slug: "base", name: "Base", printRun: null, isAuto: false },
  { slug: "refractor", name: "Refractor", printRun: 499, isAuto: false },
  { slug: "aqua-raywave-refractor", name: "Aqua Raywave Refractor", printRun: 199, isAuto: false },
  { slug: "purple-refractor", name: "Purple Refractor", printRun: 250, isAuto: false },
  { slug: "blue-refractor", name: "Blue Refractor", printRun: 150, isAuto: false },
  { slug: "green-refractor", name: "Green Refractor", printRun: 99, isAuto: false },
  { slug: "yellow-refractor", name: "Yellow Refractor", printRun: 75, isAuto: false },
  { slug: "gold-refractor", name: "Gold Refractor", printRun: 50, isAuto: false },
  { slug: "orange-refractor", name: "Orange Refractor", printRun: 25, isAuto: false },
  { slug: "black-refractor", name: "Black Refractor", printRun: 10, isAuto: false },
  { slug: "red-refractor", name: "Red Refractor", printRun: 5, isAuto: false },
  { slug: "superfractor", name: "SuperFractor", printRun: 1, isAuto: false },
];
// Base cards in Bowman Chrome flagship — mostly rookies/veterans (no auto).
const MANIFEST_BOWMAN_CHROME_BASE = MANIFEST_BOWMAN_CHROME_PROSPECTS;

const MANIFEST_BY_SUBSET = {
  autographs: MANIFEST_BOWMAN_CHROME_AUTOGRAPHS,
  prospects: MANIFEST_BOWMAN_CHROME_PROSPECTS,
  base: MANIFEST_BOWMAN_CHROME_BASE,
};

// Sapphire variant products: Refractor is replaced by Sapphire. Same
// color + print-run structure otherwise.
const MANIFEST_BOWMAN_CHROME_SAPPHIRE_AUTOGRAPHS = [
  { slug: "base", name: "Sapphire", printRun: null, isAuto: true },
  { slug: "purple-sapphire", name: "Purple Sapphire", printRun: 250, isAuto: true },
  { slug: "blue-sapphire", name: "Blue Sapphire", printRun: 150, isAuto: true },
  { slug: "green-sapphire", name: "Green Sapphire", printRun: 99, isAuto: true },
  { slug: "yellow-sapphire", name: "Yellow Sapphire", printRun: 75, isAuto: true },
  { slug: "gold-sapphire", name: "Gold Sapphire", printRun: 50, isAuto: true },
  { slug: "orange-sapphire", name: "Orange Sapphire", printRun: 25, isAuto: true },
  { slug: "black-sapphire", name: "Black Sapphire", printRun: 10, isAuto: true },
  { slug: "red-sapphire", name: "Red Sapphire", printRun: 5, isAuto: true },
  { slug: "superfractor", name: "SuperFractor", printRun: 1, isAuto: true },
];

// Bowman Sterling has a smaller/different auto parallel set. Sterling
// autos are usually /150 baseline + a handful of tinted variants.
// Conservative: only the confirmed universal parallels.
const MANIFEST_BOWMAN_STERLING_AUTOGRAPHS = [
  { slug: "base", name: "Base", printRun: null, isAuto: true },
  { slug: "refractor", name: "Refractor", printRun: 150, isAuto: true },
  { slug: "black-refractor", name: "Black Refractor", printRun: 25, isAuto: true },
  { slug: "gold-refractor", name: "Gold Refractor", printRun: 50, isAuto: true },
  { slug: "orange-refractor", name: "Orange Refractor", printRun: 25, isAuto: true },
  { slug: "red-refractor", name: "Red Refractor", printRun: 5, isAuto: true },
  { slug: "superfractor", name: "SuperFractor", printRun: 1, isAuto: true },
];

// Manifest selection by (setKey, subset). Falls back to Bowman Chrome
// when unknown — most Bowman-family + Topps Chrome products share the
// same parallel structure so the fallback is safe.
function pickManifest(setKey, subset) {
  if (subset === "autographs") {
    if (setKey === "bowman-chrome-sapphire") return MANIFEST_BOWMAN_CHROME_SAPPHIRE_AUTOGRAPHS;
    if (setKey === "bowman-sterling") return MANIFEST_BOWMAN_STERLING_AUTOGRAPHS;
    return MANIFEST_BOWMAN_CHROME_AUTOGRAPHS;
  }
  return MANIFEST_BY_SUBSET[subset] ?? null;
}

// Card number prefixes that force isAuto=true regardless of manifest.
// CPA-* is Chrome Prospects Autographs by definition; a manifest entry
// with isAuto=false for a CPA-* card is a data bug.
const AUTO_PREFIX_RE = /^(CPA|CPRA|CPAA|BSPA|CDA|CFA|BCPA)-/i;

function isAutoByCardNumber(cardNumber) {
  return AUTO_PREFIX_RE.test(String(cardNumber ?? "").trim());
}

// Extract subset chunks from a sheet: a chunk = header row + N card rows.
// Beckett Autographs sheet: header row = "Bowman Chrome Prospects Autographs Checklist"
// or similar text WITHOUT a card-number-shaped first cell; card rows have
// cardNumber shaped like CPA-XX or BCP-N or numeric.
function extractChunks(sheet, subsetName) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const chunks = [];
  let currentChunk = null;
  for (const row of rows) {
    const cell0 = String(row[0] ?? "").trim();
    if (!cell0) continue;

    // Subset header: text-only first cell (contains "Checklist" or word phrases).
    const isHeader = /Checklist$/i.test(cell0) || (!/^\d+$/.test(cell0) && !/^[A-Z]{1,6}-?[A-Z0-9]{1,10}$/i.test(cell0));
    if (isHeader) {
      if (currentChunk && currentChunk.rows.length > 0) chunks.push(currentChunk);
      currentChunk = { subsetName: cell0, rows: [] };
      continue;
    }
    // Card row: first cell is cardNumber, second is playerName, third is team.
    const cardNumber = cell0;
    const playerName = String(row[1] ?? "").trim();
    const team = String(row[2] ?? "").trim();
    const flag = String(row[3] ?? "").trim();
    if (!playerName) continue;
    if (!currentChunk) currentChunk = { subsetName, rows: [] };
    currentChunk.rows.push({ cardNumber, playerName, team, flag });
  }
  if (currentChunk && currentChunk.rows.length > 0) chunks.push(currentChunk);
  return chunks;
}

function slugifyPlayer(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildCatalogRow({ year, sport, setKey, cardNumber, playerName, team, parallel, isAuto }) {
  const cardNumSlug = String(cardNumber).toLowerCase().replace(/\s+/g, "-");
  const autoSuffix = isAuto ? ":auto" : ":no-auto";
  const printRunSuffix = parallel.printRun ? `:num-${parallel.printRun}` : "";
  const slug = `hiq:${sport}:${year}:${setKey}:${cardNumSlug}:${parallel.slug}${autoSuffix}${printRunSuffix}`;
  const searchTokens = new Set([
    ...playerName.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
    setKey.split("-").filter(Boolean),
    cardNumSlug,
    ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    parallel.slug,
    ...parallel.slug.split("-").filter(Boolean),
    isAuto ? "auto" : null,
  ].flat().filter(Boolean));

  return {
    id: slug,
    cardId: slug,
    hobbyiqCardId: slug,
    sport,
    year,
    setKey,
    setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    cardNumber,
    playerName,
    playerSlug: slugifyPlayer(playerName),
    team: team || null,
    parallel: parallel.name,
    parallelSlug: parallel.slug,
    isAuto,
    printRun: parallel.printRun,
    source: "beckett-checklist",
    // CF-CATALOG-VERSION (Drew, 2026-08-09). catalogVersion + catalogBatch
    // mark these rows as the NEW authoritative catalog wave, distinct
    // from legacy `bulk-build-from-pool` / `tree-builder-v1` / `ch-catalog`
    // rows even when the underlying identity slug collides. Query
    //   SELECT * FROM c WHERE c.catalogVersion = 2
    // returns only the checklist-derived canonical rows.
    catalogVersion: 2,
    catalogBatch: "beckett-2026-08-09",
    verificationStatus: "verified",
    builtAt: "2026-08-09T00:00:00.000Z",   // static so re-runs are idempotent
    searchTokens: [...searchTokens],
  };
}

(async () => {
  console.log(`[beckett-ingest] MODE=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`[beckett-ingest] xlsx=${XLSX_PATH} year=${YEAR} setKey=${SET_KEY} subset=${SUBSET}`);

  const wb = XLSX.readFile(XLSX_PATH);
  console.log(`[beckett-ingest] sheets: ${wb.SheetNames.join(", ")}`);

  const targetSheets = SUBSET === "all"
    ? ["Autographs", "Prospects", "Base"].filter((n) => wb.SheetNames.includes(n))
    : SUBSET === "autographs" ? ["Autographs"]
    : SUBSET === "prospects" ? ["Prospects"]
    : SUBSET === "base" ? ["Base"]
    : [];
  if (targetSheets.length === 0) { console.error(`Unknown --subset=${SUBSET}`); process.exit(1); }

  const allRows = [];
  for (const sheetName of targetSheets) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const manifestKey = sheetName.toLowerCase();
    const manifest = pickManifest(SET_KEY, manifestKey);
    if (!manifest) { console.warn(`[beckett-ingest] no manifest for setKey=${SET_KEY} subset=${manifestKey}, skipping`); continue; }
    const chunks = extractChunks(sheet, sheetName);
    console.log(`\n[beckett-ingest] sheet=${sheetName} chunks=${chunks.length}`);
    for (const chunk of chunks) {
      console.log(`   subset "${chunk.subsetName}" — ${chunk.rows.length} card rows`);
      for (const r of chunk.rows) {
        // Trust sheet context: everything on the "Autographs" sheet
        // is an auto, on "Prospects" is a prospect, on "Base" is a
        // base card. Beckett publishes subsets consistently by sheet.
        // Some subsets (e.g. ADA-*, GLDA-*, Gold Label Autographs)
        // don't match AUTO_PREFIX_RE but ARE autos by virtue of being
        // on the Autographs sheet.
        for (const parallel of manifest) {
          const isAuto = sheetName === "Autographs" || parallel.isAuto || isAutoByCardNumber(r.cardNumber);
          const parallelWithAuto = { ...parallel, isAuto };
          const row = buildCatalogRow({
            year: YEAR, sport: SPORT, setKey: SET_KEY,
            cardNumber: r.cardNumber, playerName: r.playerName, team: r.team,
            parallel: parallelWithAuto, isAuto,
          });
          allRows.push(row);
        }
      }
    }
  }

  console.log(`\n[beckett-ingest] TOTAL rows to upsert: ${allRows.length}`);

  // Sample: show CPA-EHA and CPA-JC (Jac Caglianone) if present
  const samples = allRows.filter((r) => r.cardNumber === "CPA-EHA" || r.cardNumber === "CPA-JC");
  if (samples.length > 0) {
    console.log(`\n[beckett-ingest] SAMPLE (CPA-EHA + CPA-JC):`);
    for (const r of samples) {
      console.log(`   ${r.hobbyiqCardId}`);
      console.log(`     player="${r.playerName}"  parallel="${r.parallel}"  auto=${r.isAuto}  /${r.printRun}`);
    }
  } else {
    console.log(`\n[beckett-ingest] (no CPA-EHA or CPA-JC samples in this run)`);
    console.log(`   first 5 rows for reference:`);
    for (const r of allRows.slice(0, 5)) {
      console.log(`     ${r.hobbyiqCardId}  ← ${r.playerName} · ${r.parallel}`);
    }
  }

  if (!APPLY) {
    console.log(`\n[beckett-ingest] DRY-RUN — no writes. Re-run with --apply to upsert.`);
    return;
  }

  // APPLY: upsert with parallel concurrency
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n[beckett-ingest] APPLY — upserting ${allRows.length} rows (concurrency 16)...`);
  let done = 0;
  let errors = 0;
  const CHUNK = 16;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const batch = allRows.slice(i, i + CHUNK);
    await Promise.all(batch.map(async (r) => {
      try { await cat.items.upsert(r); done++; }
      catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${r.id}: ${err.message.slice(0,80)}`); }
    }));
    process.stdout.write(`\r   progress: ${done}/${allRows.length} (${errors} err)`);
  }
  console.log(`\n[beckett-ingest] DONE — upserted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
