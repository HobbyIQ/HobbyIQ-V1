#!/usr/bin/env node
/**
 * CF-RELEASE-STALE-VERIFY-ANOMALIES (Drew, 2026-08-17).
 *
 * `awaiting-verify` holds ~907k staging rows and has no consumer at all — the
 * status is written in one place and read by nothing, so a row parked there stays
 * parked no matter how much the catalog, the vocabulary or the pool improves
 * around it.
 *
 * The anomalies holding them are FROZEN SNAPSHOTS of a disagreement, some dating
 * to 2026-08-06. Re-running the same checks with today's code on 902 sampled rows:
 *
 *     price-outlier   STALE               375
 *     price-outlier   no-verdict-possible 228
 *     price-outlier   still real          200
 *     no-image        STALE               112   (image was mirrored in later)
 *     parser-low-conf still real           24
 *
 *     every stored anomaly now stale: 680 of 902 (75.4%)
 *
 * So three quarters are held by verdicts that no longer hold. One example: 2026
 * topps-chrome #262 at $11.50, flagged as an outlier, now sits inside a band built
 * from 656 comps.
 *
 * WHY RE-EVALUATE FIRST INSTEAD OF JUST RE-DRIVING EVERYTHING. Measured earlier
 * today: re-driving `awaiting-verify` wholesale inserted 541 of 7,000 and
 * RE-ENQUEUED 6,371 into verify_queue — net worse, and exactly the storm
 * CF-PROMOTER-VERIFY-LOOP was written to stop. This pass only resets rows that
 * pass on re-evaluation, so nothing bounces.
 *
 * STRICT BY DEFAULT. A `no-verdict-possible` price anomaly (pool now under 8
 * comps) is NOT treated as cleared. The original rule records no anomaly when it
 * cannot judge, so releasing on that basis is arguable — but a thin pool is
 * precisely where one bad price does the most damage to FMV, and this job exists
 * to grow the index honestly, not quickly. --include-no-verdict opts in.
 *
 * WHAT IT WRITES: status -> "pending", which is the ONE status the hourly promoter
 * reads. It does not promote anything itself; the shipped promoter does that
 * through the shipped rules. Provenance is stamped so a released row is
 * distinguishable from one that was never held.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/release-stale-verify-anomalies.cjs [--apply] [--limit=N] [--include-no-verdict]
 *
 * Defaults to DRY-RUN. Requires a build (imports from dist/).
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const {
  priceBandFromSorted, priceOutlierDetail, gradeTierKey,
} = require(path.join(backend, "dist/services/portfolioiq/dataCleanJob.service.js"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { normalizeSetKey, slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const APPLY = has("apply");
const INCLUDE_NO_VERDICT = has("include-no-verdict");
const LIMIT = Number(arg("limit", "20000"));
const POOL = Math.max(1, Number(arg("pool", "8")));
const MS_DAY = 86_400_000;

/** STALE | still-real | no-verdict | unknown — one stored anomaly, re-asked. */
function reEvalNonPrice(a, ctx) {
  if (a.kind === "parser-low-confidence") {
    const p = parseListingIdentity(ctx.title);
    const titleSet = normalizeSetKey(ctx.title);
    const titlePar = p && p.parallel ? slugify(String(p.parallel)) : null;
    const setDisagrees = titleSet && titleSet !== ctx.setKeySeg && !/unknown/.test(titleSet);
    const parDisagrees = titlePar && ctx.parallelSeg && titlePar !== ctx.parallelSeg;
    return (setDisagrees || parDisagrees) ? "still-real" : "STALE";
  }
  if (a.kind === "no-image") return ctx.imageUrl ? "STALE" : "still-real";
  // Anything this job does not know how to re-ask is treated as STILL REAL.
  // Silence is not clearance.
  return "unknown";
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const staging = db.container("comps_staging");
  const sold = db.container("sold_comps");

  console.log(`[release-stale] mode=${APPLY ? "APPLY" : "DRY-RUN"} `
    + `noVerdict=${INCLUDE_NO_VERDICT ? "TREATED AS CLEARED" : "held (strict)"} limit=${LIMIT}\n`);

  const iter = staging.items.query({
    query: `SELECT c.id, c.hobbyiqCardId, c.clean, c.raw.vendorPayload.title AS title,
                   c.raw.vendorPayload.price AS price, c.raw.vendorPayload.imageUrl AS imageUrl
            FROM c WHERE c.status='awaiting-verify'`,
  }, { maxItemCount: 500 });

  const bandCache = new Map();
  async function bandFor(slug, tier) {
    const key = `${slug}||${tier}`;
    if (bandCache.has(key)) return bandCache.get(key);
    let band = null;
    try {
      const cutoff = new Date(Date.now() - 30 * MS_DAY).toISOString();
      const { resources } = await sold.items.query({
        query: "SELECT c.price, c.gradeCompany, c.gradeValue FROM c WHERE c.hobbyiqCardId=@h AND c.soldAt >= @c",
        parameters: [{ name: "@h", value: slug }, { name: "@c", value: cutoff }],
      }).fetchAll();
      band = priceBandFromSorted(resources
        .filter((x) => gradeTierKey(x.gradeCompany, x.gradeValue) === tier)
        .map((x) => Number(x.price)).filter((p) => Number.isFinite(p) && p > 0)
        .sort((a, b) => a - b));
    } catch { band = null; }
    bandCache.set(key, band);
    return band;
  }

  let scanned = 0, released = 0, held = 0, noAnomaly = 0, failed = 0;
  const heldBecause = {};

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    if (!resources || resources.length === 0) continue;

    const work = [];
    for (const r of resources) {
      if (scanned >= LIMIT) break;
      scanned++;
      const slug = String(r.hobbyiqCardId || "");
      const stored = (r.clean && r.clean.anomalies) || [];
      if (!slug.startsWith("hiq:")) { held++; heldBecause["no usable slug"] = (heldBecause["no usable slug"] || 0) + 1; continue; }
      // No anomaly recorded at all: this row is not being held by a verdict, so
      // it is not this job's business. Left exactly as it is.
      if (stored.length === 0) { noAnomaly++; continue; }
      work.push({ r, slug, stored });
    }

    let cursor = 0;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (cursor < work.length) {
        const { r, slug, stored } = work[cursor++];
        const parts = slug.split(":");
        const ctx = {
          title: String(r.title || ""),
          imageUrl: r.imageUrl || null,
          setKeySeg: parts[3], parallelSeg: parts[5],
        };
        let blocker = null;
        for (const a of stored) {
          let verdict;
          if (a.kind === "price-outlier") {
            const tier = gradeTierKey(r.clean && r.clean.gradeCompany, r.clean && r.clean.gradeValue);
            const band = await bandFor(slug, tier);
            if (band === null) verdict = INCLUDE_NO_VERDICT ? "STALE" : "no-verdict";
            else verdict = priceOutlierDetail(Number(r.price), band) === null ? "STALE" : "still-real";
          } else {
            verdict = reEvalNonPrice(a, ctx);
          }
          if (verdict !== "STALE") { blocker = `${a.kind}: ${verdict}`; break; }
        }
        if (blocker) {
          held++;
          heldBecause[blocker] = (heldBecause[blocker] || 0) + 1;
          continue;
        }
        released++;
        if (!APPLY) continue;
        try {
          // hobbyiqCardId is the partition key of comps_staging.
          await staging.item(r.id, slug).patch([
            { op: "set", path: "/status", value: "pending" },
            { op: "add", path: "/statusUpdatedAt", value: new Date().toISOString() },
            { op: "add", path: "/releasedFrom", value: "awaiting-verify" },
            { op: "add", path: "/releasedBy", value: "release-stale-verify-anomalies" },
            {
              op: "add", path: "/releaseReason",
              value: `all ${stored.length} stored anomaly(ies) re-evaluated STALE against current data`,
            },
          ]);
        } catch (e) {
          failed++; released--;
          if (failed <= 3) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 70)}`);
        }
      }
    }));
    process.stderr.write(`\rscanned=${scanned} released=${released} held=${held}   `);
  }
  process.stderr.write("\n");

  const judged = released + held;
  console.log(`\nscanned                  : ${scanned.toLocaleString()}`);
  console.log(`no anomaly stored (skipped): ${noAnomaly.toLocaleString()}`);
  console.log(`RELEASED -> pending      : ${released.toLocaleString()}`
    + (judged ? `  (${(100 * released / judged).toFixed(1)}% of judged)` : ""));
  console.log(`held for a live anomaly  : ${held.toLocaleString()}`);
  console.log(`patch failures           : ${failed.toLocaleString()}`);
  console.log("\nwhy rows were held:");
  Object.entries(heldBecause).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
  if (!APPLY) console.log("\nDRY-RUN — nothing written. Re-run with --apply.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
