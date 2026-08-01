#!/usr/bin/env node
// CF-EXPAND-CATALOG-FROM-CARDSIGHT (Drew, 2026-08-01). Parallel to the
// CH catalog enumeration — pulls the same (sport × year × product)
// space from Cardsight's GET /v1/catalog/cards. Combined with the CH
// pull, this doubles catalog coverage and gets us close to Beckett-
// comparable breadth for modern sports products.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   CARDSIGHT_API_KEY          required (never echoed)
//   BACKFILL_APPLY             apply | dry (default dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CHECKPOINT_ID = "expand-catalog-from-cardsight::checkpoint";

if (!process.env.CARDSIGHT_API_KEY) {
  console.error("CARDSIGHT_API_KEY required — cannot enumerate CS catalog");
  process.exit(2);
}

const CS_API = "https://api.cardsight.ai/v1";
const START_TIME = Date.now();
const CS_KEY = process.env.CARDSIGHT_API_KEY;

// CF-CS-IMAGE-PROBE (Drew, 2026-08-01). CS's catalog endpoint doesn't
// ship images — they live at /v1/images/cards/{id}. Probe per card
// and mark __hasImage explicitly so the catalog is organized (no
// ambiguity between "not probed" and "no image exists"). Rows without
// images stay in the catalog — search can filter/sort by __hasImage.
const PROXY_ORIGIN = process.env.PROXY_ORIGIN || "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function probeImageExists(cardId) {
  if (!UUID_RE.test(cardId)) return false;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${CS_API}/images/cards/${cardId}`, {
      headers: { "X-API-Key": CS_KEY },
      signal: controller.signal,
    });
    if (res.status === 200) {
      const ct = res.headers.get("content-type") || "";
      await res.arrayBuffer().catch(() => {});
      return ct.startsWith("image/");
    }
    return false;
  } catch { return false; }
  finally { clearTimeout(t); }
}

async function csGetCatalogCards(releaseName, year, take, skip) {
  const params = new URLSearchParams({ take: String(take), skip: String(skip) });
  if (releaseName) params.set("releaseName", releaseName);
  if (year) params.set("year", String(year));
  const url = `${CS_API}/catalog/cards?${params.toString()}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url, { headers: { "X-API-Key": CS_KEY, Accept: "application/json" }, signal: controller.signal });
  } finally { clearTimeout(t); }
  if (!res.ok) {
    if (res.status === 429) return { _rateLimited: true };
    return null;
  }
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.cards) ? body.cards : Array.isArray(body) ? body : null;
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
      await new Promise(res => setTimeout(res, baseMs * Math.pow(2, i)));
    }
  }
  return null;
}

function timeExpired() { return (Date.now() - START_TIME) / 60000 > MAX_MINUTES; }

// Exhaustive product taxonomy — maximum coverage per Drew's push.
const PRODUCTS = [
  // ── Baseball — Bowman family ──
  { sport: "baseball", product: "Bowman Chrome Prospects",    startYear: 1997, endYear: 2026 },
  { sport: "baseball", product: "Bowman Chrome",              startYear: 1997, endYear: 2026 },
  { sport: "baseball", product: "Bowman Chrome Draft",        startYear: 1999, endYear: 2026 },
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
  { sport: "basketball", product: "Panini Hoops",             startYear: 2012, endYear: 2026 },
  { sport: "basketball", product: "Panini Prizm Draft Picks", startYear: 2013, endYear: 2026 },
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
  { sport: "football",   product: "Panini Score",             startYear: 2015, endYear: 2026 },
  // ── Hockey ──
  { sport: "hockey",     product: "Upper Deck",               startYear: 2010, endYear: 2026 },
  { sport: "hockey",     product: "Upper Deck Series 1",      startYear: 2010, endYear: 2026 },
  { sport: "hockey",     product: "Upper Deck Series 2",      startYear: 2010, endYear: 2026 },
  { sport: "hockey",     product: "SP Authentic",             startYear: 2010, endYear: 2026 },
  { sport: "hockey",     product: "The Cup",                  startYear: 2010, endYear: 2026 },
  { sport: "hockey",     product: "O-Pee-Chee",               startYear: 2010, endYear: 2026 },
  { sport: "hockey",     product: "Young Guns",               startYear: 2010, endYear: 2026 },
  // ── Soccer ──
  { sport: "soccer",     product: "Panini Prizm",             startYear: 2015, endYear: 2026 },
  { sport: "soccer",     product: "Panini Select",            startYear: 2016, endYear: 2026 },
  { sport: "soccer",     product: "Panini Mosaic",            startYear: 2020, endYear: 2026 },
  { sport: "soccer",     product: "Topps Chrome",             startYear: 2014, endYear: 2026 },
];

function contentHash(source, cardId) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(`${source}::${cardId}`).digest("hex").slice(0, 8);
}

async function processTuple(cc, tuple, seenCardIds) {
  const query = tuple.product;
  let skip = 0;
  const take = 100;
  let persisted = 0;
  const MAX_PAGES = 40;
  for (let page = 0; page < MAX_PAGES && !timeExpired(); page++) {
    let cards;
    try { cards = await withRetry(() => csGetCatalogCards(query, tuple.year, take, skip)); }
    catch { return { persisted, error: true }; }
    if (!Array.isArray(cards) || cards.length === 0) break;

    for (const card of cards) {
      const cardId = String(card.id ?? card.cardId ?? "").trim();
      if (!cardId) continue;
      if (seenCardIds.has(cardId)) continue;
      seenCardIds.add(cardId);
      if (MODE !== "apply") { persisted++; continue; }
      // Probe CS image endpoint — mark __hasImage explicitly so search
      // can filter/sort. Rows without images stay (Drew: organize, not
      // strip).
      const hasImg = await probeImageExists(cardId);
      const nowIso = new Date().toISOString();
      const doc = {
        id: `cardsight::${cardId}::${contentHash("cardsight", cardId)}`,
        cardId,
        source: "cardsight",
        contentHash: contentHash("cardsight", cardId),
        title: card.name ?? null,
        // Schema unification: emit BOTH shape variants so downstream
        // callers work whether they read `player`/`playerName` or
        // `number`/`cardNumber` (CF-CATALOG-SCHEMA-UNIFY 2026-08-01).
        player: card.name ?? null,
        playerName: card.name ?? null,
        set: card.setName ?? card.releaseName ?? `${tuple.year} ${tuple.product}`,
        setName: card.setName ?? card.releaseName ?? `${tuple.year} ${tuple.product}`,
        year: card.releaseYear ? Number(card.releaseYear) : tuple.year,
        number: card.number ?? null,
        cardNumber: card.number ?? null,
        variant: null,
        imageUrl: hasImg ? `${PROXY_ORIGIN}/api/compiq/card-image/${cardId}` : null,
        __hasImage: hasImg,
        __imageProbedAt: nowIso,
        sport: tuple.sport,
        observedAt: nowIso,
        __expandedFromCardsight: true,
        __expandedAt: nowIso,
      };
      try { await cc.items.upsert(doc); persisted++; } catch { /* skip */ }
    }
    if (cards.length < take) break;
    skip += take;
    await new Promise(r => setTimeout(r, 200));
  }
  return { persisted, error: false };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[expand-catalog-from-cardsight]  mode=${MODE}  maxMinutes=${MAX_MINUTES}`);

  // Build tuple universe
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
  } catch {}

  const seenCardIds = new Set();
  let totalPersisted = 0, tuplesProcessed = 0;
  for (const tuple of tuples) {
    if (timeExpired()) { console.log(`\n⏰ Time cap reached at tuple ${tuplesProcessed}/${tuples.length}`); break; }
    if (processed.has(tuple.key)) continue;
    const t0 = Date.now();
    const { persisted } = await processTuple(cc, tuple, seenCardIds);
    totalPersisted += persisted;
    tuplesProcessed++;
    processed.add(tuple.key);
    if (tuplesProcessed % 5 === 0) {
      console.log(`  [${tuplesProcessed}] ${tuple.sport}/${tuple.product}/${tuple.year}  persisted=${persisted}  total=${totalPersisted}  elapsed=${Math.round((Date.now() - t0)/1000)}s`);
    }
  }

  if (MODE === "apply") {
    let prevTotal = 0;
    try {
      const { resource } = await cc.item(CHECKPOINT_ID, CHECKPOINT_ID).read().catch(() => ({ resource: null }));
      prevTotal = Number(resource?.totalPersisted) || 0;
    } catch {}
    await cc.items.upsert({
      id: CHECKPOINT_ID,
      cardId: CHECKPOINT_ID,
      processedKeys: [...processed],
      totalPersisted: prevTotal + totalPersisted,
      lastRunAt: new Date().toISOString(),
    });
  }

  const remaining = tuples.length - processed.size;
  console.log(`\n=== Slice done ===`);
  console.log(`  tuples processed this slice: ${tuplesProcessed}`);
  console.log(`  cards persisted this slice:  ${totalPersisted}`);
  console.log(`  remaining tuples:            ${remaining}`);
  if (remaining > 0) console.log(`RELAUNCH_NEEDED=true`);
  else console.log(`RELAUNCH_NEEDED=false — cardsight catalog fully enumerated`);
}

main().catch(e => { console.error(e); process.exit(1); });
