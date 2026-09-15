#!/usr/bin/env node
/**
 * REPORT-ONLY. Counts card_catalog rows per (sport, year, setKey) split by
 * source class, for an explicit list of cells. No write path exists in this
 * file — it opens a read-only container handle and only ever issues SELECT.
 *
 * Every query is partition-scoped or narrowly predicated; there is NO
 * cross-partition COUNT over sold_comps here (that wedges — see memory
 * "Retire lane wedge = the verify COUNT"). This reads card_catalog only.
 *
 * Usage:
 *   CELLS='pokemon:2024:sv4a,pokemon:2024:sv8a' \
 *   COSMOS_CONNECTION_STRING="$(az ...)" node report-checklist-coverage-by-setkey.cjs
 */
const { CosmosClient } = require("@azure/cosmos");

const CHECKLIST = /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor|tcdb|tcgdex|pokemon-tcg-data|official-pdf/;

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const cells = String(process.env.CELLS || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [sport, year, setKey] = s.split(":"); return { sport, year: Number(year), setKey }; });
  if (!cells.length) { console.error("FATAL: CELLS empty"); process.exit(1); }

  const c = new CosmosClient({ connectionString: process.env.COSMOS_CONNECTION_STRING })
    .database("hobbyiq").container("card_catalog");

  console.log(`REPORT ONLY — nothing written. ${cells.length} cells\n`);
  console.log("sport      year  setKey            total  checklist  self/other  sources");
  for (const cell of cells) {
    const q = {
      query:
        "SELECT c.source, COUNT(1) AS n FROM c WHERE c.sport=@sp AND c.year=@yr AND c.setKey=@sk GROUP BY c.source",
      parameters: [
        { name: "@sp", value: cell.sport },
        { name: "@yr", value: cell.year },
        { name: "@sk", value: cell.setKey },
      ],
    };
    let rows = [];
    try {
      rows = (await c.items.query(q, { maxItemCount: 200 }).fetchAll()).resources;
    } catch (e) {
      console.log(`${cell.sport.padEnd(10)} ${String(cell.year).padEnd(5)} ${cell.setKey.padEnd(17)} QUERY FAILED: ${e.message.slice(0, 80)}`);
      continue;
    }
    let total = 0, chk = 0;
    const srcs = [];
    for (const r of rows) {
      const n = r.n || 0; total += n;
      const s = String(r.source || "");
      if (CHECKLIST.test(s)) chk += n;
      srcs.push(`${s || "(none)"}=${n}`);
    }
    console.log(
      `${cell.sport.padEnd(10)} ${String(cell.year).padEnd(5)} ${cell.setKey.padEnd(17)} ${String(total).padStart(5)} ${String(chk).padStart(10)} ${String(total - chk).padStart(11)}  ${srcs.slice(0, 6).join(" ")}`
    );
  }
  console.log("\nREPORT ONLY — nothing written.");
}
main().catch((e) => { console.error(e); process.exit(1); });
