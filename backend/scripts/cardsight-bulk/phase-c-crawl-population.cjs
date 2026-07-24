#!/usr/bin/env node
// PHASE C — grader population reports.
//
// Two modes:
//   --level release (default) — per release, one doc per (release,company)
//     Fast: ~1,992 requests for full baseball.
//   --level card — per catalog card, one doc per (card,company)
//     Deep. Slow: 100k+ requests. Recommend --year + --limit-cards.
//
// Container: `card_population` (partition varies: /releaseId or /cardId).

const {
  csFetch, getContainer, contentHashOf,
  readState, writeState, nowIso,
} = require("./common.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

async function loadCatalogCardIds(sport, year, cap) {
  const container = await getContainer("card_catalog");
  const params = [{ name: "@src", value: "cardsight" }, { name: "@sport", value: sport }];
  let where = "c.source = @src AND c.sport = @sport";
  if (year) { where += " AND c.year = @y"; params.push({ name: "@y", value: String(year) }); }
  const query = `SELECT c.cardId, c.player, c.number, c.year, c.releaseId FROM c WHERE ${where}`;
  const rows = [];
  const it = container.items.query({ query, parameters: params }, { maxItemCount: 1000 });
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    rows.push(...resources);
    if (cap && rows.length >= cap) return rows.slice(0, cap);
  }
  return rows;
}

async function runReleaseLevel(sport, year, minYear, dryRun) {
  const stateFile = `releases-${sport}${year ? `-${year}` : ""}.json`;
  const releasesDoc = readState(stateFile);
  if (!releasesDoc) {
    console.error(`no .state/${stateFile}. run phase-a-crawl-releases.cjs first.`);
    process.exit(1);
  }
  const container = dryRun ? null : await getContainer("card_population", "/releaseId");
  const filtered = releasesDoc.releases.filter((r) => Number(r.year || 0) >= minYear);
  console.log(`[phase-c-population --level release] ${filtered.length} releases`);

  const progressFile = `population-progress-release-${sport}${year ? `-${year}` : ""}.json`;
  const progress = readState(progressFile) || { done: {}, totals: { releases: 0, docs: 0 } };
  const t0 = Date.now();
  let docCount = progress.totals.docs || 0;

  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    if (progress.done[r.id]) continue;
    try {
      const resp = await csFetch(`/population/release/${r.id}`, { timeoutMs: 30_000 });
      const companies = resp?.grading_companies || [];
      for (const co of companies) {
        const doc = {
          id: `release::${r.id}::${co.id}`,
          releaseId: r.id,
          releaseName: r.name,
          releaseYear: r.year,
          sport,
          level: "release",
          gradingCompanyId: co.id,
          gradingCompanyName: co.name,
          lastSyncedAt: co.last_synced_at || null,
          totalPopulation: co.total_population || 0,
          gradingTypes: co.grading_types || [],
          sets: co.sets || [],
          contentHash: contentHashOf(r.id, co.id, co.total_population, co.last_synced_at),
          bulkCrawledAt: nowIso(),
        };
        if (!dryRun) { try { await container.items.upsert(doc); } catch (e) { console.warn(`  upsert fail: ${e.message}`); } }
        docCount++;
      }
      progress.done[r.id] = { name: r.name, companies: companies.length, at: nowIso() };
    } catch (e) {
      console.warn(`  release ${r.id} (${r.name}) failed: ${e.message}`);
      progress.done[r.id] = { error: e.message, at: nowIso() };
    }
    progress.totals = { releases: i + 1, docs: docCount };
    writeState(progressFile, progress);
    if ((i + 1) % 25 === 0) {
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${filtered.length}] docs=${docCount} in ${elapsedS}s`);
    }
  }

  console.log(`\n[phase-c-population release] complete: ${docCount} docs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function runCardLevel(sport, year, cap, dryRun) {
  const cards = await loadCatalogCardIds(sport, year, cap);
  console.log(`[phase-c-population --level card] ${cards.length} cards`);
  const container = dryRun ? null : await getContainer("card_population");
  const progressFile = `population-progress-card-${sport}${year ? `-${year}` : ""}.json`;
  const progress = readState(progressFile) || { done: {}, totals: { cards: 0, docs: 0 } };
  const t0 = Date.now();
  let docCount = progress.totals.docs || 0;

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (progress.done[c.cardId]) continue;
    try {
      const resp = await csFetch(`/population/card/${c.cardId}`, { timeoutMs: 20_000 });
      // Per OpenAPI CardPopulationResponse: top-level fields are
      // { card_id, card_name, total_population, base, parallels[] }.
      // Grading company breakdowns live under resp.base.grading_companies
      // (base variant) and under each parallel's grading_companies.
      const baseCompanies = resp?.base?.grading_companies || [];
      for (const co of baseCompanies) {
        const doc = {
          id: `card::${c.cardId}::${co.id}`,
          cardId: c.cardId,
          csCardId: c.cardId,
          sport,
          year: c.year,
          number: c.number,
          player: c.player,
          releaseId: c.releaseId,
          level: "card",
          variantLevel: "base",
          gradingCompanyId: co.id,
          gradingCompanyName: co.name,
          lastSyncedAt: co.last_synced_at || null,
          totalPopulation: co.total_population || 0,
          basePopulation: resp?.base?.total_population ?? null,
          totalPopulationAllCompanies: resp?.total_population ?? null,
          parallelPopulations: (resp?.parallels || []).map((p) => ({
            id: p.id,
            name: p.name,
            totalPopulation: p.total_population,
          })),
          gradingTypes: co.grading_types || [],
          contentHash: contentHashOf(c.cardId, co.id, co.total_population, co.last_synced_at),
          bulkCrawledAt: nowIso(),
        };
        if (!dryRun) { try { await container.items.upsert(doc); } catch (e) { console.warn(`  upsert fail: ${e.message}`); } }
        docCount++;
      }
      progress.done[c.cardId] = { companies: baseCompanies.length, at: nowIso() };
    } catch (e) {
      progress.done[c.cardId] = { error: e.message, at: nowIso() };
    }
    progress.totals = { cards: i + 1, docs: docCount };
    if ((i + 1) % 500 === 0) {
      writeState(progressFile, progress);
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = ((i + 1) / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1);
      console.log(`  [${i + 1}/${cards.length}] docs=${docCount} @${rate}/s in ${elapsedS}s`);
    }
  }
  writeState(progressFile, progress);
  console.log(`\n[phase-c-population card] complete: ${docCount} docs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function main() {
  const sport = arg("sport", "baseball");
  const year = arg("year", null);
  const level = arg("level", "release");
  const minYear = Number(arg("min-year", "0")) || 0;
  const cap = Number(arg("limit-cards", "0")) || 0;
  const dryRun = flag("dry-run");

  if (level === "release") await runReleaseLevel(sport, year, minYear, dryRun);
  else if (level === "card") await runCardLevel(sport, year, cap, dryRun);
  else { console.error("unknown --level (want 'release' or 'card')"); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
