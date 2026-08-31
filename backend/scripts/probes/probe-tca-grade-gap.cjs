#!/usr/bin/env node
// READ-ONLY probe. Measures TCA-sourced sold_comps rows whose TITLE states a
// grade but whose stored grade FIELDS say raw/ungraded.
//
// Bounded by design: every query is source-narrowed (c.source = 'tca-ebay')
// and date-sharded. No unbounded CONTAINS scan over the 16M-row container.
//
// Env: COSMOS_CONNECTION_STRING (required), DAYS (default 14), SAMPLE (default 5)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

// THE SAME parser the healthy paths use — not a reimplementation.
const { parseGradeLabel } = require(path.join(
  __dirname, "..", "..", "dist/services/portfolioiq/gradeParser.js"));

const DAYS = Math.max(1, Number(process.env.DAYS || 14));
const SAMPLE = Math.max(1, Number(process.env.SAMPLE || 5));
const SOURCE = process.env.SOURCE || "tca-ebay";

function dayIso(offsetDays) {
  return new Date(Date.now() - offsetDays * 86400_000).toISOString();
}

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[probe-tca-grade-gap] source=${SOURCE} days=${DAYS} (READ-ONLY)`);

  let examined = 0;
  let rawStored = 0;         // gradeCompany null/empty in the stored row
  let titleSaysGraded = 0;   // parseGradeLabel(title) returns a grade
  let affected = 0;          // stored raw AND title states a grade
  let alreadyGraded = 0;
  const byGrade = {};
  const examples = [];

  // Shard one day at a time so each query stays bounded.
  for (let d = 1; d <= DAYS; d++) {
    const hi = dayIso(d - 1);
    const lo = dayIso(d);
    const iter = sc.items.query({
      query: `SELECT c.id, c.title, c.gradeCompany, c.gradeValue, c.hobbyiqCardId,
                     c.price, c.soldAt, c.parallel, c.cardNumber
              FROM c
              WHERE c.source = @src AND c.soldAt >= @lo AND c.soldAt < @hi`,
      parameters: [
        { name: "@src", value: SOURCE },
        { name: "@lo", value: lo },
        { name: "@hi", value: hi },
      ],
    }, { maxItemCount: 1000 });

    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      if (!Array.isArray(resources)) break;
      for (const r of resources) {
        examined++;
        const storedRaw = !r.gradeCompany || String(r.gradeCompany).trim() === "";
        if (!storedRaw) { alreadyGraded++; continue; }
        rawStored++;
        const g = parseGradeLabel(r.title);
        if (!g) continue;
        titleSaysGraded++;
        affected++;
        const key = g.isAuthentic
          ? `${g.gradeCompany} AUTH`
          : `${g.gradeCompany} ${g.gradeValue}${g.isBlackLabel ? " BLACK" : ""}`;
        byGrade[key] = (byGrade[key] || 0) + 1;
        if (examples.length < SAMPLE) {
          examples.push({
            id: r.id,
            title: r.title,
            storedGrade: `${r.gradeCompany ?? "null"}/${r.gradeValue ?? "null"}`,
            parsedGrade: key,
            slug: r.hobbyiqCardId,
            price: r.price,
            soldAt: r.soldAt,
          });
        }
      }
    }
    console.log(`  day -${d}: cumulative examined=${examined} affected=${affected}`);
  }

  const rate = examined > 0 ? (affected / examined * 100) : 0;
  const rateOfRaw = rawStored > 0 ? (affected / rawStored * 100) : 0;

  console.log(`\n=== MEASURED (${DAYS}d window, source=${SOURCE}) ===`);
  console.log(`examined            = ${examined}`);
  console.log(`storedGraded        = ${alreadyGraded}`);
  console.log(`storedRaw           = ${rawStored}`);
  console.log(`affected            = ${affected}   (stored raw, title states a grade)`);
  console.log(`rate of all TCA     = ${rate.toFixed(2)}%`);
  console.log(`rate of stored-raw  = ${rateOfRaw.toFixed(2)}%`);
  console.log(`\nBy parsed grade (top 15):`);
  Object.entries(byGrade).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
  console.log(`\n=== EXAMPLES ===`);
  console.log(JSON.stringify(examples, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
