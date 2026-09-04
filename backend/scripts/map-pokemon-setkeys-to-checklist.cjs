#!/usr/bin/env node
/**
 * CF-ONE-POKEMON-VOCABULARY (Drew, 2026-08-28, pokemon unification).
 *
 * Two pipelines built two identity vocabularies for the same sets:
 *
 *     derived   2022-pokemon-astral-radiance-...   (year-prefixed prose)
 *     checklist swsh10-astral-radiance             (TCG code)
 *
 * They share ZERO setKeys, which is why pokemon annotated 100.0% unconfirmed
 * while holding 111,892 checklist rows. The checklist vocabulary is canonical
 * -- the checklist is the spine -- so derived rows move onto it.
 *
 * A KEY MOVES ONLY ON A UNIQUE NAME MATCH. Both keys are normalized (year and
 * "pokemon" prefix stripped, TCG code prefix stripped, "japanese" folded) and a
 * derived key moves only when exactly one checklist key normalizes identically
 * AND the years agree on the rows being moved. Ambiguity is stamped and
 * reported, never guessed -- the measured split:
 *
 *     unique match   162 keys /  8,608 rows   <- this pass moves these
 *     ambiguous       90 keys                 <- reported for a ruling
 *     no match       614 keys / 69,294 rows   <- mostly 1995-97 Japanese
 *                                                vintage: ACQUISITION, not
 *                                                mapping. No source we hold
 *                                                covers them.
 *
 * The move is catalogRowOps.moveCatalogRow (D5 PR 2): copy before delete,
 * sales re-pointed before the old row goes, graded children of the old slug
 * retired, the searchable fields rebuilt, and a row already at the checklist
 * slug decided by authority -- a derived row never outvotes the spine.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS;
 *      CONCURRENCY=48; RUN_MINUTES=140; LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { moveCatalogRow, rebuildSearchFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
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
const SHARD_SCOPE = runnerShardScope({ label: "map-pokemon-setkeys-to-checklist" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();

const DERIVED = "(c.source='ingest-auto-seed' OR STARTSWITH(c.source,'sales-attested') " +
  "OR STARTSWITH(c.source,'sold-comps-stub') OR STARTSWITH(c.source,'catalog-explode') " +
  "OR STARTSWITH(c.source,'tree-builder'))";

/** tcgdex says lost-origin, pokemon-tcg-data says swsh11-lost-origin -- the
 *  same set twice WITHIN the checklist class. The code-prefixed form is
 *  strictly more specific, so it wins (only-improve). Two code-prefixed
 *  candidates, or none, stays ambiguous. */
const CODE = /^(swshp?|svp?|smp?|xyp?|bwp?|dpp?|pl|hgss|col|ex|base|neo|gym)[0-9]/;
const pickTarget = (targets) => {
  if (targets.size === 1) return [...targets][0];
  const coded = [...targets].filter((t) => CODE.test(t));
  return coded.length === 1 ? coded[0] : null;
};
/** Strip both vocabularies down to the set's bare name. */
const norm = (k) => String(k)
  .replace(/^\d{4}-pokemon-/, "")
  .replace(/^(swshp?|svp?|smp?|xyp?|bwp?|dpp?|pl|hgss|col|ex|base|neo|gym)\d*[a-z]?-/, "")
  .replace(/-japanese-/, "-").replace(/^japanese-/, "")
  // CF-ERA-IS-NOT-THE-SET (2026-08-28, pokemon scorecard). Derived keys carry
  // the ERA name the checklist keys encode as a code prefix:
  //   2024-pokemon-scarlet-violet-surging-sparks  vs  sv8-surging-sparks
  // Stripping the code (sv8-) but not the era (scarlet-violet-) left 47k rows
  // unconfirmed with their checklist one word away. Era names are a closed
  // list; stripped only at the START of the remaining key.
  .replace(/^(scarlet-violet|sword-shield|sun-moon|xy|black-white|diamond-pearl|platinum|heartgold-soulsilver|hgss|call-of-legends)-/, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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

  // the target vocabulary: checklist setKeys, grouped by normalized name
  const { resources: ck } = await retry(() => cat.items.query(
    `SELECT c.setKey, c.source, COUNT(1) AS n FROM c WHERE c.sport='pokemon' GROUP BY c.setKey, c.source`).fetchAll());
  const byNorm = new Map();
  for (const r of ck) {
    if (catalogAuthorityOf(r.source) !== "checklist" || !r.setKey) continue;
    const nk = norm(r.setKey);
    if (!byNorm.has(nk)) byNorm.set(nk, new Set());
    byNorm.get(nk).add(r.setKey);
  }

  const { resources: dk } = await retry(() => cat.items.query(
    `SELECT c.setKey, COUNT(1) AS n FROM c WHERE c.sport='pokemon' AND ${DERIVED} GROUP BY c.setKey`).fetchAll());
  const plan = [];
  let ambiguous = 0, noMatch = 0, noMatchRows = 0;
  const ambiguousEx = [];
  for (const r of dk.sort((a, b) => b.n - a.n)) {
    if (!r.setKey) continue;
    const targets = byNorm.get(norm(r.setKey));
    if (!targets) { noMatch++; noMatchRows += r.n; continue; }
    const picked = pickTarget(targets);
    if (!picked) { ambiguous++; if (ambiguousEx.length < 6) ambiguousEx.push(`${r.setKey} -> ${[...targets].slice(0, 3).join(" | ")}`); continue; }
    const target = picked;
    if (target !== r.setKey) plan.push({ from: r.setKey, to: target, n: r.n });
  }
  const mine = SLOTS > 1 ? plan.filter((_, i) => i % SLOTS === SLOT) : plan;
  console.log(`slot ${SLOT}/${SLOTS}  ${mine.length} of ${plan.length} mappable keys  ${APPLY ? "APPLY" : "REPORT ONLY"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ambiguous ${f(ambiguous)}   no-match ${f(noMatch)} keys / ${f(noMatchRows)} rows (acquisition)\n`);

  let scanned = 0, moved = 0, folded = 0, replaced = 0, redundant = 0, salesRepointed = 0, gradedRetired = 0, failed = 0, notReached = 0, malformed = 0, drifted = 0;
  let stopReason = null;

  for (const p of mine) {
    if (stopReason) break;
    let token;
    do {
      const page = await retry(() => cat.items.query({
        query: `SELECT * FROM c WHERE c.sport='pokemon' AND c.setKey=@k AND ${DERIVED}`,
        parameters: [{ name: "@k", value: p.from }],
      }, { maxItemCount: 300, continuationToken: token }).fetchNext());
      token = page.continuationToken;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (d) => {
          scanned++;
          try {
            const parts = String(d.id).split(":");
            if (parts.length < 7) { malformed++; return; }
            // The id is the truth: a row whose setKey FIELD drifted from its
            // own id still moves, resolved from the id segment.
            let from = parts[3], to = p.to;
            if (from !== p.from) {
              const t2 = byNorm.get(norm(from));
              const picked2 = t2 ? pickTarget(t2) : null;
              if (!picked2) { drifted++; return; }
              to = picked2;
            }
            if (from === to) {
              // The id already speaks the checklist vocabulary; only the
              // FIELD is stale. Heal the field (and the searchable fields
              // built from it) rather than skip the row.
              if (d.setKey !== to && APPLY) {
                const s = rebuildSearchFields({ ...d, setKey: to });
                await retry(() => cat.item(d.id, d.cardId ?? d.id).patch([
                  { op: "set", path: "/setKey", value: to },
                  ...Object.entries(s).map(([k, v]) => ({ op: "set", path: `/${k}`, value: v })),
                ]));
              }
              redundant++;
              return;
            }
            parts[3] = to;
            // CF-FOLD-IS-A-MOVE (2026-08-29). A fold (the checklist row keeps
            // its address) and a replace (this row outranked the incumbent)
            // are both a move -- the derived row is gone, its sales follow --
            // counted once as moved; folded/replaced are slices, not siblings.
            // Counting a fold as redundant too charged one row to two axes
            // (OVER by 2,138).
            const r = await moveCatalogRow(cat, d, parts.join(":"), { setKey: to }, {
              reason: "pokemon setKey unified to checklist vocabulary", repointNormalizedSetKey: true, dryRun: !APPLY, salesContainer: comps, retry,
            });
            salesRepointed += r.salesRepointed; gradedRetired += r.gradedChildrenRetired;
            if (r.action === "fold") folded++;
            else if (r.action === "replace") { replaced++; if (replaced <= 3) console.log(`  replaced at ${r.newSlug.slice(0, 58)}: ${r.decision}`); }
            moved++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 58)}: ${String(e.message || e).slice(0, 58)}`);
          }
        }));
        const processed = Math.min(i + CONCURRENCY, page.resources.length);
        if (LIMIT && moved >= LIMIT) { stopReason = "limit"; notReached += page.resources.length - processed; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += page.resources.length - processed; break; }
      }
      if (stopReason) break;
    } while (token);
    process.stderr.write(`\r  ${p.from.slice(0, 42)} -> ${p.to.slice(0, 30)}  moved=${f(moved)}   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  derived rows scanned    ${f(scanned)}`);
  console.log(`  MOVED to checklist key  ${f(moved)}`);
  console.log(`  ...folded into existing ${f(folded)}   <- slice of MOVED`);
  console.log(`  ...replaced existing    ${f(replaced)}   <- slice of MOVED; this row outranked it`);
  console.log(`  redundant (row existed) ${f(redundant)}`);
  console.log(`  sales re-pointed        ${f(salesRepointed)}`);
  console.log(`  graded children retired ${f(gradedRetired)}`);
  console.log(`  malformed id (left)     ${f(malformed)}`);
  console.log(`  drifted, unmappable     ${f(drifted)}`);
  console.log(`  failed                  ${f(failed)}`);
  if (ambiguousEx.length) {
    console.log(`\n  ambiguous keys, for a ruling:`);
    for (const e of ambiguousEx) console.log(`    ${e.slice(0, 96)}`);
  }
  if (APPLY) {
    reportWrites({
      job: "map-pokemon-setkeys-to-checklist", intended: scanned, written: moved,
      skipped: redundant + notReached + malformed + drifted, failed,
    });
  }
}

module.exports = { norm };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
