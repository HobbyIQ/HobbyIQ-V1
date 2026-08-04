// CF-PORTFOLIO-PRIORITY-PULL (Drew, 2026-08-04). Proof-of-concept
// pricing pipeline: prioritize TCA /sales quota on cards users
// ACTUALLY OWN. Walks every portfolio, extracts unique (player, year)
// tuples that back a holding, and queries TCA for each — grabbing
// ALL grades, raw, and parallels. Feeds the results through the
// same clean pipeline as the broad firehose pull.
//
// Rationale: prove the pricing works cleanly on Drew's actual
// portfolio before committing to the 3-year full-historical Order
// Form. Every comp for a card he owns is more valuable than a
// random Bowman Chrome 2019 base sale from someone else's card.
//
// Env:
//   TCA_API_KEY                required
//   COSMOS_CONNECTION_STRING   required
//   MAX_MINUTES                default 15 (wall-clock cap)
//   MAX_TUPLES                 default 200 (safety valve)
//   MAX_PAGES_PER_TUPLE        default 3 (~3000 comps per tuple max)
//   APPLY=true                 write via persistVendorSalesToPool
//   PLATFORMS                  comma-separated (default eBay,TCGplayer)

const { CosmosClient } = require("@azure/cosmos");
const https = require("https");
const path = require("path");
const fs = require("fs");

function loadPersistHelper() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const helperPath = path.join(distRoot, "services", "portfolioiq", "persistVendorSalesToPool.service.js");
  if (!fs.existsSync(helperPath)) throw new Error("run `npm run build` first");
  return require(helperPath).persistVendorSalesToPool;
}

const APPLY = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 15));
const MAX_TUPLES = Math.max(1, Number(process.env.MAX_TUPLES || 200));
const MAX_PAGES_PER_TUPLE = Math.max(1, Number(process.env.MAX_PAGES_PER_TUPLE || 3));
const PAGE_LIMIT = 1000;
const PLATFORMS = (process.env.PLATFORMS || "eBay,TCGplayer").split(",").map(s => s.trim()).filter(Boolean);

function tcaFetch(qs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.thecardapi.com",
      port: 443,
      path: `/api/v1/market/sales?${qs}`,
      method: "GET",
      headers: { "x-market-api-key": process.env.TCA_API_KEY, Accept: "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 429) return reject({ code: 429, body: body.slice(0, 200) });
        if (res.statusCode < 200 || res.statusCode >= 300) return reject({ code: res.statusCode, body: body.slice(0, 200) });
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function tcaRowToVsRow(r) {
  return {
    externalId: r.id ?? null,
    title: r.title ?? null,
    price: typeof r.price === "number" ? r.price : Number(r.price ?? 0),
    soldAt: r.sold_at ?? (r.sale_date ? new Date(r.sale_date + "T12:00:00Z").toISOString() : null),
    url: r.listing_url ?? null,
    imageUrl: r.image_url ?? null,
  };
}
function hintFromRow(r) {
  const h = {};
  if (r.player) h.playerName = String(r.player);
  if (typeof r.year === "number") h.cardYear = r.year;
  if (r.sport) h.sport = String(r.sport).toLowerCase();
  if (r.card_number) h.cardNumber = String(r.card_number);
  if (r.card_set) h.setName = String(r.card_set);
  return h;
}

async function collectPortfolioTuples(portfolioContainer) {
  const q = { query: "SELECT c.holdings FROM c WHERE IS_DEFINED(c.holdings)" };
  const { resources } = await portfolioContainer.items.query(q).fetchAll();
  const tuples = new Map(); // key = "player|year" -> {player, year, count}
  for (const doc of resources) {
    const holdings = Array.isArray(doc.holdings) ? doc.holdings : Object.values(doc.holdings || {});
    for (const h of holdings) {
      if (!h?.playerName || !h?.cardYear) continue;
      const key = `${String(h.playerName).toLowerCase().trim()}|${h.cardYear}`;
      let t = tuples.get(key);
      if (!t) { t = { player: h.playerName, year: h.cardYear, count: 0 }; tuples.set(key, t); }
      t.count++;
    }
  }
  // Sort by count desc so we hit the most-owned tuples first if we run
  // out of quota / wall-clock.
  return [...tuples.values()].sort((a, b) => b.count - a.count);
}

async function pullForTuple(tuple, persist, platform) {
  let inserted = 0, deduped = 0, skipped = 0, errors = 0, fetched = 0;
  let cursor = null;
  for (let page = 0; page < MAX_PAGES_PER_TUPLE; page++) {
    const qs = new URLSearchParams({
      subject: tuple.player,
      year: String(tuple.year),
      platform,
      sort: "date_desc",
      limit: String(PAGE_LIMIT),
    });
    if (cursor) qs.set("cursor", cursor);
    let resp;
    try { resp = await tcaFetch(qs.toString()); }
    catch (err) {
      if (err?.code === 429) { console.warn(`  429 on ${tuple.player}/${tuple.year} — quota exhausted`); return { inserted, deduped, skipped, errors, fetched, halted: true }; }
      console.warn(`  fetch err ${tuple.player}/${tuple.year}: ${err?.code ?? err?.message}`);
      return { inserted, deduped, skipped, errors, fetched, halted: false };
    }
    const rows = resp?.data ?? [];
    fetched += rows.length;
    if (rows.length === 0) break;
    if (APPLY) {
      const CONCURRENCY = 24;
      const inflight = new Set();
      for (const r of rows) {
        const vsRow = tcaRowToVsRow(r);
        if (!vsRow.soldAt || !(vsRow.price > 0)) { skipped++; continue; }
        const hint = hintFromRow(r);
        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        const p = persist("tca-ebay", [vsRow], hint)
          .then((res) => { inserted += res.inserted; deduped += res.deduped; skipped += res.skipped; })
          .catch(() => { errors++; })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all([...inflight]);
    }
    cursor = resp?.pagination?.next_cursor;
    if (!cursor) break;
  }
  return { inserted, deduped, skipped, errors, fetched, halted: false };
}

async function main() {
  if (!process.env.TCA_API_KEY) { console.error("TCA_API_KEY required"); process.exit(1); }
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const cosmos = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = cosmos.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const portfolio = db.container("portfolio");
  const persist = loadPersistHelper();

  console.log(`[portfolio-priority] apply=${APPLY} maxMin=${MAX_MINUTES} maxTuples=${MAX_TUPLES} maxPagesPerTuple=${MAX_PAGES_PER_TUPLE} platforms=${PLATFORMS.join(",")}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  const tuples = await collectPortfolioTuples(portfolio);
  console.log(`  ${tuples.length} unique (player, year) tuples across all portfolios`);
  const limited = tuples.slice(0, MAX_TUPLES);
  console.log(`  processing top ${limited.length} by holding count`);

  let totalFetched = 0, totalInserted = 0, totalDeduped = 0, totalSkipped = 0, totalErrors = 0;
  outer:
  for (const t of limited) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap"); break; }
    for (const platform of PLATFORMS) {
      const r = await pullForTuple(t, persist, platform);
      totalFetched += r.fetched;
      totalInserted += r.inserted;
      totalDeduped += r.deduped;
      totalSkipped += r.skipped;
      totalErrors += r.errors;
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  ${t.player}/${t.year} @ ${platform}: fetched=${r.fetched} inserted=${r.inserted} deduped=${r.deduped} skipped=${r.skipped} (holdings=${t.count}, elapsed=${el}s)`);
      if (r.halted) break outer;
    }
  }

  console.log(`\n[portfolio-priority] DONE — tuples=${limited.length} fetched=${totalFetched} inserted=${totalInserted} deduped=${totalDeduped} skipped=${totalSkipped} errors=${totalErrors} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log("(dry-run — no writes)");
}

main().catch((err) => { console.error(err); process.exit(1); });
