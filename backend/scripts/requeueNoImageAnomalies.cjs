#!/usr/bin/env node
// CF-REQUEUE-NO-IMAGE-ANOMALIES (Drew, 2026-08-13: "do it").
//
// Companion to CF-NO-IMAGE-IS-NOT-AN-ANOMALY. Rows were routed to `anomaly`
// because our blob mirror write is denied account-wide ("This request is not
// authorized to perform this operation using this permission"), which
// data-clean read as no-image. A sale without a photo is still a valid price
// point, so that rule is gone — but ~897K rows are already parked under it and
// nothing re-examines an anomaly row.
//
// This flips those back to `pending` so data-clean reconsiders them under the
// corrected rules (no-image is now a note, and the price-outlier median is
// grade-aware).
//
// SAFETY — the whole point of the filter: only rows whose anomalies are ALL
// image-related get requeued. A row that also tripped price-outlier or
// parser-low-confidence stays put, because those verdicts are still valid and
// re-pending them would re-litigate a real finding. Verified per row from
// clean.anomalies, not assumed from the aggregate counts.
//
// Dry-run by default.
//
//   node scripts/requeueNoImageAnomalies.cjs
//   node scripts/requeueNoImageAnomalies.cjs --apply --max 200000

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX = Number(val("--max", "50000"));
const PAGE = Number(val("--page", "500"));
const CONCURRENCY = Number(val("--concurrency", "16"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const st = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq")
  .container("comps_staging");

/**
 * Anomaly kinds whose RULE CHANGED, so a past verdict is no longer evidence:
 *
 *   no-image      — no longer an anomaly at all (CF-NO-IMAGE-IS-NOT-AN-ANOMALY)
 *   price-outlier — the 30d median is now bucketed per (slug, gradeTier)
 *                   (CF-DATA-CLEAN-MEDIAN-BY-GRADE), so graded sales that were
 *                   compared against a raw median get a fresh, fair verdict
 *
 * parser-low-confidence is deliberately NOT here — that rule is unchanged, so
 * requeueing those would re-litigate a still-valid finding for no reason.
 *
 * A genuine outlier simply gets re-flagged on the next pass; this is idempotent,
 * it just costs a scan.
 *
 * Correction worth recording: the historical anomaly backlog is NOT mostly
 * no-image. A 3,000-row sample found only 5 image-only rows — those 897K
 * predate the mirror outage and are mostly parser-low-confidence (3,136) and
 * price-outlier (536).
 */
const IMAGE_KINDS = new Set(["no-image", "price-outlier"]);

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const stats = { scanned: 0, requeued: 0, keptRealAnomaly: 0, noAnomalyBlock: 0, errors: 0 };
const keptReasons = {};

async function handle(row) {
  stats.scanned++;
  const anomalies = row?.clean?.anomalies ?? [];
  if (anomalies.length === 0) { stats.noAnomalyBlock++; return; }

  const nonImage = anomalies.filter((a) => !IMAGE_KINDS.has(String(a?.kind)));
  if (nonImage.length > 0) {
    stats.keptRealAnomaly++;
    for (const a of nonImage) keptReasons[a.kind] = (keptReasons[a.kind] ?? 0) + 1;
    return;
  }

  if (!APPLY) { stats.requeued++; return; }
  try {
    row.status = "pending";
    row.requeuedAt = new Date().toISOString();
    row.requeuedReason = "CF-NO-IMAGE-IS-NOT-AN-ANOMALY";
    await st.item(row.id, row.hobbyiqCardId).replace(row);
    stats.requeued++;
  } catch { stats.errors++; }
}

(async () => {
  console.log(`requeue image-only anomalies — ${APPLY ? "APPLY" : "DRY RUN"}  max=${MAX}\n`);

  const iter = st.items.query({
    query: "SELECT * FROM c WHERE c.status = 'anomaly'",
  }, { maxItemCount: PAGE });

  let batch = 0;
  while (iter.hasMoreResults() && stats.scanned < MAX) {
    const { resources } = await iter.fetchNext();
    // Cross-partition queries return empty pages while more results remain —
    // trust hasMoreResults(), not the page size.
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, handle);
    if (++batch % 10 === 0) {
      console.log(`   ...${stats.scanned} scanned, ${stats.requeued} ${APPLY ? "requeued" : "would requeue"}, ${stats.keptRealAnomaly} kept`);
    }
  }

  console.log(`\nscanned                 : ${stats.scanned}`);
  console.log(`  ${APPLY ? "REQUEUED to pending   " : "would requeue         "}: ${stats.requeued}`);
  console.log(`  kept (real anomaly)   : ${stats.keptRealAnomaly}`);
  console.log(`  no anomaly recorded   : ${stats.noAnomalyBlock}`);
  console.log(`  errors                : ${stats.errors}`);
  if (Object.keys(keptReasons).length) console.log(`  kept for: ${JSON.stringify(keptReasons)}`);
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
