#!/usr/bin/env node
// CF-MIGRATE-CARDID-TO-HIQ (Drew, 2026-08-05).
//
// Option A migration: make hobbyiqCardId THE cardId on every sold_comp.
// Vendor's original cardId is preserved as vendorCardId. Once landed,
// every downstream query by cardId hits the canonical partition for
// that card — no more cross-vendor union band-aids.
//
// Container is partitioned by /cardId. Changing cardId means Cosmos
// moves the row to a NEW logical partition, which the SDK models as
// delete + insert. Not atomic per-row.
//
// Two modes:
//   DRY RUN (default)  — samples SAMPLE_SIZE rows, shows before/after,
//                        estimates full-migration RU cost + wall time.
//                        NEVER writes.
//   APPLY (opt-in)     — BACKFILL_APPLY=true actually migrates. Bulk
//                        upsert per new-partition batch; source rows
//                        deleted after the target write returns 2xx.
//
// Filters:
//   MIGRATE_YEAR=YYYY   — limit to one card-year (test on small slice)
//   MIGRATE_SPORT=x     — limit to one sport
//   MAX_ROWS=N          — hard cap on how many rows touched
//
// Safety:
//   - Skips rows where hobbyiqCardId is null / undefined / empty
//   - Skips rows where cardId ALREADY equals hobbyiqCardId (idempotent)
//   - Skips rows where hobbyiqCardId contains "::" (malformed slug)
//   - Failures are counted, not silently swallowed; script exits non-zero
//     if any batch errored out.

const { CosmosClient } = require("@azure/cosmos");

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING required");
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const SAMPLE_SIZE = Math.max(1, Number(process.env.SAMPLE_SIZE || 20));
const MIGRATE_YEAR = process.env.MIGRATE_YEAR ? Number(process.env.MIGRATE_YEAR) : null;
const MIGRATE_SPORT = process.env.MIGRATE_SPORT || null;
const MAX_ROWS = process.env.MAX_ROWS ? Number(process.env.MAX_ROWS) : 0;
const CHUNK = 25;

const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
const src = db.container("sold_comps");

function eligibilityFilter(r) {
  if (!r.hobbyiqCardId || typeof r.hobbyiqCardId !== "string") return { ok: false, reason: "no_slug" };
  if (r.hobbyiqCardId.includes("::")) return { ok: false, reason: "malformed_slug" };
  if (r.cardId === r.hobbyiqCardId) return { ok: false, reason: "already_migrated" };
  if (!r.cardId) return { ok: false, reason: "no_cardId" };
  return { ok: true };
}

function buildWhere() {
  const parts = ["IS_DEFINED(c.hobbyiqCardId)", "c.hobbyiqCardId != null", "c.hobbyiqCardId != c.cardId"];
  const params = [];
  if (MIGRATE_YEAR) { parts.push("c.cardYear = @year"); params.push({ name: "@year", value: MIGRATE_YEAR }); }
  if (MIGRATE_SPORT) { parts.push("c.sport = @sport"); params.push({ name: "@sport", value: MIGRATE_SPORT }); }
  return { where: parts.join(" AND "), params };
}

async function countEligible() {
  const { where, params } = buildWhere();
  const { resources } = await src.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
    parameters: params,
  }).fetchAll();
  return resources[0] || 0;
}

async function sampleRows(n) {
  const { where, params } = buildWhere();
  const { resources } = await src.items.query({
    query: `SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.parallel, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.source FROM c WHERE ${where}`,
    parameters: [...params, { name: "@n", value: n }],
  }).fetchAll();
  return resources;
}

async function dryRun() {
  console.log(`\n▸ Dry-run — no writes\n`);
  console.log(`  scope: ${MIGRATE_SPORT ? `sport=${MIGRATE_SPORT} ` : ""}${MIGRATE_YEAR ? `year=${MIGRATE_YEAR}` : "all"}`);
  const total = await countEligible();
  console.log(`  eligible rows: ${total.toLocaleString()}`);
  if (total === 0) return;

  const samples = await sampleRows(SAMPLE_SIZE);
  console.log(`\n  Sample of ${samples.length} rows (before → after):`);
  for (const r of samples) {
    const el = eligibilityFilter(r);
    const marker = el.ok ? "  " : "! ";
    console.log(`\n${marker}id: ${r.id}`);
    console.log(`  cardId (before): ${r.cardId}`);
    console.log(`  cardId (after):  ${r.hobbyiqCardId}   ${el.ok ? "" : `[SKIP: ${el.reason}]`}`);
    console.log(`  vendorCardId (new field): ${r.cardId}`);
    console.log(`  who/what:  ${r.cardYear} ${r.setName}  #${r.cardNumber || "?"}  ${r.parallel || "?"}  ${r.gradeCompany || ""}${r.gradeValue || ""}  $${r.price}  ${r.playerName}`);
  }

  // Cost / wall-time estimate. Delete+insert on a Cosmos row that MOVES
  // partitions is ~20 RU. Autoscale ceiling is 10K RU/s.
  const RU_PER_ROW = 20;
  const RU_CEILING = 10_000;
  const totalRU = total * RU_PER_ROW;
  const wallSec = Math.ceil(totalRU / RU_CEILING);
  const wallMin = Math.ceil(wallSec / 60);
  console.log(`\n▸ Estimated cost of full migration:`);
  console.log(`   ${total.toLocaleString()} rows × ~${RU_PER_ROW} RU = ${totalRU.toLocaleString()} RU total`);
  console.log(`   at ${RU_CEILING.toLocaleString()} RU/s sustained autoscale ceiling → ~${wallSec}s (${wallMin} min) wall time`);
  console.log(`   real wall likely 1.5-2x due to retries + backoff`);
  console.log(`\n▸ Set BACKFILL_APPLY=true to actually migrate. Recommend testing on a`);
  console.log(`  narrow slice first: MIGRATE_YEAR=2018 MIGRATE_SPORT=baseball MAX_ROWS=1000\n`);
}

async function apply() {
  const total = await countEligible();
  const targetTotal = MAX_ROWS && MAX_ROWS < total ? MAX_ROWS : total;
  console.log(`\n▸ APPLY MODE — migrating ${targetTotal.toLocaleString()} rows (of ${total.toLocaleString()} eligible)\n`);

  const { where, params } = buildWhere();
  const it = src.items.query({
    query: `SELECT * FROM c WHERE ${where}`,
    parameters: params,
  }, { maxItemCount: 200 });

  let migrated = 0, skipped = 0, errored = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults() && migrated + skipped + errored < targetTotal) {
    const { resources } = await it.fetchNext();
    // Batch by NEW partition key (hobbyiqCardId) so each Cosmos bulk()
    // targets rows going to the same target partition — reduces cross-
    // partition orchestration cost.
    const byNewPk = new Map();
    for (const r of resources) {
      const el = eligibilityFilter(r);
      if (!el.ok) { skipped++; continue; }
      if (migrated + skipped + errored >= targetTotal) break;
      let arr = byNewPk.get(r.hobbyiqCardId);
      if (!arr) { arr = []; byNewPk.set(r.hobbyiqCardId, arr); }
      arr.push(r);
    }

    for (const [newPk, rows] of byNewPk.entries()) {
      // Insert new rows in one partition, then delete old rows from
      // their original partitions. If insert fails, we DON'T delete
      // (idempotent — script can be re-run on the same rows).
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const upserts = chunk.map((r) => {
          const { _rid, _self, _etag, _attachments, _ts, ...clean } = r;
          const oldCardId = r.cardId;
          return {
            operationType: "Upsert",
            partitionKey: newPk,
            resourceBody: {
              ...clean,
              cardId: newPk,
              vendorCardId: oldCardId,
              _migratedAt: new Date().toISOString(),
              _migratedFrom: oldCardId,
            },
          };
        });
        try {
          const upResults = await src.items.bulk(upserts);
          const okIdx = [];
          for (let j = 0; j < upResults.length; j++) {
            if (upResults[j].statusCode >= 200 && upResults[j].statusCode < 300) okIdx.push(j);
            else errored++;
          }
          // Delete old rows only where the target upsert succeeded.
          const deletes = okIdx.map((j) => ({
            operationType: "Delete",
            id: chunk[j].id,
            partitionKey: chunk[j].cardId,
          }));
          if (deletes.length > 0) {
            const delResults = await src.items.bulk(deletes);
            for (const r of delResults) {
              if (r.statusCode >= 200 && r.statusCode < 300) migrated++;
              else errored++;
            }
          }
        } catch (e) {
          errored += chunk.length;
          if (errored < 20) console.error(`  bulk failed: ${e.message}`);
        }
      }
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const rate = migrated / Math.max(1, elapsed);
    process.stdout.write(`  migrated=${migrated} skipped=${skipped} errored=${errored}  ${elapsed}s  ${rate.toFixed(1)} rows/s\r`);
  }
  console.log(`\n\n▸ DONE — migrated=${migrated} skipped=${skipped} errored=${errored}`);
  if (errored > 0) process.exit(1);
}

(async () => {
  if (APPLY) await apply();
  else await dryRun();
})().catch((e) => { console.error(e); process.exit(1); });
