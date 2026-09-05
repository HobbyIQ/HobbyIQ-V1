#!/usr/bin/env node
/**
 * conform-one-of-one-parallels.cjs -- a SuperFractor is 1/1, a printing
 * plate is 1/1, a one-of-one is 1/1; the row's print run says so.
 *
 * CF-A-SUPERFRACTOR-IS-ONE-OF-ONE (Drew, 2026-08-29: "superfractors are
 * 1/1"; the glossary, backend/docs/reference/card-lingo-glossary.md:47,118,
 * 119 -- SuperFractor = 1/1, every Printing Plate is a 1/1). Measured
 * 2026-08-29, read-only, un-graded rows whose parallelSlug names one of
 * these: 255,229 sit at an id WITHOUT `:num-1` -- printRun null 246,271, /4
 * 8,861 (the FOUR plates parsed as a print run: checklistinsider "Printing
 * Plates Parallel"), 1368310399850795000 x49, /200 x39, 2021 x5, strings --
 * and 55 sit at a `:num-1` id with a printRun field that is not 1. The
 * un-numbered twin is the seller (or the scraper) omitting "1/1": it
 * splits the card's pool from its numbered checklist row and lets an
 * un-numbered rung price a 1/1 off base sales.
 *
 * THE RULE IS THE SLUG. The id's parallel segment (segment 5) matches
 *   (^|-)superfractors?(-|$)  |  printing-plate  |  (^|-)(one-of-one|1-of-1)(-|$)
 * A colour in front changes nothing: gold-superfractor is a SuperFractor.
 * The plural is admitted deliberately -- 21,536 rows say `superfractors`
 * and 8,075 `superfractors-refractor` (a category header, "Superfractors
 * 1/1", glued into the name); they are SuperFractors. The plates match by
 * substring (printing-plates-cyan, framed-printing-plate). one-of-one /
 * 1-of-1 exist as real rungs (class-3-red-one-of-one, od-1-of-1,
 * artist's-proof-1-of-1; 25 distinct). A PROSE slug -- a scraped footnote
 * ("all-100-base-cards-are-available-in-the-following-...-superfractor-(one-
 * of-one)-printing-plate-...") -- is not a rung and is skipped and counted;
 * the name-cleaning pass owns those.
 *
 * WHAT MOVES. A row whose id lacks `:num-1` (un-numbered, or numbered with
 * anything else) moves to `<base>:num-1` through moveCatalogRow with
 * { printRun: 1 } as the changed field and sold_comps as salesContainer: the
 * survivor is written first, the sales re-point, the old slug's graded
 * children are retired, the old row is deleted last; a row already at the
 * target is a fold / replace by authority (the numbered checklist row wins;
 * vendorIds union). A `:num-1` row whose FIELD is not 1 is healed in place.
 * The per-print-run breakdown the rule found is printed.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY / APPLY (report only by
 *      default); SPORTS (comma list); SLOT/SLOTS (sha1(id) shards);
 *      RUN_MINUTES=140; CONCURRENCY=8; LIMIT=0 (rows moved or healed).
 */
"use strict";
const crypto = require("node:crypto");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
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
const SHARD_SCOPE = runnerShardScope({ label: "conform-one-of-one-parallels" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

// ── pure ─────────────────────────────────────────────────────────────────────

const FAMILIES = [
  ["superfractor", /(^|-)superfractors?(-|$)/],
  ["printing-plate", /printing-plate/],
  ["one-of-one", /(^|-)(one-of-one|1-of-1)(-|$)/],
];
/** A scraped footnote glued into the slug: punctuation a rung never has, or
 *  a length no rung reaches. */
const MENTIONS = /superfractor|printing-plate|one-of-one|1-of-1/;
const PROSE = /[().",]/;
const MAX_RUNG_LENGTH = 64;

/** Which 1/1 family a parallel slug belongs to, or null; "prose" for a
 *  footnote that merely mentions one. */
function oneOfOneFamily(parallelSlug) {
  const s = String(parallelSlug ?? "").toLowerCase();
  if (!s || !MENTIONS.test(s)) return null;
  // A footnote wraps the word in parentheses ("-(one-of-one)."), so prose is
  // judged on the mention, before the strict rung match.
  if (PROSE.test(s) || s.length > MAX_RUNG_LENGTH) return "prose";
  const fam = FAMILIES.find(([, re]) => re.test(s));
  return fam ? fam[0] : null;
}

/** hiq:sport:year:setKey:number:parallel:auto[:num-N] -> the same id at :num-1. */
function targetSlug(id) {
  const parts = String(id).split(":");
  if (parts.length !== 7 && parts.length !== 8) return null;
  if (parts.length === 8 && !parts[7].startsWith("num-")) return null; // a graded child, not an identity row
  return parts.slice(0, 7).join(":") + ":num-1";
}

/** What a row needs under the rule: move, heal (id is :num-1, field is not),
 *  or one of the skips. */
function decideRow(row) {
  const parts = String(row.id ?? "").split(":");
  if (parts[0] !== "hiq") return { action: "skip-not-hiq" };
  const family = oneOfOneFamily(parts[5]);
  if (family === null) return { action: "skip-field-id-disagree" }; // parallelSlug matched, the id's own segment does not
  if (family === "prose") return { action: "skip-prose" };
  const target = targetSlug(row.id);
  if (!target) return { action: "skip-not-identity" };
  if (target === row.id) return row.printRun === 1 ? { action: "agree", family } : { action: "heal", family };
  return { action: "move", family, newSlug: target };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { CosmosClient } = require("@azure/cosmos");
  const { moveCatalogRow } = require("../dist/services/catalog/catalogRowOps.service.js");
  const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  console.log(`conform-one-of-one-parallels  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m${SPORTS.length ? `  sports=${SPORTS.join(",")}` : ""}  limit=${LIMIT || "none"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const sportSql = SPORTS.length ? ` AND c.sport IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})` : "";
  const sportParams = SPORTS.map((s, i) => ({ name: `@sp${i}`, value: s }));
  const NAMED = `(CONTAINS(c.parallelSlug, "superfractor") OR CONTAINS(c.parallelSlug, "printing-plate") OR CONTAINS(c.parallelSlug, "one-of-one") OR CONTAINS(c.parallelSlug, "1-of-1"))`;
  // Light projection first; the full row is point-read only for a move.
  const spec = {
    query: `SELECT c.id, c.cardId, c.parallelSlug, c.printRun, c.source FROM c WHERE STARTSWITH(c.id, "hiq:") AND NOT IS_DEFINED(c.gradeTier) AND ${NAMED}${sportSql} AND (NOT ENDSWITH(c.id, ":num-1") OR NOT IS_DEFINED(c.printRun) OR c.printRun != 1)`,
    parameters: sportParams,
  };
  const REASON = "a SuperFractor / printing plate / one-of-one is 1/1; the print run follows the rung (CF-A-SUPERFRACTOR-IS-ONE-OF-ONE)";

  const stats = { scanned: 0, otherShard: 0, prose: 0, fieldIdDisagree: 0, notIdentity: 0, agree: 0, actionable: 0, healed: 0, moved: 0, folded: 0, replaced: 0, gone: 0, salesRepointed: 0, gradedRetired: 0, failed: 0, notReached: 0 };
  const breakdown = new Map(); // `${family}  printRun=${before}` -> n
  const examples = [];
  let stopReason = null;
  let token;
  do {
    const page = await retry(() => cat.items.query(spec, { maxItemCount: 500, continuationToken: token }).fetchNext());
    token = page.continuationToken || undefined;
    const rows = page.resources ?? [];
    const mine = SLOTS > 1 ? rows.filter((r) => shardOf(r.id) === SLOT) : rows;
    stats.otherShard += rows.length - mine.length;
    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      if (LIMIT && stats.actionable >= LIMIT) { stopReason = "limit"; stats.notReached += mine.length - i; break; }
      if (budgetLeft() < 90000) { stopReason = "budget"; stats.notReached += mine.length - i; break; }
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (row) => {
        stats.scanned++;
        const d = decideRow(row);
        if (d.action === "skip-prose") { stats.prose++; return; }
        if (d.action === "skip-field-id-disagree" || d.action === "skip-not-hiq") { stats.fieldIdDisagree++; return; }
        if (d.action === "skip-not-identity") { stats.notIdentity++; return; }
        if (d.action === "agree") { stats.agree++; return; }
        stats.actionable++;
        const key = `${d.family.padEnd(15)} printRun=${JSON.stringify(row.printRun ?? null)}`;
        breakdown.set(key, (breakdown.get(key) ?? 0) + 1);
        try {
          if (d.action === "heal") {
            if (APPLY) await retry(() => cat.item(row.id, row.cardId ?? row.id).patch([
              { op: "set", path: "/printRun", value: 1 },
              { op: "set", path: "/printRunRepairedFrom", value: row.printRun ?? null },
              { op: "set", path: "/printRunRepairedReason", value: REASON },
            ]));
            stats.healed++;
            if (examples.length < 20) examples.push(`  heal    ${row.id}  printRun ${JSON.stringify(row.printRun ?? null)} -> 1`);
            return;
          }
          let full = null;
          try { full = (await retry(() => cat.item(row.id, row.cardId ?? row.id).read())).resource ?? null; } catch (e) { if (e?.code !== 404) throw e; }
          if (!full) { stats.gone++; return; }
          const res = await moveCatalogRow(cat, full, d.newSlug, { printRun: 1 }, { reason: REASON, dryRun: !APPLY, salesContainer: pool, retry });
          if (res.action === "move") stats.moved++;
          else if (res.action === "fold") stats.folded++;
          else if (res.action === "replace") stats.replaced++;
          else stats.gone++;
          stats.salesRepointed += res.salesRepointed ?? 0;
          stats.gradedRetired += res.gradedChildrenRetired ?? 0;
          if (examples.length < 20) examples.push(`  ${res.action.padEnd(7)} ${row.id} -> ${d.newSlug}  [${row.source}]  (${res.decision})`);
        } catch (e) {
          stats.failed++;
          if (stats.failed <= 5) console.log(`  failed ${row.id}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }));
    }
    if (stopReason) break;
  } while (token);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  candidates (this slot)   ${f(stats.scanned)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  actionable rows          ${f(stats.actionable)}`);
  console.log(`  REPAIRED                 ${f(stats.healed + stats.moved + stats.folded + stats.replaced)}   <- moved ${f(stats.moved)}, folded ${f(stats.folded)}, replaced ${f(stats.replaced)}, healed ${f(stats.healed)} (field -> 1); sales re-pointed ${f(stats.salesRepointed)}, graded children retired ${f(stats.gradedRetired)}`);
  console.log(`  prose slug (footnote)    ${f(stats.prose)}   <- not a rung; the name-cleaning pass owns these`);
  console.log(`  field/id disagree        ${f(stats.fieldIdDisagree)}   <- parallelSlug names a 1/1, the id's own segment does not`);
  console.log(`  not an identity row      ${f(stats.notIdentity)}`);
  console.log(`  already 1/1              ${f(stats.agree)}`);
  console.log(`  gone before the move     ${f(stats.gone)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (breakdown.size) { console.log(`  by family and the print run the row had:`); for (const [k, n] of [...breakdown].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(40)} ${f(n)}`); }
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "conform-one-of-one-parallels", intended: stats.actionable, written: stats.healed + stats.moved + stats.folded + stats.replaced, skipped: stats.gone, failed: stats.failed });
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
}

module.exports = { oneOfOneFamily, targetSlug, decideRow };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
