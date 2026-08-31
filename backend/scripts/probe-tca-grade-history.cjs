#!/usr/bin/env node
// READ-ONLY. Walks MONTHLY shards of tca-ebay rows to find when (if ever) the
// raw-but-title-graded population exists. Bounded per shard by source+soldAt.
//
// Env: COSMOS_CONNECTION_STRING, START (ISO date), MONTHS (default 8)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { parseGradeLabel } = require(path.join(
  __dirname, "..", "dist/services/portfolioiq/gradeParser.js"));

const SOURCE = process.env.SOURCE || "tca-ebay";
const MONTHS = Math.max(1, Number(process.env.MONTHS || 8));

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[probe-history] source=${SOURCE} months=${MONTHS} (READ-ONLY)`);
  console.log(`month       examined  storedRaw  storedGraded  rawButTitleGraded  rate%`);

  const examples = [];
  let grandExamined = 0, grandAffected = 0;

  const now = new Date();
  for (let m = 0; m < MONTHS; m++) {
    const hi = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m + 1, 1));
    const lo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const loIso = lo.toISOString(), hiIso = hi.toISOString();

    // COUNT first so a huge shard cannot surprise us.
    const { resources: cnt } = await sc.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.source = @src AND c.soldAt >= @lo AND c.soldAt < @hi`,
      parameters: [{ name: "@src", value: SOURCE }, { name: "@lo", value: loIso }, { name: "@hi", value: hiIso }],
    }).fetchAll();
    const total = cnt[0] || 0;
    if (total === 0) { console.log(`${loIso.slice(0,7)}      0`); continue; }

    // Only rows stored RAW — that is the population under test. Narrows the read.
    const iter = sc.items.query({
      query: `SELECT c.id, c.title, c.gradeCompany, c.hobbyiqCardId, c.price, c.soldAt
              FROM c
              WHERE c.source = @src AND c.soldAt >= @lo AND c.soldAt < @hi
                AND (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null OR c.gradeCompany = '')`,
      parameters: [{ name: "@src", value: SOURCE }, { name: "@lo", value: loIso }, { name: "@hi", value: hiIso }],
    }, { maxItemCount: 1000 });

    let storedRaw = 0, affected = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      if (!Array.isArray(resources)) break;
      for (const r of resources) {
        storedRaw++;
        const g = parseGradeLabel(r.title);
        if (!g) continue;
        affected++;
        if (examples.length < 10) examples.push({
          id: r.id, title: r.title, parsed: `${g.gradeCompany} ${g.gradeValue}`,
          slug: r.hobbyiqCardId, price: r.price, soldAt: r.soldAt,
        });
      }
    }
    grandExamined += total; grandAffected += affected;
    const rate = total > 0 ? (affected / total * 100).toFixed(2) : "0.00";
    console.log(`${loIso.slice(0,7)}  ${String(total).padStart(9)}  ${String(storedRaw).padStart(9)}  ${String(total - storedRaw).padStart(12)}  ${String(affected).padStart(17)}  ${rate}`);
  }

  console.log(`\nTOTAL examined=${grandExamined} affected=${grandAffected} rate=${grandExamined ? (grandAffected/grandExamined*100).toFixed(3) : 0}%`);
  console.log(`\n=== EXAMPLES ===`);
  console.log(JSON.stringify(examples, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
