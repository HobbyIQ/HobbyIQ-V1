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
 *   MODE=shapes  re-runs the spec's shape table (grade digit / slash / bare
 *                print run / 1st / LOT / hash-with-no-number) so before and
 *                after are the same measurement.
 *
 * Every mode reports by `source`, because the writers are the point: a shape
 * that is 90% cardhedge is a converter bug and a shape that is 90% tca-ebay is
 * an ingest bug, and the aggregate hides which.
 *
 * This script NEVER writes. There is no APPLY path in it at all.
 *
 * Env: COSMOS_CONNECTION_STRING; MODE; MONTHS; SINCE=YYYY-MM; SLOT/SLOTS
 *      (hash of cardId, for running the month walk in parallel); LIMIT;
 *      RUN_MINUTES=140.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { judgeCardNumber, explicitTitleCardNumber, isTcgVertical } =
  require(path.join(__dirname, "..", "dist", "services", "portfolioiq", "cardNumberIntegrity.js"));

const MODE = String(process.env.MODE || "grade").trim().toLowerCase();
const MONTHS = Number(process.env.MONTHS ?? 0);
const SINCE = String(process.env.SINCE || "2018-01");
const SLOT = Number(process.env.SLOT ?? 0), SLOTS = Math.max(1, Number(process.env.SLOTS ?? 1));
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
  // the row is keyed to.
  if (stated && num && stated.toUpperCase() !== num.toUpperCase()) shapes.push("strict-disagreement");
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
      ["no cardNumber, '#' in title", `${SELECT} WHERE NOT IS_DEFINED(c.cardNumber) AND CONTAINS(c.title, '#')`],
      ["4-digit cardNumber", `${SELECT} WHERE LENGTH(c.cardNumber) = 4 AND IS_DEFINED(c.title)`],
    ];
    for (const [label, q] of slices) {
      if (Date.now() - STARTED > RUN_MS) { out.stopped = "budget"; break; }
      const n = await walk(pool, q, [], label, out);
      console.log(`  ${label.padEnd(38)} scanned ${f(n)}`);
    }
  } else {
    console.error(`FATAL: MODE must be one of grade | months | shapes (got "${MODE}")`);
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
  if (out.stopped === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (out.stopped === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\nREAD ONLY — nothing written.`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
