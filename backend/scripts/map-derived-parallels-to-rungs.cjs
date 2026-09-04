#!/usr/bin/env node
/**
 * CF-MAP-THE-SPELLING-TO-THE-RUNG (Drew, 2026-08-28: "do it").
 *
 * The APPLY half of learn-parallel-model. For every sales-derived catalog row
 * whose parallel resolves onto its own product's checklist ladder, move the row
 * to the rung's slug and re-point its sales -- the BCP fix's shape, applied to
 * the parallel segment.
 *
 * WHAT MAY RESOLVE, exactly the measured cascade, strictest first:
 *
 *   R1 exact       slugify(text) === rung
 *   R2 squash      hyphen-insensitive ("X Fractor" ≡ "X-Fractor")
 *   R4 long-form   text + family suffix hits EXACTLY ONE rung ("Gold" ->
 *                  "Gold Refractor"); two candidates = no move. Measured
 *                  ambiguity rate: 0.2%.
 *
 * WHAT NEVER HAPPENS HERE:
 *   - no rung is invented (no-synthetic-parallels): unresolved rows are
 *     STAMPED and skipped, they are the acquisition list
 *   - the ladder is the VERIFIED family only (setKey, -series*, -update*);
 *     a chrome ladder must never resolve a flagship spelling
 *   - a resolution that lands on the SAME slug is a no-op, not a rewrite
 *
 * MOVE SEMANTICS are catalogRowOps.moveCatalogRow (D5 PR 2): copy before
 * delete, sales first, graded children of the old slug retired. A row already
 * at the target slug (usually the checklist rung itself) is decided by
 * authority: the derived row folds onto it (redundant) unless it outranks the
 * incumbent, in which case it replaces it. Source is unchanged either way --
 * resolution does not launder provenance. A crash leaves a duplicate, never a
 * lost card or a stranded sale.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SPORT=baseball  REDO=true rechecks stamped rows
 *   SLOT/SLOTS  CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// The workflow passes the existing `sports` input as SPORTS; accept both so
// non-baseball dispatches need no new plumbing.
const SPORT = process.env.SPORT || process.env.SPORTS || "baseball";
// REDO comes as its own env, or through the runner's existing `mode` input
// (MODE=redo) so a re-map dispatch needs no new workflow plumbing.
const REDO = String(process.env.REDO || "") === "true" || String(process.env.MODE || "").toLowerCase() === "redo";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
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
const SHARD_SCOPE = runnerShardScope({ label: "map-derived-parallels-to-rungs" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const MAP_VERSION = 1;
const f = (n) => Number(n).toLocaleString();

const DERIVED = "(c.source='ingest-auto-seed' OR STARTSWITH(c.source,'catalog-explode') " +
  "OR STARTSWITH(c.source,'sold-comps-stub') OR STARTSWITH(c.source,'sales-derived') " +
  "OR STARTSWITH(c.source,'tree-builder'))";
const PENDING = REDO ? "" : ` AND (NOT IS_DEFINED(c.parallelMapV) OR c.parallelMapV < ${MAP_VERSION})`;

const slug = (s) => String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const FAMILIES = ["refractor", "x-fractor", "prizm", "shimmer", "lava", "wave", "holo", "foilboard", "foil", "sapphire", "chrome", "ice", "mojo", "camo", "pattern"];

/** Resolve one spelling against a ladder. Returns the rung slug or null. */
function resolve(text, rungs, squashIndex) {
  const s0 = slug(text);
  if (!s0) return null;
  if (rungs.has(s0)) return s0;                              // R1
  const sq = squashIndex.get(s0.replace(/-/g, ""));
  if (sq) return sq;                                          // R2
  const candidates = [];                                      // R4: unique long-form
  for (const k of rungs.keys()) {
    for (const fam of FAMILIES) {
      if (k === `${s0}-${fam}`) { candidates.push(k); break; }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), comps = db.container("sold_comps");
  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // products, sized, greedy-assigned — the measured shard pattern
  const { resources: prods } = await retry(() => cat.items.query({
    query: `SELECT c.year, c.setKey, COUNT(1) AS n FROM c WHERE c.sport=@s AND ${DERIVED}${PENDING} GROUP BY c.year, c.setKey`,
    parameters: [{ name: "@s", value: SPORT }],
  }).fetchAll());
  const all = prods.filter((p) => p.setKey && p.year).sort((a, b) => b.n - a.n || `${a.year}${a.setKey}`.localeCompare(`${b.year}${b.setKey}`));
  const load = new Array(Math.max(1, SLOTS)).fill(0);
  const mine = [];
  for (const p of all) {
    const i = load.indexOf(Math.min(...load));
    if (i === SLOT) mine.push(p);
    load[i] += p.n;
  }
  console.log(`slot ${SLOT}/${SLOTS}  sport=${SPORT}  ${mine.length} products / ${f(mine.reduce((s, p) => s + p.n, 0))} rows  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, moved = 0, redundant = 0, replaced = 0, atRung = 0, unresolved = 0, salesRepointed = 0, gradedRetired = 0, noLadder = 0, failed = 0, notReached = 0;
  let stopReason = null;

  for (const p of mine) {
    if (stopReason) break;

    // the family ladder, checklist authority only
    const rungs = new Map(), squashIndex = new Map();
    const { resources: lad } = await retry(() => cat.items.query({
      query: `SELECT c.parallel, c.setKey, c.source, COUNT(1) AS n FROM c
              WHERE c.sport=@s AND c.year=@y AND (c.setKey=@k OR STARTSWITH(c.setKey, @ks) OR STARTSWITH(c.setKey, @ku))
              GROUP BY c.parallel, c.setKey, c.source`,
      parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey },
        { name: "@ks", value: p.setKey + "-series" }, { name: "@ku", value: p.setKey + "-update" }],
    }).fetchAll());
    for (const r of lad) {
      if (catalogAuthorityOf(r.source) !== "checklist") continue;
      const k = slug(r.parallel);
      if (!k) continue;
      if (!rungs.has(k)) { rungs.set(k, true); squashIndex.set(k.replace(/-/g, ""), k); }
    }
    if (!rungs.size) { noLadder += p.n; continue; }   // acquisition list, not an error

    let token;
    do {
      const page = await retry(() => cat.items.query({
        query: `SELECT * FROM c WHERE c.sport=@s AND c.year=@y AND c.setKey=@k AND ${DERIVED}${PENDING}`,
        parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }],
      }, { maxItemCount: 300, continuationToken: token }).fetchNext());
      token = page.continuationToken;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (d) => {
          scanned++;
          try {
            const target = resolve(d.parallel, rungs, squashIndex);
            const currentSeg = String(d.id).split(":")[5];
            if (!target || target === currentSeg) {
              // stamped either way: unresolved is the acquisition list; at-rung is done
              if (target) atRung++; else unresolved++;
              if (APPLY) await retry(() => cat.item(d.id, d.cardId ?? d.id).patch([{ op: "set", path: "/parallelMapV", value: MAP_VERSION }])).catch(() => {});
              return;
            }
            const r = await moveCatalogRow(cat, d, String(d.id).replace(`:${currentSeg}:`, `:${target}:`), { parallelMapV: MAP_VERSION }, {
              reason: "parallel mapped to checklist rung", dryRun: !APPLY, salesContainer: comps, retry,
            });
            salesRepointed += r.salesRepointed; gradedRetired += r.gradedChildrenRetired;
            // the rung row existed: this row folded onto it (redundant) or, outranking it, replaced it -- slices of MOVED
            if (r.action === "fold") redundant++;
            else if (r.action === "replace") { replaced++; if (replaced <= 3) console.log(`  replaced at ${r.newSlug.slice(0, 58)}: ${r.decision}`); }
            moved++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 60)}: ${String(e.message || e).slice(0, 60)}`);
          }
        }));
        const processed = Math.min(i + CONCURRENCY, page.resources.length);
        if (LIMIT && moved >= LIMIT) { stopReason = "limit"; notReached += page.resources.length - processed; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += page.resources.length - processed; break; }
      }
      if (stopReason) break;
    } while (token);
    process.stderr.write(`\r  ${p.year} ${p.setKey}  scanned=${f(scanned)} moved=${f(moved)}   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  derived rows scanned      ${f(scanned)}`);
  console.log(`  MOVED to a checklist rung ${f(moved)}`);
  console.log(`  ...folded, rung existed   ${f(redundant)}   <- slice of MOVED; the rung row kept its address`);
  console.log(`  ...replaced the rung row  ${f(replaced)}   <- slice of MOVED; this row outranked it`);
  console.log(`  sales re-pointed          ${f(salesRepointed)}`);
  console.log(`  graded children retired   ${f(gradedRetired)}`);
  console.log(`  already at the rung       ${f(atRung)}   <- stamped, nothing to move`);
  console.log(`  unresolved (stamped)      ${f(unresolved)}   <- the acquisition list`);
  console.log(`  rows in ladder-less products ${f(noLadder)}   <- acquisition, whole products`);
  console.log(`  failed                    ${f(failed)}`);
  if (APPLY) {
    reportWrites({
      job: "map-derived-parallels-to-rungs", intended: scanned, written: moved,
      skipped: unresolved + atRung + notReached, failed,
    });
  }
}

module.exports = { resolve, FAMILIES };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
