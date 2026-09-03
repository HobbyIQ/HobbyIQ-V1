#!/usr/bin/env node
// CF-A-DELETED-HOLDING-KEEPS-NO-TRAIL (H-9, 2026-09-03).
//
// `priceHistoryByHolding` is keyed by holding id. Nothing ever removed an entry
// when the holding was deleted, so every delete since the map existed leaked
// its whole trail into the user doc permanently. The writer-side fix is
// `reapPriceTrail()` in portfolioStore.service.ts, called at all five
// `delete doc.holdings[...]` sites. This script is the other half: the
// one-time sweep for the trails that are ALREADY orphaned.
//
// Measured on prod 2026-09-03 (read-only):
//   250 orphaned trails corpus-wide, 16,246 of 24,055 stored points (67.5%)
//   user-199fcbc9  1,963,908 / 2,097,152 bytes (93.7%)  238 of 281 trails orphaned
//
// The 2 MB Cosmos document ceiling is a hard failure, not a slowdown: at the
// ceiling EVERY reprice and EVERY holding edit for that user fails. The
// per-class history caps from #1627 bound a live holding's trail and bound
// nothing at all once the holding is gone.
//
// Report-first, like every runner lane:
//   BACKFILL_APPLY unset/false  ->  count and name the orphans, write nothing
//   BACKFILL_APPLY=true         ->  delete the orphaned trails, reconciled
//
// Reconciliation (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW): `intended` is the number
// of orphaned TRAILS found by the scan, and it must equal written + skipped +
// failed. Verified by read: after each write the doc is re-read and its
// remaining orphan count asserted to be zero, so a silent partial write is
// counted as failed rather than reported green.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   COSMOS_DATABASE            optional (default "hobbyiq")
//   BACKFILL_APPLY=true        the runner's write switch
//   REPRICE_USER_ID            optional -- scope the sweep to ONE user.
//                              Reuses the existing runner env rather than
//                              claiming a new dispatch input (it is at 24 of
//                              25). Empty = every user, which is the intended
//                              corpus-wide repair.

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const ONLY_USER = String(process.env.REPRICE_USER_ID || "").trim() || null;
const DB = process.env.COSMOS_DATABASE || "hobbyiq";
const CEILING = 2 * 1024 * 1024; // Cosmos hard document ceiling, bytes.

const n = (x) => x.toLocaleString("en-US");
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : "0.0");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const container = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(DB).container("portfolio");

  console.log("=".repeat(74));
  console.log("reap-orphan-price-trails");
  console.log(`  mode:   ${APPLY ? "APPLY (writes)" : "REPORT-ONLY (no writes)"}`);
  console.log(`  scope:  ${ONLY_USER ? `ONE user (${ONLY_USER})` : "EVERY user with holdings"}`);
  console.log("=".repeat(74));
  console.log();

  const query = ONLY_USER
    ? { query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings) AND c.userId = @u", parameters: [{ name: "@u", value: ONLY_USER }] }
    : { query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings)" };
  const { resources: docs } = await container.items.query(query).fetchAll();

  // -- Scan ---------------------------------------------------------------
  const plan = [];
  let intendedTrails = 0, intendedPoints = 0, corpusTrails = 0, corpusPoints = 0;
  for (const doc of docs) {
    const holdings = doc.holdings || {};
    const trails = doc.priceHistoryByHolding || {};
    const orphanIds = [];
    let orphanPoints = 0, totalPoints = 0;
    for (const [id, pts] of Object.entries(trails)) {
      const count = Array.isArray(pts) ? pts.length : 0;
      totalPoints += count;
      corpusPoints += count;
      corpusTrails += 1;
      // An orphan is a trail whose holding is no longer in the map. That is
      // the whole test: the holdings map IS the set of live holdings.
      if (!(id in holdings)) { orphanIds.push(id); orphanPoints += count; }
    }
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    if (orphanIds.length > 0) {
      intendedTrails += orphanIds.length;
      intendedPoints += orphanPoints;
    }
    plan.push({
      doc, userId: doc.userId, bytes,
      pctOfCeiling: Number(((bytes / CEILING) * 100).toFixed(1)),
      holdings: Object.keys(holdings).length,
      trails: Object.keys(trails).length,
      orphanIds, orphanPoints, totalPoints,
    });
  }

  plan.sort((a, b) => b.orphanPoints - a.orphanPoints || b.bytes - a.bytes);

  console.log(`Scanned ${n(docs.length)} user docs -- ${n(corpusTrails)} trails, ${n(corpusPoints)} points total.`);
  console.log(`ORPHANED: ${n(intendedTrails)} trails carrying ${n(intendedPoints)} points (${pct(intendedPoints, corpusPoints)}% of all stored points).`);
  console.log();
  console.log("Per user (largest orphan payload first; docs over 50% of ceiling always listed):");
  console.log("  userId                                            bytes  %ceil   hold  trails  orphan     pts");
  for (const p of plan) {
    if (p.orphanIds.length === 0 && p.pctOfCeiling < 50) continue;
    console.log(
      `  ${String(p.userId).padEnd(44)} ${String(n(p.bytes)).padStart(9)} ${String(p.pctOfCeiling).padStart(5)}% `
      + `${String(p.holdings).padStart(6)} ${String(p.trails).padStart(7)} ${String(p.orphanIds.length).padStart(7)} ${String(n(p.orphanPoints)).padStart(7)}`,
    );
  }
  console.log();

  if (!APPLY) {
    const affected = plan.filter((p) => p.orphanIds.length > 0).length;
    console.log(`REPORT-ONLY -- ${n(intendedTrails)} orphaned trails (${n(intendedPoints)} points) would be reaped across ${n(affected)} users.`);
    console.log("Nothing was written. Re-dispatch with apply=true to reap.");
    return;
  }

  // -- Apply --------------------------------------------------------------
  let written = 0, skipped = 0, failed = 0, pointsReaped = 0;
  for (const p of plan) {
    if (p.orphanIds.length === 0) continue;
    try {
      for (const id of p.orphanIds) delete p.doc.priceHistoryByHolding[id];
      await container.item(p.doc.id, p.userId).replace(p.doc);

      // Verify by read (CF-VERIFY-THE-WRITE-NOT-THE-RUN): re-read the doc and
      // count what remains. A write that silently did not land, or landed
      // partially, is counted as FAILED, never as written.
      const { resource: after } = await container.item(p.doc.id, p.userId).read();
      const liveHoldings = after.holdings || {};
      const remaining = Object.keys(after.priceHistoryByHolding || {})
        .filter((id) => !(id in liveHoldings));
      if (remaining.length > 0) {
        failed += p.orphanIds.length;
        console.error(`  FAILED  ${p.userId}: ${remaining.length} orphans still present after the write landed`);
        continue;
      }
      const afterBytes = Buffer.byteLength(JSON.stringify(after));
      written += p.orphanIds.length;
      pointsReaped += p.orphanPoints;
      console.log(
        `  reaped  ${p.userId}  ${p.orphanIds.length} trails / ${n(p.orphanPoints)} points  `
        + `${n(p.bytes)} -> ${n(afterBytes)} bytes (${((afterBytes / CEILING) * 100).toFixed(1)}% of ceiling)`,
      );
    } catch (err) {
      failed += p.orphanIds.length;
      console.error(`  FAILED  ${p.userId}: ${err?.message ?? String(err)}`);
    }
  }

  console.log();
  console.log(`Reaped ${n(written)} trails / ${n(pointsReaped)} points.`);
  // intended = every orphaned trail the scan found; each one is written,
  // skipped or failed. skipped stays 0: this lane holds nothing back, so a
  // non-zero skip would mean a trail vanished between the scan and the write.
  reportWrites({
    job: "reap-orphan-price-trails",
    intended: intendedTrails,
    written,
    skipped,
    failed,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
