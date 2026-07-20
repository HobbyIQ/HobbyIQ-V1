#!/usr/bin/env node
/**
 * CF-CONTENT-HASH-BACKFILL (Drew, 2026-07-20). Compute + stamp the
 * `contentHash` field on every existing sold_comps row so the new
 * pre-write dedup (recordSoldComp, PR #641) sees historical rows and
 * dedups against them correctly on subsequent writes.
 *
 * Without this, pre-write dedup would skip rows for cardIds where the
 * legacy dup already exists but has no hash — so a fresh incoming
 * write would land as a 3rd duplicate instead of dedup'ing.
 *
 * Idempotent: skips rows that already have contentHash. Safe to
 * re-run.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... \
 *     node backend/scripts/backfill-sold-comps-content-hash.cjs \
 *       [--cardId=X] [--limit=N] [--apply]
 *
 *   Default is dry-run. Requires --apply to write.
 *
 * Rate-limited via env BACKFILL_RATE_MS (default 30ms/patch).
 */
const { CosmosClient } = require("@azure/cosmos");
const { createHash } = require("crypto");

const RATE_MS = Number(process.env.BACKFILL_RATE_MS ?? "30");

function parseArgs(argv) {
  const args = { apply: false, cardId: null, limit: Infinity };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--cardId=")) args.cardId = a.slice(9);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
  }
  return args;
}

function normalizeParallel(s) {
  return String(s ?? "").trim().toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ refractors?$/, "");
}

function computeContentHash(row) {
  const parts = [
    String(row.cardId ?? "").trim(),
    normalizeParallel(row.parallel),
    row.isAuto === true ? "1" : "0",
    String(row.gradeCompany ?? "raw").toUpperCase(),
    String(row.gradeValue ?? 0),
    String(Math.round((row.price ?? 0) * 100)),
    String(row.soldAt ?? "").slice(0, 10),
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  console.error(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  cardId=${args.cardId ?? "(all)"}  limit=${args.limit}  rate=${RATE_MS}ms`);

  const params = [];
  let whereExtra = "";
  if (args.cardId) {
    whereExtra = " AND c.cardId = @cid";
    params.push({ name: "@cid", value: args.cardId });
  }
  const iter = sc.items.query({
    query: `SELECT c.id, c.cardId, c.parallel, c.isAuto, c.gradeCompany,
                   c.gradeValue, c.price, c.soldAt, c.contentHash
            FROM c
            WHERE c.contentHash = null OR (NOT IS_DEFINED(c.contentHash))
            ${whereExtra}
            OFFSET 0 LIMIT ${Math.min(args.limit, 500000)}`,
    parameters: params,
  }, args.cardId ? { partitionKey: args.cardId } : {});

  let scanned = 0, stamped = 0, alreadyOk = 0, errors = 0;
  const t0 = Date.now();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      if (row.contentHash) { alreadyOk++; continue; }
      const hash = computeContentHash(row);
      if (!args.apply) {
        stamped++;
        continue;
      }
      try {
        await sc.item(row.id, row.cardId).patch([
          { op: "set", path: "/contentHash", value: hash },
        ]);
        stamped++;
        await sleep(RATE_MS);
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`  patch failed ${row.id}: ${err.message}`);
      }
      if (stamped % 500 === 0) {
        const rate = stamped / ((Date.now() - t0) / 1000);
        console.error(`  ${scanned.toLocaleString()} scanned, ${stamped} stamped, ${errors} err @ ${rate.toFixed(1)}/s`);
      }
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.error(`\nDONE. scanned=${scanned.toLocaleString()}  ${args.apply ? "stamped" : "would-stamp"}=${stamped.toLocaleString()}  alreadyOk=${alreadyOk.toLocaleString()}  errors=${errors}  time=${elapsed.toFixed(0)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
