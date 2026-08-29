#!/usr/bin/env node
/**
 * audit-pool-identity.cjs -- is every sale in sold_comps filed under the
 * identity the doctrine says it should be? READ-ONLY. One scorecard.
 *
 * D14 probe #4 (Drew, 2026-08-29: "maybe we should audit the whole app
 * too?"). The pool is where every price comes from, so a sale filed under
 * the wrong key is a wrong price for every consumer downstream. Five
 * questions, each answered with a number, totals first and then per source:
 *
 *   1. cardId is not an hiq: slug   -- the partition key is a vendor id
 *      (CardHedge bubble id, Cardsight UUID). Expected for vendor sources
 *      today; the number says how far the pool is from "keyed by identity".
 *   2. hobbyiqCardId != cardId      -- two identities on one row. For
 *      vendor rows that is the vendor id vs our slug; for USER rows (cardId
 *      already hiq:) it means the sale was filed under one card and matched
 *      to another.
 *   3. CardHedge id shapes          -- the same CH card carries rows keyed
 *      `ch-daily::` (the daily export) AND `ch-comp::` (the comps API). Two
 *      keys for one sale is a duplicate in the pool; measured per card by
 *      reading whole partitions, and per (day, price) pair across shapes.
 *   4. user rows' keys              -- a user purchase/sale should be keyed
 *      by the eBay order id or item id. `holding::` is our stand-in; a null
 *      key falls back to `{source}::{cardId}::{soldAt}` and a re-submit
 *      makes a second row (D7b).
 *   5. verified rows whose parallel word is absent from the title -- a
 *      vendor tag stamped over a silent title (the Gold Refractor / base
 *      auto shape behind holding ca7a150b). Cosmos-side
 *      NOT CONTAINS(LOWER(c.title), @word) on the parallel's first token,
 *      Base excluded.
 *
 * COUNT + GROUP BY where the index can answer (sub-second at the 10k RU
 * floor); sampled TOP scans where it cannot (property-to-property compares).
 * A bad number is a finding, not a crash: exit 0 unless the probe itself
 * fails (exit 3). Never writes.
 *
 * Env: COSMOS_CONNECTION_STRING (required); LIMIT=2000 (rows sampled per
 *      source for the scans; 0/empty = default); CH_CARDS=50 (CardHedge
 *      cards per key shape whose partitions are read whole).
 */
"use strict";
const { CosmosClient } = require("@azure/cosmos");

const LIMIT = Number(process.env.LIMIT) > 0 ? Math.trunc(Number(process.env.LIMIT)) : 2000;
const CH_CARDS = Number(process.env.CH_CARDS) > 0 ? Math.trunc(Number(process.env.CH_CARDS)) : 50;
const USER_SOURCES = ["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"];
const f = (n) => Number(n ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + "%" : "-");
const cell = (a, b) => `${f(a)} (${pct(a, b)})`;
// Copied from identity-triangulation.cjs: sold_comps sits at its RU floor
// while the spine fleets run; every read retries on 429 instead of taking
// the whole measurement down.
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

const isHiq = (v) => typeof v === "string" && v.startsWith("hiq:");
/** The key shape of a sourceExternalId. */
function keyShape(id) {
  if (id == null || String(id).trim() === "") return "null (timestamp-keyed id)";
  const s = String(id);
  if (s.startsWith("holding::")) return "holding::";
  if (/^\d{2}-\d{5}-\d{5}$/.test(s)) return "ebay order id";
  if (/^\d{11,14}$/.test(s)) return "ebay item id";
  const m = /^([a-z][a-z0-9-]*)::/i.exec(s);
  return m ? `${m[1]}::` : "other";
}
/** First word of a parallel name, lower-cased; null for Base / empty. */
function parallelWord(p) {
  const s = String(p ?? "").trim().toLowerCase();
  if (!s || s === "base" || s === "[base]") return null;
  const w = s.split(/[\s/]+/)[0];
  return w.length >= 3 ? w : null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const q = async (query, parameters = []) => (await retry(() => pool.items.query({ query, parameters }, { maxItemCount: 1000 }).fetchAll())).resources;
  const count = async (where, parameters = []) => Number((await q(`SELECT VALUE COUNT(1) FROM c ${where}`, parameters))[0] ?? 0);
  const bySource = async (where, parameters = []) => {
    const rows = await q(`SELECT c.source, COUNT(1) AS n FROM c ${where} GROUP BY c.source`, parameters);
    return new Map(rows.map((r) => [String(r.source ?? "(none)"), Number(r.n)]));
  };
  const t0 = Date.now();

  // ── 1. discover the sources, then the index-served counts ───────────────
  const total = await bySource("");
  const sources = [...total.keys()].sort((a, b) => (total.get(b) ?? 0) - (total.get(a) ?? 0));
  const grand = [...total.values()].reduce((a, b) => a + b, 0);
  const hiqCard = await bySource("WHERE STARTSWITH(c.cardId, 'hiq:')");
  const slugged = await bySource("WHERE IS_DEFINED(c.hobbyiqCardId) AND STARTSWITH(c.hobbyiqCardId, 'hiq:')");
  const verified = await bySource("WHERE c.verifiedByUser = true");
  console.log(`audit-pool-identity  READ-ONLY  sold_comps ${f(grand)} rows, ${sources.length} sources  sample=${f(LIMIT)}/source  (counts ${Date.now() - t0}ms)\n`);

  // ── 2. sampled scans: what the index cannot compare ─────────────────────
  const sampled = new Map();
  for (const s of sources) {
    const rows = await q(`SELECT TOP ${LIMIT} c.cardId, c.hobbyiqCardId, c.sourceExternalId FROM c WHERE c.source = @s`, [{ name: "@s", value: s }]);
    const st = { n: rows.length, mismatch: 0, bothDefinedHiqMismatch: 0, notHiq: 0, noSlug: 0, shapes: new Map() };
    for (const r of rows) {
      if (!isHiq(r.cardId)) st.notHiq++;
      if (!isHiq(r.hobbyiqCardId)) st.noSlug++;
      if (r.cardId && r.hobbyiqCardId && r.cardId !== r.hobbyiqCardId) { st.mismatch++; if (isHiq(r.cardId) && isHiq(r.hobbyiqCardId)) st.bothDefinedHiqMismatch++; }
      const k = keyShape(r.sourceExternalId); st.shapes.set(k, (st.shapes.get(k) ?? 0) + 1);
    }
    sampled.set(s, st);
  }

  // ── 3. verified rows: parallel word vs title, Cosmos-side ───────────────
  const verifiedTotal = [...verified.values()].reduce((a, b) => a + b, 0);
  const vp = await q("SELECT c.source, c.parallel, COUNT(1) AS n FROM c WHERE c.verifiedByUser = true GROUP BY c.source, c.parallel");
  const absent = new Map(), judged = new Map(), noTitle = new Map(), offenders = [];
  for (const r of vp) {
    const w = parallelWord(r.parallel);
    if (!w) continue;
    const s = String(r.source ?? "(none)");
    const params = [{ name: "@s", value: s }, { name: "@p", value: r.parallel }, { name: "@w", value: w }];
    const titled = await count("WHERE c.verifiedByUser = true AND c.source = @s AND c.parallel = @p AND IS_DEFINED(c.title) AND c.title != null", params);
    const missing = titled > 0 ? await count("WHERE c.verifiedByUser = true AND c.source = @s AND c.parallel = @p AND IS_DEFINED(c.title) AND c.title != null AND NOT CONTAINS(LOWER(c.title), @w)", params) : 0;
    judged.set(s, (judged.get(s) ?? 0) + titled);
    absent.set(s, (absent.get(s) ?? 0) + missing);
    noTitle.set(s, (noTitle.get(s) ?? 0) + (Number(r.n) - titled));
    if (missing > 0) offenders.push({ source: s, parallel: r.parallel, word: w, missing, titled });
  }
  const absentTotal = [...absent.values()].reduce((a, b) => a + b, 0);
  const judgedTotal = [...judged.values()].reduce((a, b) => a + b, 0);
  const noTitleTotal = [...noTitle.values()].reduce((a, b) => a + b, 0);

  // ── TOTALS ──────────────────────────────────────────────────────────────
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const sampledN = sum(new Map([...sampled].map(([k, v]) => [k, v.n])));
  const sampledMismatch = sum(new Map([...sampled].map(([k, v]) => [k, v.mismatch])));
  console.log("TOTALS");
  console.log(`  cardId not an hiq: slug                     ${cell(grand - sum(hiqCard), grand)}`);
  console.log(`  hobbyiqCardId missing / not hiq:            ${cell(grand - sum(slugged), grand)}`);
  console.log(`  cardId != hobbyiqCardId (sampled)           ${cell(sampledMismatch, sampledN)}   sample ${f(sampledN)}`);
  console.log(`  verifiedByUser rows                         ${f(verifiedTotal)}`);
  console.log(`  verified, parallel word absent from title   ${cell(absentTotal, judgedTotal)}   (Base excluded; ${f(noTitleTotal)} verified rows have no title)`);

  // ── PER SOURCE ──────────────────────────────────────────────────────────
  console.log("\nPER SOURCE");
  console.log(`  ${"source".padEnd(20)} ${"rows".padStart(12)}   ${"cardId!=hiq:".padEnd(22)} ${"hobbyiq missing".padEnd(22)} ${"cardId!=hobbyiq (sample)".padEnd(26)} ${"verified".padStart(9)}   ${"parallel word absent".padEnd(22)}`);
  for (const s of sources) {
    const n = total.get(s) ?? 0, st = sampled.get(s);
    console.log(`  ${s.padEnd(20)} ${f(n).padStart(12)}   ${cell(n - (hiqCard.get(s) ?? 0), n).padEnd(22)} ${cell(n - (slugged.get(s) ?? 0), n).padEnd(22)} ${(st ? `${cell(st.mismatch, st.n)} of ${f(st.n)}` : "-").padEnd(26)} ${f(verified.get(s) ?? 0).padStart(9)}   ${cell(absent.get(s) ?? 0, judged.get(s) ?? 0)}`);
  }
  console.log("\n  sourceExternalId key shapes (sampled):");
  for (const s of sources) {
    const st = sampled.get(s);
    if (!st || !st.n) continue;
    console.log(`    ${s.padEnd(20)} ${[...st.shapes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${cell(n, st.n)}`).join(" | ")}`);
  }
  if (offenders.length) {
    offenders.sort((a, b) => b.missing - a.missing);
    console.log("\n  verified parallels whose first word is absent from the title (top 12):");
    for (const o of offenders.slice(0, 12)) console.log(`    ${o.source.padEnd(20)} ${String(o.parallel).padEnd(28)} word="${o.word}"  ${f(o.missing)} / ${f(o.titled)}`);
  }

  // ── CARDHEDGE ID SHAPES ─────────────────────────────────────────────────
  if (total.has("cardhedge")) {
    const chTotal = total.get("cardhedge");
    const daily = await count("WHERE c.source = 'cardhedge' AND STARTSWITH(c.sourceExternalId, 'ch-daily::')");
    const comp = await count("WHERE c.source = 'cardhedge' AND STARTSWITH(c.sourceExternalId, 'ch-comp::')");
    console.log(`\nCARDHEDGE ID SHAPES  (${f(chTotal)} rows)`);
    console.log(`  ch-daily:: keyed                            ${cell(daily, chTotal)}`);
    console.log(`  ch-comp::  keyed                            ${cell(comp, chTotal)}`);
    console.log(`  other                                       ${cell(chTotal - daily - comp, chTotal)}`);
    // per CH card: whole partitions, CH_CARDS cards found from each shape
    const ids = new Set();
    for (const prefix of ["ch-daily::", "ch-comp::"]) {
      const rows = await q(`SELECT DISTINCT TOP ${CH_CARDS} c.cardId FROM c WHERE c.source = 'cardhedge' AND STARTSWITH(c.sourceExternalId, @p) AND NOT STARTSWITH(c.cardId, 'hiq:')`, [{ name: "@p", value: prefix }]);
      for (const r of rows) if (r.cardId) ids.add(r.cardId);
    }
    let bothShapes = 0, rowsRead = 0, dupPairs = 0, pairsSeen = 0;
    for (const id of ids) {
      const rows = await q("SELECT TOP 5000 c.sourceExternalId, c.soldAt, c.price FROM c WHERE c.cardId = @id AND c.source = 'cardhedge'", [{ name: "@id", value: id }]);
      rowsRead += rows.length;
      const byPair = new Map();
      for (const r of rows) {
        const shape = keyShape(r.sourceExternalId);
        const pair = `${String(r.soldAt ?? "").slice(0, 10)}|${Math.round(Number(r.price) * 100)}`;
        if (!byPair.has(pair)) byPair.set(pair, new Set());
        byPair.get(pair).add(shape);
      }
      const shapes = new Set([...byPair.values()].flatMap((s) => [...s]));
      if (shapes.size > 1) bothShapes++;
      for (const s of byPair.values()) { pairsSeen++; if (s.size > 1) dupPairs++; }
    }
    console.log(`  CH cards read whole                         ${f(ids.size)}   (${f(rowsRead)} rows)`);
    console.log(`  cards carrying BOTH key shapes              ${cell(bothShapes, ids.size)}`);
    console.log(`  (day, price) pairs present under 2 shapes   ${cell(dupPairs, pairsSeen)}   <- the same sale keyed twice`);
  }

  // ── USER ROWS: what keys them ───────────────────────────────────────────
  const present = USER_SOURCES.filter((s) => total.has(s));
  if (present.length) {
    console.log(`\nUSER ROWS  (${present.map((s) => `${s} ${f(total.get(s))}`).join(", ")})`);
    for (const s of present) {
      const rows = await q(`SELECT TOP ${LIMIT} c.sourceExternalId, c.cardId, c.hobbyiqCardId FROM c WHERE c.source = @s`, [{ name: "@s", value: s }]);
      const shapes = new Map();
      let mismatch = 0;
      for (const r of rows) {
        const k = keyShape(r.sourceExternalId); shapes.set(k, (shapes.get(k) ?? 0) + 1);
        if (r.cardId && r.hobbyiqCardId && r.cardId !== r.hobbyiqCardId) mismatch++;
      }
      const parts = [...shapes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${cell(n, rows.length)}`);
      console.log(`  ${s.padEnd(20)} keyed by: ${parts.join(" | ")}`);
      console.log(`  ${"".padEnd(20)} cardId != hobbyiqCardId ${cell(mismatch, rows.length)}   <- filed under one card, matched to another`);
    }
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s  (read-only; nothing written)`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
