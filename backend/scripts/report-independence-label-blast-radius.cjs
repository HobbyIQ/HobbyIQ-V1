#!/usr/bin/env node
// CF-A-CAVEAT-THAT-FIRES-EVERYWHERE-SAYS-NOTHING (Drew, 2026-09-04).
//
// READ-ONLY. No write path exists in this file: no APPLY flag, no upsert,
// no patch, no reprice. It reads one portfolio document and prints how many
// of a user's holdings would carry `independence-unverified` under the
// thin-pool gate versus under #1775 as merged.
//
// It does NOT re-price anything. Each holding already carries the two
// numbers the label rule reads — `fmvRung` (is this an exact-pool rung?)
// and `pricingSourceMeta.compsUsed` (the pool total the gate measures) —
// stamped by the last sanctioned reprice. Re-running the engine locally to
// recompute them would be a WRITE path against prod, which is forbidden;
// the persisted stamps are the record and they are what the label site
// itself reads on the next reprice.
//
// Env: COSMOS_CONNECTION_STRING, REPORT_USER_ID.
"use strict";

const { CosmosClient } = require("@azure/cosmos");

const USER_ID = process.env.REPORT_USER_ID;
if (!USER_ID) {
  console.error("REPORT_USER_ID is required");
  process.exit(1);
}
const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) {
  console.error("COSMOS_CONNECTION_STRING is required");
  process.exit(1);
}

// Mirrors isExactPoolRung (fmvRung.ts). Kept as a prefix test so a rung
// added later is still counted rather than silently dropped from the report.
const isExactPool = (r) => typeof r === "string" && r.startsWith("exact-pool");

// The measured rule under review: thin is compCount < 5.
const THIN_MAX = 5;

(async () => {
  const cont = new CosmosClient(CONN).database(process.env.COSMOS_DATABASE || "hobbyiq").container("portfolio");
  const { resources } = await cont.items
    .query({
      query: "SELECT * FROM c WHERE c.userId = @u",
      parameters: [{ name: "@u", value: USER_ID }],
    })
    .fetchAll();

  // CF-HOLDINGS-IS-A-MAP: walk the map, print the count, refuse on zero.
  const holdings = [];
  for (const doc of resources) {
    const h = doc.holdings;
    if (!h) continue;
    for (const item of Array.isArray(h) ? h : Object.values(h)) holdings.push(item);
  }
  if (holdings.length === 0) {
    console.error("REFUSING: zero holdings read for " + USER_ID);
    process.exit(1);
  }

  const rows = [];
  for (const hd of holdings) {
    const meta = hd.pricingSourceMeta || {};
    const rung = typeof hd.fmvRung === "string" ? hd.fmvRung : (typeof meta.method === "string" ? meta.method : null);
    const compsUsed = Number.isFinite(meta.compsUsed) ? Math.floor(meta.compsUsed) : null;
    const persistedLabels = Array.isArray(meta.labels) ? meta.labels.map((l) => l && l.code) : [];
    const selfAnchored = meta.selfAnchored || null;
    // The label site skips a FULLY self-anchored result: it is already told
    // the strongest version of the same thing.
    const wholeSelf = Boolean(selfAnchored && selfAnchored.own > 0 && selfAnchored.own === selfAnchored.total);
    const exact = isExactPool(rung);
    // #1775 as merged: every exact-pool result that is not wholly
    // self-anchored, because basis is `row-count` on all of them.
    const before = exact && !wholeSelf;
    // With the thin-pool gate: the same, AND the pool is thin.
    const after = before && (compsUsed === null || compsUsed < THIN_MAX);
    rows.push({
      id: hd.id,
      player: hd.playerName || hd.cardName || null,
      rung,
      compsUsed,
      wholeSelf,
      persistedLabels,
      before,
      after,
    });
  }

  const n = (f) => rows.filter(f).length;
  const summary = {
    userId: USER_ID,
    holdings: rows.length,
    exactPoolRungs: n((r) => isExactPool(r.rung)),
    nonExactPoolRungs: n((r) => !isExactPool(r.rung)),
    labelledBefore_1775AsMerged: n((r) => r.before),
    labelledAfter_thinPoolGate: n((r) => r.after),
    silencedByGate: n((r) => r.before && !r.after),
    thinPoolMaxSales: THIN_MAX,
    // Sanity: what is actually persisted on the holdings today. These were
    // written before this change, so they show the pre-gate world.
    persistedIndependenceLabelsToday: n((r) => r.persistedLabels.includes("independence-unverified")),
  };

  console.log(JSON.stringify({ summary, rows }, null, 2));
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
