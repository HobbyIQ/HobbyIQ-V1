#!/usr/bin/env node
/**
 * CF-CH-INGEST-BASEBALL-ONLY (Drew, 2026-07-17). Deletes rows from
 * ch_daily_sales that are outside the sport allow-list. Idempotent —
 * safe to re-run any number of times.
 *
 * Runbook (dry-run first, always):
 *
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/purge-non-baseball-sales.cjs --dry-run
 *   node backend/scripts/purge-non-baseball-sales.cjs --apply
 *
 * Flags:
 *   --sport-filter=Sport1,Sport2   Sports to KEEP (default: Baseball).
 *                                  Also reads CH_INGEST_SPORT_FILTER env.
 *   --dry-run                      Report counts, delete nothing.
 *   --apply                        Actually delete non-matching rows.
 *   --limit=N                      Cap total rows processed (smoke test).
 *
 * Exit codes:
 *   0  completed
 *   1  cosmos unavailable / bad flags / no --dry-run and no --apply
 */

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cosmos = process.env.COSMOS_CONNECTION_STRING;
  if (!cosmos) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (!args.dryRun && !args.apply) {
    console.error("Must pass --dry-run OR --apply. Never both.");
    process.exit(1);
  }
  if (args.dryRun && args.apply) {
    console.error("Cannot pass both --dry-run and --apply.");
    process.exit(1);
  }

  const keepList = resolveSportFilter(args);
  if (keepList.length === 0) {
    console.error("Empty sport filter — refuse to run (would delete everything).");
    process.exit(1);
  }
  const keepSet = new Set(keepList);
  const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
  const containerId = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";

  const client = new CosmosClient(cosmos);
  const { database } = await client.databases.createIfNotExists({ id: dbName });
  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: ["/card_id"] },
  });

  const t0 = Date.now();
  console.log(JSON.stringify({
    event: "purge_start",
    mode: args.dryRun ? "dry-run" : "apply",
    keepSports: keepList,
    limit: args.limit ?? null,
  }));

  // Distribution before
  const beforeRes = await container.items.query({
    query: 'SELECT c["group"] AS sport, COUNT(1) AS n FROM c GROUP BY c["group"]',
  }).fetchAll();
  const before = (beforeRes.resources ?? []).sort((a, b) => b.n - a.n);
  console.log(JSON.stringify({ event: "purge_before", distribution: before }));
  const totalBefore = before.reduce((s, r) => s + r.n, 0);
  const targetBefore = before
    .filter((r) => !keepSet.has(r.sport))
    .reduce((s, r) => s + r.n, 0);

  if (args.dryRun) {
    console.log(JSON.stringify({
      event: "purge_dry_run_summary",
      totalRows: totalBefore,
      wouldDelete: targetBefore,
      wouldKeep: totalBefore - targetBefore,
      keepSports: keepList,
    }));
    process.exit(0);
  }

  // Apply mode: enumerate targets in pages, delete concurrently per
  // partition. Cosmos requires delete-by-(id, partitionKey), so we
  // fetch id+card_id (partition key) then batch-delete.
  const targetSports = before.filter((r) => !keepSet.has(r.sport)).map((r) => r.sport);
  const limit = args.limit ?? null;
  let totalDeleted = 0;
  let totalFailed = 0;

  for (const sport of targetSports) {
    console.log(JSON.stringify({ event: "purge_sport_start", sport }));
    let sportDeleted = 0;
    let done = false;
    while (!done) {
      const cap = limit ? Math.min(500, limit - totalDeleted) : 500;
      if (cap <= 0) { done = true; break; }
      const { resources: rows } = await container.items
        .query({
          query: `SELECT TOP ${cap} c.id, c.card_id FROM c WHERE c["group"] = @sport`,
          parameters: [{ name: "@sport", value: sport }],
        })
        .fetchAll();
      if (!rows || rows.length === 0) { done = true; break; }
      const results = await Promise.allSettled(rows.map(async (r) => {
        await container.item(r.id, r.card_id).delete();
      }));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      sportDeleted += ok;
      totalDeleted += ok;
      totalFailed += fail;
      console.log(JSON.stringify({
        event: "purge_batch",
        sport,
        deleted: ok,
        failed: fail,
        sportSubtotal: sportDeleted,
      }));
      if (limit && totalDeleted >= limit) { done = true; break; }
      if (rows.length < cap) done = true;
    }
    console.log(JSON.stringify({ event: "purge_sport_done", sport, deleted: sportDeleted }));
    if (limit && totalDeleted >= limit) break;
  }

  // Distribution after
  const afterRes = await container.items.query({
    query: 'SELECT c["group"] AS sport, COUNT(1) AS n FROM c GROUP BY c["group"]',
  }).fetchAll();
  const after = (afterRes.resources ?? []).sort((a, b) => b.n - a.n);

  console.log(JSON.stringify({
    event: "purge_complete",
    totalDeleted,
    totalFailed,
    elapsedMs: Date.now() - t0,
    afterDistribution: after,
  }));
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply") out.apply = true;
    else if (a.startsWith("--sport-filter=")) out.sportFilter = a.slice(15);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
  }
  return out;
}

function resolveSportFilter(args) {
  const raw = args.sportFilter ?? process.env.CH_INGEST_SPORT_FILTER ?? "Baseball";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "purge_fatal",
    error: err.message ?? String(err),
    stack: err.stack ?? null,
  }));
  process.exit(1);
});
