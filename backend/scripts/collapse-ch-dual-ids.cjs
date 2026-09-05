#!/usr/bin/env node
/**
 * collapse-ch-dual-ids.cjs -- one CardHedge sale, one pool row.
 *
 * CF-THE-POOL-KEEPS-EVERY-SALE-ONCE (D19, 2026-08-30). The D14 probe read 100
 * CardHedge cards whole and found 49 carrying BOTH `ch-daily::` and
 * `ch-comp::` ids, with 693 (day, price) pairs present under both shapes
 * (3.1%): the same sale ingested twice by two paths -- the daily-sales
 * fan-out and the comps lookup -- landing under two ids in one partition.
 * The pre-write contentHash dedup could not catch them: the two paths wrote
 * different titles and slugs, and the hash was added after most of them.
 * Measured 2026-08-30 (read-only): 1,842 `ch-comp::` rows in the pool, all
 * of the composed `ch-comp::<cardId>::<soldAt>::<cents>` shape, against
 * 12.9M `ch-daily::` -- the population is every card a `ch-comp::` row names
 * (105 cards). No code path writes `ch-comp::` today.
 *
 * For each such card, every cardhedge row in the partition is grouped by
 * (soldAt day, price cents). A group with exactly ONE `ch-daily::` row and
 * exactly ONE `ch-comp::` row is a pair; any other mix is ambiguous and left
 * alone. The field-by-field variance across ALL pairs is printed BEFORE the
 * rule is applied -- what varies: the title? the grade? the slug? Then:
 *
 *   REFUSE   a pair whose grade or parallel differs (isAuto, print run and
 *            card number too) -- those are two sales, not one. The first dry
 *            run refused 660 of 979 pairs, 517 of them on the parallel: the
 *            two CH paths disagree about the parallel of ONE card id
 *            ("Refractor" vs "Blue Refractor", "Base" vs "Chrome Refractor").
 *            That is a finding about the writers, not a licence to guess
 *            here; the daily->comp parallel pairs are printed for it
 *   KEEP     the row with the richer identity: a slug the catalog holds, the
 *            slug, a title (the longer -- the comp path kept the real listing
 *            title, the daily path composed one), a grade, a print run, an
 *            image; equal -> the `ch-daily::` row
 *   FOLD     the fields the kept row lacks from the other; the other's title,
 *            slug and parallel ride on `collapsedFrom` so nothing is lost
 *   DELETE   the other, through scripts/lib/relocate-sold-comp.cjs (write the
 *            kept row, read it back, then delete; a failed delete is a
 *            duplicate reported on its own line, never a lost sale)
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (default report
 *      only); SLOT/SLOTS (hash shards on the CH card id); RUN_MINUTES=140
 *      (budget marker); LIMIT (CH cards processed; 0 = all).
 * Requires dist/ (reportWrites).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { relocateSoldComp, stripSystem, isMissing, cents, day, normParallel, gradeKey, varianceOf, foldMissing } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
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
const SHARD_SCOPE = runnerShardScope({ label: "collapse-ch-dual-ids" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const f = (n) => Number(n ?? 0).toLocaleString();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const isHiq = (v) => typeof v === "string" && v.startsWith("hiq:");

// ── pure ───────────────────────────────────────────────────────────────────

/** `ch-daily::` / `ch-comp::` / other (the bare bubble ids, TCA-shaped ids). */
function chShape(sourceExternalId) {
  const s = String(sourceExternalId ?? "");
  return s.startsWith("ch-daily::") ? "ch-daily" : s.startsWith("ch-comp::") ? "ch-comp" : "other";
}
/** The D14 pairing key: the sale's day and its price in cents. */
const pairKey = (r) => `${day(r.soldAt)}|${cents(r.price)}`;

/** Group one partition's cardhedge rows by (day, price). Exactly one of each
 *  shape is a pair; more than one of either is ambiguous (which daily row is
 *  the comp row's twin? -- guessing is worse than the duplicate). */
function pairUp(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = pairKey(r);
    if (!byKey.has(k)) byKey.set(k, { daily: [], comp: [], other: [] });
    const shape = chShape(r.sourceExternalId);
    byKey.get(k)[shape === "ch-daily" ? "daily" : shape === "ch-comp" ? "comp" : "other"].push(r);
  }
  const pairs = [], ambiguous = [];
  let compAlone = 0;
  for (const [key, g] of byKey) {
    if (g.comp.length === 0) continue;
    if (g.daily.length === 0) { compAlone++; continue; }
    if (g.daily.length === 1 && g.comp.length === 1) pairs.push({ key, daily: g.daily[0], comp: g.comp[0] });
    else ambiguous.push({ key, daily: g.daily.length, comp: g.comp.length });
  }
  return { pairs, ambiguous, compAlone };
}

const VARIANCE_FIELDS = ["soldAt", "title", "hobbyiqCardId", "setName", "cardNumber", "parallel", "parallelSlug", "printRun", "gradeCompany", "gradeValue", "isAuto", "imageUrl", "confidence", "verifiedByUser", "sport", "cardYear", "playerName", "contentHash", "verifyStatus"];
const FOLD_FIELDS = ["title", "imageUrl", "hobbyiqCardId", "printRun", "gradeQualifier", "autoStyle", "parallelSlug", "cardNumber", "setName", "playerName", "cardYear", "sport", "composite", "vendorCardId"];
const REASON = "CF-THE-POOL-KEEPS-EVERY-SALE-ONCE (D19): the same CH sale under ch-daily:: and ch-comp::";
const normNumber = (v) => String(v ?? "").trim().toLowerCase().replace(/^#/, "");
/** What the dropped row said, kept on the row that replaces it. */
const trace = (r) => ({ id: r.id, cardId: r.cardId, sourceExternalId: r.sourceExternalId ?? null, hobbyiqCardId: r.hobbyiqCardId ?? null, title: r.title ?? null, parallel: r.parallel ?? null, soldAt: r.soldAt ?? null });

/** The richer identity. `slugHeld`: the catalog holds this row's slug. */
function richness(r, slugHeld = false) {
  return (slugHeld ? 3 : 0)
    + (isHiq(r.hobbyiqCardId) ? 2 : 0)
    + (!isMissing(r.title) ? 1 : 0)
    + (!isMissing(r.gradeCompany) ? 2 : 0)
    + (!isMissing(r.printRun) ? 1 : 0)
    + (!isMissing(r.imageUrl) ? 0.25 : 0)
    + Math.min(String(r.title ?? "").length, 120) / 100;
}

/**
 * One pair -> refuse, or the kept document and the row to drop.
 * The variance is computed on the pair as read, before any rule.
 * `held` says which of the two slugs the catalog holds.
 */
function decideChCollapse(daily, comp, { now = new Date().toISOString(), held = { daily: false, comp: false } } = {}) {
  const variance = varianceOf([daily, comp], VARIANCE_FIELDS);
  const refuse = (reason) => ({ collapse: false, reason, variance });
  if (gradeKey(daily) !== gradeKey(comp)) return refuse("grade-differs");
  if (normParallel(daily.parallel) !== normParallel(comp.parallel)) return refuse("parallel-differs");
  if ((daily.isAuto === true) !== (comp.isAuto === true)) return refuse("auto-differs");
  if (!isMissing(daily.printRun) && !isMissing(comp.printRun) && Number(daily.printRun) !== Number(comp.printRun)) return refuse("printrun-differs");
  if (normNumber(daily.cardNumber) && normNumber(comp.cardNumber) && normNumber(daily.cardNumber) !== normNumber(comp.cardNumber)) return refuse("cardnumber-differs");
  const winner = richness(comp, held.comp) > richness(daily, held.daily) ? comp : daily;
  const loser = winner === daily ? comp : daily;
  const keep = stripSystem(winner);
  const folded = foldMissing(keep, [loser], FOLD_FIELDS);
  keep.collapsedFrom = trace(loser);
  keep.collapsedAt = now; keep.collapsedReason = REASON;
  return { collapse: true, variance, keep, drop: { id: loser.id, cardId: loser.cardId }, kept: chShape(winner.sourceExternalId), folded };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { reportWrites } = require(path.join(path.resolve(__dirname, ".."), "dist", "services", "ops", "writeReconciliation.js"));
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps"), cat = db.container("card_catalog");
  console.log(`collapse-ch-dual-ids  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"} cards`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  const catalogSeen = new Map();
  const catalogHas = async (slug) => {
    if (!isHiq(slug)) return false;
    if (catalogSeen.has(slug)) return catalogSeen.get(slug);
    let has = false;
    try { has = !!(await retry(() => cat.item(slug, slug).read())).resource; } catch (e) { if (e?.code !== 404) throw e; }
    catalogSeen.set(slug, has);
    return has;
  };

  // the population: every card a ch-comp:: row names
  const cards = [];
  {
    const it = pool.items.query({ query: "SELECT DISTINCT VALUE c.cardId FROM c WHERE c.source = 'cardhedge' AND STARTSWITH(c.sourceExternalId, 'ch-comp::')" }, { maxItemCount: 1000 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const id of resources ?? []) if (id) cards.push(String(id)); }
  }
  console.log(`  ${f(cards.length)} CH cards carry a ch-comp:: row`);

  const stats = { cards: 0, otherShard: 0, rowsRead: 0, pairs: 0, ambiguous: 0, compAlone: 0, refused: 0, collapsed: 0, failed: 0, duplicatesLeft: 0, alreadyGone: 0, keptDaily: 0, keptComp: 0, notReached: 0 };
  const varied = new Map(), refusedBy = new Map(), foldedHist = new Map(), parallelPairs = new Map(), gradePairs = new Map();
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  const examples = [];
  let stopReason = null, i = 0;
  for (const cardId of cards) {
    if (LIMIT && stats.cards >= LIMIT) { stats.notReached += cards.length - i; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; stats.notReached += cards.length - i; break; }
    i++;
    if (SLOTS > 1 && shardOf(cardId) !== SLOT) { stats.otherShard++; continue; }
    stats.cards++;
    const rows = [];
    const it = pool.items.query({ query: "SELECT * FROM c WHERE c.cardId = @id AND c.source = 'cardhedge'", parameters: [{ name: "@id", value: cardId }] }, { partitionKey: cardId, maxItemCount: 1000 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const r of resources ?? []) rows.push(r); }
    stats.rowsRead += rows.length;
    const { pairs, ambiguous, compAlone } = pairUp(rows);
    stats.pairs += pairs.length; stats.ambiguous += ambiguous.length; stats.compAlone += compAlone;
    // the histogram first: what varies between the two rows of every pair,
    // before the rule says anything about them
    const decisions = [];
    for (const p of pairs) {
      const held = { daily: await catalogHas(p.daily.hobbyiqCardId), comp: await catalogHas(p.comp.hobbyiqCardId) };
      decisions.push({ p, d: decideChCollapse(p.daily, p.comp, { held }) });
    }
    for (const { d } of decisions) for (const fld of d.variance.differing) bump(varied, fld);
    for (const { p, d } of decisions) {
      if (!d.collapse) {
        stats.refused++; bump(refusedBy, d.reason);
        if (d.reason === "parallel-differs") bump(parallelPairs, `${p.daily.parallel ?? "(null)"} -> ${p.comp.parallel ?? "(null)"}`);
        if (d.reason === "grade-differs") bump(gradePairs, `${gradeKey(p.daily)} -> ${gradeKey(p.comp)}`);
        if (examples.length < 30) examples.push(`  REFUSED ${d.reason}  ${cardId} ${p.key}  daily=${JSON.stringify({ g: gradeKey(p.daily), par: p.daily.parallel, n: p.daily.cardNumber })} comp=${JSON.stringify({ g: gradeKey(p.comp), par: p.comp.parallel, n: p.comp.cardNumber })}`);
        continue;
      }
      if (examples.length < 30) examples.push(`  KEEP ${d.kept}  ${cardId} ${p.key}  fold[${d.folded.join(",")}]  varied: ${d.variance.differing.join(",") || "nothing"}`);
      for (const fld of d.folded) bump(foldedHist, fld);
      const res = await relocateSoldComp(pool, { keep: d.keep, drop: [d.drop], retry, verifyFields: ["collapsedAt"], dryRun: !APPLY });
      if (!res.ok && res.stage !== "done") { stats.failed++; console.log(`  FAILED at ${res.stage} ${d.keep.id}: ${String(res.error).slice(0, 100)}`); continue; }
      if (res.duplicatesLeft.length) { stats.failed++; stats.duplicatesLeft += res.duplicatesLeft.length; for (const x of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${x.id}@${x.cardId}: ${String(x.error).slice(0, 80)}`); continue; }
      if (APPLY) stats.alreadyGone += res.alreadyGone.length;
      stats.collapsed++;
      if (d.kept === "ch-daily") stats.keptDaily++; else stats.keptComp++;
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  CH cards read whole      ${f(stats.cards)}   (${f(stats.otherShard)} belonging to other slots; ${f(stats.rowsRead)} rows)`);
  console.log(`  (day, price) pairs       ${f(stats.pairs)}   <- one ch-daily:: + one ch-comp:: row`);
  console.log(`  ambiguous groups         ${f(stats.ambiguous)}   <- two or more of a shape on one (day, price); left alone`);
  console.log(`  ch-comp:: with no twin   ${f(stats.compAlone)}   <- the daily path never saw that sale; left alone`);
  console.log(`  VARIANCE across the ${f(stats.pairs)} pairs, before the rule (field: pairs where it differs):`);
  for (const [k, n] of [...varied].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(16)} ${f(n).padStart(7)}  (${stats.pairs ? (100 * n / stats.pairs).toFixed(1) : "0.0"}%)`);
  console.log(`  refused                  ${f(stats.refused)}   <- ${[...refusedBy].map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`);
  if (parallelPairs.size) { console.log(`    parallel daily -> comp (top 15):`); for (const [k, n] of [...parallelPairs].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`      ${String(n).padStart(5)}  ${k}`); }
  if (gradePairs.size) { console.log(`    grade daily -> comp (top 10):`); for (const [k, n] of [...gradePairs].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`      ${String(n).padStart(5)}  ${k}`); }
  console.log(`  ${APPLY ? "COLLAPSED" : "WOULD COLLAPSE"}           ${f(stats.collapsed)}   <- kept ch-daily:: ${f(stats.keptDaily)}, kept ch-comp:: ${f(stats.keptComp)}`);
  console.log(`  fields folded            ${[...foldedHist].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" | ") || "-"}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`    duplicates left        ${f(stats.duplicatesLeft)}   <- kept row written, the other's delete failed: the sale is in the pool twice, never lost`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (examples.length) { console.log("  examples:"); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "collapse-ch-dual-ids", intended: stats.pairs, written: stats.collapsed, skipped: stats.refused, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
}

module.exports = { chShape, pairKey, pairUp, decideChCollapse, richness, VARIANCE_FIELDS, FOLD_FIELDS };

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
