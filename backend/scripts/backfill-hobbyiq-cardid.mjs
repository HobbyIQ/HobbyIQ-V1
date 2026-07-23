#!/usr/bin/env node
// CF-HOBBYIQ-CARDID-BACKFILL (Drew, 2026-07-23, issue #706 Phase 1c).
// Populates the hobbyiqCardId field on existing sold_comps rows.
//
// Usage:
//   COSMOS_CONNECTION_STRING="..." \
//   node backend/scripts/backfill-hobbyiq-cardid.mjs [options]
//
// Options:
//   --limit=N          Max rows to process this run (default: 100000)
//   --batch=N          Rows per query page (default: 500)
//   --dry-run          Compute + log but don't write (default: false)
//   --sleep-ms=N       Sleep between batches to stay under Cosmos RU (default: 500)
//   --resume-from=TS   Start after this soldAt ISO timestamp (default: 0)
//
// Idempotent — re-runs skip rows that already have hobbyiqCardId set.
// Batched — uses Cosmos continuation tokens to page through the corpus
// without RU spikes.
//
// Under baseline 400 RU/s throughput this script runs slowly (~1-2
// rows/sec). For a full 2.5M-row backfill, dispatch after temporarily
// bumping Cosmos throughput (issue #706 references the IAM path needed
// for automated burst). Progress checkpoints via --resume-from let you
// pause + resume without re-processing.
//
// The compiled dist/ path is required — this script uses the same
// slug generator + print run extractor as the runtime write path so
// the two can never diverge.
//
// Exit codes:
//   0  ran to completion (limit reached, or corpus fully covered)
//   1  fatal error (bad env, unrecoverable Cosmos exception)

import { CosmosClient } from "@azure/cosmos";
import { computeHobbyIqCardId } from "../dist/services/portfolioiq/hobbyIqCardId.service.js";
import { extractPrintRunFromTitle } from "../dist/services/portfolioiq/soldCompsStore.service.js";
import { inferSportFromContext } from "../dist/services/portfolioiq/soldCompsStore.service.js";

const args = parseArgs(process.argv.slice(2));
const connStr = process.env.COSMOS_CONNECTION_STRING;
if (!connStr) {
  console.error("COSMOS_CONNECTION_STRING not set");
  process.exit(1);
}

const client = new CosmosClient(connStr);
const container = client
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = {
  seen: 0,
  alreadyPopulated: 0,
  computed: 0,
  written: 0,
  skippedMissingIdentity: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};

let checkpoint = args.resumeFrom ?? "";
const startTime = process.hrtime.bigint();

console.error(`Starting backfill. limit=${args.limit} batch=${args.batch} dryRun=${args.dryRun} sleepMs=${args.sleepMs} resumeFrom="${checkpoint}"`);

let done = false;
while (!done && stats.seen < args.limit) {
  const params = [{ name: "@from", value: checkpoint }];
  const query = `SELECT TOP ${args.batch} c.id, c.cardId, c.playerName, c.cardYear, c.setName, c.parallel, c.cardNumber, c.isAuto, c.sport, c.title, c.soldAt, c.hobbyiqCardId
                 FROM c
                 WHERE c.soldAt > @from
                 ORDER BY c.soldAt ASC`;
  let rows;
  try {
    const { resources } = await container.items.query({ query, parameters: params }).fetchAll();
    rows = resources;
  } catch (err) {
    console.error("query failed:", err.message?.slice(0, 200));
    stats.errors++;
    await sleep(5000);
    continue;
  }

  if (rows.length === 0) {
    done = true;
    break;
  }

  for (const row of rows) {
    stats.seen++;
    checkpoint = row.soldAt;

    if (typeof row.hobbyiqCardId === "string" && row.hobbyiqCardId.startsWith("hiq:")) {
      stats.alreadyPopulated++;
      continue;
    }

    const sport = row.sport ?? inferSportFromContext(row.setName, row.title);
    if (!sport || typeof row.cardYear !== "number" || !Number.isFinite(row.cardYear)) {
      stats.skippedMissingIdentity++;
      continue;
    }

    const hobbyiqCardId = computeHobbyIqCardId({
      sport,
      year: row.cardYear,
      setKey: row.setName ?? "",
      cardNumber: row.cardNumber ?? "",
      parallel: row.parallel ?? "Base",
      isAuto: row.isAuto ?? false,
      printRun: extractPrintRunFromTitle(row.title),
    });
    stats.computed++;

    if (args.dryRun) continue;

    try {
      await container.item(row.id, row.cardId).patch([
        { op: "add", path: "/hobbyiqCardId", value: hobbyiqCardId },
      ]);
      stats.written++;
    } catch (err) {
      // patch fails if the doc doesn't exist under this partition key
      // (Cosmos strictness) or on any other write error. Log + continue.
      if (stats.errors < 20) {
        console.error(`write err id=${row.id}:`, err.message?.slice(0, 200));
      }
      stats.errors++;
    }
  }

  const elapsedSec = Number((process.hrtime.bigint() - startTime) / 1000000000n);
  const rate = elapsedSec > 0 ? (stats.seen / elapsedSec).toFixed(1) : "n/a";
  console.error(`progress: seen=${stats.seen} written=${stats.written} skipped=${stats.alreadyPopulated}(populated)+${stats.skippedMissingIdentity}(no-identity) errors=${stats.errors} rate=${rate}rows/sec checkpoint=${checkpoint}`);

  await sleep(args.sleepMs);
}

const finalElapsedSec = Number((process.hrtime.bigint() - startTime) / 1000000000n);
console.error("");
console.error("BACKFILL COMPLETE");
console.error(JSON.stringify({ ...stats, checkpoint, elapsedSec: finalElapsedSec }, null, 2));

function parseArgs(argv) {
  const out = {
    limit: 100000,
    batch: 500,
    dryRun: false,
    sleepMs: 500,
    resumeFrom: "",
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice(8));
    else if (a.startsWith("--sleep-ms=")) out.sleepMs = Number(a.slice(11));
    else if (a.startsWith("--resume-from=")) out.resumeFrom = a.slice(14);
    else if (a === "--help") {
      console.log("usage: node backfill-hobbyiq-cardid.mjs [--limit=N] [--batch=N] [--dry-run] [--sleep-ms=N] [--resume-from=ISO]");
      process.exit(0);
    }
  }
  return out;
}
