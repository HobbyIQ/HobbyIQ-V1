#!/usr/bin/env node
// CF-CS-BULK-REBUILD-STATE (Drew, 2026-07-24). Reconstructs
// .state/cards-progress-<sport>.json from card_catalog so --resume
// works after a Cloud Shell home-mount wipe.
//
// Reads distinct (releaseId, releaseName, year, cardCount) from
// card_catalog where source='cardsight' and sport=<sport>, marks each
// as done, and writes the same shape the crawler emits so --resume can
// skip them.
//
// Usage:
//   node scripts/cardsight-bulk/rebuild-state-from-cosmos.cjs --sport baseball

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function requireEnv(n) {
  const v = process.env[n];
  if (!v || !String(v).trim()) { console.error(`missing env: ${n}`); process.exit(1); }
  return String(v).trim();
}

async function main() {
  const sport = arg("sport", "baseball");
  const client = new CosmosClient(requireEnv("COSMOS_CONNECTION_STRING"));
  const container = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[rebuild-state] querying card_catalog for cardsight ${sport}...`);
  // Grouping in JS instead of SQL GROUP BY — the Cosmos SDK's cross-
  // partition GROUP BY can return undefined `resources` mid-iteration.
  const query = `SELECT c.releaseId, c.releaseName, c.year FROM c WHERE c.source = 'cardsight' AND c.sport = @sp`;
  const it = container.items.query({ query, parameters: [{ name: "@sp", value: sport }] }, { maxItemCount: 5000 });
  const byRelease = new Map();
  let total = 0;
  while (it.hasMoreResults()) {
    const page = await it.fetchNext();
    const resources = Array.isArray(page?.resources) ? page.resources : [];
    for (const r of resources) {
      if (!r.releaseId) continue;
      const meta = byRelease.get(r.releaseId) || { name: r.releaseName || null, year: r.year || null, count: 0 };
      meta.count++;
      byRelease.set(r.releaseId, meta);
    }
    total += resources.length;
    process.stdout.write(`\r  scanned ${total} rows, ${byRelease.size} releases`);
  }
  console.log(`\n  ${byRelease.size} distinct releases across ${total} rows`);
  const rows = [...byRelease.entries()].map(([releaseId, meta]) => ({
    releaseId, releaseName: meta.name, year: meta.year, cardCount: meta.count,
  }));

  const stateDir = path.join(__dirname, ".state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const progressFile = path.join(stateDir, `cards-progress-${sport}.json`);

  const progress = { done: {}, totals: { releases: 0, cards: 0 } };
  let totalCards = 0;
  for (const r of rows) {
    if (!r.releaseId) continue;
    progress.done[r.releaseId] = {
      name: r.releaseName || null,
      year: r.year || null,
      count: Number(r.cardCount || 0),
      inserted: Number(r.cardCount || 0),
      durationMs: 0,
      completedAt: new Date().toISOString(),
      rebuiltFromCosmos: true,
    };
    totalCards += Number(r.cardCount || 0);
  }
  progress.totals.releases = Object.keys(progress.done).length;
  progress.totals.cards = totalCards;
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
  console.log(`  wrote ${progressFile}`);
  console.log(`  ${progress.totals.releases} releases marked done, ${totalCards} cards accounted for`);
  console.log(`\nNext: node scripts/cardsight-bulk/run-all-sports.cjs --sports ${sport} --skip-marketplace --resume`);
}

main().catch(e => { console.error(e); process.exit(1); });
