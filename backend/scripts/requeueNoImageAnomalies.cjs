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
// CF-REJUDGE-ALL (Drew, 2026-08-13: "what about fixing the anamoly?").
//
// The selective predicate below frees a row only when EVERY verdict on it is
// stale, which is right when one rule changed. But the rules have now changed
// repeatedly (no-image, price band, setKey upgrade, and the 2026-08-06
// parallel-direction guard), and the pile is full of verdicts recorded before
// those fixes — e.g. "title parallel Base disagrees with staging parallel gold"
// on a title that literally ends in "Gold", which current code already
// suppresses. Those rows will never be freed selectively because the predicate
// cannot tell a stale verdict from a live one for that emitter.
//
// --all requeues every anomaly row for a fresh verdict under current rules.
// Idempotent: a genuinely anomalous row is simply re-flagged. Costs a scan.
const ALL = args.includes("--all");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX = Number(val("--max", "50000"));
const PAGE = Number(val("--page", "1000"));
const CONCURRENCY = Number(val("--concurrency", "64"));
const SHARD = Number(val("--shard", "-1"));
const SHARDS = Number(val("--shards", "1"));

// CF-REQUEUE-THROUGHPUT (Drew, 2026-08-13: "how can we speed it up? ... go
// live date is 9/14"). First pass ran ~1,800 rows/min, ~8h for the pile.
// comps_staging autoscales to 40,000 RU, so we were never throttled — the
// bottleneck was entirely client-side, and it was two things:
//
//   SELECT *  — staging docs carry the whole raw vendor payload. We were
//               pulling megabytes to read three fields.
//   replace() — sends the ENTIRE document back to flip one string.
//
// Now: project the three fields we actually read, and patch the three we
// actually write. Plus optional id-prefix sharding so N processes cover
// disjoint slices without racing (same trick as dataCleanJob's shardChars —
// staging ids are randomUUID(), so hex prefixes distribute evenly).
const HEX = "0123456789abcdef".split("");
function shardClause() {
  if (SHARD < 0 || SHARDS <= 1) return "";
  const mine = HEX.filter((_, i) => i % SHARDS === SHARD % SHARDS);
  if (mine.length === 0) return "";
  return ` AND (${mine.map((c) => `STARTSWITH(c.id, '${c}')`).join(" OR ")})`;
}

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
  // `_anoms` is the projected alias for c.clean.anomalies (see the query).
  // Falls back to the nested path so the function still works if someone
  // hands it a full document.
  const anomalies = row?._anoms ?? row?.clean?.anomalies ?? [];
  if (anomalies.length === 0) { stats.noAnomalyBlock++; return; }

  const stillValid = ALL ? [] : anomalies.filter((a) => !isStaleVerdict(a));
  if (stillValid.length > 0) {
    stats.keptRealAnomaly++;
    for (const a of stillValid) keptReasons[a.kind] = (keptReasons[a.kind] ?? 0) + 1;
    return;
  }

  if (!APPLY) { stats.requeued++; return; }
  try {
    // Patch, not replace: three fields instead of the whole document.
    await st.item(row.id, row.hobbyiqCardId).patch([
      { op: "set", path: "/status", value: "pending" },
      { op: "set", path: "/requeuedAt", value: new Date().toISOString() },
      { op: "set", path: "/requeuedReason", value: "CF-STALE-ANOMALY-VERDICT-2026-08-13" },
    ]);
    stats.requeued++;
  } catch (e) {
    stats.errors++;
    if (stats.errors <= 3) console.error("  write error:", String(e && e.message).slice(0, 140));
  }
}

(async () => {
  const shardLabel = SHARD >= 0 && SHARDS > 1 ? `  shard ${SHARD}/${SHARDS}` : "";
  console.log(`requeue stale-verdict anomalies — ${APPLY ? "APPLY" : "DRY RUN"}  max=${MAX}  conc=${CONCURRENCY}${shardLabel}\n`);

  // Project only what handle() reads. `SELECT *` pulled the entire raw vendor
  // payload for every row — the single biggest cost in the first pass.
  const iter = st.items.query({
    query: `SELECT c.id, c.hobbyiqCardId, c.clean.anomalies AS _anoms FROM c WHERE c.status = 'anomaly'${shardClause()}`,
  }, { maxItemCount: PAGE });

  const started = Date.now();
  let batch = 0;
  while (iter.hasMoreResults() && stats.scanned < MAX) {
    const { resources } = await iter.fetchNext();
    // Cross-partition queries return empty pages while more results remain —
    // trust hasMoreResults(), not the page size.
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, handle);
    if (++batch % 10 === 0) {
      const mins = (Date.now() - started) / 60000;
      const rate = Math.round(stats.scanned / Math.max(mins, 0.001));
      console.log(`   ...${stats.scanned} scanned, ${stats.requeued} ${APPLY ? "requeued" : "would requeue"}, ${stats.keptRealAnomaly} kept  [${rate}/min]`);
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
