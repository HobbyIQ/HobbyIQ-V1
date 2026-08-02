// CF-BACKFILL-CATALOG-FROM-SOLD-COMPS (Drew, 2026-08-02). Closes the
// gap between "cards we've SEEN sell (in sold_comps)" and "cards we've
// INDEXED for search (in card_catalog)". CH-source sales cover ~517K
// distinct cardIds; card_catalog only has ~251K CH-source rows.
// Result: ~266K cards had real observed sales but were invisible to
// the catalog-first search — users saw 0 results even though we knew
// the card existed.
//
// Approach: aggregate identity from sold_comps in-memory (each sale
// carries playerName/setName/cardNumber/parallel/sport/isAuto/imageUrl),
// take the most-common value per field per cardId, compute searchText +
// searchTokens the same way persistVendorCatalog does at runtime, and
// upsert into card_catalog with source='cardhedge'. No CH API calls —
// pure data pipeline.
//
// Env:
//   COSMOS_CONNECTION_STRING     (required)
//   APPLY=true                   execute writes (else dry-run count only)
//   CONCURRENCY=6                parallel upsert workers (Cosmos 429-safe)
//   MAX_MINUTES=90               wall-clock cap; re-runnable
//   SPORT=<sport>                only process one sport (default: all)
//
// Usage:
//   Dry-run:  node scripts/backfill-catalog-from-sold-comps.cjs
//   Live:     APPLY=true node scripts/backfill-catalog-from-sold-comps.cjs

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 90));
const SPORT_FILTER = typeof process.env.SPORT === "string" && process.env.SPORT.trim() ? process.env.SPORT.trim() : null;

// ─── Search-index helpers (kept in sync with searchIndexing.service.ts) ───
function buildSearchText(row) {
  const parts = [];
  if (row.player) parts.push(String(row.player));
  if (row.releaseName) parts.push(String(row.releaseName));
  if (row.setName && row.setName !== row.releaseName) parts.push(String(row.setName));
  if (row.number) parts.push(String(row.number));
  if (row.year !== undefined && row.year !== null && row.year !== "") parts.push(String(row.year));
  if (Array.isArray(row.parallels)) for (const p of row.parallels) if (p && p.name) parts.push(String(p.name));
  if (Array.isArray(row.attributes)) for (const a of row.attributes) if (a) parts.push(String(a));
  return parts.join(" ").toLowerCase();
}
function buildSearchTokens(searchText) {
  if (!searchText) return [];
  const seen = new Set(); const out = [];
  const raw = String(searchText).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const r of raw) {
    if (r.length >= 2 && !seen.has(r)) { seen.add(r); out.push(r); }
    if (r.includes("-")) {
      for (const f of r.split("-")) {
        if (f.length >= 2 && !seen.has(f)) { seen.add(f); out.push(f); }
      }
    }
  }
  return out;
}

// Pick the most-common value from an array of samples. Ties: first-seen wins.
function mostCommon(samples) {
  const counts = new Map();
  for (const s of samples) {
    if (s === null || s === undefined) continue;
    const k = String(s);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null; let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const catalog = db.container("card_catalog");
  const sold = db.container("sold_comps");

  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  console.log(`[backfill-catalog-from-sold-comps] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}${SPORT_FILTER ? ` sport=${SPORT_FILTER}` : ""}`);

  // Phase 1 — load all existing CH-source cardIds from card_catalog into a Set.
  console.log("phase 1: loading existing CH cardIds from card_catalog…");
  const existing = new Set();
  {
    const iter = catalog.items.query({
      query: `SELECT c.cardId FROM c WHERE c.source = 'cardhedge' AND IS_DEFINED(c.cardId)${SPORT_FILTER ? " AND c.sport = @sport" : ""}`,
      parameters: SPORT_FILTER ? [{ name: "@sport", value: SPORT_FILTER }] : [],
    }, { maxItemCount: 1000 });
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources) if (r?.cardId) existing.add(String(r.cardId));
    }
  }
  console.log(`  existing CH catalog cardIds: ${existing.size}`);

  // Phase 2 — stream sold_comps, aggregate identity per NEW cardId.
  console.log("phase 2: streaming sold_comps to aggregate missing-card identity…");
  // agg: cardId → { players[], setNames[], cardNumbers[], parallels[], sports[], years[], autos[], imageUrls[], sampleCount }
  const agg = new Map();
  const soldQ = `SELECT c.cardId, c.playerName, c.setName, c.cardNumber, c.parallel, c.printRun,
                        c.isAuto, c.cardYear, c.sport, c.imageUrl
                 FROM c
                 WHERE c.source = 'cardhedge' AND IS_DEFINED(c.cardId)${SPORT_FILTER ? " AND c.sport = @sport" : ""}`;
  let scanned = 0; let uniqueNew = 0;
  const iter = sold.items.query({
    query: soldQ,
    parameters: SPORT_FILTER ? [{ name: "@sport", value: SPORT_FILTER }] : [],
  }, { maxItemCount: 1000 });
  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn(`  phase-2 wall-clock cap ${MAX_MINUTES}m reached — stopping scan.`); break; }
    const { resources } = await iter.fetchNext();
    scanned += resources.length;
    for (const r of resources) {
      const cid = String(r.cardId || ""); if (!cid) continue;
      if (existing.has(cid)) continue;   // already catalogued — skip
      let entry = agg.get(cid);
      if (!entry) { entry = { players: [], setNames: [], cardNumbers: [], parallels: [], sports: [], years: [], autos: [], imageUrls: [], sampleCount: 0 }; agg.set(cid, entry); uniqueNew++; }
      if (r.playerName) entry.players.push(r.playerName);
      if (r.setName) entry.setNames.push(r.setName);
      if (r.cardNumber) entry.cardNumbers.push(r.cardNumber);
      if (r.parallel) entry.parallels.push(r.parallel);
      if (r.sport) entry.sports.push(r.sport);
      if (r.cardYear !== undefined && r.cardYear !== null) entry.years.push(r.cardYear);
      if (typeof r.isAuto === "boolean") entry.autos.push(r.isAuto);
      if (r.imageUrl && String(r.imageUrl).startsWith("http") && !String(r.imageUrl).includes("/api/compiq/card-image/")) entry.imageUrls.push(r.imageUrl);
      entry.sampleCount++;
    }
    if (scanned % 100000 === 0) {
      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  scanned=${scanned}, uniqueNew=${uniqueNew}, elapsed=${elapsedS}s`);
    }
  }
  console.log(`  scan complete: scanned=${scanned}, uniqueNew=${uniqueNew}`);

  if (uniqueNew === 0) {
    console.log("nothing to backfill.");
    return;
  }
  if (!APPLY) {
    console.log(`DRY-RUN — would upsert ${uniqueNew} new card_catalog rows. Re-run with APPLY=true.`);
    return;
  }

  // Phase 3 — reduce + upsert.
  console.log(`phase 3: reducing + upserting ${uniqueNew} card_catalog rows…`);
  const nowIso = new Date().toISOString();
  const inflight = new Set();
  let written = 0; let failed = 0;
  async function upsertOne(cardId, entry) {
    try {
      const player = mostCommon(entry.players);
      const setName = mostCommon(entry.setNames);
      const cardNumber = mostCommon(entry.cardNumbers);
      const parallelName = mostCommon(entry.parallels);
      const sport = mostCommon(entry.sports);
      const year = mostCommon(entry.years);
      const isAuto = mostCommon(entry.autos.map(String)) === "true";
      const imageUrl = entry.imageUrls[0] || null;   // first-seen is fine; not perfect but not worth another pass

      // Skip if we lack the two must-haves for a useful catalog row.
      if (!player || !setName) return;

      // Match the shape of runtime persistVendorCatalog rows so canonical
      // search and downstream consumers see it as first-class CH data.
      const parallels = parallelName ? [{ id: null, name: parallelName, numberedTo: null }] : [];
      const attributes = isAuto ? ["auto"] : [];
      const idx = { player, releaseName: setName, setName, number: cardNumber, year: year ?? null, parallels, attributes };
      const searchText = buildSearchText(idx);
      const searchTokens = buildSearchTokens(searchText);
      const doc = {
        id: `cardhedge::${cardId}`,
        cardId,
        source: "cardhedge",
        sport: sport ?? null,
        player,
        releaseName: setName,
        setName,
        number: cardNumber,
        year: year ?? null,
        parallels,
        attributes,
        imageUrl,
        searchText,
        searchTokens,
        recentSaleCount: entry.sampleCount,
        __derivedFromSoldComps: true,
        __derivedAt: nowIso,
      };
      await catalog.items.upsert(doc);
      written++;
      if (written % 2500 === 0) {
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
        const ratePerS = (written / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
        console.log(`  written=${written}/${uniqueNew} failed=${failed} elapsed=${elapsedS}s rate=${ratePerS}/s`);
      }
    } catch (err) {
      failed++;
      if (failed < 10) console.warn(`  upsert failed cardId=${cardId}: ${err?.code ?? err?.message ?? err}`);
    }
  }

  for (const [cardId, entry] of agg) {
    if (Date.now() - startMs > budgetMs) { console.warn(`  phase-3 wall-clock cap ${MAX_MINUTES}m reached — stopping writes.`); break; }
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const p = upsertOne(cardId, entry).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all([...inflight]);

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n[backfill-catalog-from-sold-comps] done — written=${written} failed=${failed} skipped(no player/set)=${uniqueNew - written - failed} elapsed=${elapsedS}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
