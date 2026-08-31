#!/usr/bin/env node
// READ-ONLY. How many of the demotion candidates carry a REAL stated grade the
// parser missed because a second grader token appears later in the title
// ("BGS 9.5 ... PSA Ready")? Those rows must NOT be demoted.
//
// Env: COSMOS_CONNECTION_STRING, SOURCES, SINCE

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { parseGradeLabel } = require(path.join(
  __dirname, "..", "..", "dist/services/portfolioiq/gradeParser.js"));

const SOURCES = String(process.env.SOURCES || "tca-ebay").split(",").map(s => s.trim()).filter(Boolean);
const SINCE = process.env.SINCE || "2026-05-01";
const GRADERS = /\b(PSA|BGS|SGC|CGC|CSG|HGA)\b/gi;

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const params = SOURCES.map((v, i) => ({ name: `@s${i}`, value: v }));
  params.push({ name: "@since", value: SINCE });
  const iter = sc.items.query({
    query: `SELECT c.id, c.title, c.gradeCompany, c.gradeValue, c.price
            FROM c WHERE c.source IN (${SOURCES.map((_, i) => `@s${i}`).join(",")})
              AND IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null AND c.gradeCompany != ''
              AND c.soldAt >= @since`,
    parameters: params,
  }, { maxItemCount: 500 });

  let demotable = 0, multiGrader = 0, singleGrader = 0, noGraderToken = 0;
  const multiSamples = [], noneSamples = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      const title = String(r.title ?? "").trim();
      if (!title) continue;
      if (parseGradeLabel(title)) continue;   // title-backed, not a candidate
      demotable++;
      const found = [...new Set((title.match(GRADERS) || []).map(s => s.toUpperCase()))];
      if (found.length >= 2) {
        multiGrader++;
        if (multiSamples.length < 12) multiSamples.push({ title, stored: `${r.gradeCompany} ${r.gradeValue}`, graders: found.join("+"), price: r.price });
      } else if (found.length === 1) {
        singleGrader++;
        if (noneSamples.length < 8) noneSamples.push({ title, stored: `${r.gradeCompany} ${r.gradeValue}`, grader: found[0], price: r.price });
      } else {
        noGraderToken++;
      }
    }
  }

  const pct = (n) => demotable ? (n / demotable * 100).toFixed(2) : "0.00";
  console.log(`\n=== DEMOTION CANDIDATES, BY TITLE EVIDENCE (since ${SINCE}) ===`);
  console.log(`demotable candidates      = ${demotable}`);
  console.log(`  NO grader token at all  = ${noGraderToken}  (${pct(noGraderToken)}%)  <- unambiguously raw, safe to demote`);
  console.log(`  ONE grader token        = ${singleGrader}  (${pct(singleGrader)}%)  <- grader named, no readable value`);
  console.log(`  TWO+ grader tokens      = ${multiGrader}  (${pct(multiGrader)}%)  <- parser may have missed a real grade`);
  console.log(`\n=== TWO+ GRADER SAMPLES (must NOT be demoted blindly) ===`);
  console.log(JSON.stringify(multiSamples, null, 2));
  console.log(`\n=== ONE GRADER SAMPLES ===`);
  console.log(JSON.stringify(noneSamples, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
