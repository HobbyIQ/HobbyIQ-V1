#!/usr/bin/env node
/**
 * repair-truncated-card-year.cjs -- LANE 4 (c), 2026-08-31.
 *
 * THE POPULATION. 2,980 sold_comps rows carry a THREE-DIGIT cardYear, measured
 * read-only 2026-08-31:
 *
 *     201  1,234      202    163
 *     197    947      199    143
 *     198    458      200     35
 *
 * Every one is the real year with its last digit gone: "2016 Panini Donruss
 * Football" filed under 201, "1978 Kellogg's 3-D Super Stars Baseball" under
 * 197. All 2,980 are source=cardhedge, and the 1,040 ch_daily_sales rows
 * behind them carry the same truncated value across 146 distinct card_ids.
 *
 * WHERE IT COMES FROM. Not our CSV parse -- on every affected row every OTHER
 * field is intact (player, number, card_set, grade, grader, group, the
 * timestamps), which is not what a shifted column looks like, and toInt is
 * faithful. The value arrives truncated from the vendor, consistently per
 * card_id: not one of the 146 has both a truncated and a full-year row. The
 * INGEST-SIDE guard closes in the same PR (reconcileYear in
 * cardhedgeDailyExport.client.ts), or the next daily export re-imports the
 * same defect. This script repairs what is already stored.
 *
 * THE EVIDENCE. setName (falling back to the sale title) names the year, and
 * on all 2,980 rows the stored value is exactly a PREFIX of the year the text
 * states -- zero disagreements. So the repair reconciles against evidence the
 * row already carries; it never guesses a year, and a row whose text supports
 * no year is REPORTED and left alone.
 *
 * TWO SHAPES, and they are not the same operation.
 *   PATCH  -- the 2,523 rows whose hobbyiqCardId does NOT embed the year.
 *             cardYear is a field on the row; the identity does not move. The
 *             row is patched in place.
 *   RE-KEY -- the 457 rows whose hobbyiqCardId carries the truncated year as a
 *             segment (`hiq:football:201:donruss:372:base:no-auto`). The slug
 *             is the identity, so the year has to move INSIDE it, or the row
 *             stays addressed by a card that does not exist. sold_comps
 *             partitions on /cardId, which does NOT change here -- so this is
 *             a field update on the same partition, not a cross-partition
 *             move, and the pool stays one pool.
 *
 * ONE CARD, ONE ROW, ONE POOL. Re-keying can land a row on a hobbyiqCardId
 * another row already uses -- which is the CORRECT end state (they are the
 * same card; that is the whole point) and is exactly why this is a re-key and
 * not a dedup. Merging the two pool rows is a SEPARATE decision with its own
 * evidence, so this pass reports the collisions it creates and does not
 * collapse them.
 *
 * SLUG RECOMPUTE ONLY IMPROVES: 201 -> 2016 is strictly more specific, and the
 * only segment touched is the year. Nothing else on the slug is recomputed.
 *
 * SCOPE is required and has no default, so a whole-container write cannot
 * happen by omission.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      BACKFILL_APPLY / APPLY   actually write (default: REPORT ONLY)
 *      SOURCE=cardhedge         required -- the whole-source scope, named
 *      LIMIT=0  RUN_MINUTES=140  CONCURRENCY=8  SLOT/SLOTS
 */
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const SOURCE = String(process.env.SOURCE || "").trim();
const LIMIT = Number(process.env.LIMIT || 0);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
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
const SHARD_SCOPE = runnerShardScope({ label: "repair-truncated-card-year" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const retry = async (fn, tries = 10) => {
  let wait = 700;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 30000);
    }
  }
};

/** The only years a card can plausibly carry. Not a free 4-digit match. */
const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/g;

/**
 * The true year for a truncated one, from text the row already carries.
 * Returns null when the text supports nothing -- the row is then reported and
 * left exactly as it is.
 */
function trueYearFrom(stored, setName, title) {
  if (!Number.isFinite(stored) || stored < 100 || stored > 999) return null;
  const prefix = String(stored);
  for (const text of [setName, title]) {
    const s = String(text ?? "");
    if (!s) continue;
    const hits = (s.match(YEAR_RE) ?? []).map(Number);
    // The candidate must be the stored value with its last digit restored.
    // Anything else is a year that happens to appear in the text, which is not
    // evidence about THIS row's year.
    const ok = [...new Set(hits)].filter((y) => String(y).startsWith(prefix));
    // Two different candidates both matching the prefix (1996 and 1997 in one
    // title) is ambiguity, not evidence. Refuse rather than pick.
    if (ok.length === 1) return { year: ok[0], via: text === setName ? "setName" : "title" };
    if (ok.length > 1) return null;
  }
  return null;
}

/** Swap ONLY the year segment of a hiq: slug. null when it carries no such segment. */
function rekeySlug(slug, fromYear, toYear) {
  const s = String(slug ?? "");
  if (!s) return null;
  const from = `:${fromYear}:`;
  const at = s.indexOf(from);
  if (at < 0) return null;
  // Guard against a year-shaped segment appearing twice: only the FIRST is the
  // year in `hiq:<sport>:<year>:<setKey>:...`, and it must sit at index 2.
  const parts = s.split(":");
  if (parts.length < 4 || parts[2] !== String(fromYear)) return null;
  parts[2] = String(toYear);
  return parts.join(":");
}

function reconcile(job, s) {
  const candidates = s.candidates ?? 0, written = s.written ?? 0;
  const skipped = s.skipped ?? 0, failed = s.failed ?? 0, notReached = s.notReached ?? 0;
  return {
    job, candidates, written, skipped, failed, notReached,
    intended: candidates + notReached,
    balances: written + skipped + failed === candidates,
    accountsForAll: written + skipped + failed + notReached === candidates + notReached,
  };
}

function querySpec() {
  return {
    query: "SELECT * FROM c WHERE c.cardYear >= 100 AND c.cardYear <= 999 AND c.source = @src",
    parameters: [{ name: "@src", value: SOURCE }],
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  // A WHOLE-SOURCE REPAIR NEEDS ITS NAME. This job rewrites an identity field
  // across a source; it refuses to run without being told which one.
  if (!SOURCE) {
    console.error("FATAL: SOURCE is required -- a whole-source write never derives its own scope.");
    console.error("  e.g. SOURCE=cardhedge   (all 2,980 known rows are source=cardhedge)");
    process.exit(2);
  }

  const { CosmosClient } = require("@azure/cosmos");
  const { reportWrites } = require(path.join(path.resolve(__dirname, ".."), "dist/services/ops/writeReconciliation.js"));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");

  console.log(`repair-truncated-card-year   ${APPLY ? "APPLY" : "REPORT ONLY -- nothing will be written"}`);
  console.log(`scope: source=${SOURCE}, cardYear 100..999   slot ${SLOT}/${SLOTS}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const stats = { candidates: 0, written: 0, skipped: 0, failed: 0, notReached: 0, otherShard: 0 };
  const reasons = new Map();
  const byYear = new Map();
  const shape = { patch: 0, rekey: 0 };
  const collisions = [];
  const examples = [];
  const note = (k) => reasons.set(k, (reasons.get(k) ?? 0) + 1);
  const example = (s) => { if (examples.length < 12) examples.push("    " + s); };

  let stopReason = null;
  const it = sold.items.query(querySpec(), { maxItemCount: 200 });
  let token = null;
  do {
    const page = await retry(() => it.fetchNext());
    token = page.continuationToken;
    const batch = page.resources ?? [];
    if (!batch.length) continue;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      if (budgetLeft() <= 0) { stopReason = "budget"; break; }
      if (LIMIT && stats.candidates >= LIMIT) { stopReason = "limit"; break; }
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (row) => {
        if (SLOTS > 1 && shardOf(row.id) !== SLOT) { stats.otherShard++; return; }
        if (LIMIT && stats.candidates >= LIMIT) { stats.notReached++; return; }
        stats.candidates++;
        try {
          const stored = Number(row.cardYear);
          const hit = trueYearFrom(stored, row.setName, row.title);
          if (!hit) {
            stats.skipped++;
            note("no unambiguous year in setName or title -- REPORTED, left as stored");
            example(`left alone: cardYear=${stored} setName=${JSON.stringify(row.setName ?? null)} title=${JSON.stringify(String(row.title ?? "").slice(0, 60))}`);
            return;
          }
          const patch = { cardYear: hit.year };
          const newSlug = rekeySlug(row.hobbyiqCardId, stored, hit.year);
          if (newSlug) {
            patch.hobbyiqCardId = newSlug;
            shape.rekey++;
            // The re-key can land on a slug another row already uses. That is
            // the CORRECT end state -- same card, one pool -- and merging the
            // rows is a separate decision. Report it, never collapse it here.
            const dup = await retry(() => sold.items.query({
              query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s AND c.id != @id",
              parameters: [{ name: "@s", value: newSlug }, { name: "@id", value: row.id }],
            }, { partitionKey: row.cardId }).fetchAll());
            if ((dup.resources?.[0] ?? 0) > 0 && collisions.length < 10) {
              collisions.push(`    ${row.id}\n      -> ${newSlug}  (${dup.resources[0]} row(s) already there -- same card, reported not merged)`);
            }
          } else {
            shape.patch++;
          }

          byYear.set(`${stored} -> ${hit.year}`, (byYear.get(`${stored} -> ${hit.year}`) ?? 0) + 1);

          if (APPLY) {
            // A field patch on the SAME partition (/cardId is untouched).
            await retry(() => sold.item(row.id, row.cardId).patch(
              Object.entries(patch).map(([k, v]) => ({ op: "set", path: `/${k}`, value: v })),
            ));
          }
          stats.written++;
          example(`${newSlug ? "re-key" : "patch"} cardYear ${stored} -> ${hit.year} (via ${hit.via})  ${row.id}${newSlug ? `\n      slug -> ${newSlug}` : ""}`);
        } catch (e) {
          stats.failed++;
          if (stats.failed <= 6) console.log(`  failed ${String(row.id).slice(0, 90)}: ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }));
      if (stopReason) break;
    }
    if (stopReason) break;
  } while (token);

  const verb = APPLY ? "APPLIED" : "REPORT ONLY -- nothing written";
  console.log(`\n${verb}`);
  console.log(`  candidates (this slot)   ${f(stats.candidates)}   (${f(stats.otherShard)} belong to other slots)`);
  console.log(`  ${APPLY ? "REPAIRED" : "WOULD REPAIR"}             ${f(stats.written)}`);
  console.log(`    of which patch-only    ${f(shape.patch)}   (identity does not move)`);
  console.log(`    of which re-key        ${f(shape.rekey)}   (year is a slug segment)`);
  console.log(`  left alone               ${f(stats.skipped)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (byYear.size) {
    console.log(`  by year:`);
    for (const [k, n] of [...byYear].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(20)} ${f(n)}`);
  }
  if (reasons.size) {
    console.log(`  why a row was left alone:`);
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(66)} ${f(n)}`);
  }
  if (collisions.length) {
    console.log(`  re-keys landing on an existing slug (same card, one pool -- reported, NOT merged):`);
    for (const c of collisions) console.log(c);
  }
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }

  const rec = reconcile("repair-truncated-card-year", stats);
  if (!rec.balances) console.log(`\n  NOTE: the rows examined do not partition (${f(rec.written)} + ${f(rec.skipped)} + ${f(rec.failed)} != ${f(rec.candidates)})`);
  if (APPLY) reportWrites({ job: rec.job, intended: rec.intended, written: rec.written, skipped: rec.skipped + rec.notReached, failed: rec.failed });

  console.log(`\nINGEST-SIDE GUARD ships in the same PR (reconcileYear, cardhedgeDailyExport.client.ts).`);
  console.log(`  Without it the next daily export re-imports the same truncated years.`);

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget -- the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} -- a bounded run`);
}

module.exports = { trueYearFrom, rekeySlug, reconcile, querySpec };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
