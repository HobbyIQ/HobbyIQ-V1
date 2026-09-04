#!/usr/bin/env node
/**
 * measure-card-number-integrity.cjs -- READ ONLY. The D28 numbers.
 *
 * The strict measure the spec left to the builder: how many pool rows carry a
 * title that states an explicit `#X` DIFFERENT from the stored `cardNumber`.
 * The full-pool version of that query timed out at 10 minutes on 2026-08-30,
 * so this walks it in bounded slices and reports each one:
 *
 *   MODE=grade   the grade-digit slice first -- cardNumber IN ('8','9','10'),
 *                which is where Harrison's holding came from. Small enough to
 *                finish, and the number Drew asked for first.
 *   MODE=months  the whole pool, one `_ts` month per query, oldest to newest.
 *                MONTHS=6 walks the last six; MONTHS=0 walks every month back
 *                to SINCE (default 2018-01).
 *   MODE=catalog-year  card_catalog rows whose cardNumber IS the set year --
 *                by SOURCE and by AUTHORITY, because a checklist-backed one is
 *                a converter bug to fix and a vendor one is a retire.
 *   MODE=shapes  re-runs the spec's shape table (grade digit / slash / bare
 *                print run / 1st / LOT / hash-with-no-number) so before and
 *                after are the same measurement.
 *
 * Every mode reports by `source`, because the writers are the point: a shape
 * that is 90% cardhedge is a converter bug and a shape that is 90% tca-ebay is
 * an ingest bug, and the aggregate hides which.
 *
 * This script NEVER writes. There is no APPLY path in it at all, and it does
 * NOT print the runner's budget marker: nothing relaunches a read-only walk,
 * so claiming the relaunch contract would be a lie the invariant test
 * (everyWriteJobReconciles) rightly catches. It says the clock ran out and
 * that its numbers are partial instead.
 *
 * Env: COSMOS_CONNECTION_STRING; MODE; MONTHS; SINCE=YYYY-MM; SLOT/SLOTS
 *      (hash of cardId, for running the month walk in parallel); LIMIT;
 *      RUN_MINUTES=140.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { catalogAuthorityOf } = require(path.join(__dirname, "..", "dist", "services", "catalog", "catalogAuthority.service.js"));
const { judgeCardNumber, explicitTitleCardNumber, isTcgVertical, sameCardNumber } =
  require(path.join(__dirname, "..", "dist", "services", "portfolioiq", "cardNumberIntegrity.js"));

const MODE = String(process.env.MODE || "grade").trim().toLowerCase();
const MONTHS = Number(process.env.MONTHS ?? 0);
const SINCE = String(process.env.SINCE || "2018-01");
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "measure-card-number-integrity" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const LIMIT = Number(process.env.LIMIT || 0);
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString("en-US");
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

/** A tally that reports by source and keeps a handful of examples. */
function tally() {
  return { total: 0, bySource: new Map(), samples: [] };
}
function bump(t, source, sample) {
  t.total++;
  t.bySource.set(source, (t.bySource.get(source) ?? 0) + 1);
  if (sample && t.samples.length < 6) t.samples.push(sample);
}
function printTally(label, t, indent = "  ") {
  console.log(`${indent}${label.padEnd(46)} ${f(t.total).padStart(12)}`);
  for (const [s, n] of [...t.bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${indent}    ${String(s).padEnd(30)} ${f(n).padStart(10)}`);
  }
  for (const s of t.samples) console.log(`${indent}    e.g. ${s}`);
}

/** One row's verdict. Returns the shape names it belongs to. */
function classify(r) {
  const num = String(r.cardNumber ?? "").trim();
  const title = String(r.title ?? "");
  const tcg = isTcgVertical(r.sport);
  const shapes = [];
  const stated = explicitTitleCardNumber(title, { isTcg: tcg });
  // THE STRICT MEASURE: the title states an explicit #X and it is not what
  // the row is keyed to. "BCP-10" and "#BCP10" are ONE card number spelled two
  // ways -- 1.13% of the last six hours of live rows -- so the comparison is
  // on identity, not on punctuation (sameCardNumber).
  if (stated && num && !sameCardNumber(stated, num)) shapes.push("strict-disagreement");
  if (stated && !num) shapes.push("hash-in-title-no-number");
  if (num) {
    const v = judgeCardNumber(num, title, { isTcg: tcg });
    if (v.rejected) shapes.push(v.rejected);
  }
  return { shapes, stated, num, title };
}

async function walk(pool, query, params, label, out) {
  let token, scanned = 0, otherSlot = 0;
  do {
    if (Date.now() - STARTED > RUN_MS) { out.stopped = "budget"; break; }
    const page = await retry(() => pool.items
      .query({ query, parameters: params }, { maxItemCount: 2000, continuationToken: token, maxDegreeOfParallelism: 8 })
      .fetchNext());
    token = page.continuationToken;
    for (const r of page.resources ?? []) {
      if (SLOTS > 1 && shardOf(r.cardId ?? "") !== SLOT) { otherSlot++; continue; }
      scanned++;
      const c = classify(r);
      const src = String(r.source ?? "(none)");
      for (const shape of c.shapes) {
        out.shapes[shape] = out.shapes[shape] ?? tally();
        bump(out.shapes[shape], src,
          shape === "strict-disagreement"
            ? `cardNumber="${c.num}" title says #${c.stated} :: ${c.title.slice(0, 96)}`
            : `cardNumber="${c.num}" :: ${c.title.slice(0, 96)}`);
      }
    }
    if (scanned && scanned % 100000 < 2000) process.stderr.write(`\r  ${label}: scanned ${f(scanned)}   `);
    if (LIMIT && scanned >= LIMIT) { out.stopped = "limit"; break; }
  } while (token);
  process.stderr.write("\n");
  out.scanned += scanned;
  out.otherSlot += otherSlot;
  return scanned;
}

function monthsBack() {
  const out = [];
  const [sy, sm] = SINCE.split("-").map(Number);
  const now = new Date();
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  while (y > sy || (y === sy && m >= sm)) {
    out.push([y, m]);
    m--; if (m === 0) { m = 12; y--; }
    if (MONTHS && out.length >= MONTHS) break;
  }
  return out;
}
const tsOf = (y, m) => Math.floor(Date.UTC(y, m - 1, 1) / 1000);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");

  console.log(`measure-card-number-integrity  MODE=${MODE}  slot ${SLOT}/${SLOTS}  READ ONLY (this script has no write path)  budget ${RUN_MS / 60000}m`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const out = { scanned: 0, otherSlot: 0, shapes: {}, stopped: null };
  const SELECT = "SELECT c.cardNumber, c.title, c.source, c.sport, c.cardId FROM c";

  if (MODE === "grade") {
    // The slice Harrison's holding came from. Small enough to finish, and the
    // one the spec asked for first.
    console.log(`\nslice: cardNumber IN ('8','9','10')`);
    await walk(pool,
      `${SELECT} WHERE c.cardNumber IN ('8','9','10') AND IS_DEFINED(c.title)`,
      [], "grade-slice", out);
  } else if (MODE === "months") {
    const months = monthsBack();
    console.log(`\nslices: ${months.length} _ts months, newest first (SINCE=${SINCE}${MONTHS ? `, MONTHS=${MONTHS}` : ""})`);
    for (const [y, m] of months) {
      if (Date.now() - STARTED > RUN_MS) { out.stopped = "budget"; break; }
      const lo = tsOf(y, m), hi = tsOf(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
      const n = await walk(pool,
        `${SELECT} WHERE c._ts >= @lo AND c._ts < @hi AND IS_DEFINED(c.title) AND IS_DEFINED(c.cardNumber)`,
        [{ name: "@lo", value: lo }, { name: "@hi", value: hi }],
        `${y}-${String(m).padStart(2, "0")}`, out);
      console.log(`  ${y}-${String(m).padStart(2, "0")}  scanned ${f(n).padStart(10)}  running strict ${f(out.shapes["strict-disagreement"]?.total ?? 0)}`);
    }
  } else if (MODE === "shapes") {
    // The spec's table, re-measured through the guard rather than through six
    // hand-written WHERE clauses -- so before and after are the same question.
    console.log(`\nslices: the measured shapes (grade digit / slash / 1st / LOT / hash-no-number)`);
    const slices = [
      ["grade digit", `${SELECT} WHERE c.cardNumber IN ('8','9','10') AND IS_DEFINED(c.title)`],
      ["slash in cardNumber", `${SELECT} WHERE CONTAINS(c.cardNumber, '/') AND IS_DEFINED(c.title)`],
      ["cardNumber 1 or 2 (ordinal / lot)", `${SELECT} WHERE c.cardNumber IN ('1','2') AND IS_DEFINED(c.title)`],
      ["no cardNumber, '#' in title", `${SELECT} WHERE (NOT IS_DEFINED(c.cardNumber) OR IS_NULL(c.cardNumber) OR c.cardNumber = '') AND CONTAINS(c.title, '#')`],
      ["4-digit cardNumber", `${SELECT} WHERE LENGTH(c.cardNumber) = 4 AND IS_DEFINED(c.title)`],
    ];
    for (const [label, q] of slices) {
      if (Date.now() - STARTED > RUN_MS) { out.stopped = "budget"; break; }
      const n = await walk(pool, q, [], label, out);
      console.log(`  ${label.padEnd(38)} scanned ${f(n)}`);
    }
  } else if (MODE === "catalog-year") {
    // card_catalog, not the pool: rows whose cardNumber IS the set's year
    // (`hiq:baseball:2018:topps-chrome:2018:gold-refractor:no-auto`). The
    // question is not how many there are, it is WHOSE they are -- a
    // checklist-backed one would be a converter bug to fix, and a vendor or
    // sale-minted one is a retire.
    const cat = db.container("card_catalog");
    const bySource = new Map(), byAuthority = new Map(), samples = [];
    let scanned = 0, hits = 0, token;
    console.log(`\nslice: card_catalog rows with a 4-character cardNumber, kept when it equals the row's year`);
    do {
      if (Date.now() - STARTED > RUN_MS) { out.stopped = "budget"; break; }
      const page = await retry(() => cat.items
        .query("SELECT c.id, c.source, c.cardNumber, c.year, c.gradeTier, c.checklistBacking FROM c WHERE LENGTH(c.cardNumber) = 4", { maxItemCount: 1000, continuationToken: token, maxDegreeOfParallelism: 8 })
        .fetchNext());
      token = page.continuationToken;
      for (const r of page.resources ?? []) {
        scanned++;
        if (String(r.cardNumber) !== String(r.year)) continue;
        hits++;
        const src = String(r.source ?? "(none)");
        bySource.set(src, (bySource.get(src) ?? 0) + 1);
        const auth = catalogAuthorityOf(src);
        byAuthority.set(auth, (byAuthority.get(auth) ?? 0) + 1);
        if (samples.length < 8) samples.push(`${r.id}   source=${src}  authority=${auth}${r.gradeTier ? `  gradeTier=${r.gradeTier}` : ""}${r.checklistBacking ? `  checklistBacking=${r.checklistBacking}` : ""}`);
      }
      if (scanned && scanned % 50000 < 1000) process.stderr.write(`\r  catalog-year: scanned ${f(scanned)}  hits ${f(hits)}   `);
    } while (token);
    process.stderr.write("\n");
    console.log(`\n${"=".repeat(72)}`);
    console.log(`4-character cardNumber rows scanned  ${f(scanned)}`);
    console.log(`cardNumber EQUALS the year           ${f(hits)}`);
    console.log(`\n  by authority (checklist here would be a CONVERTER BUG, not a retire):`);
    for (const [k, n] of [...byAuthority.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(30)} ${f(n).padStart(10)}`);
    console.log(`\n  by source:`);
    for (const [k, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(44)} ${f(n).padStart(10)}`);
    console.log(`\n  samples:`);
    for (const x of samples) console.log(`    ${x}`);
    if (out.stopped === "budget") console.log(`\nthe ${RUN_MS / 60000}-minute clock ran out before the walk finished. This script is READ ONLY and NOTHING relaunches it — re-run with a larger RUN_MINUTES, or split it across SLOTS. The numbers above are a PARTIAL count.`);
    console.log(`\nREAD ONLY — nothing written.`);
    return;
  } else {
    console.error(`FATAL: MODE must be one of grade | months | shapes | catalog-year (got "${MODE}")`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`rows scanned            ${f(out.scanned)}${SLOTS > 1 ? `   (+${f(out.otherSlot)} in other slots)` : ""}`);
  const strict = out.shapes["strict-disagreement"] ?? tally();
  console.log(`\nTHE STRICT MEASURE -- the title states an explicit #X that is NOT the stored cardNumber`);
  printTally("strict disagreements", strict);
  console.log(`\nthe other shapes, through the same guard:`);
  for (const [name, t] of Object.entries(out.shapes)) {
    if (name === "strict-disagreement") continue;
    printTally(name, t);
  }
  if (out.stopped === "budget") console.log(`\nthe ${RUN_MS / 60000}-minute clock ran out before the walk finished. This script is READ ONLY and NOTHING relaunches it — re-run with a larger RUN_MINUTES, or split it across SLOTS. The numbers above are a PARTIAL count.`);
  else if (out.stopped === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\nREAD ONLY — nothing written.`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
