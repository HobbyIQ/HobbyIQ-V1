#!/usr/bin/env node
// READ-ONLY. Two remaining hypotheses for "no grades / listed as raw":
//
//  H1  gradeValue TYPE DRIFT — stored as string on some rows. soldCompsGradeReader
//      guards this ("gradeValue landed as both number and string historically"),
//      but a reader that does not would bucket those rows as raw.
//  H2  isAuthentic rows (gradeValue 0) rendering as "raw" to the user.
//  H3  A graded sale sitting in the SAME slug pool as raw sales — measure, for
//      real slugs, how many carry mixed grade tiers under one hobbyiqCardId.
//
// Env: COSMOS_CONNECTION_STRING, LO, HI

const { CosmosClient } = require("@azure/cosmos");

const SOURCE = process.env.SOURCE || "tca-ebay";
const LO = process.env.LO || "2026-08-25T00:00:00Z";
const HI = process.env.HI || "2026-08-29T00:00:00Z";

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[readback] source=${SOURCE} ${LO}..${HI} (READ-ONLY)`);

  const iter = sc.items.query({
    query: `SELECT c.id, c.title, c.gradeCompany, c.gradeValue, c.isAuthentic,
                   c.hobbyiqCardId, c.price
            FROM c WHERE c.source = @src AND c.soldAt >= @lo AND c.soldAt < @hi
              AND IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null AND c.gradeCompany != ''`,
    parameters: [{ name: "@src", value: SOURCE }, { name: "@lo", value: LO }, { name: "@hi", value: HI }],
  }, { maxItemCount: 1000 });

  let graded = 0, valueIsString = 0, valueIsNumber = 0, valueNull = 0, authentic = 0;
  const stringSamples = [];
  const bySlug = new Map(); // slug -> Set of tiers

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      graded++;
      const v = r.gradeValue;
      if (v === null || v === undefined) valueNull++;
      else if (typeof v === "string") {
        valueIsString++;
        if (stringSamples.length < 5) stringSamples.push({ id: r.id, title: r.title, gradeValue: v, type: typeof v });
      } else valueIsNumber++;
      if (r.isAuthentic === true) authentic++;
      const slug = r.hobbyiqCardId;
      if (slug) {
        if (!bySlug.has(slug)) bySlug.set(slug, new Set());
        bySlug.get(slug).add(`${r.gradeCompany}-${r.gradeValue}`);
      }
    }
  }

  console.log(`\n=== GRADED ROW FIELD TYPES ===`);
  console.log(`graded rows       = ${graded}`);
  console.log(`gradeValue number = ${valueIsNumber}`);
  console.log(`gradeValue STRING = ${valueIsString}   <- H1 type drift`);
  console.log(`gradeValue null   = ${valueNull}`);
  console.log(`isAuthentic true  = ${authentic}   <- H2 renders as raw`);
  console.log(`\nSTRING SAMPLES:`);
  console.log(JSON.stringify(stringSamples, null, 2));

  // H3: how many slugs hold more than one grade tier (raw+graded share a slug)?
  let multiTier = 0;
  for (const [, tiers] of bySlug) if (tiers.size > 1) multiTier++;
  console.log(`\n=== H3 SLUG POOLING ===`);
  console.log(`distinct graded slugs = ${bySlug.size}`);
  console.log(`slugs w/ >1 tier      = ${multiTier}`);
}

main().catch(e => { console.error(e); process.exit(1); });
