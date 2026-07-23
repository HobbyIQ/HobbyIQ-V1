#!/usr/bin/env node
// PHASE E — active marketplace listings (asks).
//
// GET /v1/marketplace/{card_id} per catalog card. No batch endpoint
// documented, so single-card. Slower than Phase B; recommend --year
// and --limit-cards to scope.
//
// Container: `active_listings` (partition /cardId). Each active listing
// is a doc; on rerun the whole card's rows get replaced by delete+insert
// scoped by csCardId (asks churn constantly — freshness > dedup).
//
// Usage:
//   node phase-e-crawl-marketplace.cjs --year 2025 --limit-cards 5000
//   node phase-e-crawl-marketplace.cjs --sport baseball --resume
//   node phase-e-crawl-marketplace.cjs --dry-run

const {
  csFetch, getContainer, contentHashOf,
  readState, writeState, nowIso,
} = require("./common.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

async function loadTargets(sport, year, cap) {
  const container = await getContainer("card_catalog");
  const params = [{ name: "@src", value: "cardsight" }, { name: "@sport", value: sport }];
  let where = "c.source = @src AND c.sport = @sport";
  if (year) { where += " AND c.year = @y"; params.push({ name: "@y", value: String(year) }); }
  const q = `SELECT c.cardId, c.player, c.number, c.year, c.releaseName, c.setName, c.parallels FROM c WHERE ${where}`;
  const rows = [];
  const it = container.items.query({ query: q, parameters: params }, { maxItemCount: 1000 });
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    rows.push(...resources);
    if (cap && rows.length >= cap) return rows.slice(0, cap);
  }
  return rows;
}

function buildListingDoc(catalogRow, record, gradedContext, sport) {
  const price = Number(record.price);
  const contentHash = contentHashOf(
    catalogRow.cardId, record.url || record.title, price, record.listing_type,
  );
  return {
    id: `active::${catalogRow.cardId}::${contentHash}`,
    cardId: catalogRow.cardId,
    csCardId: catalogRow.cardId,
    sport,
    year: catalogRow.year,
    player: catalogRow.player,
    number: catalogRow.number,
    releaseName: catalogRow.releaseName,
    setName: catalogRow.setName,
    title: record.title || null,
    price: Number.isFinite(price) ? price : null,
    source: record.source || null,
    listingType: record.listing_type || null,
    url: record.url || null,
    imageUrl: record.image_url || null,
    condition: record.condition || null,
    endDate: record.end_date || null,
    bidCount: record.bid_count ?? null,
    parallelId: record.parallel_id || null,
    parallelName: record.parallel_name || null,
    gradingCompanyName: gradedContext?.companyName || null,
    gradeValue: gradedContext?.gradeValue || null,
    contentHash,
    observedAt: nowIso(),
    bulkCrawledAt: nowIso(),
  };
}

async function main() {
  const sport = arg("sport", "baseball");
  const year = arg("year", null);
  const cap = Number(arg("limit-cards", "0")) || 0;
  const resume = flag("resume");
  const dryRun = flag("dry-run");

  console.log(`[phase-e-marketplace] sport=${sport} year=${year || "all"} cap=${cap || "none"} dryRun=${dryRun}`);

  const targets = await loadTargets(sport, year, cap);
  console.log(`  ${targets.length} target cards`);
  if (targets.length === 0) return;

  const container = dryRun ? null : await getContainer("active_listings");
  const progressFile = `marketplace-progress-${sport}${year ? `-${year}` : ""}.json`;
  const progress = resume ? (readState(progressFile) || { done: {}, totals: { cards: 0, listings: 0 } }) : { done: {}, totals: { cards: 0, listings: 0 } };

  const t0 = Date.now();
  let listings = progress.totals.listings || 0;

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    if (progress.done[c.cardId]) continue;
    try {
      const resp = await csFetch(`/marketplace/${c.cardId}`, { timeoutMs: 20_000 });
      let cardListings = 0;
      for (const rec of (resp?.raw?.records || [])) {
        const doc = buildListingDoc(c, rec, null, sport);
        if (!dryRun) { try { await container.items.upsert(doc); cardListings++; } catch (e) { console.warn(`  upsert fail: ${e.message}`); } }
        else cardListings++;
      }
      for (const grp of (resp?.graded || [])) {
        for (const gg of (grp.grades || [])) {
          const ctx = { companyName: grp.company_name, gradeValue: gg.grade_value };
          for (const rec of (gg.records || [])) {
            const doc = buildListingDoc(c, rec, ctx, sport);
            if (!dryRun) { try { await container.items.upsert(doc); cardListings++; } catch (e) { console.warn(`  upsert fail: ${e.message}`); } }
            else cardListings++;
          }
        }
      }
      listings += cardListings;
      progress.done[c.cardId] = { listings: cardListings, at: nowIso() };
    } catch (e) {
      progress.done[c.cardId] = { error: e.message, at: nowIso() };
    }
    progress.totals = { cards: i + 1, listings };
    if ((i + 1) % 100 === 0) {
      writeState(progressFile, progress);
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = ((i + 1) / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1);
      console.log(`  [${i + 1}/${targets.length}] listings=${listings} @${rate}/s in ${elapsedS}s`);
    }
  }
  writeState(progressFile, progress);
  console.log(`\n[phase-e-marketplace] complete: ${listings} listings in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
