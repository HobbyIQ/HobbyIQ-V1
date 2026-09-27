#!/usr/bin/env node
// CF-CLEANLINESS-SETTLE-ON-REPORT-DOC (2026-09-27). Root cause: the "Wait for
// anomaly-force-scan ... to settle" step in nightly-cleanliness.yml polled
// `gh run list --workflow=backfill-runner.yml --limit 1` with no lane filter.
// backfill-runner.yml is a SHARED dispatcher with one static workflow name
// used by every lane (anomaly-force-scan, run-ebay-order-poll, and others),
// so "the newest backfill-runner run" is whichever lane happened to fire most
// recently -- not necessarily the one this workflow dispatched or any of its
// budget-stop relaunches. On 2026-09-26 the loop sampled an unrelated hourly
// lane (run-ebay-order-poll, run 36215231471 @ 03:36Z) that was already
// completed, called that "settled", and moved on while the real
// anomaly-force-scan chain (805 units, 110-minute budget, relaunched at
// 03:51Z) was still mid-sweep. The next step then failed reading a report
// doc that could not exist yet: "no anomaly scan report for 2026-09-26
// (id=2026-09-26::anomaly-scan-report) -- the sweep did not finish tonight."
// Runs 36213879571 / 36089169537 / 35950221396 all show the same shape; last
// green was 35682083053 on 09-22, before this race started firing.
//
// FIX. Stop inferring "done" from a run-list sample of a shared dispatcher.
// Wait for the OUTCOME directly: anomaly-force-scan.cjs writes its report doc
// to `anomaly_scan_reports` (id `<scanDate>::anomaly-scan-report`, pk /id)
// only once the FULL sweep completes -- a scan-phase budget stop writes a
// crawl_state cursor and deliberately writes NOTHING to the report container
// (see that script's own header: a partial report would compare a different,
// smaller pool against the baseline and report drift that never happened).
// So the report doc's existence IS the settle signal, race-free by
// construction: there is no lane-identity ambiguity to sample around,
// because nothing but the finished chain ever writes this id.
//
// This script polls that doc directly with a point read (same call
// check-anomaly-scan-report.cjs makes) and exits 0 as soon as it appears, or
// exits 2 naming the missing doc once the bounded wait elapses. The workflow
// then runs the existing check-anomaly-scan-report.cjs unconditionally, which
// still owns the pass/fail semantics on the doc's *contents* -- this script
// only removes the race on *whether it exists yet*.
//
// STALE-DOC HAZARD (found in review, 2026-09-27). The doc id is DATE-only
// (`<scanDate>::anomaly-scan-report`), and workflow_dispatch is enabled on
// this workflow, so a same-day re-dispatch (a manual re-run after an earlier
// failure, or two dispatches landing on the same UTC date) can find an
// EARLIER run's doc immediately -- it upserts onto the SAME id, but a wait
// that started only checking existence would treat the OLD doc as "found"
// before the NEW chain ever writes its own, and check-anomaly-scan-report.cjs
// would then report last chain's numbers as fresh. Guarded by WAIT_FOR_DOC_
// NOT_BEFORE: the doc is only accepted once its own `computedAt` (the field
// anomaly-force-scan.cjs stamps at report-build time, ISO 8601 UTC, directly
// string-comparable) is >= that bound. A doc older than the bound is logged
// and treated exactly like "not present yet".
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   COSMOS_DATABASE            default hobbyiq
//   ANOMALY_REPORT_CONTAINER   default anomaly_scan_reports
//   WAIT_FOR_DOC_ID            required -- the doc id to poll (pk = id)
//   WAIT_FOR_DOC_NOT_BEFORE    optional -- ISO 8601 UTC; a doc whose own
//                              `computedAt` is older than this is treated as
//                              not-yet-present (guards a same-day re-dispatch
//                              finding an earlier run's doc under the same
//                              date-only id)
//   WAIT_FOR_DOC_MAX_MS        default 14400000 (4h)
//   WAIT_FOR_DOC_POLL_MS       default 300000 (5m)
//
// Exit codes: 0 doc found within the bound (and fresh enough, if bounded)
//             1 Cosmos not configured / doc id missing / read error
//             2 bound elapsed with no (sufficiently fresh) doc -- names it
"use strict";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core poll loop, independent of the CosmosClient wiring so it can be unit
 * tested against a fake `container` (anything with an `item(id, pk).read()`
 * shaped like the @azure/cosmos SDK).
 *
 * @param {{item: (id: string, pk: string) => {read: () => Promise<{resource: any}>}}} container
 * @param {{docId: string, notBefore?: string, maxMs?: number, pollMs?: number, containerName?: string,
 *          log?: (s: string) => void, err?: (s: string) => void, sleepFn?: (ms: number) => Promise<void>}} opts
 * @returns {Promise<0|1|2>}
 */
async function waitForDoc(container, opts) {
  const docId = opts.docId;
  if (!docId) { (opts.err || console.error)("::error::WAIT_FOR_DOC_ID required"); return 1; }

  const notBefore = opts.notBefore || null;
  const maxMs = Number(opts.maxMs || 4 * 60 * 60 * 1000);
  const pollMs = Number(opts.pollMs || 5 * 60 * 1000);
  const containerName = opts.containerName || "anomaly_scan_reports";
  const log = opts.log || console.log;
  const err = opts.err || console.error;
  const sleepFn = opts.sleepFn || sleep;

  const t0 = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const elapsedMs = Date.now() - t0;
    let found = false;
    let staleComputedAt = null;
    try {
      const { resource } = await container.item(docId, docId).read();
      if (resource) {
        // ISO 8601 UTC timestamps compare correctly as plain strings.
        if (notBefore && !(resource.computedAt >= notBefore)) {
          staleComputedAt = resource.computedAt;
        } else {
          found = true;
        }
      }
    } catch (e) {
      if (e && e.code !== 404) {
        err(`::error::wait-for-doc read failed for ${docId}: ${e && e.message}`);
        return 1;
      }
    }

    const elapsedMin = Math.round(elapsedMs / 60000);
    if (found) {
      log(`[wait-for-doc] found ${docId} after ${elapsedMin}m (attempt ${attempt})`);
      return 0;
    }

    if (staleComputedAt) {
      log(`[wait-for-doc] attempt=${attempt} elapsed=${elapsedMin}m — stale doc from ${staleComputedAt}`
        + ` (before ${notBefore}), waiting for a newer one`);
    } else {
      log(`[wait-for-doc] attempt=${attempt} elapsed=${elapsedMin}m — ${docId} not present yet`);
    }

    if (Date.now() - t0 + pollMs > maxMs) {
      err(`::error::timed out waiting for ${docId} in ${containerName} `
        + `after ${Math.round(maxMs / 60000)}m — the chain that writes this doc never finished settling`
        + (staleComputedAt ? ` (a doc exists but is stale: computedAt=${staleComputedAt}, needed >= ${notBefore})` : ""));
      return 2;
    }

    await sleepFn(pollMs);
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); return 1; }

  const docId = process.env.WAIT_FOR_DOC_ID;
  if (!docId) { console.error("::error::WAIT_FOR_DOC_ID required"); return 1; }

  const { CosmosClient } = require("@azure/cosmos");
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const containerName = process.env.ANOMALY_REPORT_CONTAINER || "anomaly_scan_reports";
  const container = db.container(containerName);

  return waitForDoc(container, {
    docId,
    notBefore: process.env.WAIT_FOR_DOC_NOT_BEFORE || null,
    maxMs: Number(process.env.WAIT_FOR_DOC_MAX_MS || 4 * 60 * 60 * 1000),
    pollMs: Number(process.env.WAIT_FOR_DOC_POLL_MS || 5 * 60 * 1000),
    containerName,
  });
}

module.exports = { waitForDoc };

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`::error::wait-for-doc FATAL: ${(e && e.stack) || e}`);
      process.exit(1);
    });
}
