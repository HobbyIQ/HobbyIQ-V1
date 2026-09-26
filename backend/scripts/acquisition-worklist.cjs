#!/usr/bin/env node
"use strict";
/**
 * acquisition-worklist.cjs — turns UNBACKED sold_comps sales into a RANKED
 * acquisition worklist. Read-only: no Cosmos writes, ever.
 *
 * Prior art (read, reused, not re-derived): C:/tmp/gap2025topps_1430/RESULT.md
 * and C:/tmp/gap2024_2200/RESULT.md + backend/scripts/gap2024-classify.cjs
 * (an uncommitted analysis script in that clone). This file reuses the same
 * three shared libraries that script does:
 *   - scripts/lib/rematch-derive-identity.cjs  (storedIdentity, deriveIdentity)
 *   - scripts/lib/rematch-classify.cjs         (isStrictChecklistSource)
 *   - scripts/lib/name-agreement.cjs           (namesAgree)
 * and the same case-insensitive-cardNumber / per-(year,setKey)-cell in-memory
 * index pattern gap2024-classify.cjs built. All classifyOne / namesAgree /
 * rung-lookup logic below is a straight port of that pattern (adapted from
 * two hardcoded baseball cells to the CLI's --sport/--years/--setkeys args
 * and to a cell list read from a backing-census merge file), not a rewrite.
 *
 * ── WHAT THIS ADDS ON TOP OF gap2024-classify.cjs's TAXONOMY ────────────────
 *
 * The task's taxonomy calls out STALE (derived id already has a checklist
 * row -- rematch's job, EXCLUDED from the worklist) vs STALE-NO-ROW /
 * DERIVED-ONLY / RUNG-MISSING / CARD-MISSING (-> the worklist). This script
 * keeps that split explicit: `classifyOne` returns STALE separately so the
 * two levers (apply a rematch pass vs acquire a missing checklist) are never
 * blended into one number -- see per-cell `staleWithRowCount` in the output.
 *
 * Genuinely-unbacked buckets are then AGGREGATED by destination identity:
 *   (sport, year, destination setKey, insert prefix|'base', parallel, isAuto,
 *    printRun)
 * -> sales count, distinct cardNumbers, example titles, best-guess source URL.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   COSMOS_CONNECTION_STRING="$(...)" node scripts/acquisition-worklist.cjs \
 *     --sport baseball --years 2024,2025,2026 --sample 8000 --out <dir>
 *   ... --setkeys topps,bowman-chrome                 (explicit cells)
 *   ... --cells-from <backing-report-merge.json> --top-cells 12  (census-driven)
 *
 * ── SECRET / RU DISCIPLINE ───────────────────────────────────────────────────
 * COSMOS_CONNECTION_STRING is read from process.env only, never echoed, never
 * written to disk. sold_comps paging uses FeedOptions
 * {maxItemCount:500, maxDegreeOfParallelism:-1} with a while(hasMoreResults())
 * loop (continuationToken-driven — empty pages before the end are expected
 * and handled, never treated as "done"); no COUNT, no GROUP BY, no -1 sample
 * cap. A token-bucket throttle keeps sold_comps reads at <=2,000 RU/s
 * (default cap; override with SOLD_COMPS_RU_CAP) because a census may be
 * running concurrently. card_catalog reads are not throttled — same
 * reasoning gap2024-classify.cjs documents: it is provisioned with its own
 * separate headroom and is not the container under RU pressure.
 */
const fs = require("fs");
const path = require("path");

const { storedIdentity, deriveIdentity } = require(path.join(__dirname, "lib", "rematch-derive-identity.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));

const norm = (s) => String(s ?? "").trim().toLowerCase();
const f = (n) => Number(n || 0).toLocaleString("en-US");

// ─────────────────────────────────────────────────────────────────────────────
// PURE CLASSIFICATION / AGGREGATION / RANKING / URL-GUESS LOGIC
// (no Cosmos, no fs — this is the part vitest exercises with fakes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a leading insert-set prefix from a cardNumber, e.g. "BP-12" -> "BP",
 * "T90R-3" -> "T90R", "42" -> null (bare numeric = base, no insert prefix).
 * Case-insensitive matcher upstream (indexFor/rungLookup below), but the
 * prefix itself is upper-cased for display/grouping, matching
 * gap2024-classify.cjs's extractInsertPrefix.
 */
function extractInsertPrefix(cardNumber) {
  const m = String(cardNumber || "").match(/^[A-Za-z][A-Za-z0-9]*-/);
  if (m) return m[0].slice(0, -1).toUpperCase();
  return null;
}

/**
 * Build a case-insensitive cardNumber -> rows[] index for one (year,setKey)
 * cell's catalog rows. LOWER(cardNumber) is the key throughout — this is the
 * single seam that makes cardNumber matching case-insensitive; the mutation
 * test in the vitest suite flips this to a case-SENSITIVE compare and
 * expects the "1" / "1a" mixed-case fixture to break, proving the guard is
 * load-bearing rather than accidental.
 */
function indexCatalogCell(rows) {
  const byNumber = new Map();
  for (const r of rows || []) {
    const num = norm(r.cardNumber);
    if (!num) continue;
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(r);
  }
  return byNumber;
}

function isBacked(row) {
  if (!row) return false;
  const named = [row.source, row.sourceSystem, ...(Array.isArray(row.sources) ? row.sources : [])];
  return named.some((s) => K.isStrictChecklistSource(s));
}

/**
 * Rung lookup: (cardNumber [case-insensitive], isAuto, printRun) under
 * setKey, gated by namesAgree against the sale's own playerName before any
 * cross-key or cross-rung claim is trusted. Mirrors gap2024-classify.cjs's
 * rungLookup, generalized off its two hardcoded cells.
 */
function rungLookup(byNumberIndex, cardNumber, isAuto, printRun, playerName) {
  const candidates = byNumberIndex.get(norm(cardNumber)) || [];
  return candidates.map((c) => ({
    row: c,
    autoMatch: (c.isAuto === true) === (isAuto === true),
    prMatch: (c.printRun ?? null) === (printRun ?? null) || (!c.printRun && !printRun),
    agree: namesAgree(playerName || "", c.playerName || ""),
  }));
}

/**
 * Classify one already-known-unbacked sale into exactly one bucket.
 * `io` supplies the only Cosmos-shaped calls this function needs:
 *   io.pointReadById(id) -> row|null           (exact-id point read)
 *   io.getCellIndex(year, setKey) -> {rows, byNumber}  (cached cell load)
 * Both are pure lookups over pre-fetched/cached data in real use; the vitest
 * suite passes plain in-memory fakes for both.
 *
 * Returns { name, detail } where name is one of:
 *   STALE            — derived id differs from stored AND has a checklist row
 *                       (rematch's job; caller EXCLUDES this from the worklist)
 *   STALE-NO-ROW      — derived id differs from stored, no row at all there
 *   BACKED-DERIVED-ONLY — exact rung exists under the derived id; a point-read
 *                       miss only, not a real gap
 *   RUNG-MISSING      — this cardNumber exists in the cell, but not at this
 *                       (isAuto, printRun) rung under any parallel spelling
 *   CARD-MISSING      — no catalog row for that cardNumber under this setKey
 *                       at all (case-insensitive)
 * STALE-NO-ROW / DERIVED-ONLY / RUNG-MISSING / CARD-MISSING are the task's
 * named worklist-bound buckets; STALE is the one exclusion.
 */
function classifyOne(row, cell, deps, io) {
  const stored = storedIdentity(row, deps);
  let der;
  try {
    der = deriveIdentity(row, deps);
  } catch (e) {
    der = { ok: false, reasons: [`throw:${String(e && e.message).slice(0, 60)}`] };
  }

  if (!der.ok) {
    return { name: "NO-NUMBER", detail: { reasons: der.reasons } };
  }

  const storedSlug = row.hobbyiqCardId || row.cardId || null;
  if (der.slug && storedSlug && der.slug !== storedSlug) {
    const derivedRow = io.pointReadById(der.slug);
    if (isBacked(derivedRow)) {
      return { name: "STALE", detail: { from: storedSlug, to: der.slug } };
    }
    if (!derivedRow) {
      return { name: "STALE-NO-ROW", detail: { from: storedSlug, to: der.slug, identity: der.identity } };
    }
    // else: derived row exists but isn't strict-backed — fall through and
    // keep classifying against the derived identity, the current truth.
  }

  const cardNumber = der.identity.cardNumber || stored.cardNumber || "";
  if (!cardNumber) return { name: "NO-NUMBER", detail: null };

  const setKey = der.identity.setKey || cell.setKey;
  const { byNumber } = io.getCellIndex(cell.year, setKey);
  const hits = rungLookup(byNumber, cardNumber, der.identity.isAuto, der.identity.printRun, row.playerName);

  const backedHits = hits.filter((h) => isBacked(h.row));
  const exactRung = backedHits.find((h) => h.autoMatch && h.prMatch);
  if (exactRung) {
    return { name: "BACKED-DERIVED-ONLY", detail: { note: "rung exists but point read missed it", id: exactRung.row.id } };
  }

  const anyNumberPresent = hits.length > 0;
  if (anyNumberPresent) {
    return {
      name: "RUNG-MISSING",
      detail: { candidatesAtNumber: hits.length, identity: der.identity, cardNumber },
    };
  }

  const prefix = extractInsertPrefix(cardNumber);
  return { name: "CARD-MISSING", detail: { identity: der.identity, cardNumber, prefix } };
}

/** The task's worklist-bound bucket set — everything else (STALE, NO-NUMBER,
 *  BACKED-DERIVED-ONLY) is reported but excluded from the acquisition rows. */
const WORKLIST_BUCKETS = new Set(["STALE-NO-ROW", "RUNG-MISSING", "CARD-MISSING"]);

/**
 * Aggregation key for one worklist-bound classification: destination
 * identity as (sport, year, destination setKey, insert prefix|'base',
 * parallel, isAuto, printRun). Stable stringify so Map lookups are exact.
 */
function aggregationKey(sport, year, setKey, prefix, parallel, isAuto, printRun) {
  return [
    String(sport || "").toLowerCase(),
    Number(year),
    String(setKey || "").toLowerCase(),
    prefix ? String(prefix).toUpperCase() : "base",
    String(parallel || "Base"),
    isAuto === true ? "auto" : "non-auto",
    printRun == null ? "" : String(printRun),
  ].join("|");
}

/**
 * Fold a bucketed classification result into the running aggregate map.
 * `agg` is a Map<key, {sport,year,setKey,prefix,parallel,isAuto,printRun,
 * salesCount, cardNumbers:Set, exampleTitles:[]}>. Mutates and returns `agg`.
 */
function foldIntoAggregate(agg, sport, year, sale, classification) {
  if (!WORKLIST_BUCKETS.has(classification.name)) return agg;
  const identity = (classification.detail && classification.detail.identity) || {};
  const setKey = identity.setKey || null;
  const cardNumber = classification.detail && classification.detail.cardNumber;
  const prefix = (classification.detail && classification.detail.prefix) || extractInsertPrefix(cardNumber) || null;
  const parallel = identity.parallel || "Base";
  const isAuto = identity.isAuto === true;
  const printRun = identity.printRun ?? null;

  const key = aggregationKey(sport, year, setKey, prefix, parallel, isAuto, printRun);
  if (!agg.has(key)) {
    agg.set(key, {
      sport, year, setKey, prefix: prefix ? String(prefix).toUpperCase() : "base",
      parallel, isAuto, printRun,
      salesCount: 0,
      cardNumbers: new Set(),
      exampleTitles: [],
      buckets: {},
    });
  }
  const entry = agg.get(key);
  entry.salesCount += 1;
  if (cardNumber) entry.cardNumbers.add(String(cardNumber));
  if (entry.exampleTitles.length < 5 && sale && sale.title) entry.exampleTitles.push(sale.title);
  entry.buckets[classification.name] = (entry.buckets[classification.name] || 0) + 1;
  return agg;
}

/**
 * Rank aggregate entries by salesCount descending, attach cumulative share.
 * Ties broken by distinct-cardNumber count, then setKey/prefix for
 * determinism (never insertion order).
 */
function rankAggregate(agg) {
  const rows = [...agg.values()].map((e) => ({
    ...e,
    distinctCardNumbers: e.cardNumbers.size,
  }));
  rows.sort((a, b) => {
    if (b.salesCount !== a.salesCount) return b.salesCount - a.salesCount;
    if (b.distinctCardNumbers !== a.distinctCardNumbers) return b.distinctCardNumbers - a.distinctCardNumbers;
    const as = `${a.setKey}|${a.prefix}`;
    const bs = `${b.setKey}|${b.prefix}`;
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
  const total = rows.reduce((s, r) => s + r.salesCount, 0);
  let running = 0;
  for (const r of rows) {
    running += r.salesCount;
    r.cumulativeShare = total > 0 ? running / total : 0;
    r.share = total > 0 ? r.salesCount / total : 0;
  }
  return rows;
}

/**
 * Best-guess source URLs for a destination identity. Every URL returned is
 * a GUESS from a naming pattern, never independently fetched/verified by
 * this script — callers must say so wherever they render these.
 *   - checklistinsider: https://www.checklistinsider.com/<year>-<product-words>-<sport>-checklist
 *   - baseballcardpedia (baseball only): index.php/<Year>_<Product>
 *   - cardboardconnection: https://www.cardboardconnection.com/<year>-<product-words>-<sport>-cards
 */
function guessSourceUrls(sport, year, setKey) {
  const words = String(setKey || "").split("-").filter(Boolean);
  const productWords = words.join("-");
  const productTitleCase = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("_");
  const sportLower = String(sport || "").toLowerCase();

  const urls = [];
  if (productWords) {
    urls.push({
      source: "checklistinsider",
      url: `https://www.checklistinsider.com/${year}-${productWords}-${sportLower}-checklist`,
      guess: true,
    });
    urls.push({
      source: "cardboardconnection",
      url: `https://www.cardboardconnection.com/${year}-${productWords}-${sportLower}-cards`,
      guess: true,
    });
  }
  if (sportLower === "baseball" && productTitleCase) {
    urls.push({
      source: "baseballcardpedia",
      url: `https://www.baseballcardpedia.com/index.php/${year}_${productTitleCase}`,
      guess: true,
    });
  }
  return urls;
}

/** Per-cell summary: sampled fraction, bucket shares, and the STALE-with-row
 *  count (the rematch lever) reported SEPARATELY from the acquisition lever. */
function summarizeCell(cellStats) {
  const { scanned, sampled, unbacked, buckets, staleWithRowCount, totalPopulationHint } = cellStats;
  const sampledFraction = totalPopulationHint > 0 ? sampled / totalPopulationHint : (scanned > 0 ? sampled / scanned : 0);
  const bucketShares = {};
  const bucketTotal = Object.values(buckets || {}).reduce((s, n) => s + n, 0);
  for (const [name, count] of Object.entries(buckets || {})) {
    bucketShares[name] = bucketTotal > 0 ? count / bucketTotal : 0;
  }
  const acquisitionCount = Object.entries(buckets || {})
    .filter(([name]) => WORKLIST_BUCKETS.has(name))
    .reduce((s, [, n]) => s + n, 0);
  return {
    scanned, sampled, unbacked,
    sampledFraction,
    buckets: buckets || {},
    bucketShares,
    staleWithRowCount: staleWithRowCount || 0,
    acquisitionCount,
    rematchVsAcquisitionSplit: {
      rematch: staleWithRowCount || 0,
      acquisition: acquisitionCount,
    },
  };
}

module.exports = {
  extractInsertPrefix,
  indexCatalogCell,
  isBacked,
  rungLookup,
  classifyOne,
  WORKLIST_BUCKETS,
  aggregationKey,
  foldIntoAggregate,
  rankAggregate,
  guessSourceUrls,
  summarizeCell,
  writeOutputs,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI DRIVER — only runs when invoked directly, never on require() (so the
// vitest suite can `require()` this file for the pure functions above without
// pulling in @azure/cosmos or touching Cosmos at all).
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const val = (flag, d) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
  };
  const SPORT = val("--sport", "baseball");
  const YEARS = String(val("--years", "")).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  const SETKEYS = String(val("--setkeys", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const CELLS_FROM = val("--cells-from", null);
  const TOP_CELLS = Number(val("--top-cells", "0"));
  const SAMPLE = Number(val("--sample", "8000"));
  const OUT_DIR = val("--out", path.join(process.cwd(), "acquisition-worklist-out"));
  const RU_CAP = Number(process.env.SOLD_COMPS_RU_CAP || 2000);

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Run via:");
    console.error(`  COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" node scripts/acquisition-worklist.cjs ...`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cells = resolveCells({ sport: SPORT, years: YEARS, setkeys: SETKEYS, cellsFrom: CELLS_FROM, topCells: TOP_CELLS });
  if (!cells.length) {
    console.error("FATAL: no cells resolved from --setkeys/--years or --cells-from. Nothing to do.");
    process.exit(1);
  }
  console.log(`Resolved ${cells.length} cell(s):`);
  for (const c of cells) console.log(`  ${c.sport}|${c.year}|${c.setKey}`);

  const { CosmosClient } = require("@azure/cosmos");
  const backend = path.resolve(__dirname, "..");
  const d = (p) => require(path.join(backend, "dist", "services", ...p));
  const pti = d(["portfolioiq", "parseTitleIdentity.service.js"]);
  const hic = d(["portfolioiq", "hobbyIqCardId.service.js"]);
  const psk = d(["catalog", "productSetKeys.js"]);
  const guard = d(["portfolioiq", "slugGuard.service.js"]);
  const pvs = d(["portfolioiq", "persistVendorSalesToPool.service.js"]);
  const slugRe = d(["portfolioiq", "slugRederivation.service.js"]);

  const deps = {
    parseListingIdentity: pti.parseListingIdentity,
    checklistSpellingFor: undefined,
    noteSpellingAdopted: undefined,
    isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
    scopedMarketLanguageAlias: pti.scopedMarketLanguageAlias,
    inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
    titleStatesSoccerCompetition: pti.titleStatesSoccerCompetition,
    inferSportFromTitle: pti.inferSportFromTitle,
    ingestGradeFromTitle: pvs.ingestGradeFromTitle,
    isMultiCardLot: pti.isMultiCardLot,
    normalizeSetKey: hic.normalizeSetKey,
    computeHobbyIqCardId: hic.computeHobbyIqCardId,
    applySiblingChecklistOverride: hic.applySiblingChecklistOverride,
    spellForEra: psk.spellForEra,
    guardSlugInputs: guard.guardSlugInputs,
    normalizeSportStrict: guard.normalizeSportStrict,
    extractYearFromTitle: slugRe.extractYearFromTitle,
  };

  const client = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  });
  const db = client.database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  // Token-bucket RU throttle for sold_comps ONLY (<=RU_CAP per second); a
  // census may be concurrently running against the same container.
  let ruWindowStart = Date.now();
  let ruInWindow = 0;
  async function chargeSoldCompsRu(charge) {
    ruInWindow += Number(charge) || 0;
    const elapsed = Date.now() - ruWindowStart;
    if (elapsed >= 1000) { ruWindowStart = Date.now(); ruInWindow = 0; return; }
    if (ruInWindow > RU_CAP) {
      const waitMs = 1000 - elapsed;
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      ruWindowStart = Date.now();
      ruInWindow = 0;
    }
  }

  const cellRowCache = new Map(); // "year|setKey" -> rows[]
  const cellIndexCache = new Map(); // "year|setKey" -> byNumber Map
  const idIndexCache = new Map(); // "year|setKey" -> Map(id -> row)

  async function loadCatalogCell(year, setKey) {
    const key = `${year}|${setKey}`;
    if (cellRowCache.has(key)) return cellRowCache.get(key);
    const rows = [];
    try {
      const it = cat.items.query(
        {
          query: "SELECT c.id, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.source, c.sourceSystem, c.sources FROM c WHERE c.year=@y AND c.setKey=@s",
          parameters: [{ name: "@y", value: Number(year) }, { name: "@s", value: setKey }],
        },
        { maxItemCount: 500, maxDegreeOfParallelism: -1 },
      );
      // while(hasMoreResults()) — empty pages before the end are expected.
      while (it.hasMoreResults()) {
        const page = await retry(() => it.fetchNext());
        for (const r of page.resources || []) rows.push(r);
      }
      console.log(`  loaded catalog cell ${key}: ${f(rows.length)} rows`);
    } catch (e) {
      console.error(`  catalog cell load FAILED ${key}: ${String(e && e.message).slice(0, 150)}`);
    }
    cellRowCache.set(key, rows);
    const byId = new Map();
    for (const r of rows) byId.set(r.id, r);
    idIndexCache.set(key, byId);
    const { indexCatalogCell } = module.exports;
    cellIndexCache.set(key, indexCatalogCell(rows));
    return rows;
  }

  function getCellIndex(year, setKey) {
    const key = `${year}|${setKey}`;
    return { rows: cellRowCache.get(key) || [], byNumber: cellIndexCache.get(key) || new Map() };
  }
  function pointReadById(id) {
    if (!id || !String(id).startsWith("hiq:")) return null;
    const parts = String(id).split(":");
    if (parts.length < 4) return null;
    const year = Number(parts[2]);
    const setKey = parts[3];
    const key = `${year}|${setKey}`;
    const byId = idIndexCache.get(key);
    return byId ? (byId.get(id) || null) : null;
  }

  const io = { pointReadById, getCellIndex };

  const perCellSummaries = {};
  const aggregate = new Map();

  for (const cell of cells) {
    console.log(`\n=== ${cell.sport} ${cell.year} ${cell.setKey} ===`);
    await loadCatalogCell(cell.year, cell.setKey);

    const query = {
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.setName, c.sport, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.gradeCompany, c.gradeValue, c.source, c.sourceSystem, c.flaggedWrong, c.excludedFromFmv FROM c WHERE c.sport=@sp AND c.cardYear=@yr AND c.setName=@sk",
      parameters: [{ name: "@sp", value: cell.sport }, { name: "@yr", value: cell.year }, { name: "@sk", value: cell.setKey }],
    };
    const it = pool.items.query(query, { maxItemCount: 500, maxDegreeOfParallelism: -1 });

    const cellStats = { scanned: 0, sampled: 0, unbacked: 0, staleWithRowCount: 0, buckets: {}, totalPopulationHint: 0 };
    let sampled = 0;
    let pageNum = 0;

    // while(hasMoreResults()) — never a fixed page count, never -1 as a cap.
    while (it.hasMoreResults() && sampled < SAMPLE) {
      pageNum++;
      const page = await retry(() => it.fetchNext());
      await chargeSoldCompsRu(page.requestCharge || 0);
      const rows = page.resources || [];
      cellStats.totalPopulationHint += rows.length;

      for (const row of rows) {
        cellStats.scanned++;
        if (sampled >= SAMPLE) break;
        if (row.flaggedWrong === true || row.excludedFromFmv === true) continue;

        const storedSlug = row.hobbyiqCardId || row.cardId || null;
        const storedRow = pointReadById(storedSlug);
        if (isBacked(storedRow)) continue; // already backed; not part of the unbacked population

        sampled++;
        cellStats.sampled++;
        cellStats.unbacked++;

        const classification = classifyOne(row, cell, deps, io);
        cellStats.buckets[classification.name] = (cellStats.buckets[classification.name] || 0) + 1;
        if (classification.name === "STALE") {
          cellStats.staleWithRowCount++;
          continue; // rematch's lever, never the worklist's
        }
        foldIntoAggregate(aggregate, cell.sport, cell.year, row, classification);
      }
      console.log(`  page ${pageNum} (RU ${Math.round(page.requestCharge || 0)}): sampled=${f(sampled)} unbacked=${f(cellStats.unbacked)}`);
    }

    perCellSummaries[`${cell.sport}|${cell.year}|${cell.setKey}`] = summarizeCell(cellStats);
  }

  const ranked = rankAggregate(aggregate).map((r) => ({ ...r, sourceUrls: guessSourceUrls(r.sport, r.year, r.setKey) }));

  writeOutputs(OUT_DIR, ranked, perCellSummaries, { sport: SPORT, cells, sample: SAMPLE });
  console.log(`\nWrote worklist.csv + WORKLIST.md to ${OUT_DIR}`);
}

/** Resolve the cell list either from an explicit sport/years/setkeys triple,
 *  or from a backing-census merge file's `allSportsUnbackedCells.rows`
 *  (ranked by `unbacked` count, top `topCells` for the given sport/years). */
function resolveCells({ sport, years, setkeys, cellsFrom, topCells }) {
  if (cellsFrom) {
    const j = JSON.parse(fs.readFileSync(cellsFrom, "utf8"));
    const block = j.allSportsUnbackedCells;
    if (!block || !Array.isArray(block.rows)) {
      throw new Error(`${cellsFrom} has no allSportsUnbackedCells.rows`);
    }
    const idx = Object.fromEntries(block.columns.map((c, i) => [c, i]));
    let rows = block.rows.filter((r) => r[idx.sport] === sport);
    if (years.length) rows = rows.filter((r) => years.includes(Number(r[idx.year])));
    rows.sort((a, b) => b[idx.unbacked] - a[idx.unbacked]);
    if (topCells > 0) rows = rows.slice(0, topCells);
    return rows.map((r) => ({ sport: r[idx.sport], year: Number(r[idx.year]), setKey: r[idx.setKey], unbackedHint: r[idx.unbacked] }));
  }
  const cells = [];
  for (const year of years) {
    for (const setKey of setkeys) cells.push({ sport, year, setKey });
  }
  return cells;
}

function writeOutputs(outDir, ranked, perCellSummaries, meta) {
  // worklist.csv
  const csvHeader = ["rank", "sport", "year", "setKey", "prefix", "parallel", "isAuto", "printRun", "salesCount", "share", "cumulativeShare", "distinctCardNumbers", "exampleTitle", "checklistinsiderUrl(GUESS)", "baseballcardpediaUrl(GUESS)", "cardboardconnectionUrl(GUESS)"];
  const csvLines = [csvHeader.join(",")];
  ranked.forEach((r, i) => {
    const urlFor = (source) => (r.sourceUrls.find((u) => u.source === source) || {}).url || "";
    csvLines.push([
      i + 1, r.sport, r.year, r.setKey, r.prefix, csvEscape(r.parallel), r.isAuto, r.printRun ?? "",
      r.salesCount, (r.share * 100).toFixed(2) + "%", (r.cumulativeShare * 100).toFixed(2) + "%",
      r.distinctCardNumbers, csvEscape((r.exampleTitles[0] || "")),
      urlFor("checklistinsider"), urlFor("baseballcardpedia"), urlFor("cardboardconnection"),
    ].join(","));
  });
  fs.writeFileSync(path.join(outDir, "worklist.csv"), csvLines.join("\n") + "\n");

  // WORKLIST.md
  const md = [];
  md.push(`# Acquisition worklist — ${meta.sport}, ${meta.cells.map((c) => `${c.year}:${c.setKey}`).join(", ")}`);
  md.push("");
  md.push(`Read-only. Generated ${new Date().toISOString()}. Sample cap: ${meta.sample}/cell.`);
  md.push("");
  md.push("Every source URL below is a GUESS from a naming pattern (checklistinsider `/<year>-<product>-<sport>-checklist`, baseballcardpedia `index.php/<Year>_<Product>`, cardboardconnection `/<year>-<product>-<sport>-cards`) — **verify before acting**, none of these were fetched by this script.");
  md.push("");
  const MD_TOP_N = Number(process.env.WORKLIST_MD_TOP_N || 200);
  const shown = ranked.slice(0, MD_TOP_N);
  md.push(`## Ranked acquisition worklist (top ${f(shown.length)} of ${f(ranked.length)} destination buckets, by sales count, cumulative share)`);
  md.push("");
  if (ranked.length > shown.length) {
    md.push(`Full ranked list (all ${f(ranked.length)} buckets, most of it a long tail of count-1 destinations) is in \`worklist.csv\` next to this file.`);
    md.push("");
  }
  md.push("| Rank | Destination (sport/year/setKey/prefix/parallel/auto/printRun) | Sales | Share | Cumulative | Distinct #s | Example title | Guess URLs |");
  md.push("|---|---|---|---|---|---|---|---|");
  shown.forEach((r, i) => {
    const dest = `${r.sport}/${r.year}/${r.setKey}/${r.prefix}/${r.parallel}/${r.isAuto ? "auto" : "non-auto"}/${r.printRun ?? "-"}`;
    const urls = r.sourceUrls.map((u) => `[${u.source}](${u.url})`).join(", ");
    md.push(`| ${i + 1} | ${dest} | ${f(r.salesCount)} | ${(r.share * 100).toFixed(1)}% | ${(r.cumulativeShare * 100).toFixed(1)}% | ${r.distinctCardNumbers} | ${mdEscape(r.exampleTitles[0] || "")} | ${urls} |`);
  });
  md.push("");
  md.push("## Per-cell summary (sample fraction, bucket shares, the two separated levers)");
  md.push("");
  md.push("| Cell | Sampled | Unbacked | Sample fraction | STALE-with-row (rematch lever) | Acquisition-bound (this lever) | Bucket shares |");
  md.push("|---|---|---|---|---|---|---|");
  for (const [cellKey, s] of Object.entries(perCellSummaries)) {
    const shares = Object.entries(s.bucketShares).map(([n, sh]) => `${n}: ${(sh * 100).toFixed(1)}%`).join("; ");
    md.push(`| ${cellKey} | ${f(s.sampled)} | ${f(s.unbacked)} | ${(s.sampledFraction * 100).toFixed(2)}% | ${f(s.staleWithRowCount)} | ${f(s.acquisitionCount)} | ${shares} |`);
  }
  md.push("");
  fs.writeFileSync(path.join(outDir, "WORKLIST.md"), md.join("\n"));

  fs.writeFileSync(path.join(outDir, "per-cell-summary.json"), JSON.stringify(perCellSummaries, null, 2));
}

function csvEscape(s) {
  const str = String(s ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}
function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

async function retry(fn, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const backoff = Math.min(30000, 500 * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
