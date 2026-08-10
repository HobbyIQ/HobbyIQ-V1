#!/usr/bin/env node
/**
 * CF-GRADE-EXPLODE (Drew, 2026-08-10). Materializes grade-tier rows
 * for every catalog v2 identity row. Doctrine: "make them even if
 * there are no sales so it maps cleanly" — every grade every card.
 *
 * Grade tier set (STANDARD, 23 tiers):
 *   Raw
 *   PSA: 6, 7, 8, 8.5, 9, 9.5, 10
 *   BGS: 8, 8.5, 9, 9.5, 10, 10 Black Label
 *   SGC: 8, 8.5, 9, 9.5, 10
 *   CGC: 8, 8.5, 9, 9.5, 10
 *
 * Row shape: same as parent v2 identity but adds
 *   gradeCompany, gradeValue, gradeQualifier, gradeTier, parentSlug
 *
 * Slug pattern:
 *   identity: hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto:num-150
 *   graded:   hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto:num-150:psa-10
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/explodeCatalogGrades.cjs \
 *     [--limit=1000] [--source-filter=checklistcenter] [--apply]
 */

const { CosmosClient } = require("@azure/cosmos");

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(argOf("limit", "0"));
const SOURCE_FILTER = argOf("source-filter", "");
const CONCURRENCY = 128;

// CORE grade tier set (12 tiers) — chosen for market activity coverage
// per Drew 2026-08-10. Reduces write scope 50% vs STANDARD 24-tier set.
const GRADE_TIERS = [
  { tier: "raw",        gradeCompany: null,  gradeValue: null, gradeQualifier: null,           slug: "raw" },
  { tier: "psa-8",      gradeCompany: "PSA", gradeValue: 8,    gradeQualifier: null,           slug: "psa-8" },
  { tier: "psa-9",      gradeCompany: "PSA", gradeValue: 9,    gradeQualifier: null,           slug: "psa-9" },
  { tier: "psa-9-5",    gradeCompany: "PSA", gradeValue: 9.5,  gradeQualifier: null,           slug: "psa-9-5" },
  { tier: "psa-10",     gradeCompany: "PSA", gradeValue: 10,   gradeQualifier: null,           slug: "psa-10" },
  { tier: "bgs-9",      gradeCompany: "BGS", gradeValue: 9,    gradeQualifier: null,           slug: "bgs-9" },
  { tier: "bgs-9-5",    gradeCompany: "BGS", gradeValue: 9.5,  gradeQualifier: null,           slug: "bgs-9-5" },
  { tier: "bgs-10",     gradeCompany: "BGS", gradeValue: 10,   gradeQualifier: null,           slug: "bgs-10" },
  { tier: "bgs-10-black", gradeCompany: "BGS", gradeValue: 10, gradeQualifier: "Black Label", slug: "bgs-10-black" },
  { tier: "sgc-10",     gradeCompany: "SGC", gradeValue: 10,   gradeQualifier: null,           slug: "sgc-10" },
  { tier: "cgc-9-5",    gradeCompany: "CGC", gradeValue: 9.5,  gradeQualifier: null,           slug: "cgc-9-5" },
  { tier: "cgc-10",     gradeCompany: "CGC", gradeValue: 10,   gradeQualifier: null,           slug: "cgc-10" },
];

function buildGradedRow(identityRow, tier) {
  const parentSlug = identityRow.hobbyiqCardId;
  if (!parentSlug) return null;
  const slug = `${parentSlug}:${tier.slug}`;
  return {
    id: slug,
    // Use parent cardId as partition key so all grades of a card land in same partition
    cardId: identityRow.cardId,
    hobbyiqCardId: slug,
    parentSlug,
    sport: identityRow.sport,
    year: identityRow.year,
    setKey: identityRow.setKey,
    setName: identityRow.setName,
    cardNumber: identityRow.cardNumber,
    playerName: identityRow.playerName,
    team: identityRow.team,
    parallel: identityRow.parallel,
    parallelSlug: identityRow.parallelSlug,
    isAuto: identityRow.isAuto,
    printRun: identityRow.printRun,
    gradeCompany: tier.gradeCompany,
    gradeValue: tier.gradeValue,
    gradeQualifier: tier.gradeQualifier,
    gradeTier: tier.tier,
    source: `${identityRow.source ?? "unknown"}-graded`,
    catalogVersion: 2,
    catalogBatch: "grade-explode-2026-08-10",
    verificationStatus: identityRow.verificationStatus ?? "verified",
    builtAt: "2026-08-10T00:00:00.000Z",
    // Search tokens: parent tokens + grade tokens
    searchTokens: [
      ...(identityRow.searchTokens ?? []),
      tier.tier,
      tier.gradeCompany ? tier.gradeCompany.toLowerCase() : "raw",
      tier.gradeValue ? String(tier.gradeValue) : null,
    ].filter(Boolean),
  };
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  console.log(`[grade-explode] MODE=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY} limit=${LIMIT || "unlimited"}`);
  console.log(`[grade-explode] tiers: ${GRADE_TIERS.length}`);
  console.log(`[grade-explode] source-filter: ${SOURCE_FILTER || "(none)"}`);

  // Query identity rows (skip already-exploded graded rows).
  const whereClauses = [
    "c.catalogVersion = 2",
    "IS_DEFINED(c.hobbyiqCardId)",
    "NOT IS_DEFINED(c.gradeTier)",   // skip already-graded rows
  ];
  if (SOURCE_FILTER) whereClauses.push(`c.source = '${SOURCE_FILTER}'`);
  const query = `SELECT * FROM c WHERE ${whereClauses.join(" AND ")}${LIMIT > 0 ? ` OFFSET 0 LIMIT ${LIMIT}` : ""}`;
  const iter = cat.items.query({ query }, { maxItemCount: 500 }).getAsyncIterator();

  let scanned = 0, generated = 0, upserted = 0, errors = 0, skipped = 0;
  const t0 = Date.now();
  for await (const page of iter) {
    const rows = page.resources ?? [];
    if (rows.length === 0) continue;
    // Build all graded rows for this page
    const graded = [];
    for (const row of rows) {
      scanned++;
      if (!row.hobbyiqCardId) { skipped++; continue; }
      for (const tier of GRADE_TIERS) {
        const g = buildGradedRow(row, tier);
        if (g) graded.push(g);
      }
    }
    generated += graded.length;

    if (!APPLY) {
      if (scanned <= 500 && graded.length > 0) {
        console.log("SAMPLE (first 3):");
        for (const g of graded.slice(0, 3)) {
          console.log(`   ${g.hobbyiqCardId}  ← ${g.playerName} · ${g.parallel} · ${g.gradeTier}`);
        }
      }
      if (scanned % 5000 === 0) process.stdout.write(`\r  scanned ${scanned.toLocaleString()} · would-generate ${generated.toLocaleString()}`);
      continue;
    }
    // APPLY — group graded rows by cardId (partition key), then use
    // TransactionalBatch to upsert all 24 grades of a card in ONE
    // HTTP call. 24x reduction in HTTP overhead vs per-item.
    const byCardId = new Map();
    for (const g of graded) {
      const pk = g.cardId ?? "__nopk__";
      if (!byCardId.has(pk)) byCardId.set(pk, []);
      byCardId.get(pk).push(g);
    }
    const entries = [...byCardId.entries()];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const partBatch = entries.slice(i, i + CONCURRENCY);
      await Promise.all(partBatch.map(async ([pk, docs]) => {
        // Cosmos TransactionalBatch limit: 100 ops per batch
        for (let j = 0; j < docs.length; j += 100) {
          const chunk = docs.slice(j, j + 100);
          try {
            const ops = chunk.map((d) => ({ operationType: "Upsert", resourceBody: d }));
            const res = await cat.items.batch(ops, pk);
            if (res.result && Array.isArray(res.result)) {
              for (const r of res.result) {
                if (r.statusCode >= 200 && r.statusCode < 300) upserted++;
                else errors++;
              }
            } else {
              // If batch returns no per-op results, treat as all-success or check status
              if (res.code >= 200 && res.code < 300) upserted += chunk.length;
              else errors += chunk.length;
            }
          } catch (err) {
            // Fall back to per-item upserts for this chunk on batch failure
            for (const d of chunk) {
              try { await cat.items.upsert(d); upserted++; }
              catch (e2) { errors++; if (errors <= 5) console.warn(`   FALLBACK ERR ${d.id}: ${e2.message.slice(0,80)}`); }
            }
          }
        }
      }));
    }
    if (scanned % 1000 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (upserted / (elapsed || 1)).toFixed(0);
      process.stdout.write(`\r  scanned ${scanned.toLocaleString()} · upserted ${upserted.toLocaleString()} (${rate}/s) · errors ${errors}`);
    }
  }
  console.log(`\n\n═══ RESULT ═══`);
  console.log(`Identities scanned:  ${scanned.toLocaleString()}`);
  console.log(`Skipped (no slug):   ${skipped.toLocaleString()}`);
  console.log(`Graded rows built:   ${generated.toLocaleString()}`);
  console.log(`${APPLY ? "Upserted" : "Would-upsert"}: ${(APPLY ? upserted : generated).toLocaleString()}`);
  console.log(`Errors:              ${errors.toLocaleString()}`);
})().catch((e) => { console.error(e); process.exit(1); });
