#!/usr/bin/env node
// CF-BACKFILL-AUTOSTYLE-QUALIFIER (Drew, 2026-07-23, issues #712 #713).
// Populates the autoStyle + gradeQualifier fields on existing sold_comps
// rows by running parseListingIdentity + parseGradeLabel over each row's
// title. Same shape as backfill-hobbyiq-cardid.mjs.
//
// Usage:
//   COSMOS_CONNECTION_STRING="..." \
//   node backend/scripts/backfill-autostyle-gradequalifier.mjs [options]
//
// Options:
//   --limit=N          Max rows to process this run (default: 100000)
//   --batch=N          Rows per query page (default: 500)
//   --concurrency=N    Parallel in-flight patches per batch (default: 32)
//   --dry-run          Compute + log but don't write
//   --sleep-ms=N       Sleep between batches (default: 50)
//   --resume-from=TS   Start after this soldAt ISO timestamp
//
// Idempotent — re-runs skip rows that already have BOTH fields populated
// (which they might via new runtime persistence path from PR #723).
//
// Exit codes:
//   0 ran to completion
//   1 fatal error

import { CosmosClient } from "@azure/cosmos";
import { parseListingIdentity } from "../dist/services/portfolioiq/parseTitleIdentity.service.js";
import { parseGradeLabel } from "../dist/services/portfolioiq/gradeParser.js";

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
  noTitle: 0,
  errors: 0,
  autoStyleOnCard: 0,
  autoStyleSticker: 0,
  qualifierTagged: 0,
  startedAt: new Date().toISOString(),
};

let checkpoint = args.resumeFrom ?? "";
const startTime = process.hrtime.bigint();

console.error(`Starting backfill. limit=${args.limit} batch=${args.batch} concurrency=${args.concurrency} dryRun=${args.dryRun} sleepMs=${args.sleepMs} resumeFrom="${checkpoint}"`);

async function patchWithRetry(id, cardId, patchOps) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await container.item(id, cardId).patch(patchOps);
      return { ok: true };
    } catch (err) {
      const code = err?.code ?? err?.statusCode;
      if (code === 429 && attempt < MAX_ATTEMPTS - 1) {
        const retryAfterMs = Number(err?.retryAfterInMs ?? err?.headers?.["x-ms-retry-after-ms"] ?? (100 * Math.pow(2, attempt)));
        await sleep(retryAfterMs);
        continue;
      }
      return { ok: false, err };
    }
  }
  return { ok: false, err: new Error("max retries exceeded") };
}

async function patchInParallel(work, concurrency) {
  for (let i = 0; i < work.length; i += concurrency) {
    const chunk = work.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((w) => patchWithRetry(w.id, w.cardId, w.patchOps)));
    for (let j = 0; j < results.length; j++) {
      if (results[j].ok) stats.written++;
      else {
        if (stats.errors < 20) {
          console.error(`write err id=${chunk[j].id}:`, results[j].err?.message?.slice(0, 200));
        }
        stats.errors++;
      }
    }
  }
}

let done = false;
while (!done && stats.seen < args.limit) {
  const params = [{ name: "@from", value: checkpoint }];
  const query = `SELECT TOP ${args.batch} c.id, c.cardId, c.title, c.soldAt, c.autoStyle, c.gradeQualifier, c.isAuto
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

  if (rows.length === 0) { done = true; break; }

  const workQueue = [];
  for (const row of rows) {
    stats.seen++;
    checkpoint = row.soldAt;

    // Skip when both new fields are already populated (idempotent).
    const hasAutoStyle = row.autoStyle !== undefined;
    const hasQualifier = row.gradeQualifier !== undefined;
    if (hasAutoStyle && hasQualifier) { stats.alreadyPopulated++; continue; }

    const title = String(row.title ?? "").trim();
    if (!title) { stats.noTitle++; continue; }

    // Parse identity (for autoStyle) + grade (for qualifier)
    const identity = parseListingIdentity(title);
    const gradeParsed = parseGradeLabel(title);
    const autoStyle = row.isAuto ? identity.autoStyle : null;
    const gradeQualifier = gradeParsed?.qualifier ?? null;
    stats.computed++;
    if (autoStyle === "on-card") stats.autoStyleOnCard++;
    if (autoStyle === "sticker") stats.autoStyleSticker++;
    if (gradeQualifier) stats.qualifierTagged++;

    if (args.dryRun) continue;

    // Skip writing pure-null values. Field-absence and field=null both
    // read as "unknown" downstream; writing null on ~2M rows wastes
    // RU with no signal gain. Only patch when we have real values.
    const patchOps = [];
    if (!hasAutoStyle && autoStyle !== null) {
      patchOps.push({ op: "add", path: "/autoStyle", value: autoStyle });
    }
    if (!hasQualifier && gradeQualifier !== null) {
      patchOps.push({ op: "add", path: "/gradeQualifier", value: gradeQualifier });
    }
    if (patchOps.length === 0) continue;
    workQueue.push({ id: row.id, cardId: row.cardId, patchOps });
  }

  if (workQueue.length > 0) await patchInParallel(workQueue, args.concurrency);

  const elapsedSec = Number((process.hrtime.bigint() - startTime) / 1000000000n);
  const rate = elapsedSec > 0 ? (stats.seen / elapsedSec).toFixed(1) : "n/a";
  console.error(`progress: seen=${stats.seen} written=${stats.written} skipped=${stats.alreadyPopulated}(populated)+${stats.noTitle}(no-title) onCard=${stats.autoStyleOnCard} sticker=${stats.autoStyleSticker} qualifier=${stats.qualifierTagged} errors=${stats.errors} rate=${rate}rows/sec checkpoint=${checkpoint}`);

  await sleep(args.sleepMs);
}

const finalElapsedSec = Number((process.hrtime.bigint() - startTime) / 1000000000n);
console.error("");
console.error("BACKFILL COMPLETE");
console.error(JSON.stringify({ ...stats, checkpoint, elapsedSec: finalElapsedSec }, null, 2));

function parseArgs(argv) {
  const out = {
    limit: 5000000,
    batch: 500,
    concurrency: 32,
    dryRun: false,
    sleepMs: 50,
    resumeFrom: "",
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice(8));
    else if (a.startsWith("--concurrency=")) out.concurrency = Math.max(1, Math.min(200, Number(a.slice(14))));
    else if (a.startsWith("--sleep-ms=")) out.sleepMs = Number(a.slice(11));
    else if (a.startsWith("--resume-from=")) out.resumeFrom = a.slice(14);
    else if (a === "--help") {
      console.log("usage: node backfill-autostyle-gradequalifier.mjs [--limit=N] [--batch=N] [--concurrency=N] [--dry-run] [--sleep-ms=N] [--resume-from=ISO]");
      process.exit(0);
    }
  }
  return out;
}
