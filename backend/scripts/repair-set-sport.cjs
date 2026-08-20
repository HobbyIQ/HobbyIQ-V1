#!/usr/bin/env node
/**
 * CF-SET-SPORT-REPAIR (Drew, 2026-08-20). Applies the set-level sport verdict
 * measured by audit-set-sport.
 *
 * DEFAULTS TO DRY-RUN. Nothing is written without --apply.
 *
 * ── THE GATES ARE NOT DEFINED HERE ──────────────────────────────────────────
 *
 * They come from scripts/lib/setSportAuthority.cjs, shared with the audit. An
 * audit that measures with different gates than the repair applies is not an
 * audit of that repair, and this codebase has paid for that lesson twice: five
 * copies of "is this a checklist source" drifted far enough to flip 51
 * card-number prefixes between repair and blocked, and a setKey rule with two
 * implementations produced the fragmentation merged earlier today.
 *
 * ── WHY THE FIRST VERSION OF THIS MEASUREMENT WAS WRONG ─────────────────────
 *
 * The audit initially reported 8.69% (1,243,562 comps) with its two largest
 * moves BACKWARDS. It ranked only checklist-backed rows at 0.95 dominance, but
 * dominance over a single-sport sample is always 1.0 — and we hold no checklist
 * for Donruss BASEBALL 2024, so a football-only checklist made the whole setKey
 * "football" and condemned 5,503 real baseball rows. The corrected figure is
 * 195,440 (1.36%).
 *
 * If this script's dry run does not reproduce the audit's number, the gates
 * have diverged and NEITHER result should be trusted. That check is the point
 * of sharing the module.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * ONLY EVER ACT ON A POSITIVE ANSWER. A row is rewritten only when a
 * checklist-backed, single-sport set names a DIFFERENT sport and the title veto
 * does not object. A refusal leaves the row exactly as it is — we never clear a
 * sport to express doubt, which would trade a wrong slug for a broken one.
 *
 * REVERSIBLE. `sportBefore` and `hobbyiqCardIdBefore` record the originals, the
 * same fields every prior repair in this directory uses, so one query undoes
 * the pass.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-set-sport.cjs [--apply] [--limit=N] [--concurrency=16]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { canAdjudicate } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { buildAuthority, judgeComp } = require("./lib/setSportAuthority.cjs");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const APPLY = has("apply");
const LIMIT = Number(arg("limit", "0")) || Infinity;
const CONCURRENCY = Number(arg("concurrency", "16"));
const TOP = Number(arg("top", "25"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    const legStart = Date.now();
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e && e.code !== 429 && e.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, ((e && e.retryAfterInMs) || 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 250000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES || Date.now() - legStart > LEG_MAX_MS) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

/** Swap segment 1 of `hiq:sport:year:setKey:...`, leaving every other segment
 *  byte-identical. Rebuilding the whole slug would risk changing more than the
 *  one field this repair is allowed to touch. */
function reSportSlug(slug, toSport) {
  const p = String(slug).split(":");
  if (p.length < 7 || p[0] !== "hiq") return null;
  p[1] = toSport;
  return p.join(":");
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[repair-set-sport] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}\n`);

  // ── 1. Authority, from the SHARED gates. ────────────────────────────────
  const checklistCounts = new Map(), allCounts = new Map();
  await scanAll("card_catalog", {
    query: `SELECT c.year, c.setKey, c.sport, c.source FROM c
             WHERE IS_DEFINED(c.setKey) AND IS_DEFINED(c.sport) AND IS_DEFINED(c.year)`,
    parameters: [],
  }, (r) => {
    const k = `${r.year}|${r.setKey}`;
    let a = allCounts.get(k);
    if (!a) allCounts.set(k, (a = new Map()));
    a.set(r.sport, (a.get(r.sport) ?? 0) + 1);
    if (!canAdjudicate(r.source)) return;
    let m = checklistCounts.get(k);
    if (!m) checklistCounts.set(k, (m = new Map()));
    m.set(r.sport, (m.get(r.sport) ?? 0) + 1);
  }, "catalog");

  const { authority, skipped } = buildAuthority(checklistCounts, allCounts);
  console.log(`(year, setKey) usable as authority : ${authority.size.toLocaleString()}`);
  console.log(`  skipped mixed / cross-sport / thin: ${skipped.mixed} / ${skipped.crossSport} / ${skipped.thin}\n`);

  // ── 2. Judge every comp with the SHARED decision. ───────────────────────
  const targets = [];
  const tally = { agree: 0, "no-authority": 0, "vetoed-title-backs-slug": 0, "vetoed-title-backs-neither": 0, contradict: 0, unslugged: 0 };
  const moves = new Map();
  await scanAll("sold_comps", {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.title, c.price FROM c
             WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId)`,
    parameters: [],
  }, (r) => {
    const p = String(r.hobbyiqCardId).split(":");
    if (p.length < 7) { tally.unslugged++; return; }
    const [, slugSport, year, setKey] = p;
    if (!slugSport || !year || !setKey) { tally.unslugged++; return; }
    const v = judgeComp({ slugSport, year, setKey, title: r.title }, authority);
    tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
    if (v.verdict !== "contradict") return;
    const to = reSportSlug(r.hobbyiqCardId, v.to);
    // A slug we cannot rewrite safely is REFUSED, not forced.
    if (!to) return;
    moves.set(`${v.from} -> ${v.to}`, (moves.get(`${v.from} -> ${v.to}`) ?? 0) + 1);
    if (targets.length < LIMIT) {
      targets.push({ id: r.id, cardId: r.cardId, from: r.hobbyiqCardId, to, fromSport: v.from, toSport: v.to, title: r.title, price: r.price, player: r.playerName });
    }
  }, "comps");

  const judged = Object.values(tally).reduce((s, n) => s + n, 0);
  const pc = (n) => `${((n / Math.max(judged, 1)) * 100).toFixed(2)}%`;
  console.log(`comps judged        : ${judged.toLocaleString()}`);
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k.padEnd(26)}: ${n.toLocaleString()}  ${pc(n)}`);
  console.log(`\nrewritable targets  : ${targets.length.toLocaleString()}\n`);
  console.log("moves:");
  for (const [k, n] of [...moves].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`   ${String(n).padStart(8)}  ${k}`);
  console.log("\nsample:");
  for (const t of targets.slice(0, 8)) {
    console.log(`   $${String(t.price).padEnd(8)} ${String(t.player || "?").slice(0, 22).padEnd(23)} ${t.fromSport} -> ${t.toSport}`);
    console.log(`        ${String(t.title || "").slice(0, 78)}`);
    console.log(`        ${t.from}\n     -> ${t.to}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN. Nothing written.");
    console.log("Before applying, confirm this `contradict` count matches audit-set-sport.");
    console.log("A divergence means the shared gates are not actually shared.");
    return 0;
  }

  // ── 3. Apply. ───────────────────────────────────────────────────────────
  const sold = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  let ok = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const t = targets[i++];
      try {
        await sold.item(t.id, t.cardId).patch([
          { op: "add", path: "/sportBefore", value: t.fromSport },
          { op: "add", path: "/hobbyiqCardIdBefore", value: t.from },
          { op: "add", path: "/sport", value: t.toSport },
          { op: "add", path: "/hobbyiqCardId", value: t.to },
          { op: "add", path: "/setSportRepairedAt", value: new Date().toISOString() },
        ]);
        ok++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.warn(`   patch failed ${t.id}: ${String(e.message).slice(0, 90)}`);
      }
      if ((ok + failed) % 5000 === 0) process.stderr.write(`\r  applied ${ok + failed}/${targets.length}   `);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");
  console.log(`\napplied: ${ok.toLocaleString()}   failed: ${failed.toLocaleString()}`);
  console.log("Reversible: sportBefore + hobbyiqCardIdBefore carry the originals.");
  return failed ? 1 : 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
