#!/usr/bin/env node
// CF-EXPAND-CATALOG-FULL (Drew, 2026-08-01).
//
// FULL catalog enumeration from CardHedge. Iterates every
// (sport, year, product) tuple in our known-product universe and pulls
// every card CH catalogs for that set — including all variants,
// print-runs, and imageUrls. Persists each to card_catalog.
//
// Runtime: ~10-20 hours full sweep across baseball + basketball +
// football × 22 products × 30 years × 25-500 cards/set. Self-relaunches
// via the backfill-runner workflow after each 30-min slice until every
// tuple in the space is covered.
//
// Checkpoint: doc in card_catalog with the last-processed (sport,
// product, year) tuple + cursor. Idempotent: re-invocations skip
// already-processed tuples.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   CARD_HEDGE_API_KEY         required (never echoed)
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_MAX_MINUTES       per-invocation cap (default 25, workflow slice = 30 min)
//   BACKFILL_CONCURRENCY       parallel CH pages (default 3)

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 3));
const CHECKPOINT_ID = "expand-catalog-full-enumeration::checkpoint";

if (!process.env.CARD_HEDGE_API_KEY) {
  console.error("CARD_HEDGE_API_KEY required — cannot enumerate CH catalog");
  process.exit(2);
}

const CH_API = "https://api.cardhedger.com/v1";
const START_TIME = Date.now();

async function chSearchCards(query, category, limit = 50, page = 1) {
  const url = `${CH_API}/cards/card-search`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.CARD_HEDGE_API_KEY,
    },
    body: JSON.stringify({
      search: query,
      category,
      page,
      page_size: Math.max(1, Math.min(limit, 50)),
    }),
  });
  if (!res.ok) {
    if (res.status === 429) return { _rateLimited: true };
    if (res.status >= 500) return { _serverError: true, status: res.status };
    console.warn(`CH HTTP ${res.status} for "${query}" (${category})`);
    return null;
  }
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.cards) ? body.cards : null;
}

async function withRetry(fn, attempts = 4, baseMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r && r._rateLimited) {
        await new Promise(res => setTimeout(res, 5000 + Math.random() * 3000));
        continue;
      }
      return r;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
  return null;
}

const PRODUCTS = [
  // ── Baseball — Bowman family ──
  { sport: "baseball", product: "Bowman Chrome Prospects",    startYear: 1997, endYear: 2026 },
  { sport: "baseball", product: "Bowman Chrome",              startYear: 1997, endYear: 2026 },
  { sport: "baseball", product: "Bowman Draft Chrome",        startYear: 1999, endYear: 2026 },
  { sport: "baseball", product: "Bowman Draft",               startYear: 1995, endYear: 2026 },
  { sport: "baseball", product: "Bowman",                     startYear: 1989, endYear: 2026 },
  { sport: "baseball", product: "Bowman Sterling",            startYear: 2004, endYear: 2026 },
  { sport: "baseball", product: "Bowman's Best",              startYear: 1994, endYear: 2026 },
  { sport: "baseball", product: "Bowman Chrome Sapphire",     startYear: 2018, endYear: 2026 },
  { sport: "baseball", product: "Bowman Inception",           startYear: 2011, endYear: 2026 },
  { sport: "baseball", product: "Bowman Mega Box",            startYear: 2018, endYear: 2026 },
  // ── Baseball — Topps family ──
  { sport: "baseball", product: "Topps Chrome",               startYear: 1996, endYear: 2026 },
  { sport: "baseball", product: "Topps Chrome Update",        startYear: 2015, endYear: 2026 },
  { sport: "baseball", product: "Topps Chrome Sapphire",      startYear: 2019, endYear: 2026 },
  { sport: "baseball", product: "Topps Chrome Platinum",      startYear: 2021, endYear: 2026 },
  { sport: "baseball", product: "Topps",                      startYear: 1989, endYear: 2026 },
  { sport: "baseball", product: "Topps Update",               startYear: 2006, endYear: 2026 },
  { sport: "baseball", product: "Topps Heritage",             startYear: 2001, endYear: 2026 },
  { sport: "baseball", product: "Topps Finest",               startYear: 1993, endYear: 2026 },
  { sport: "baseball", product: "Topps Stadium Club",         startYear: 1991, endYear: 2026 },
  { sport: "baseball", product: "Topps Allen and Ginter",     startYear: 2006, endYear: 2026 },
  { sport: "baseball", product: "Topps Gypsy Queen",          startYear: 2011, endYear: 2026 },
  { sport: "baseball", product: "Topps Archives",             startYear: 1994, endYear: 2026 },
  { sport: "baseball", product: "Topps Inception",            startYear: 2013, endYear: 2026 },
  { sport: "baseball", product: "Topps Tribute",              startYear: 2002, endYear: 2026 },
  { sport: "baseball", product: "Topps Dynasty",              startYear: 2013, endYear: 2026 },
  { sport: "baseball", product: "Topps Definitive",           startYear: 2017, endYear: 2026 },
  { sport: "baseball", product: "Topps Museum Collection",    startYear: 2014, endYear: 2026 },
  { sport: "baseball", product: "Topps Five Star",            startYear: 2012, endYear: 2026 },
  { sport: "baseball", product: "Topps Transcendent",         startYear: 2015, endYear: 2026 },
  { sport: "baseball", product: "Topps Pristine",             startYear: 2004, endYear: 2026 },
  // ── Basketball ──
  { sport: "basketball", product: "Panini Prizm",             startYear: 2012, endYear: 2026 },
  { sport: "basketball", product: "Panini Select",            startYear: 2013, endYear: 2026 },
  { sport: "basketball", product: "Panini Mosaic",            startYear: 2019, endYear: 2026 },
  { sport: "basketball", product: "Panini Donruss Optic",     startYear: 2018, endYear: 2026 },
  { sport: "basketball", product: "Panini Donruss",           startYear: 2015, endYear: 2026 },
  { sport: "basketball", product: "Panini Contenders",        startYear: 2013, endYear: 2026 },
  { sport: "basketball", product: "Panini Immaculate",        startYear: 2013, endYear: 2026 },
  { sport: "basketball", product: "Panini Flawless",          startYear: 2013, endYear: 2026 },
  { sport: "basketball", product: "Panini National Treasures", startYear: 2013, endYear: 2026 },
  { sport: "basketball", product: "Panini Absolute",          startYear: 2015, endYear: 2026 },
  { sport: "basketball", product: "Panini Chronicles",        startYear: 2018, endYear: 2026 },
  { sport: "basketball", product: "Topps Chrome",             startYear: 2013, endYear: 2016 },
  // ── Football ──
  { sport: "football",   product: "Panini Prizm",             startYear: 2012, endYear: 2026 },
  { sport: "football",   product: "Panini Select",            startYear: 2013, endYear: 2026 },
  { sport: "football",   product: "Panini Mosaic",            startYear: 2019, endYear: 2026 },
  { sport: "football",   product: "Panini Donruss Optic",     startYear: 2018, endYear: 2026 },
  { sport: "football",   product: "Panini Donruss",           startYear: 2015, endYear: 2026 },
  { sport: "football",   product: "Panini Contenders",        startYear: 2013, endYear: 2026 },
  { sport: "football",   product: "Panini National Treasures", startYear: 2013, endYear: 2026 },
  { sport: "football",   product: "Panini Immaculate",        startYear: 2013, endYear: 2026 },
  { sport: "football",   product: "Panini Absolute",          startYear: 2015, endYear: 2026 },
  { sport: "football",   product: "Panini Flawless",          startYear: 2013, endYear: 2026 },
  { sport: "football",   product: "Panini Chronicles",        startYear: 2018, endYear: 2026 },
];

function contentHash(source, cardId) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(`${source}::${cardId}`).digest("hex").slice(0, 8);
}

function timeExpired() {
  return (Date.now() - START_TIME) / 60000 > MAX_MINUTES;
}

const SPORT_TO_CH_CATEGORY = {
  baseball: "Baseball",
  basketball: "Basketball",
  football: "Football",
  hockey: "Hockey",
  soccer: "Soccer",
};

async function processTuple(cc, tuple, seenCardIds) {
  const query = `${tuple.year} ${tuple.product}`;
  const category = SPORT_TO_CH_CATEGORY[tuple.sport] || "Baseball";
  let page = 1;
  let persisted = 0, empty = 0;
  const MAX_PAGES = 40; // covers ~2000 cards per set at 50/page
  while (page <= MAX_PAGES && !timeExpired()) {
    let cards;
    try { cards = await withRetry(() => chSearchCards(query, category, 50, page)); }
    catch { return { persisted, error: true, empty }; }
    if (!Array.isArray(cards) || cards.length === 0) { empty++; break; }
    let newInPage = 0;
    for (const card of cards) {
      const cardId = String(card.card_id ?? card.cardId ?? "").trim();
      if (!cardId) continue;
      if (seenCardIds.has(cardId)) continue;
      seenCardIds.add(cardId);
      newInPage++;
      if (MODE !== "apply") { persisted++; continue; }
      const doc = {
        id: `cardhedge::${cardId}::${contentHash("cardhedge", cardId)}`,
        cardId,
        source: "cardhedge",
        contentHash: contentHash("cardhedge", cardId),
        title: card.title ?? card.name ?? null,
        player: card.player ?? null,
        set: card.set ?? `${tuple.year} ${tuple.product}`,
        year: card.year ?? tuple.year,
        number: card.number ?? null,
        variant: card.variant ?? null,
        imageUrl: card.image ?? card.image_url ?? null,
        sport: tuple.sport,
        observedAt: new Date().toISOString(),
        __expandedFromFull: true,
        __expandedAt: new Date().toISOString(),
      };
      try { await cc.items.upsert(doc); persisted++; } catch { /* skip */ }
    }
    if (cards.length < 50) break; // last page
    page++;
    await new Promise(r => setTimeout(r, 200)); // rate limit friendly
  }
  return { persisted, error: false, empty };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cc = db.container("card_catalog");

  console.log(`[expand-catalog-full]  mode=${MODE}  maxMinutes=${MAX_MINUTES}  concurrency=${CONCURRENCY}`);

  // Build the tuple universe
  const tuples = [];
  for (const p of PRODUCTS) {
    for (let y = p.startYear; y <= p.endYear; y++) {
      tuples.push({ sport: p.sport, product: p.product, year: y, key: `${p.sport}::${p.product}::${y}` });
    }
  }
  console.log(`  total tuples: ${tuples.length}`);

  // Load checkpoint
  let processed = new Set();
  try {
    const { resource } = await cc.item(CHECKPOINT_ID, CHECKPOINT_ID).read().catch(() => ({ resource: null }));
    if (resource?.processedKeys) processed = new Set(resource.processedKeys);
    console.log(`  Resuming — already processed: ${processed.size} tuples`);
  } catch { /* first run */ }

  // Optimistically load seen cardIds so we skip within-tuple dupes fast
  const seenCardIds = new Set();

  let totalPersisted = 0, tuplesProcessed = 0, tuplesSkippedEmpty = 0;
  for (const tuple of tuples) {
    if (timeExpired()) { console.log(`\n⏰ Time cap reached at tuple ${tuplesProcessed}/${tuples.length}`); break; }
    if (processed.has(tuple.key)) continue;
    const t0 = Date.now();
    const { persisted, empty } = await processTuple(cc, tuple, seenCardIds);
    totalPersisted += persisted;
    tuplesProcessed++;
    if (empty && persisted === 0) tuplesSkippedEmpty++;
    processed.add(tuple.key);
    if (tuplesProcessed % 5 === 0) {
      console.log(`  [${tuplesProcessed}] ${tuple.sport}/${tuple.product}/${tuple.year}  persisted=${persisted}  total=${totalPersisted}  elapsed=${Math.round((Date.now() - t0)/1000)}s`);
    }
  }

  // Update checkpoint
  if (MODE === "apply") {
    await cc.items.upsert({
      id: CHECKPOINT_ID,
      cardId: CHECKPOINT_ID,
      processedKeys: [...processed],
      totalPersisted: (Number((await cc.item(CHECKPOINT_ID, CHECKPOINT_ID).read().catch(() => ({ resource: {} }))).resource?.totalPersisted) || 0) + totalPersisted,
      lastRunAt: new Date().toISOString(),
    });
  }

  const remaining = tuples.length - processed.size;
  console.log(`\n=== Slice done ===`);
  console.log(`  tuples processed this slice: ${tuplesProcessed}`);
  console.log(`  cards persisted this slice:  ${totalPersisted}`);
  console.log(`  tuples skipped (empty):      ${tuplesSkippedEmpty}`);
  console.log(`  remaining tuples:            ${remaining}`);
  if (remaining > 0) console.log(`RELAUNCH_NEEDED=true`);
  else console.log(`RELAUNCH_NEEDED=false — full catalog enumeration complete`);
}

main().catch(e => { console.error(e); process.exit(1); });
