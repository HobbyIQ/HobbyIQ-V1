#!/usr/bin/env node
/**
 * CF-DEDUP-DETECT (Drew, 2026-07-19). READ-ONLY scanner that finds
 * duplicate sold_comps rows. Reports groups, never deletes.
 *
 * Duplicate = same (source, soldAt-to-minute, priceCents,
 * normalized-parallel) tuple in the same cardId partition. Root
 * causes:
 *   - Inconsistent sourceExternalId prefixes across emit paths
 *     (`holding::` vs `batch-backfill::` vs `rematch::` for the same
 *     purchase — code is now unified, legacy rows survive)
 *   - Cross-parallel pollution from retired warmPoolFromCh (same sale
 *     tagged with different parallels from separate queries)
 *
 * Output: JSON to stdout, one object per duplicate group. Redirect to
 * a file, review, then feed to a separate delete step ONLY if
 * confirmed safe.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *     node backend/scripts/detect-sold-comps-duplicates.cjs [--cardId=X] [--limit=N] > dup-report.json
 *
 * Safe: no writes, no deletes, no mutations.
 */
const { CosmosClient } = require("@azure/cosmos");

function parseArgs(argv) {
  // CF-DEDUP-RECENCY-FILTER (Drew, 2026-07-26). Add --since so the
  // nightly cron only re-scans cardIds that had a WRITE in the last
  // 24 hours (that's when new duplicates would be introduced). The
  // full-pool re-scan blew past the 120min workflow timeout for 5 of
  // the last 6 nights (only 2026-07-22 completed). Recency-filtered
  // enumeration completes in ~10-20 min.
  //
  // --full          override — process every distinct cardId (weekly
  //                 deep-scan cadence; not the default)
  // --since=<ISO>   explicit lower bound on observedAt (default: 24h ago)
  const args = { cardId: null, limit: Infinity, since: null, full: false };
  const defaultSince = new Date(Date.now() - 24 * 3600_000).toISOString();
  for (const a of argv) {
    if (a.startsWith("--cardId=")) args.cardId = a.slice(9);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--since=")) args.since = a.slice(8);
    else if (a === "--full") args.full = true;
  }
  if (!args.since && !args.full && !args.cardId) args.since = defaultSince;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container("sold_comps");

  const mode = args.cardId ? "single-cardId"
             : args.full   ? "full-pool"
             : "recency-filtered";
  console.error(`Scan mode: ${mode}  cardId=${args.cardId ?? "(n/a)"}  since=${args.since ?? "(n/a)"}  limit=${args.limit}`);

  let cardIds = [];
  if (args.cardId) {
    cardIds = [args.cardId];
  } else if (args.full) {
    console.error("Enumerating ALL distinct cardIds (full-pool mode)…");
    const { resources } = await sc.items.query(
      "SELECT DISTINCT VALUE c.cardId FROM c"
    ).fetchAll();
    cardIds = resources;
    console.error(`Found ${cardIds.length.toLocaleString()} distinct cardIds (full pool)`);
  } else {
    // CF-DEDUP-RECENCY-FILTER: only re-scan cardIds that had a WRITE
    // (observedAt) in the [since, now] window. New dupes can only be
    // introduced when new rows land — old cardIds that haven't changed
    // haven't gained new dupes since the last nightly.
    console.error(`Enumerating distinct cardIds with observedAt >= ${args.since}…`);
    const { resources } = await sc.items.query({
      query: "SELECT DISTINCT VALUE c.cardId FROM c WHERE c.observedAt >= @since",
      parameters: [{ name: "@since", value: args.since }],
    }).fetchAll();
    cardIds = resources;
    console.error(`Found ${cardIds.length.toLocaleString()} distinct cardIds with recent writes`);
  }

  const stripRefr = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, "");
  let scanned = 0;
  let duplicateGroups = 0;
  let extraRows = 0;
  const t0 = Date.now();

  for (const cardId of cardIds) {
    if (scanned >= args.limit) break;
    const { resources: rows } = await sc.items.query({
      query: "SELECT c.id, c.cardId, c.source, c.sourceExternalId, c.soldAt, c.price, c.parallel, c.gradeCompany, c.gradeValue, c.verifiedByUser, c.observedAt FROM c WHERE c.cardId = @cid",
      parameters: [{ name: "@cid", value: cardId }],
    }, { partitionKey: cardId }).fetchAll();
    scanned += rows.length;

    const clusters = new Map();
    for (const r of rows) {
      const soldMinute = r.soldAt ? new Date(r.soldAt).toISOString().slice(0, 16) : "null";
      const priceCents = Math.round(Number(r.price ?? 0) * 100);
      const parallelKey = stripRefr(r.parallel);
      const key = `${r.source}::${soldMinute}::${priceCents}::${parallelKey}`;
      const arr = clusters.get(key) ?? [];
      arr.push(r);
      clusters.set(key, arr);
    }

    for (const [key, cluster] of clusters) {
      if (cluster.length < 2) continue;
      duplicateGroups++;
      extraRows += cluster.length - 1;
      process.stdout.write(JSON.stringify({
        clusterKey: key,
        cardId,
        rowCount: cluster.length,
        rows: cluster.map((r) => ({
          id: r.id,
          sourceExternalId: r.sourceExternalId,
          parallel: r.parallel,
          gradeCompany: r.gradeCompany,
          gradeValue: r.gradeValue,
          verifiedByUser: r.verifiedByUser,
          observedAt: r.observedAt,
        })),
      }) + "\n");
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.error(`\nDONE. scanned=${scanned.toLocaleString()}  dupGroups=${duplicateGroups.toLocaleString()}  extraRows=${extraRows.toLocaleString()}  time=${elapsed.toFixed(0)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
