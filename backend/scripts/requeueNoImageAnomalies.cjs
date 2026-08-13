#!/usr/bin/env node
// CF-REQUEUE-STALE-ANOMALY-VERDICTS (Drew, 2026-08-13: "do it" →
// "lets check the anomaly out and fix").
//
// Nothing in the pipeline ever re-examines an `anomaly` row, and promotion
// reads status IN ('clean','verified') — so a row parked under a rule that has
// since been corrected stays parked forever, and its sale never reaches
// sold_comps. This flips those back to `pending` for a fresh verdict.
//
// Three rules have changed under it, so three classes of verdict are stale:
//
//   no-image        — no longer an anomaly at all. A sale without a photo is
//                     still a valid price point (CF-NO-IMAGE-IS-NOT-AN-ANOMALY).
//   price-outlier   — band was median/3..median*3, now the pool's own
//                     p10..p90 widened 3x (CF-PRICE-BAND-FROM-DISPERSION),
//                     bucketed per (slug, gradeTier).
//   parser-low-confidence, setKey emitter ONLY — the job adopted the more
//                     specific setKey and flagged the row anyway
//                     (CF-SETKEY-UPGRADE-IS-NOT-AN-ANOMALY).
//
// SAFETY — the whole point of the filter: a row is requeued only when EVERY
// one of its anomalies is stale. Anything carrying a still-valid verdict stays
// put, because re-pending it would re-litigate a real finding. Note this is
// finer-grained than a kind check: parser-low-confidence has three emitters and
// only the setKey one changed, so the predicate reads the detail text. Verified
// per row from clean.anomalies, never assumed from aggregate counts.
//
// A genuine outlier simply gets re-flagged on the next pass — idempotent, it
// just costs a scan.
//
// Correction worth recording: the anomaly backlog is NOT mostly no-image. An
// earlier 3,000-row sample found only 5 image-only rows. Measured properly on
// 30,000 rows: parser-low-confidence 53.0%, price-outlier 46.6%, no-image
// 11.7% (kinds overlap; a row can carry several).
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

/** Kinds that are stale outright, whatever their detail says. */
const STALE_KINDS = new Set(["no-image", "price-outlier"]);

/**
 * CF-SETKEY-UPGRADE-IS-NOT-AN-ANOMALY / CF-PRICE-BAND-FROM-DISPERSION
 * (Drew, 2026-08-13: "lets check the anomaly out and fix").
 *
 * parser-low-confidence is no longer uniformly "unchanged". It has three
 * emitters and only ONE of them changed:
 *
 *   setKey specificity  — the job adopted the more specific setKey and then
 *                         flagged the row anyway. That anomaly is gone, so
 *                         these rows deserve a fresh verdict.
 *   parallel / isAuto   — rules untouched. Requeueing those would re-litigate
 *                         a still-valid finding.
 *
 * So the predicate has to read the DETAIL, not just the kind. Measured on a
 * 30,000-row sample: 9,429 setKey verdicts vs 6,475 parallel/isAuto, freeing
 * 6,725 rows (22.4% of all anomalies) once no other anomaly remains.
 */
function isStaleVerdict(a) {
  const kind = String(a && a.kind);
  if (STALE_KINDS.has(kind)) return true;
  if (kind !== "parser-low-confidence") return false;
  const d = String((a && a.detail) || "");
  // Matches both the current wording and the pre-2026-08-06 deployed wording
  // ("disagrees with slug setKey"), which is what most historical rows carry.
  return /infers setKey/.test(d) && /more specific than|disagrees with slug setKey/.test(d);
}

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

  const stillValid = anomalies.filter((a) => !isStaleVerdict(a));
  if (stillValid.length > 0) {
    stats.keptRealAnomaly++;
    for (const a of stillValid) keptReasons[a.kind] = (keptReasons[a.kind] ?? 0) + 1;
    return;
  }

  if (!APPLY) { stats.requeued++; return; }
  try {
    row.status = "pending";
    row.requeuedAt = new Date().toISOString();
    row.requeuedReason = "CF-STALE-ANOMALY-VERDICT-2026-08-13";
    await st.item(row.id, row.hobbyiqCardId).replace(row);
    stats.requeued++;
  } catch { stats.errors++; }
}

(async () => {
  console.log(`requeue stale-verdict anomalies — ${APPLY ? "APPLY" : "DRY RUN"}  max=${MAX}\n`);

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
