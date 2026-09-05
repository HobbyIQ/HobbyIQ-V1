#!/usr/bin/env node
/**
 * clean-parallel-annotations.cjs -- the parallel NAME is the name, not the footnote.
 *
 * CF-CLEAN-THE-NAMES (Drew, 2026-08-29 "do it"). 402,289 checklist-source
 * identity rows carry a page annotation glued into `parallel`:
 *
 *   "Refractor - Est. print run ~4,000 to 6,000"       (bccp, 3,298 rows)
 *   "Purple (exclusive to packs sold at Meijer stores)" (290,823 rows)
 *   "Platinum ()"                                       (24,330 rows)
 *
 * The rung exists on the spine under an unmatchable slug, so the sale-derived
 * twin never folds onto it -- Ohtani's 2018 Topps Chrome Refractor is exactly
 * this, and it is most of why only 6% of derived rows are rung-confirmed.
 *
 * This is NOT vocabulary invention (the rule Drew set on 08-28): nothing is
 * added. The annotation is moved, verbatim, to `parallelNote`; a numeric print
 * run inside it fills `printRun` when the row has none; the name is what the
 * checklist calls the rung once the footnote is off it.
 *
 * What it does per row (checklist sources only, identity rows only):
 *   1. clean(parallel) -> { name, note, printRun }
 *   2. newSlug = the id with segment 5 (parallelSlug) rebuilt from name
 *   3. newSlug === id  -> patch parallel/parallelNote/printRun in place, the
 *                         searchable fields rebuilt (rebuildSearchFields)   (healed)
 *      otherwise       -> catalogRowOps.moveCatalogRow (D5 PR 2): copy to the
 *                         clean slug, re-point sales, retire graded children
 *                         of the old slug, delete old. A row already at the
 *                         clean slug is decided by authority: the spine keeps
 *                         its address and the footnote / print run it lacks
 *                         are grafted on (folded); a derived twin is
 *                         overwritten, its vendorIds kept (replaced).
 *
 * The "other" shape -- 83,838 rows where `parallel` holds player-pair text or a
 * page paragraph ("Eric Davis (as) Andy Nezelek", "Purple RayWave Refractor (")
 * -- is a mis-parsed checklist, not an annotated rung. Counted, left alone,
 * reported as its own repair list.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS (hash of id);
 *      SPORTS (comma list, default all); CONCURRENCY=16; RUN_MINUTES=140; LIMIT.
 * Exit 4 when the reconciliation does not add up (see reportWrites).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(__dirname, "..", "dist", "services", "ops", "writeReconciliation.js"));
const { moveCatalogRow, rebuildSearchFields } = require(path.join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "clean-parallel-annotations" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 16));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();

const CHECKLIST_SQL = "(c.source = 'bccp' OR STARTSWITH(c.source,'baseballcardpedia') OR STARTSWITH(c.source,'checklist') OR STARTSWITH(c.source,'beckett') OR STARTSWITH(c.source,'tcgdex') OR STARTSWITH(c.source,'cardboardchecklist'))";
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;

/** The three annotation shapes. Returns null for anything else (the
 *  mis-parsed "other" shape is not ours to rename). */
function clean(parallel) {
  const raw = String(parallel ?? "");
  let name = raw, note = null, shape = null;
  const est = name.match(/^(.*?)\s*[-–—]?\s*Est\.?\s*print run\b(.*)$/i);
  if (est) { note = ("Est. print run" + est[2]).trim(); name = est[1]; shape = "est-print-run"; }
  const par = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (par) {
    const inner = par[2].trim();
    note = [inner, note].filter(Boolean).join("; ") || null;
    name = par[1];
    shape = shape ?? (inner ? "parenthetical" : "empty-paren");
  }
  if (!shape) return null;
  name = name.replace(/[-–—:]\s*$/, "").trim();
  // A print run is taken ONLY when the whole footnote is a print-run
  // statement. "(Base not numbered, ... serial numbered to 500 copies)"
  // describes sub-classes, not this rung -- that 500 must not become its number.
  let printRun = null;
  if (note) {
    const m = note.match(/^(?:#\s*)?\/?\s*(\d[\d,]{0,6})\s*(?:copies|cards|made)?\.?$/i)
      || note.match(/^(?:serial\s+)?numbered to\s*(\d[\d,]{0,6})\.?$/i)
      || note.match(/^(?:series\s+\w+:\s*)?(\d[\d,]{0,6})\s*copies\.?$/i)
      || note.match(/^\d+\s*\/\s*(\d[\d,]{0,6})$/);
    if (m) printRun = Number(m[1].replace(/,/g, "")) || null;
  }
  return { name, note, printRun, shape };
}

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");

  console.log(`slot ${SLOT}/${SLOTS}  sports=${SPORTS.join(",") || "all"}  ${APPLY ? "APPLY" : "REPORT ONLY"}  budget ${RUN_MS / 60000}m\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  const shapes = {}; const misparsedNames = new Map();
  let scanned = 0, otherShards = 0, misparsed = 0, emptyName = 0, healed = 0, moved = 0, folded = 0, replaced = 0, salesRepointed = 0, gradedDeleted = 0, failed = 0, notReached = 0, printRunsFilled = 0;
  let stopReason = null, token;
  const sportSql = SPORTS.length ? ` AND c.sport IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})` : "";
  const query = {
    query: `SELECT * FROM c WHERE NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.parallel) AND (CONTAINS(c.parallel, '(') OR CONTAINS(LOWER(c.parallel), 'print run')) AND ${CHECKLIST_SQL}${sportSql}`,
    parameters: SPORTS.map((s, i) => ({ name: `@sp${i}`, value: s })),
  };

  do {
    const page = await retry(() => cat.items.query(query, { maxItemCount: 200, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    const mine = page.resources.filter((d) => shardOf(d.id) === SLOT);
    otherShards += page.resources.length - mine.length;

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          const c = clean(d.parallel);
          if (!c) { misparsed++; misparsedNames.set(String(d.parallel).slice(0, 60), (misparsedNames.get(String(d.parallel).slice(0, 60)) ?? 0) + 1); return; }
          shapes[c.shape] = (shapes[c.shape] ?? 0) + 1;
          if (!c.name) { emptyName++; return; }
          const parts = String(d.id).split(":");
          if (parts.length < 7) { misparsed++; return; }
          parts[5] = slugify(c.name);
          const newSlug = parts.join(":");
          const printRun = d.printRun ?? c.printRun ?? null;
          if (printRun && !d.printRun) printRunsFilled++;

          if (newSlug === d.id) {
            // The slug never carried the footnote; only the name text did.
            if (!APPLY) { healed++; return; }
            const fields = { parallel: c.name, parallelSlug: parts[5], parallelNote: c.note, printRun, parallelCleanedAt: new Date().toISOString() };
            Object.assign(fields, rebuildSearchFields({ ...d, ...fields }));
            await retry(() => cat.item(d.id, d.cardId ?? d.id).patch(Object.entries(fields).map(([k, v]) => ({ op: "set", path: `/${k}`, value: v }))));
            healed++;
            return;
          }

          // One point read serves both the move's collision decision (`known`)
          // and the fold-time graft below -- CF-DO-NOT-LOOK-TWICE.
          const existing = await retry(() => cat.item(newSlug, newSlug).read())
            .then((x) => x.resource ?? null, (e) => { if (e?.code === 404) return null; throw e; });
          const r = await moveCatalogRow(cat, d, newSlug, { parallel: c.name, parallelNote: c.note, printRun }, {
            reason: "parallel annotation moved to parallelNote", dryRun: !APPLY, salesContainer: pool, known: existing, retry,
          });
          salesRepointed += r.salesRepointed; gradedDeleted += r.gradedChildrenRetired;
          if (r.action === "fold") {
            // The spine's row kept its address; the footnote and print run it lacks come along.
            const ops = [];
            if (c.note && !existing.parallelNote) ops.push({ op: "set", path: "/parallelNote", value: c.note });
            if (printRun && !existing.printRun) ops.push({ op: "set", path: "/printRun", value: printRun });
            if (ops.length && APPLY) await retry(() => cat.item(newSlug, newSlug).patch(ops)).catch(() => {});
          }
          if (r.action === "move") moved++; else if (r.action === "fold") folded++; else if (r.action === "replace") replaced++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 70)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && (healed + moved + folded + replaced) >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (stopReason) break;
    if (scanned && scanned % 2000 < CONCURRENCY) process.stderr.write(`\r  scanned=${f(scanned)} healed=${f(healed)} moved=${f(moved)} folded=${f(folded)} replaced=${f(replaced)} sales=${f(salesRepointed)}   `);
  } while (token);
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned (this slot)     ${f(scanned)}   (+${f(otherShards)} belonging to other slots)`);
  console.log(`  shapes                       ${Object.entries(shapes).map(([k, v]) => `${k}=${f(v)}`).join("  ")}`);
  console.log(`  HEALED in place              ${f(healed)}   <- slug was already clean; name text was not`);
  console.log(`  MOVED to the clean slug      ${f(moved)}`);
  console.log(`  FOLDED (spine had it)        ${f(folded)}`);
  console.log(`  REPLACED a derived twin      ${f(replaced)}   <- the checklist outranks a sale-minted row`);
  console.log(`  sales re-pointed             ${f(salesRepointed)}`);
  console.log(`  graded children deleted      ${f(gradedDeleted)}   <- regenerable by materialize-graded-identities`);
  console.log(`  print runs recovered         ${f(printRunsFilled)}`);
  console.log(`  mis-parsed (left alone)      ${f(misparsed)}   <- player text / page prose in the parallel column; its own repair`);
  console.log(`  empty after clean (left)     ${f(emptyName)}`);
  console.log(`  failed                       ${f(failed)}`);
  if (misparsedNames.size) {
    console.log(`\n  mis-parsed examples (top 8):`);
    for (const [k, n] of [...misparsedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${String(f(n)).padStart(7)}  ${k}`);
  }
  if (APPLY) {
    reportWrites({ job: "clean-parallel-annotations", intended: scanned, written: healed + moved + folded + replaced, skipped: misparsed + emptyName + notReached, failed });
  }
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
