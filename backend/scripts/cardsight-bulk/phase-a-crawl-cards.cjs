#!/usr/bin/env node
// PHASE A2 — enumerate cards for every release in .state/releases-<sport>.json
// via GET /v1/catalog/releases/{id}/cards (paginated) and upsert them to the
// `card_catalog` container so HobbyIQ owns the catalog independent of any
// runtime vendor query.
//
// Persistence shape matches persistVendorCatalog.service.ts so runtime +
// bulk rows are compatible. Bulk rows use id suffix "::bulk" so they
// upsert-idempotently on rerun and never collide with runtime rows.
//
// Usage:
//   node phase-a-crawl-cards.cjs                       # default baseball
//   node phase-a-crawl-cards.cjs --sport baseball --year 2025
//   node phase-a-crawl-cards.cjs --resume              # skip completed releases
//   node phase-a-crawl-cards.cjs --dry-run             # no Cosmos writes
//   node phase-a-crawl-cards.cjs --min-year 2020       # only crawl >= 2020

const {
  csFetch, paginateAll, getContainer, contentHashOf,
  readState, writeState, nowIso,
} = require("./common.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const SOURCE = "cardsight";

function buildCatalogDoc(card, release, sport, segmentId) {
  const cardId = card.id;
  const setName = card.setName || null;
  const releaseName = release.name || card.releaseName || null;
  const player = card.name || null;
  const number = card.number || null;
  const year = card.releaseYear || release.year || null;
  const parallels = Array.isArray(card.parallels)
    ? card.parallels.map((p) => ({
      id: p.id,
      name: p.name,
      numberedTo: p.numberedTo ?? null,
    }))
    : [];
  const contentHash = contentHashOf(
    SOURCE, cardId, player, setName, releaseName, year, number, "bulk",
  );
  return {
    id: `${SOURCE}::${cardId}::bulk`,
    cardId,
    source: SOURCE,
    contentHash,
    title: player,
    player,
    set: setName,
    year,
    number,
    variant: null,
    imageUrl: null,
    releaseId: release.id,
    releaseName,
    setId: card.setId || null,
    setName,
    segmentId,
    sport,
    parallels,
    parallelCount: parallels.length,
    isParallelOnly: !!card.isParallelOnly,
    attributes: Array.isArray(card.attributes) ? card.attributes : [],
    description: card.description || null,
    fields: Array.isArray(card.fields) ? card.fields : [],
    bulkCrawledAt: nowIso(),
    observedAt: nowIso(),
  };
}

async function main() {
  const sport = arg("sport", "baseball");
  const year = arg("year", null);
  const minYear = Number(arg("min-year", "0")) || 0;
  const resume = flag("resume");
  const dryRun = flag("dry-run");

  const stateFile = `releases-${sport}${year ? `-${year}` : ""}.json`;
  const releasesDoc = readState(stateFile);
  if (!releasesDoc) {
    console.error(`no .state/${stateFile}. run phase-a-crawl-releases.cjs first.`);
    process.exit(1);
  }
  console.log(`[phase-a-cards] sport=${sport} releases=${releasesDoc.releases.length} dryRun=${dryRun} resume=${resume}`);

  const progressFile = `cards-progress-${sport}${year ? `-${year}` : ""}.json`;
  const progress = resume ? (readState(progressFile) || { done: {}, totals: { releases: 0, cards: 0 } }) : { done: {}, totals: { releases: 0, cards: 0 } };

  const container = dryRun ? null : await getContainer("card_catalog");

  const filtered = releasesDoc.releases
    .filter((r) => Number(r.year || 0) >= minYear);

  const t0 = Date.now();
  let totalCards = 0;
  let insertedTotal = 0;

  for (let i = 0; i < filtered.length; i++) {
    const release = filtered[i];
    if (progress.done[release.id]) {
      totalCards += progress.done[release.id].count || 0;
      continue;
    }
    const startAt = Date.now();
    try {
      const cards = await paginateAll(`/catalog/releases/${release.id}/cards`, "cards", {}, 100);
      let releaseInserted = 0;
      for (const card of cards) {
        const doc = buildCatalogDoc(card, release, sport, releasesDoc.segmentId);
        if (!dryRun) {
          try { await container.items.upsert(doc); releaseInserted++; }
          catch (e) { console.warn(`  upsert fail ${card.id}: ${e.message}`); }
        } else {
          releaseInserted++;
        }
      }
      totalCards += cards.length;
      insertedTotal += releaseInserted;
      progress.done[release.id] = {
        name: release.name,
        year: release.year,
        count: cards.length,
        inserted: releaseInserted,
        durationMs: Date.now() - startAt,
        completedAt: nowIso(),
      };
      progress.totals.releases = (progress.totals.releases || 0) + 1;
      progress.totals.cards = totalCards;
      writeState(progressFile, progress);
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${filtered.length}] ${release.year} ${release.name} — ${cards.length} cards (${((Date.now() - startAt) / 1000).toFixed(1)}s) | total ${totalCards} in ${elapsedS}s`);
    } catch (e) {
      console.warn(`  release ${release.id} (${release.name}) failed: ${e.message}`);
      progress.done[release.id] = { error: e.message, failedAt: nowIso() };
      writeState(progressFile, progress);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[phase-a-cards] complete: ${totalCards} cards across ${filtered.length} releases in ${elapsed}s`);
  console.log(`  upserted (or would upsert): ${insertedTotal}`);
  console.log(`  progress state: .state/${progressFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
