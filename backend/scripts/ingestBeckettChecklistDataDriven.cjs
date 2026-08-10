#!/usr/bin/env node
/**
 * CF-BECKETT-CHECKLIST-DATA-DRIVEN (Drew, 2026-08-09). V2 of the
 * Beckett checklist ingester. Instead of exploding each card into
 * every parallel from a hardcoded manifest, this version:
 *
 *   1. Loads (cardNumber, playerName) from the Beckett XLSX
 *   2. Queries sold_comps for the OBSERVED (parallel, printRun)
 *      tuples for that specific (year, setKey, cardNumber)
 *   3. Materializes catalog rows ONLY for parallels with sales evidence
 *
 * Per Drew's guidance 2026-08-09: "learn from what we have. dont make
 * parallel assumptions unless the data is there." Zero phantom rows
 * for parallels a card doesn't actually have.
 *
 * A player card that never had a SuperFractor sold has no SuperFractor
 * catalog row. If SuperFractor sales appear later, the next ingest run
 * picks them up.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/ingestBeckettChecklistDataDriven.cjs \
 *     --xlsx=/path/to/beckett.xlsx --year=2024 --sport=baseball \
 *     --setKey=bowman-chrome --subset=autographs [--apply]
 */

const XLSX = require("xlsx");
const { CosmosClient } = require("@azure/cosmos");
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

if (!XLSX_PATH || !YEAR || !SET_KEY) { console.error("Missing required --xlsx / --year / --setKey"); process.exit(1); }
if (!fs.existsSync(XLSX_PATH)) { console.error(`XLSX not found: ${XLSX_PATH}`); process.exit(1); }

function extractChunks(sheet, sheetName) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const chunks = [];
  let currentChunk = null;
  for (const row of rows) {
    const cell0 = String(row[0] ?? "").trim();
    if (!cell0) continue;
    const isHeader = /Checklist$/i.test(cell0) || (!/^\d+$/.test(cell0) && !/^[A-Z]{1,6}-?[A-Z0-9]{1,10}$/i.test(cell0));
    if (isHeader) {
      if (currentChunk && currentChunk.rows.length > 0) chunks.push(currentChunk);
      currentChunk = { subsetName: cell0, rows: [] };
      continue;
    }
    const cardNumber = cell0;
    const playerName = String(row[1] ?? "").trim();
    const team = String(row[2] ?? "").trim();
    if (!playerName) continue;
    if (!currentChunk) currentChunk = { subsetName: sheetName, rows: [] };
    currentChunk.rows.push({ cardNumber, playerName, team });
  }
  if (currentChunk && currentChunk.rows.length > 0) chunks.push(currentChunk);
  return chunks;
}

function normalizeParallelSlug(name) {
  return String(name || "base").toLowerCase().trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function buildCatalogRow({ year, sport, setKey, cardNumber, playerName, team, parallelName, parallelSlug, printRun, isAuto, sampleCount }) {
  const cardNumSlug = String(cardNumber).toLowerCase().replace(/\s+/g, "-");
  const autoSuffix = isAuto ? ":auto" : ":no-auto";
  const printRunSuffix = printRun ? `:num-${printRun}` : "";
  const slug = `hiq:${sport}:${year}:${setKey}:${cardNumSlug}:${parallelSlug}${autoSuffix}${printRunSuffix}`;
  const searchTokens = new Set([
    ...playerName.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
    ...setKey.split("-").filter(Boolean),
    cardNumSlug,
    ...cardNumSlug.split("-").filter(Boolean),
    String(year),
    parallelSlug,
    ...parallelSlug.split("-").filter(Boolean),
    isAuto ? "auto" : null,
  ].flat().filter(Boolean));
  return {
    id: slug, cardId: slug, hobbyiqCardId: slug,
    sport, year, setKey,
    setName: setKey.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    cardNumber, playerName, team: team || null,
    parallel: parallelName, parallelSlug,
    isAuto, printRun,
    source: "beckett-checklist",
    catalogVersion: 2,
    catalogBatch: "beckett-2026-08-09",
    verificationStatus: "verified",
    builtAt: "2026-08-09T00:00:00.000Z",
    observedSampleCount: sampleCount,   // NEW: how many sold_comps rows we saw for this (card, parallel)
    searchTokens: [...searchTokens],
  };
}

// Query sold_comps once per (year, setKey, subset) to build an
// { cardNumber → [{ parallelName, parallelSlug, printRun, count }] } index.
// Handles the mess: multiple print runs seen for one parallel → pick the
// mode (most common), or the max non-1 value (skip printRun=1 which is
// often noise from Superfractor mislabeling).
async function buildObservedIndex(container, year, setKey, cardNumberPrefixList) {
  console.log(`\n[data-driven] querying sold_comps for observed parallels...`);
  const prefixWhere = cardNumberPrefixList.map((p, i) => `STARTSWITH(c.cardNumber, @p${i})`).join(" OR ");
  const params = cardNumberPrefixList.map((p, i) => ({ name: `@p${i}`, value: p }));
  params.push({ name: "@y", value: year });
  // Query on cardYear + prefix. We don't filter setKey server-side because
  // sold_comps rows may not carry a normalized setKey — filter after.
  const q = {
    query: `SELECT c.cardNumber, c.parallel, c.printRun, c.setName, c.setKey, c.hobbyiqCardId, COUNT(1) AS n
            FROM c
            WHERE c.cardYear = @y AND (${prefixWhere}) AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
            GROUP BY c.cardNumber, c.parallel, c.printRun, c.setName, c.setKey, c.hobbyiqCardId`,
    parameters: params,
  };
  let total = 0;
  const byCard = new Map();
  for await (const page of container.items.query(q, { maxItemCount: 1000 }).getAsyncIterator()) {
    for (const r of page.resources ?? []) {
      total++;
      // Filter to rows likely from this setKey (setKey or setName match)
      const rowSetKey = String(r.setKey ?? "").toLowerCase();
      const rowSetName = String(r.setName ?? "").toLowerCase();
      const targetKeyWords = setKey.split("-").filter(Boolean);
      const matchesSet = targetKeyWords.every((w) => rowSetKey.includes(w) || rowSetName.includes(w));
      // Also allow rows whose hobbyiqCardId includes the setKey segments
      const slug = String(r.hobbyiqCardId ?? "").toLowerCase();
      const slugMatches = targetKeyWords.every((w) => slug.includes(w));
      if (!matchesSet && !slugMatches) continue;
      const cn = String(r.cardNumber ?? "").trim();
      const parallelName = String(r.parallel ?? "Base").trim();
      const parallelSlug = normalizeParallelSlug(parallelName);
      const printRun = (typeof r.printRun === "number" && r.printRun > 0) ? r.printRun : null;
      if (!byCard.has(cn)) byCard.set(cn, new Map());
      const cardMap = byCard.get(cn);
      if (!cardMap.has(parallelSlug)) cardMap.set(parallelSlug, { parallelName, parallelSlug, printRunCounts: new Map(), totalCount: 0 });
      const entry = cardMap.get(parallelSlug);
      entry.totalCount += r.n;
      if (printRun !== null) entry.printRunCounts.set(printRun, (entry.printRunCounts.get(printRun) ?? 0) + r.n);
    }
  }
  console.log(`[data-driven] queried ${total} distinct (cardNumber, parallel, printRun) tuples, ${byCard.size} unique cards had observed parallels`);
  // Pick modal print run per parallel; skip printRun=1 (mis-normalized SuperFractor noise) unless it's the ONLY one
  const observedManifest = new Map();
  for (const [cn, cardMap] of byCard.entries()) {
    const manifest = [];
    for (const [slug, entry] of cardMap.entries()) {
      // Skip parallels with total count < 2 (too thin to be a real parallel)
      if (entry.totalCount < 2) continue;
      const runs = [...entry.printRunCounts.entries()].sort((a, b) => b[1] - a[1]);
      // Prefer runs > 1 (Base + Base Auto often lack printRun; Superfractor is /1)
      const nonOneRuns = runs.filter(([r]) => r > 1);
      const bestRun = nonOneRuns.length > 0 ? nonOneRuns[0][0] : (runs.length > 0 ? runs[0][0] : null);
      manifest.push({
        parallelName: entry.parallelName, parallelSlug: slug, printRun: bestRun, sampleCount: entry.totalCount,
      });
    }
    manifest.sort((a, b) => b.sampleCount - a.sampleCount);
    observedManifest.set(cn, manifest);
  }
  return observedManifest;
}

(async () => {
  console.log(`[data-driven] MODE=${APPLY ? "APPLY" : "DRY-RUN"} xlsx=${XLSX_PATH} year=${YEAR} setKey=${SET_KEY} subset=${SUBSET}`);
  const wb = XLSX.readFile(XLSX_PATH);
  const targetSheets = SUBSET === "all" ? ["Autographs", "Prospects", "Base"].filter((n) => wb.SheetNames.includes(n))
    : SUBSET === "autographs" ? ["Autographs"]
    : SUBSET === "prospects" ? ["Prospects"]
    : SUBSET === "base" ? ["Base"]
    : [];
  if (targetSheets.length === 0) { console.error(`Unknown --subset=${SUBSET}`); process.exit(1); }

  // Extract card numbers from XLSX
  const cardsBySheet = {};
  const cardNumbers = new Set();
  const prefixesForQuery = new Set();
  for (const sheetName of targetSheets) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const chunks = extractChunks(sheet, sheetName);
    cardsBySheet[sheetName] = [];
    for (const chunk of chunks) {
      for (const r of chunk.rows) {
        cardsBySheet[sheetName].push(r);
        cardNumbers.add(r.cardNumber);
        const m = /^([A-Z]{1,6})-/i.exec(r.cardNumber);
        if (m) prefixesForQuery.add(m[1] + "-");
      }
    }
    console.log(`[data-driven] sheet=${sheetName} chunks=${chunks.length} cards=${cardsBySheet[sheetName].length}`);
  }
  console.log(`[data-driven] total unique cardNumbers: ${cardNumbers.size} across prefixes: [${[...prefixesForQuery].join(",")}]`);

  // Connect + query observed manifest
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const sc = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  const observedManifest = await buildObservedIndex(sc, YEAR, SET_KEY, [...prefixesForQuery]);

  // Build catalog rows
  const allRows = [];
  const isAutoBySheet = { Autographs: true, Prospects: false, Base: false };
  let cardsWithNoData = 0;
  for (const [sheetName, cards] of Object.entries(cardsBySheet)) {
    const isAuto = isAutoBySheet[sheetName] ?? false;
    for (const card of cards) {
      const observed = observedManifest.get(card.cardNumber);
      if (!observed || observed.length === 0) {
        cardsWithNoData++;
        // Still materialize a Base row so the player exists in catalog
        allRows.push(buildCatalogRow({
          year: YEAR, sport: SPORT, setKey: SET_KEY,
          cardNumber: card.cardNumber, playerName: card.playerName, team: card.team,
          parallelName: "Base", parallelSlug: "base", printRun: null, isAuto, sampleCount: 0,
        }));
        continue;
      }
      // Materialize each observed parallel
      for (const par of observed) {
        allRows.push(buildCatalogRow({
          year: YEAR, sport: SPORT, setKey: SET_KEY,
          cardNumber: card.cardNumber, playerName: card.playerName, team: card.team,
          parallelName: par.parallelName, parallelSlug: par.parallelSlug,
          printRun: par.printRun, isAuto, sampleCount: par.sampleCount,
        }));
      }
    }
  }

  console.log(`\n[data-driven] Total rows to upsert: ${allRows.length}`);
  console.log(`[data-driven] Cards with no observed sales: ${cardsWithNoData} (each gets a Base row only)`);

  // Sample
  const samples = allRows.filter((r) => r.cardNumber === "CPA-EHA" || r.cardNumber === "CPA-JC");
  if (samples.length > 0) {
    console.log(`\nSAMPLE (CPA-EHA + CPA-JC):`);
    for (const r of samples) {
      console.log(`  ${r.hobbyiqCardId}`);
      console.log(`    player="${r.playerName}"  parallel="${r.parallel}" /${r.printRun}  observed_n=${r.observedSampleCount}`);
    }
  } else {
    console.log(`\nFirst 8 rows:`);
    for (const r of allRows.slice(0, 8)) {
      console.log(`  ${r.hobbyiqCardId}   ${r.playerName} · ${r.parallel} · n=${r.observedSampleCount}`);
    }
  }

  if (!APPLY) { console.log(`\n[data-driven] DRY-RUN. --apply to write.`); return; }

  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n[data-driven] APPLY — upserting ${allRows.length} rows (concurrency 16)`);
  let done = 0, errors = 0;
  const CH = 16;
  for (let i = 0; i < allRows.length; i += CH) {
    const batch = allRows.slice(i, i + CH);
    await Promise.all(batch.map(async (r) => {
      try { await cat.items.upsert(r); done++; }
      catch (err) { errors++; if (errors <= 5) console.warn(`   ERR ${r.id}: ${err.message.slice(0,80)}`); }
    }));
    process.stdout.write(`\r   ${done}/${allRows.length} (${errors} err)`);
  }
  console.log(`\n[data-driven] DONE — upserted ${done}, errors ${errors}`);
})().catch((e) => { console.error(e); process.exit(1); });
