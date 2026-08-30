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
const { isIssuedGrade, canonicalGradeCompany } =
  require(require("node:path").resolve(__dirname, "..", "dist/services/catalog/gradeLadder.service.js"));
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). This mints graded rows
// nightly. Counters, disjoint: intended = graded rows built (generated);
// written = per-operation 2xx from the batch, or a per-item fallback upsert
// that resolved; failed = the rest. Every built row is attempted under
// --apply, so generated = upserted + errors.
const { reportWrites } = require(require("node:path").resolve(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(argOf("limit", "0"));
const SOURCE_FILTER = argOf("source-filter", "");
// CF-GRADE-EXPLODE-THROTTLE-FIX (Drew, 2026-08-11). Was hardcoded to 128
// which tips card_catalog RU into 429 when other jobs are competing for
// the same throughput pool (e.g. sold_comps mass-reslugs during a busy
// day). Env-configurable + defaults to a safer 32.
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const SELF_THROTTLE_MS = Math.max(0, Number(process.env.SELF_THROTTLE_MS || 0));

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

  // CF-EXPLODE-WRITES-TO-THE-CONTRACT (Drew, 2026-08-26). Two changes, both
  // about not manufacturing the problems this catalog spent four days on.
  //
  // PARTITION. This used to set `cardId: identityRow.cardId` -- co-locating a
  // card's whole ladder in the parent's partition, so the ladder could be read
  // in one query. A reasonable design, and not the one the rest of the system
  // holds: catalogMatcher point-reads (slug, slug), and deriveCatalogEntry sets
  // cardId = id. Worse, inheriting the parent's key propagates the parent's
  // breakage -- a parent stranded under a vendor Bubble id gave every one of
  // its graded children the same wrong address. That is how 16.4M rows became
  // invisible to the matcher. Each row now owns its partition, which is what
  // makes the ~1 RU point read work.
  //
  // FIELDS. The old builder hand-listed the fields to carry, so anything the
  // checklist knew and this list did not -- subsetName, displayName,
  // playerSlug, imageUrl, cardYear -- was silently dropped from every graded
  // row. Spread the parent instead: a graded card IS its parent card plus a
  // grade, and the matcher discriminates on exactly the fields that were being
  // thrown away. New fields now propagate without editing this function.
  const {
    _rid, _self, _etag, _attachments, _ts,
    id: _oldId, cardId: _oldCardId, hobbyiqCardId: _oldSlug,
    gradeCompany: _gc, gradeValue: _gv, gradeQualifier: _gq, gradeTier: _gt,
    ...parent
  } = identityRow;

  return {
    ...parent,
    id: slug,
    cardId: slug,
    hobbyiqCardId: slug,
    parentSlug,
    gradeCompany: tier.gradeCompany,
    gradeValue: tier.gradeValue,
    gradeQualifier: tier.gradeQualifier,
    gradeTier: tier.tier,
    source: `${identityRow.source ?? "unknown"}-graded`,
    catalogVersion: 2,
    catalogBatch: "grade-explode-contract-2026-08-26",
    verificationStatus: identityRow.verificationStatus ?? "verified",
    builtAt: new Date().toISOString(),
    searchTokens: [
      ...(identityRow.searchTokens ?? []),
      tier.tier,
      tier.gradeCompany ? tier.gradeCompany.toLowerCase() : "raw",
      tier.gradeValue ? String(tier.gradeValue) : null,
    ].filter(Boolean),
  };
}

// CF-ONE-GRADE-LADDER. The tier table above is what SOMEBODY once believed each
// grader issues; gradeLadder.service is what they actually issue. Filtering
// here rather than editing the table means a tier nobody issues cannot be
// reintroduced by a future edit -- PSA 9.5 got into that table and produced
// 1,462,513 ungradeable rows before anyone noticed.
const ISSUED_TIERS = GRADE_TIERS.filter((t) => {
  if (t.gradeCompany === null) return true;              // raw
  const ok = isIssuedGrade(t.gradeCompany, t.gradeValue);
  if (!ok) {
    console.warn(`[grade-explode] DROPPED tier ${t.tier}: ` +
      `${canonicalGradeCompany(t.gradeCompany) ?? t.gradeCompany} does not issue ${t.gradeValue}`);
  }
  return ok;
});

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  console.log(`[grade-explode] MODE=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY} limit=${LIMIT || "unlimited"}`);
  console.log(`[grade-explode] tiers: ${ISSUED_TIERS.length} of ${GRADE_TIERS.length} (impossible grades dropped)`);
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

  // CF-GRADE-EXPLODE-ITER-RETRY (Drew, 2026-08-11). Wrap iterator
  // advancement with 429-safe retry. Prior: unhandled 429 from
  // iter.next() crashed the whole run mid-progress. Now: back off per
  // Cosmos-supplied retryAfterInMs, resume same page.
  async function nextPageWithRetry(iterator, tries = 5) {
    for (let i = 0; i < tries; i++) {
      try { return await iterator.next(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 2000 * (i + 1)) + 500;
          console.warn(`\n  iter 429; backing off ${wait}ms (try ${i+1}/${tries})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error("iter retries exhausted");
  }

  while (true) {
    const step = await nextPageWithRetry(iter);
    if (step.done) break;
    const page = step.value;
    {
    const rows = page.resources ?? [];
    if (rows.length === 0) continue;
    // Build all graded rows for this page
    const graded = [];
    for (const row of rows) {
      scanned++;
      if (!row.hobbyiqCardId) { skipped++; continue; }
      for (const tier of ISSUED_TIERS) {
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
    } // end page-scope block
    if (SELF_THROTTLE_MS > 0) await new Promise((r) => setTimeout(r, SELF_THROTTLE_MS));
  }
  console.log(`\n\n═══ RESULT ═══`);
  console.log(`Identities scanned:  ${scanned.toLocaleString()}`);
  console.log(`Skipped (no slug):   ${skipped.toLocaleString()}`);
  console.log(`Graded rows built:   ${generated.toLocaleString()}`);
  console.log(`${APPLY ? "Upserted" : "Would-upsert"}: ${(APPLY ? upserted : generated).toLocaleString()}`);
  console.log(`Errors:              ${errors.toLocaleString()}`);
  if (APPLY) reportWrites({ job: "explodeCatalogGrades", intended: generated, written: upserted, failed: errors });
}

// Only a direct run does the work; the builder is also imported by tests.
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { buildGradedRow, GRADE_TIERS, ISSUED_TIERS };
