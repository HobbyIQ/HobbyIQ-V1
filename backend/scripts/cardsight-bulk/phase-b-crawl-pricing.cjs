#!/usr/bin/env node
// PHASE B — batch pricing crawler.
//
// Reads cardIds from `card_catalog` (Phase A output), batches them 100 at
// a time into POST /v1/pricing/ (default period=all, listing_type=auction
// for completed sales, limit=100/card), parses raw + graded records, and
// upserts each sale to `sold_comps` with hobbyiqCardId + contentHash dedup.
//
// Identity for each sale is derived from the card_catalog row (the
// authoritative context: year, releaseName, cardNumber, playerName, sport)
// combined with the record's parallel_name/parallel_id. This is more
// reliable than parsing free-form eBay listing titles.
//
// Usage:
//   node phase-b-crawl-pricing.cjs                             # all baseball
//   node phase-b-crawl-pricing.cjs --sport baseball --year 2025
//   node phase-b-crawl-pricing.cjs --limit-cards 5000          # cap
//   node phase-b-crawl-pricing.cjs --period 1y --listing-type both
//   node phase-b-crawl-pricing.cjs --resume                    # skip processed
//   node phase-b-crawl-pricing.cjs --dry-run                   # no writes

const path = require("path");
const crypto = require("crypto");
const {
  csFetch, getContainer, contentHashOf,
  readState, writeState, nowIso, chunk,
} = require("./common.cjs");

const backend = path.resolve(__dirname, "..", "..");
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const SOURCE = "cardsight";
const BATCH_SIZE = 100;   // POST /v1/pricing/ cap

const AUTO_CARD_NUMBER_PREFIX = /^(CPA|BCPA|BCA|RA|USA|TAA|BCRA|BSA|BSHA|CDA|BDPA|BFA|BCPA|CPAP|CRA|AC|A|GA)-/i;
const AUTO_SET_TOKENS = /auto(graph)?s?\b|signature/i;

function inferIsAuto(row) {
  if (row.setName && AUTO_SET_TOKENS.test(row.setName)) return true;
  if (row.number && AUTO_CARD_NUMBER_PREFIX.test(row.number)) return true;
  return false;
}

function printRunForParallelId(row, parallelId) {
  if (!parallelId || !Array.isArray(row.parallels)) return null;
  const p = row.parallels.find((x) => x.id === parallelId);
  return p?.numberedTo ?? null;
}

function parallelNameForId(row, parallelId, fallback) {
  if (!parallelId || !Array.isArray(row.parallels)) return fallback || "Base";
  const p = row.parallels.find((x) => x.id === parallelId);
  return p?.name || fallback || "Base";
}

async function loadTargetCards(sport, year, cap) {
  const container = await getContainer("card_catalog");
  const params = [{ name: "@src", value: SOURCE }, { name: "@sport", value: sport }];
  let where = "c.source = @src AND c.sport = @sport";
  if (year) {
    where += " AND c.year = @y";
    params.push({ name: "@y", value: String(year) });
  }
  const query = `SELECT c.cardId, c.player, c.number, c.year, c.set, c.setName, c.releaseName, c.parallels, c.sport, c.attributes FROM c WHERE ${where}`;
  const rows = [];
  const iterator = container.items.query({ query, parameters: params }, { maxItemCount: 1000 });
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) {
      rows.push(r);
      if (cap && rows.length >= cap) return rows;
    }
  }
  return rows;
}

async function upsertSale(soldCompsContainer, source, catalogRow, saleRecord, gradedContext, dryRun) {
  const price = Number(saleRecord.price);
  const soldAt = saleRecord.date;
  if (!Number.isFinite(price) || price <= 0 || !soldAt) return "skipped";

  const parallelId = saleRecord.parallel_id || null;
  const parallelName = parallelNameForId(catalogRow, parallelId, saleRecord.parallel_name);
  const printRun = printRunForParallelId(catalogRow, parallelId);
  const isAuto = inferIsAuto(catalogRow);
  const setKey = catalogRow.releaseName || catalogRow.setName || catalogRow.set || "";
  const cardYear = Number(catalogRow.year || 0) || null;
  const sport = catalogRow.sport || "baseball";
  const cardNumber = catalogRow.number || "";
  if (!cardYear || !cardNumber) return "skipped";

  let slug;
  try {
    slug = computeHobbyIqCardId({
      sport, year: cardYear, setKey,
      cardNumber, parallel: parallelName, isAuto, printRun,
    });
  } catch { return "skipped"; }

  const url = saleRecord.url || null;
  const title = saleRecord.title || null;
  const contentHash = crypto.createHash("sha256").update(
    `${slug}|${price.toFixed(2)}|${String(soldAt).slice(0, 10)}|${source}|${url || ""}`,
  ).digest("hex").slice(0, 32);

  if (!dryRun) {
    try {
      const { resources: existing } = await soldCompsContainer.items.query({
        query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @hiq AND c.contentHash = @ch",
        parameters: [{ name: "@hiq", value: slug }, { name: "@ch", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) return "deduped";
    } catch { /* fall through and attempt upsert */ }
  }

  const sourceExternalId = url
    ? crypto.createHash("sha256").update("cs:" + url).digest("hex").slice(0, 24)
    : crypto.createHash("sha256").update("cs:" + (title || "") + price + soldAt).digest("hex").slice(0, 24);

  const doc = {
    id: `${source}::${sourceExternalId}`,
    cardId: `hiq:${slug.slice(4)}`,
    hobbyiqCardId: slug,
    contentHash,
    playerName: catalogRow.player || null,
    cardYear,
    setName: setKey,
    cardNumber,
    parallel: parallelName,
    isAuto,
    printRun,
    autoStyle: null,
    gradeCompany: gradedContext?.companyName ?? null,
    gradeValue: gradedContext?.gradeValue ?? null,
    gradeQualifier: null,
    price,
    soldAt: new Date(soldAt).toISOString(),
    source,
    sourceExternalId,
    title,
    url,
    observedAt: nowIso(),
    sport,
    listingType: saleRecord.listing_type ?? null,
    imageUrl: saleRecord.image_url ?? null,
    csCardId: catalogRow.cardId,
    bulkCrawledAt: nowIso(),
  };
  if (dryRun) return "inserted";
  try { await soldCompsContainer.items.upsert(doc); return "inserted"; }
  catch (err) { console.warn(`  upsert fail (${slug}): ${err.message}`); return "skipped"; }
}

async function main() {
  const sport = arg("sport", "baseball");
  const year = arg("year", null);
  const cap = Number(arg("limit-cards", "0")) || 0;
  const period = arg("period", "all");
  const listingType = arg("listing-type", "auction");
  const perCardLimit = Number(arg("per-card-limit", "100"));
  const resume = flag("resume");
  const dryRun = flag("dry-run");

  console.log(`[phase-b-pricing] sport=${sport} year=${year || "all"} cap=${cap || "none"} period=${period} listingType=${listingType} perCardLimit=${perCardLimit} dryRun=${dryRun}`);

  console.log("  loading target cards from card_catalog…");
  const targets = await loadTargetCards(sport, year, cap);
  console.log(`  ${targets.length} target cards`);
  if (targets.length === 0) {
    console.log("  nothing to crawl. run phase-a-crawl-cards.cjs first.");
    return;
  }

  const soldCompsContainer = dryRun ? null : await getContainer("sold_comps");

  const progressFile = `pricing-progress-${sport}${year ? `-${year}` : ""}.json`;
  const progress = resume ? (readState(progressFile) || { doneCardIds: {}, totals: { batches: 0, inserted: 0, deduped: 0, skipped: 0, failed: 0 } }) : { doneCardIds: {}, totals: { batches: 0, inserted: 0, deduped: 0, skipped: 0, failed: 0 } };

  const catalogById = new Map(targets.map((c) => [c.cardId, c]));
  const filtered = targets.filter((c) => !progress.doneCardIds[c.cardId]);
  console.log(`  ${filtered.length} cards to process (${targets.length - filtered.length} already done)`);

  const batches = chunk(filtered.map((c) => c.cardId), BATCH_SIZE);
  console.log(`  ${batches.length} batches of up to ${BATCH_SIZE}`);

  const t0 = Date.now();
  let inserted = progress.totals.inserted, deduped = progress.totals.deduped, skipped = progress.totals.skipped, failed = progress.totals.failed;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const body = { card_ids: batch, period, listing_type: listingType, limit: perCardLimit };
    let resp;
    try {
      resp = await csFetch("/pricing/", { method: "POST", body, timeoutMs: 60_000 });
    } catch (e) {
      console.warn(`  batch ${bi + 1}/${batches.length} error: ${e.message}`);
      failed += batch.length;
      continue;
    }
    const results = Array.isArray(resp?.results) ? resp.results : [];
    for (const result of results) {
      const cardId = result?.card_id;
      const catalogRow = catalogById.get(cardId);
      if (!catalogRow) { skipped++; progress.doneCardIds[cardId] = "no-catalog"; continue; }
      if (!result?.success || !result.data) {
        progress.doneCardIds[cardId] = result?.error?.message || "no-data";
        continue;
      }
      const data = result.data;
      let cardInserted = 0, cardDeduped = 0, cardSkipped = 0;
      for (const rec of (data.raw?.records || [])) {
        const status = await upsertSale(soldCompsContainer, SOURCE, catalogRow, rec, null, dryRun);
        if (status === "inserted") cardInserted++;
        else if (status === "deduped") cardDeduped++;
        else cardSkipped++;
      }
      for (const grp of (data.graded || [])) {
        for (const gg of (grp.grades || [])) {
          const gradedContext = {
            companyName: grp.company_name,
            gradeValue: gg.grade_value,
          };
          for (const rec of (gg.records || [])) {
            const status = await upsertSale(soldCompsContainer, SOURCE, catalogRow, rec, gradedContext, dryRun);
            if (status === "inserted") cardInserted++;
            else if (status === "deduped") cardDeduped++;
            else cardSkipped++;
          }
        }
      }
      inserted += cardInserted;
      deduped += cardDeduped;
      skipped += cardSkipped;
      progress.doneCardIds[cardId] = { inserted: cardInserted, deduped: cardDeduped, skipped: cardSkipped };
    }
    progress.totals = { batches: bi + 1, inserted, deduped, skipped, failed };
    writeState(progressFile, progress);
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = ((bi + 1) * BATCH_SIZE / Math.max(1, (Date.now() - t0) / 1000)).toFixed(0);
    console.log(`  batch ${bi + 1}/${batches.length} — inserted=${inserted} deduped=${deduped} skipped=${skipped} failed=${failed} | ${rate} cards/s | elapsed ${elapsedS}s`);
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[phase-b-pricing] complete: inserted=${inserted} deduped=${deduped} skipped=${skipped} failed=${failed} in ${total}s`);
  console.log(`  progress state: .state/${progressFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
