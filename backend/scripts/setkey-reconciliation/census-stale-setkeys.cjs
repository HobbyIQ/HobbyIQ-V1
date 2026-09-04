#!/usr/bin/env node
// READ-ONLY census for the setKey reconciliation (PR follow-on to #1689).
//
// Produces the raw evidence the reconciliation verdicts are derived from:
//   catalog.json  every (sport, cardYear, setKey, source) cell in card_catalog
//   pool.json     every (sport, cardYear, setName) cell in sold_comps
//
// NO WRITES. NO DISPATCHES. Every query is a SELECT.
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const OUT = process.env.OUT_DIR || path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
const client = new CosmosClient(conn);
const db = client.database("hobbyiq");

async function runAll(container, query, label) {
  const it = db.container(container).items.query(query, { maxItemCount: 1000 });
  const rows = [];
  let pages = 0;
  while (it.hasMoreResults()) {
    const r = await it.fetchNext();
    if (r.resources) rows.push(...r.resources);
    pages++;
    if (pages % 20 === 0) process.stderr.write(`  ${label}: ${rows.length} cells\n`);
  }
  return rows;
}

(async () => {
  console.error("catalog census (card_catalog by sport/year/setKey/source)...");
  const catalog = await runAll("card_catalog",
    "SELECT c.sport, c.cardYear, c.setKey, c.source, COUNT(1) AS n FROM c GROUP BY c.sport, c.cardYear, c.setKey, c.source",
    "catalog");
  fs.writeFileSync(path.join(OUT, "catalog.json"), JSON.stringify(catalog));
  console.error(`  catalog cells: ${catalog.length}`);

  console.error("pool census (sold_comps by sport/year/setName)...");
  const pool = await runAll("sold_comps",
    "SELECT c.sport, c.cardYear, c.setName, COUNT(1) AS n FROM c GROUP BY c.sport, c.cardYear, c.setName",
    "pool");
  fs.writeFileSync(path.join(OUT, "pool.json"), JSON.stringify(pool));
  console.error(`  pool cells: ${pool.length}`);

  console.error("pool setKey census (sold_comps by sport/year/setKey)...");
  const poolKeys = await runAll("sold_comps",
    "SELECT c.sport, c.cardYear, c.setKey, COUNT(1) AS n FROM c GROUP BY c.sport, c.cardYear, c.setKey",
    "poolKeys");
  fs.writeFileSync(path.join(OUT, "pool-setkeys.json"), JSON.stringify(poolKeys));
  console.error(`  pool setKey cells: ${poolKeys.length}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
