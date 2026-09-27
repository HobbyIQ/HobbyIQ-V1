#!/usr/bin/env node
// CF-CLEANLINESS-ANOMALY-BUDGET (2026-09-11). nightly-cleanliness.yml no
// longer waits on an HTTP dispatch of /cleanliness/anomalies?force=true --
// that call is an unbounded full sold_comps walk that has gone two nights
// straight without a terminal answer inside poll-admin-job.cjs's ceiling.
// The scan is now backend/scripts/anomaly-force-scan.cjs, a backfill-runner
// lane that persists its own result to the `anomaly_scan_reports` container
// (one doc per scanDate) once a full (cardYear, sportClass) sweep completes.
//
// This script is the nightly workflow's READ side: after dispatching and
// waiting on that lane (and any budget-stop relaunches it triggers), read
// today's report doc and print the same "N total, M high-suspiciousness"
// summary the old inline HTTP-poll step used to compute from RESULT_JSON,
// then exit non-zero when the report is missing/stale or the high count
// crosses the warn floor -- exactly the checks the old step made, just
// against a Cosmos doc instead of an HTTP response body.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   COSMOS_DATABASE            default hobbyiq
//   ANOMALY_REPORT_CONTAINER   default anomaly_scan_reports
//   ANOMALY_SCAN_DATE          default today (UTC, YYYY-MM-DD) -- the report
//                              this run expects to find. A report from an
//                              EARLIER date means the sweep did not finish
//                              tonight (still mid-relaunch, or the whole
//                              chain died) and this exits 1 rather than
//                              silently reporting stale numbers as current.
//   ANOMALY_HIGH_WARN_FLOOR    default 10 -- prints ::warning:: above this
//   ANOMALY_NOT_BEFORE         required -- ISO 8601 timestamp. Guards the
//                              same stale-doc hazard wait-for-doc.cjs guards
//                              (2026-09-27 review, see scripts/lib/
//                              not-before.cjs): the report id is date-only,
//                              so a same-day workflow_dispatch re-run can
//                              find an EARLIER run's doc under the same id.
//                              A doc whose own `computedAt` predates this
//                              bound (beyond a 5s clock-skew tolerance) is
//                              treated as absent (exit 1) rather than read
//                              as fresh. Missing/empty/unparseable is a hard
//                              failure, never a silent skip of the guard --
//                              the workflow always sets this from its own
//                              DISPATCHED_AT.
//
// Exit codes: 0 fresh report read (regardless of anomaly count -- a high
//             count is a warning, not a failure: the scan itself succeeded)
//           1 no report for today / stale report older than ANOMALY_NOT_BEFORE
//             / ANOMALY_NOT_BEFORE missing or unparseable / Cosmos not
//             configured / read error
//           2 report present but its own `report` field is null (no
//             baseline snapshot existed when the sweep ran)
"use strict";

const { CosmosClient } = require("@azure/cosmos");
const { requireNotBefore, isFreshEnough } = require("./lib/not-before.cjs");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); return 1; }

  // Required, not optional: an empty/malformed bound is a wiring bug, never
  // a signal to skip the stale-doc check (see scripts/lib/not-before.cjs).
  let notBeforeMs;
  try {
    notBeforeMs = requireNotBefore(process.env.ANOMALY_NOT_BEFORE);
  } catch (e) {
    console.error(`::error::ANOMALY_NOT_BEFORE invalid: ${e.message}`);
    return 1;
  }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const container = db.container(process.env.ANOMALY_REPORT_CONTAINER || "anomaly_scan_reports");
  const scanDate = process.env.ANOMALY_SCAN_DATE || new Date().toISOString().slice(0, 10);
  const warnFloor = Number(process.env.ANOMALY_HIGH_WARN_FLOOR || 10);

  const id = `${scanDate}::anomaly-scan-report`;
  let doc = null;
  try {
    const { resource } = await container.item(id, id).read();
    doc = resource || null;
  } catch (e) {
    if (e.code !== 404) {
      console.error(`::error::anomaly-scan-report read failed: ${e && e.message}`);
      return 1;
    }
  }

  if (!doc) {
    console.error(`::error::no anomaly scan report for ${scanDate} (id=${id}) -- `
      + "the sweep did not finish tonight. Check the backfill-runner dispatch for "
      + "anomaly-force-scan: a chain of budget-stop relaunches that never completed "
      + "leaves a crawl_state cursor but no report doc.");
    return 1;
  }

  // Same date-only-id hazard wait-for-doc.cjs guards against: a same-day
  // workflow_dispatch re-run can leave an EARLIER run's doc under this same
  // id. Compares parsed epoch ms (with clock-skew tolerance), never raw ISO
  // strings -- DISPATCHED_AT has no milliseconds, computedAt does, and
  // string order does not agree with chronological order across that
  // boundary.
  if (!isFreshEnough(doc.computedAt, notBeforeMs)) {
    console.error(`::error::anomaly scan report for ${scanDate} (id=${id}) is stale -- `
      + `computedAt=${doc.computedAt} is older than ANOMALY_NOT_BEFORE=${process.env.ANOMALY_NOT_BEFORE}. `
      + "This is an earlier run's doc under the same date-only id; the sweep for "
      + "THIS dispatch did not finish tonight.");
    return 1;
  }

  console.log(`anomaly-force-scan report: scanDate=${doc.scanDate} unitsScanned=${doc.unitsScanned} `
    + `rowsScanned=${doc.rowsScanned} computedAt=${doc.computedAt}`);

  if (doc.report === null || doc.report === undefined) {
    console.error("::error::anomaly scan report=null -- no baseline snapshot exists yet, so no "
      + "drift comparison was possible (run baseline-pool-snapshot)");
    return 2;
  }

  const anomalies = Array.isArray(doc.report.anomalies) ? doc.report.anomalies : [];
  const highCount = anomalies.filter((a) => a.suspiciousness === "high").length;
  console.log(`Anomalies detected: ${anomalies.length} total, ${highCount} high-suspiciousness`);
  if (highCount > warnFloor) {
    console.log(`::warning::${highCount} slugs with high-suspiciousness drift — review /app/admin/cleanliness`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`::error::check-anomaly-scan-report FATAL: ${(e && e.stack) || e}`);
    process.exit(1);
  });
