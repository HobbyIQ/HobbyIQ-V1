#!/usr/bin/env node
/**
 * CF-SLUG-REDERIVATION (Drew, 2026-08-14). Phase 2 + 3 sweep: repair
 * sold_comps rows carrying a wrong slug, and collapse the non-canonical
 * sport vocabulary.
 *
 * Resumable by soldAt MONTH rather than a Cosmos continuation token.
 * Tokens are opaque, large, and expire; a month string survives a
 * killed run, a redeploy, and a week on the shelf. The cursor advances
 * only after a month completes end-to-end, so an interrupted run
 * re-does at most one month — and every write is idempotent, so redoing
 * one is free.
 *
 * ONLY-IMPROVE: a row whose current fields already pass slugGuard is
 * skipped outright — not re-derived, not compared against its title.
 * See slugRederivation.service.ts for why the rule is asymmetric.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/rederive-slugs.cjs
 *     [--apply] [--from=2019-01] [--to=2026-12] [--months=6]
 *     [--concurrency=16] [--status] [--reset]
 *
 * Defaults to DRY-RUN. Nothing is written without --apply.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

const CURSOR_ID = "rederive::cursor";
const CURSOR_PK = "_checkpoint";

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
/** Exclusive upper bound for a month: "2025-12" -> "2026-01". */
const monthEnd = (mo) => {
  let [y, m] = mo.split("-").map(Number);
  m++; if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
};

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const svc = require(path.join(backend, "dist/services/portfolioiq/slugRederivation.service.js"));
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const ck = db.container("ch_daily_sales"); // shares the _checkpoint partition

  const readCursor = async () => {
    try { const { resource } = await ck.item(CURSOR_ID, CURSOR_PK).read(); return resource || null; }
    catch (e) { if (e.code === 404 || e.statusCode === 404) return null; throw e; }
  };

  if (has("status")) {
    const c = await readCursor();
    console.log(c ? JSON.stringify(c, null, 2) : "no cursor — a run would start at --from");
    return 0;
  }
  if (has("reset")) {
    try { await ck.item(CURSOR_ID, CURSOR_PK).delete(); console.log("cursor cleared"); }
    catch (e) { if (e.code !== 404 && e.statusCode !== 404) throw e; console.log("no cursor"); }
    return 0;
  }

  const APPLY = has("apply");
  const FROM = arg("from", "2019-01");
  const TO = arg("to", new Date().toISOString().slice(0, 7));
  const MAX_MONTHS = Number(arg("months", "6"));
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));

  const prior = await readCursor();
  const all = monthsBetween(FROM, TO);
  const startIdx = prior?.lastCompletedMonth ? all.indexOf(prior.lastCompletedMonth) + 1 : 0;
  const todo = all.slice(startIdx, startIdx + MAX_MONTHS);

  console.log(`[rederive] mode=${APPLY ? "APPLY" : "DRY-RUN"} range=${FROM}..${TO} concurrency=${CONCURRENCY}`);
  console.log(`[rederive] cursor=${prior?.lastCompletedMonth ?? "(none)"} → processing ${todo.length} month(s): ${todo.join(", ") || "(none)"}`);
  if (todo.length === 0) { console.log("[rederive] range exhausted — nothing to do"); return 0; }

  const tot = { scanned: 0, untouched: 0, sportNormalized: 0, rederived: 0, unrecoverable: 0, written: 0, failed: 0 };
  const reasonTally = {};

  for (const mo of todo) {
    const from = `${mo}-01`, to = `${monthEnd(mo)}-01`;
    const t0 = Date.now();
    const m = { scanned: 0, untouched: 0, sportNormalized: 0, rederived: 0, unrecoverable: 0, written: 0, failed: 0 };

    const iter = sold.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.setName,
                     c.cardNumber, c.parallel, c.isAuto, c.title
              FROM c WHERE c.soldAt >= @from AND c.soldAt < @to`,
      parameters: [{ name: "@from", value: from }, { name: "@to", value: to }],
    }, { maxItemCount: 500 });

    const inflight = new Set();
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const row of resources || []) {
        m.scanned++;
        let res;
        try { res = svc.rederiveRow(row); }
        catch { m.unrecoverable++; continue; }

        if (res.action === "ok-untouched") { m.untouched++; continue; }
        if (res.action === "unrecoverable") {
          m.unrecoverable++;
          for (const r of res.reasons || []) reasonTally[r] = (reasonTally[r] || 0) + 1;
          continue;
        }
        if (res.action === "sport-normalized") m.sportNormalized++; else m.rederived++;
        if (!APPLY) continue;

        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        const patch = [{ op: "add", path: "/rederivedAt", value: new Date().toISOString() }];
        if (res.sport !== undefined) patch.push({ op: "add", path: "/sport", value: res.sport });
        if (res.hobbyiqCardId !== undefined) patch.push({ op: "add", path: "/hobbyiqCardId", value: res.hobbyiqCardId });
        if (res.action === "rederived") {
          if (res.cardYear !== undefined) patch.push({ op: "add", path: "/cardYear", value: res.cardYear });
          if (res.setName !== undefined) patch.push({ op: "add", path: "/setName", value: res.setName });
          if (res.cardNumber !== undefined) patch.push({ op: "add", path: "/cardNumber", value: res.cardNumber });
          if (res.parallel !== undefined) patch.push({ op: "add", path: "/parallel", value: res.parallel });
          if (res.isAuto !== undefined) patch.push({ op: "add", path: "/isAuto", value: res.isAuto });
        }
        // sold_comps is partitioned by /cardId. Getting this wrong is not
        // theoretical — the staging promoter passed the doc id as the
        // partition key and silently 404'd 15,170 patches in one run.
        const p = sold.item(row.id, row.cardId).patch(patch)
          .then(() => { m.written++; })
          .catch((e) => {
            m.failed++;
            if (m.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
    while (inflight.size > 0) await Promise.race([...inflight]);

    for (const k of Object.keys(m)) tot[k] += m[k];
    console.log(`  ${mo}: scanned=${m.scanned} untouched=${m.untouched} sportNorm=${m.sportNormalized} rederived=${m.rederived} unrecoverable=${m.unrecoverable} written=${m.written} failed=${m.failed} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    if (APPLY) {
      await ck.items.upsert({
        id: CURSOR_ID, card_id: CURSOR_PK,
        lastCompletedMonth: mo,
        updatedAt: new Date().toISOString(),
        cumulativeScanned: (prior?.cumulativeScanned || 0) + tot.scanned,
        cumulativeWritten: (prior?.cumulativeWritten || 0) + tot.written,
        ttl: -1, // ch_daily_sales defaults to 365d; the cursor must outlive it
      });
    }
  }

  console.log(`\n════════ SUMMARY (${APPLY ? "APPLIED" : "DRY-RUN"}) ════════`);
  console.log(`  scanned        : ${tot.scanned.toLocaleString()}`);
  console.log(`  ok-untouched   : ${tot.untouched.toLocaleString()}  (already pass the guard)`);
  console.log(`  sport-normalized: ${tot.sportNormalized.toLocaleString()}`);
  console.log(`  rederived      : ${tot.rederived.toLocaleString()}`);
  console.log(`  unrecoverable  : ${tot.unrecoverable.toLocaleString()}  (left unkeyed — absent beats wrong)`);
  console.log(`  written        : ${tot.written.toLocaleString()}${APPLY ? "" : "  (dry-run: nothing written)"}`);
  console.log(`  patch failed   : ${tot.failed.toLocaleString()}`);
  if (Object.keys(reasonTally).length) {
    console.log(`\n  why rows stayed unrecoverable:`);
    Object.entries(reasonTally).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([k, v]) => console.log(`    ${String(v).padStart(8)}  ${k}`));
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
