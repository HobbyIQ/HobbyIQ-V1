#!/usr/bin/env node
// READ-ONLY. Characterizes TCA stored-raw rows: what do their titles look like,
// and does the SHARED parser disagree with the stored fields in EITHER direction?
// Also checks the slug dimension (does the slug carry a grade tier?).
//
// Env: COSMOS_CONNECTION_STRING, MONTHS_BACK (default 0 = most recent), DAYS

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { parseGradeLabel } = require(path.join(
  __dirname, "..", "dist/services/portfolioiq/gradeParser.js"));
const { GRADE_TIER_RE } = require(path.join(
  __dirname, "..", "dist/services/portfolioiq/cardIdentityKey.service.js"));

const SOURCE = process.env.SOURCE || "tca-ebay";
const LO = process.env.LO; // ISO
const HI = process.env.HI; // ISO

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[probe-shape] source=${SOURCE} lo=${LO} hi=${HI} (READ-ONLY)`);

  const iter = sc.items.query({
    query: `SELECT c.id, c.title, c.gradeCompany, c.gradeValue, c.gradeQualifier,
                   c.isAuthentic, c.hobbyiqCardId, c.parentSlug, c.price, c.soldAt,
                   c.identityMethod
            FROM c
            WHERE c.source = @src AND c.soldAt >= @lo AND c.soldAt < @hi`,
    parameters: [
      { name: "@src", value: SOURCE },
      { name: "@lo", value: LO },
      { name: "@hi", value: HI },
    ],
  }, { maxItemCount: 1000 });

  let examined = 0, storedRaw = 0, storedGraded = 0;
  let rawButTitleGraded = 0;      // the reported bug
  let gradedButTitleRaw = 0;      // opposite direction
  let slugCarriesTier = 0;        // graded child slug present
  let gradedNoTierInSlug = 0;     // graded fields but parent-shaped slug
  const rawTitleSamples = [];
  const affectedSamples = [];
  const gradedSamples = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      examined++;
      const storedIsRaw = !r.gradeCompany || String(r.gradeCompany).trim() === "";
      const g = parseGradeLabel(r.title);

      const parts = String(r.hobbyiqCardId || "").split(":");
      const hasTier = parts.length > 7 && GRADE_TIER_RE.test(parts[7]);
      if (hasTier) slugCarriesTier++;

      if (storedIsRaw) {
        storedRaw++;
        if (g) {
          rawButTitleGraded++;
          if (affectedSamples.length < 8) affectedSamples.push({
            id: r.id, title: r.title, parsed: `${g.gradeCompany} ${g.gradeValue}`,
            slug: r.hobbyiqCardId, price: r.price, soldAt: r.soldAt,
          });
        } else if (rawTitleSamples.length < 12) {
          rawTitleSamples.push({ title: r.title, price: r.price, slug: r.hobbyiqCardId });
        }
      } else {
        storedGraded++;
        if (!hasTier) gradedNoTierInSlug++;
        if (!g) gradedButTitleRaw++;
        if (gradedSamples.length < 8) gradedSamples.push({
          id: r.id, title: r.title,
          stored: `${r.gradeCompany} ${r.gradeValue}`,
          slug: r.hobbyiqCardId, parentSlug: r.parentSlug ?? null,
          identityMethod: r.identityMethod ?? null,
        });
      }
    }
  }

  console.log(`\n=== SHAPE ===`);
  console.log(`examined              = ${examined}`);
  console.log(`storedRaw             = ${storedRaw}`);
  console.log(`storedGraded          = ${storedGraded}`);
  console.log(`rawButTitleGraded     = ${rawButTitleGraded}  <- reported bug`);
  console.log(`gradedButTitleRaw     = ${gradedButTitleRaw}  <- price-resolver inferred`);
  console.log(`slugCarriesGradeTier  = ${slugCarriesTier}`);
  console.log(`gradedNoTierInSlug    = ${gradedNoTierInSlug}  <- graded fields, parent-shaped slug`);
  console.log(`\n=== AFFECTED SAMPLES ===`);
  console.log(JSON.stringify(affectedSamples, null, 2));
  console.log(`\n=== STORED-GRADED SAMPLES ===`);
  console.log(JSON.stringify(gradedSamples, null, 2));
  console.log(`\n=== STORED-RAW, TITLE-ALSO-RAW SAMPLES ===`);
  console.log(JSON.stringify(rawTitleSamples, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
