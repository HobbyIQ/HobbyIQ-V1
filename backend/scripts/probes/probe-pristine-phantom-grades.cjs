#!/usr/bin/env node
// READ-ONLY. Counts the blast radius of CF-PRISTINE-IS-A-PRODUCT-NOT-A-GRADE:
// sold_comps rows whose TITLE is a Topps Pristine PRODUCT listing (the set word
// beside a year/brand, no grader named, no numeric grade phrase) but which are
// STORED with a grade. Every one of these is a phantom — a raw sale sitting in a
// graded pool, dragging that tier's FMV toward a raw price while the raw tier
// loses the sale.
//
// The classifier here is the SHIPPED parser, not a restatement of it: a row is
// phantom when the stored row carries a grade and parseGradeLabel(title) — with
// the fix in place — says raw. Run it against dist/ built from this branch.
//
// This script WRITES NOTHING. Repair of stored rows belongs to the census/apply
// lanes, not here.
//
// Env: COSMOS_CONNECTION_STRING (required), COSMOS_DATABASE, SOURCE, LO, HI

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { parseGradeLabel } = require(path.join(
  __dirname, "..", "..", "dist/services/portfolioiq/gradeParser.js"));

// null SOURCE = every vendor lane.
const SOURCE = process.env.SOURCE || null;
const LO = process.env.LO || null;
const HI = process.env.HI || null;

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const where = [
    "CONTAINS(LOWER(c.title), 'pristine')",
    "IS_DEFINED(c.gradeValue)",
    "c.gradeValue != null",
  ];
  const parameters = [];
  if (SOURCE) { where.push("c.source = @src"); parameters.push({ name: "@src", value: SOURCE }); }
  if (LO) { where.push("c.soldAt >= @lo"); parameters.push({ name: "@lo", value: LO }); }
  if (HI) { where.push("c.soldAt < @hi"); parameters.push({ name: "@hi", value: HI }); }

  console.log(`[pristine-phantom] source=${SOURCE || "ALL"} ${LO || "-inf"}..${HI || "+inf"} (READ-ONLY)`);

  const iter = sc.items.query({
    query: `SELECT c.id, c.title, c.source, c.gradeCompany, c.gradeValue,
                   c.hobbyiqCardId, c.price, c.soldAt
            FROM c WHERE ${where.join(" AND ")}`,
    parameters,
  }, { maxItemCount: 1000 });

  let scanned = 0;          // rows whose title mentions pristine AND carry a grade
  let phantom = 0;          // ... and whose title states NO grade (the defect)
  let phantomTen = 0;       // ... of those, stored specifically as a 10
  let genuine = 0;          // title states a grade -> legitimately graded
  const bySource = {};
  const byTier = {};
  const samples = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      // THE CLASSIFIER: the fixed parser says raw, but the row stores a grade.
      const g = parseGradeLabel(r.title);
      if (g && g.gradeValue !== null && g.gradeValue !== undefined) { genuine++; continue; }
      phantom++;
      const tier = `${r.gradeCompany} ${r.gradeValue}`;
      byTier[tier] = (byTier[tier] || 0) + 1;
      bySource[r.source || "?"] = (bySource[r.source || "?"] || 0) + 1;
      if (Number(r.gradeValue) === 10) phantomTen++;
      if (samples.length < 10) samples.push({
        id: r.id, title: r.title, source: r.source,
        storedGrade: tier, slug: r.hobbyiqCardId, price: r.price, soldAt: r.soldAt,
      });
    }
    if (scanned % 20000 === 0) console.log(`  ...scanned ${scanned}`);
  }

  console.log(`\nrows w/ 'pristine' in title AND a stored grade : ${scanned}`);
  console.log(`  genuine (title states a grade)               : ${genuine}`);
  console.log(`  PHANTOM (title states none)                  : ${phantom}`);
  console.log(`    of which stored as a 10                    : ${phantomTen}`);
  console.log(`\nby stored tier:`);
  for (const [k, v] of Object.entries(byTier).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  console.log(`\nby source:`);
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log(`\nsample ids (evidence for the census audit):`);
  for (const s of samples) console.log(`  ${JSON.stringify(s)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
