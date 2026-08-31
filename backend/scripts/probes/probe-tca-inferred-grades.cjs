#!/usr/bin/env node
// READ-ONLY. Measures the population written by resolveGradeTierByPrice:
// rows stored WITH a grade whose TITLE states none. These are price-inferred
// grades — the expensive direction (a raw sale up-graded into a graded pool).
//
// Env: COSMOS_CONNECTION_STRING, LO, HI, SOURCE

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { parseGradeLabel } = require(path.join(
  __dirname, "..", "..", "dist/services/portfolioiq/gradeParser.js"));

const SOURCE = process.env.SOURCE || "tca-ebay";
const LO = process.env.LO || "2026-08-01T00:00:00Z";
const HI = process.env.HI || "2026-08-31T00:00:00Z";

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[inferred-grades] source=${SOURCE} ${LO}..${HI} (READ-ONLY)`);

  const iter = sc.items.query({
    query: `SELECT c.id, c.title, c.gradeCompany, c.gradeValue, c.isAuthentic,
                   c.hobbyiqCardId, c.price, c.soldAt
            FROM c WHERE c.source = @src AND c.soldAt >= @lo AND c.soldAt < @hi
              AND IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null AND c.gradeCompany != ''`,
    parameters: [{ name: "@src", value: SOURCE }, { name: "@lo", value: LO }, { name: "@hi", value: HI }],
  }, { maxItemCount: 1000 });

  let graded = 0, titleAgrees = 0, titleSilent = 0, titleDisagrees = 0;
  const silentSamples = [], disagreeSamples = [];
  const byTier = {};

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      graded++;
      const g = parseGradeLabel(r.title);
      if (!g) {
        titleSilent++;
        const tier = `${r.gradeCompany} ${r.gradeValue}`;
        byTier[tier] = (byTier[tier] || 0) + 1;
        if (silentSamples.length < 10) silentSamples.push({
          id: r.id, title: r.title, storedGrade: tier,
          slug: r.hobbyiqCardId, price: r.price, soldAt: r.soldAt,
        });
      } else if (String(g.gradeCompany) === String(r.gradeCompany) && Number(g.gradeValue) === Number(r.gradeValue)) {
        titleAgrees++;
      } else {
        titleDisagrees++;
        if (disagreeSamples.length < 10) disagreeSamples.push({
          id: r.id, title: r.title,
          stored: `${r.gradeCompany} ${r.gradeValue}`,
          titleSays: `${g.gradeCompany} ${g.gradeValue}`,
          price: r.price,
        });
      }
    }
  }

  const pct = (n) => graded ? (n / graded * 100).toFixed(2) : "0.00";
  console.log(`\n=== INFERRED-GRADE POPULATION ===`);
  console.log(`stored graded rows = ${graded}`);
  console.log(`title AGREES       = ${titleAgrees}  (${pct(titleAgrees)}%)`);
  console.log(`title SILENT       = ${titleSilent}  (${pct(titleSilent)}%)  <- price-inferred, no title evidence`);
  console.log(`title DISAGREES    = ${titleDisagrees}  (${pct(titleDisagrees)}%)`);
  console.log(`\nInferred by tier (top 15):`);
  Object.entries(byTier).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
  console.log(`\n=== TITLE-SILENT SAMPLES (the expensive direction) ===`);
  console.log(JSON.stringify(silentSamples, null, 2));
  console.log(`\n=== TITLE-DISAGREES SAMPLES ===`);
  console.log(JSON.stringify(disagreeSamples, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
