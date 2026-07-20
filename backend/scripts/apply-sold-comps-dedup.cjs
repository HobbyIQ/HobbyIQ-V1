#!/usr/bin/env node
/**
 * CF-DEDUP-APPLY (Drew, 2026-07-19). Companion to the read-only
 * detect-sold-comps-duplicates.cjs — reads its JSONL output from stdin
 * and deletes the non-canonical rows in each duplicate cluster.
 *
 * The pickCanonical scoring keeps the row with:
 *   1. verifiedByUser=true (highest signal)
 *   2. sourceExternalId starting with "holding::" or "ch-daily::"
 *      (canonical prefixes per current emit code)
 *   3. Longer parallel string (more specific)
 *   4. Newer observedAt (more recent code path)
 *
 * All OTHER rows in the cluster get deleted.
 *
 * Runbook (safe: dry-run by default, requires --apply):
 *   # Detect + apply for a single cardId (validate first)
 *   node backend/scripts/detect-sold-comps-duplicates.cjs \
 *     --cardId=1778542140951x283396404010038530 \
 *     | node backend/scripts/apply-sold-comps-dedup.cjs
 *
 *   # Same, actually apply
 *   node backend/scripts/detect-sold-comps-duplicates.cjs \
 *     --cardId=1778542140951x283396404010038530 \
 *     | node backend/scripts/apply-sold-comps-dedup.cjs --apply
 *
 *   # Full pool (WARNING: potentially thousands of deletes)
 *   node backend/scripts/detect-sold-comps-duplicates.cjs \
 *     | node backend/scripts/apply-sold-comps-dedup.cjs --apply
 *
 * Rate-limited to protect Cosmos throughput.
 */
const { CosmosClient } = require("@azure/cosmos");
const readline = require("readline");

const APPLY = process.argv.includes("--apply");
const RATE_MS = Number(process.env.DEDUP_RATE_MS ?? "50");

function pickCanonical(rows) {
  const scored = rows.map((r) => {
    const prefix = r.sourceExternalId ?? "";
    const prefixScore = prefix.startsWith("holding::") ? 50
      : prefix.startsWith("ch-daily::") ? 50
      : 0;
    return {
      row: r,
      score: (
        (r.verifiedByUser === true ? 100 : 0) +
        prefixScore +
        (r.parallel ? String(r.parallel).length : 0) +
        (r.observedAt ? new Date(r.observedAt).getTime() / 1e11 : 0)
      ),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].row;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container("sold_comps");

  console.error(`Mode: ${APPLY ? "APPLY (deletes)" : "DRY-RUN"}  rate=${RATE_MS}ms/delete`);

  const rl = readline.createInterface({ input: process.stdin });
  let clusters = 0;
  let deleted = 0;
  let kept = 0;
  let errors = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cluster;
    try { cluster = JSON.parse(trimmed); } catch { continue; }
    if (!cluster.rows || cluster.rows.length < 2) continue;
    clusters++;
    const canonical = pickCanonical(cluster.rows);
    const doomed = cluster.rows.filter((r) => r.id !== canonical.id);
    kept++;

    for (const d of doomed) {
      if (!APPLY) { deleted++; continue; }
      try {
        await sc.item(d.id, cluster.cardId).delete();
        deleted++;
        await sleep(RATE_MS);
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`  delete failed ${d.id}: ${err.message}`);
      }
    }
  }

  console.error(`\nDONE. clusters=${clusters}  kept=${kept}  ${APPLY ? "deleted" : "would-delete"}=${deleted}  errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
