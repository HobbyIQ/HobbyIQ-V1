// CF-CATALOG-SALES-SYNTH (Drew, 2026-08-03). Builds owned catalog
// entries by aggregating sold_comps by identity tuple. Every unique
// (sport, year, setName, cardNumber, parallel, isAuto, printRun, player)
// combo with >= MIN_SALES observed sales becomes a card_catalog row
// with source='sales-derived'.
//
// Empirical + self-verifying — actual sales prove the card exists,
// so the catalog needs no scraping, no vendor dependency. Covers rare
// parallels TCA/CH catalogs miss because we see the sales anyway.
//
// Runs safely on all sold_comps: walks in batches, aggregates
// in-memory per chunk, flushes to card_catalog. Idempotent —
// deterministic id `sales-derived:{sha256(tuple)[:20]}`.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 write to card_catalog (else dry-run count)
//   MIN_SALES=1                minimum observed sales to qualify (default 1)
//   MAX_MINUTES=45             wall-clock cap
//   BATCH=5000                 rows per Cosmos query page
//   SOURCE_FILTER              optional: only aggregate rows with c.source = X
//   YEAR_FROM / YEAR_TO        optional: constrain to a year range

const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

const APPLY = process.env.APPLY === "true";
const MIN_SALES = Math.max(1, Number(process.env.MIN_SALES || 1));
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 45));
const BATCH = Math.max(500, Number(process.env.BATCH || 5000));
const SOURCE_FILTER = process.env.SOURCE_FILTER || null;
const YEAR_FROM = process.env.YEAR_FROM ? Number(process.env.YEAR_FROM) : null;
const YEAR_TO = process.env.YEAR_TO ? Number(process.env.YEAR_TO) : null;
const WRITE_CONCURRENCY = Math.max(1, Number(process.env.WRITE_CONCURRENCY || 16));

// CF-SET-KEY-CONSOLIDATION (Drew, 2026-08-03). Different vendors label
// the same real set differently:
//   "2020 Bowman Chrome Baseball" (cardsight)
//   "2020 Bowman Chrome" (cardhedge)
//   "bowman-chrome" (canonical)
// All three refer to the same set. Aggregating without normalization
// creates 3× the catalog rows and splits the sale count. Normalize
// to a canonical set-key: strip year prefix, strip sport suffix,
// slugify. Same set → same tuple → one catalog entry.
const SPORT_WORDS_RX = /\s+(baseball|basketball|football|hockey|soccer|golf|racing|tennis|mma|boxing)(\s|$)/gi;
const YEAR_PREFIX_RX = /^(19|20)\d{2}(-\d{2})?\s+/;
function normalizeSetKey(v) {
  let s = String(v ?? "").toLowerCase().trim();
  if (!s) return "";
  s = s.replace(YEAR_PREFIX_RX, "").trim();
  s = s.replace(SPORT_WORDS_RX, " ").trim();
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return s;
}

function tupleKey(r) {
  // Canonicalize each axis so minor variations collapse into one
  // catalog entry. Same rules as slug-side canonicalization.
  const norm = (v) => String(v ?? "").toLowerCase().trim();
  return [
    norm(r.sport),
    r.cardYear ?? "",
    normalizeSetKey(r.setName),
    norm(r.cardNumber),
    norm(r.parallel ?? "base"),
    r.isAuto ? "auto" : "no-auto",
    r.printRun ?? "",
    norm(r.playerName),
  ].join("|");
}

function docFromAgg(key, agg) {
  const [sport, year, setName, cardNumber, parallel, autoFlag, printRun, player] = key.split("|");
  // CF-CATALOG-KEYED-BY-HOBBYIQCARDID (Drew, 2026-08-07). Prefer the
  // canonical hobbyiqCardId slug as the doc id so batch synth converges
  // with real-time writes on ONE doc per physical card. Fall back to the
  // legacy sales-derived:sha256 scheme only when no sample slug is
  // available (thin aggregations from pre-slug-backfill sold_comps rows —
  // ~0.02% of the pool). Also stamp hobbyiqCardId + cardId=slug so the
  // doc joins to sold_comps by field-lookup.
  const canonicalId = agg.sampleSlug && String(agg.sampleSlug).startsWith("hiq:")
    ? agg.sampleSlug
    : "sales-derived:" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 20);
  const hobbyiqCardId = agg.sampleSlug && String(agg.sampleSlug).startsWith("hiq:") ? agg.sampleSlug : null;
  return {
    id: canonicalId,
    cardId: canonicalId, // partition key matches id for slug-keyed docs
    hobbyiqCardId,
    player,
    year: year ? Number(year) : null,
    number: cardNumber,
    setKey: setName,
    setName: setName,
    sport,
    parallels: parallel && parallel !== "base" ? [{ name: parallel }] : [],
    parallel,
    isAuto: autoFlag === "auto",
    printRun: printRun ? Number(printRun) : null,
    source: "sales-derived",
    salesCount: agg.count,
    salesSources: [...agg.sources],
    firstObservedSaleAt: agg.minDate,
    lastObservedSaleAt: agg.maxDate,
    sampleHobbyiqCardId: agg.sampleSlug ?? null,
    sampleCardId: agg.sampleCardId ?? null,
    // Original vendor names for this canonical set-key — helpful for
    // display + debugging which raw labels collapsed into this row.
    rawSetNames: agg.rawSetNames ? [...agg.rawSetNames].slice(0, 8) : [],
    // Confidence bands: 1 sale = 0.4, 5 sales = 0.7, 20+ sales = 0.95
    confidence: Math.min(0.95, 0.35 + Math.log10(Math.max(1, agg.count)) * 0.3),
    synthesizedAt: new Date().toISOString(),
  };
}

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`[synth] apply=${APPLY} minSales=${MIN_SALES} maxMin=${MAX_MINUTES} batch=${BATCH} sourceFilter=${SOURCE_FILTER || "*"} years=${YEAR_FROM || "*"}-${YEAR_TO || "*"}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Build query
  const conds = ["IS_DEFINED(c.playerName)", "IS_DEFINED(c.cardYear)", "IS_DEFINED(c.setName)", "IS_DEFINED(c.cardNumber)"];
  const params = [];
  if (SOURCE_FILTER) { conds.push("c.source = @src"); params.push({ name: "@src", value: SOURCE_FILTER }); }
  if (YEAR_FROM) { conds.push("c.cardYear >= @yf"); params.push({ name: "@yf", value: YEAR_FROM }); }
  if (YEAR_TO) { conds.push("c.cardYear <= @yt"); params.push({ name: "@yt", value: YEAR_TO }); }
  const q = {
    query: `SELECT c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport, c.source, c.soldAt, c.hobbyiqCardId, c.cardId FROM c WHERE ${conds.join(" AND ")}`,
    parameters: params,
  };

  const iter = sold.items.query(q, { maxItemCount: BATCH });
  const agg = new Map();
  let scanned = 0;

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap during scan"); break; }
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      const key = tupleKey(r);
      let a = agg.get(key);
      if (!a) {
        a = { count: 0, sources: new Set(), minDate: null, maxDate: null, sampleSlug: null, sampleCardId: null, rawSetNames: new Set() };
        agg.set(key, a);
      }
      a.count++;
      if (r.source) a.sources.add(r.source);
      if (r.setName) a.rawSetNames.add(String(r.setName));
      if (r.soldAt) {
        if (!a.minDate || r.soldAt < a.minDate) a.minDate = r.soldAt;
        if (!a.maxDate || r.soldAt > a.maxDate) a.maxDate = r.soldAt;
      }
      if (!a.sampleSlug && r.hobbyiqCardId) a.sampleSlug = r.hobbyiqCardId;
      if (!a.sampleCardId && r.cardId) a.sampleCardId = r.cardId;
    }
    if (scanned % 50000 === 0) {
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  scanned=${scanned.toLocaleString()} uniqueTuples=${agg.size.toLocaleString()} elapsed=${el}s`);
    }
  }
  console.log(`\n[synth] scan complete: rows=${scanned.toLocaleString()} uniqueTuples=${agg.size.toLocaleString()}`);

  // Filter by MIN_SALES + write
  let qualified = 0, written = 0, errors = 0;
  const inflight = new Set();
  for (const [key, a] of agg.entries()) {
    if (a.count < MIN_SALES) continue;
    qualified++;
    if (!APPLY) continue;
    const doc = docFromAgg(key, a);
    while (inflight.size >= WRITE_CONCURRENCY) await Promise.race([...inflight]);
    const p = cat.items.upsert(doc)
      .then(() => { written++; })
      .catch((err) => {
        errors++;
        if (errors < 10) console.warn("  upsert err:", err?.code ?? err?.message);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    if (qualified % 5000 === 0) {
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  qualified=${qualified.toLocaleString()} written=${written.toLocaleString()} errors=${errors} el=${el}s`);
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[synth] DONE — scanned=${scanned.toLocaleString()} uniqueTuples=${agg.size.toLocaleString()} qualified(>=${MIN_SALES})=${qualified.toLocaleString()} written=${written.toLocaleString()} errors=${errors} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log("(dry-run — no writes)");
}

main().catch((err) => { console.error(err); process.exit(1); });
