#!/usr/bin/env node
/**
 * fold-unnumbered-twins.cjs -- a key needs both halves: an UN-NUMBERED catalog
 * row minted by a sale, a vendor or a user folds into the ONE numbered
 * checklist row that is the same card.
 *
 * CF-A-KEY-NEEDS-BOTH-HALVES (Drew, 2026-08-29, holding ca7a150b). The 2026
 * Bowman Chrome CPA-MG Marconi German Gold Refractor holding sits at
 * `…:gold-refractor:auto` -- a user-seeded catalog row with printRun null --
 * while the checklist row is `…:gold-refractor:auto:num-50`. Because the
 * un-numbered twin EXISTS, exact matching finds it first: the holding never
 * reaches the checklist card, its three real sales pool under the twin, and
 * the cross-setkey rung was free to admit a paper-Bowman /75 comp. The
 * numbered checklist row is the identity; the un-numbered twin is the seller
 * omitting "/50".
 *
 * THE RULE (the same one merge-unambiguous-printrun applies to the pool):
 *   exactly ONE numbered CHECKLIST-source row at `<id>:num-N`, and NO
 *   un-numbered checklist row at `<id>`  -> FOLD the twin into it
 *   two or more numbered variants        -> LEAVE ALONE (which /N was it? --
 *                                           guessing is worse than the split)
 *   the un-numbered row is itself checklist-source -> LEAVE ALONE (the
 *                                           checklist lists both; numbered
 *                                           Base is checklist-defined)
 *
 * The fold goes through moveCatalogRow (#1417): the checklist row survives by
 * authority, vendorIds union, sales re-pointed BEFORE the twin is deleted,
 * the twin's graded children retired (numbered-sibling-safe). Holdings are
 * NOT touched here -- conform-holdings-to-catalog re-derives them once the
 * twin is gone (the exact un-numbered id no longer exists to "agree" with).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (report only
 *      by default); SLOT/SLOTS (hash shards on the twin id); RUN_MINUTES=140;
 *      SPORT (optional filter); LIMIT=0.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { moveCatalogRow } = require(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist", "services", "catalog", "catalogAuthority.service.js"));
const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const SLOT = Number(process.env.SLOT || 0), SLOTS = Number(process.env.SLOTS || 1);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const SPORT = String(process.env.SPORT || "").toLowerCase();
const LIMIT = Number(process.env.LIMIT || 0);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const isChecklist = (source) => catalogAuthorityOf(String(source ?? "")) === "checklist";
const NUM_SEG = /:num-\d+(?::|$)/;

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  console.log(`fold-unnumbered-twins  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m${SPORT ? `  sport=${SPORT}` : ""}`);

  // Pass 1: every NUMBERED checklist identity row, grouped by its un-numbered
  // base id. Only groups with exactly one /N are candidates.
  const numberedByBase = new Map(); // baseId -> [{ id, printRun, source }]
  {
    const q = { query: `SELECT c.id, c.printRun, c.source FROM c WHERE STARTSWITH(c.id, "hiq:") AND NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.printRun) AND c.printRun != null${SPORT ? " AND c.sport = @sp" : ""}`, parameters: SPORT ? [{ name: "@sp", value: SPORT }] : [] };
    const it = cat.items.query(q, { maxItemCount: 1000 });
    let n = 0;
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        n++;
        if (!isChecklist(r.source)) continue;
        const m = String(r.id).match(/^(.*):num-(\d+)$/);
        if (!m) continue;
        const list = numberedByBase.get(m[1]) ?? [];
        list.push({ id: r.id, printRun: Number(m[2]), source: r.source });
        numberedByBase.set(m[1], list);
      }
    }
    console.log(`  pass 1: ${f(n)} numbered identity rows read; ${f(numberedByBase.size)} base ids carry a checklist /N`);
  }
  const unique = new Map();
  for (const [base, list] of numberedByBase) if (new Set(list.map((x) => x.printRun)).size === 1) unique.set(base, list[0]);
  console.log(`  ${f(unique.size)} of them have exactly ONE numbered variant (the rest are ambiguous and left alone)`);

  // Pass 2: for each candidate, does an un-numbered twin exist, and is it
  // NOT itself a checklist row? Point reads on the twin id (partition = id).
  const stats = { candidates: 0, otherShard: 0, noTwin: 0, twinIsChecklist: 0, folded: 0, salesRepointed: 0, gradedRetired: 0, failed: 0, notReached: 0 };
  const examples = [];
  let stopReason = null;
  let i = 0;
  for (const [base, numbered] of unique) {
    if (LIMIT && i >= LIMIT) { stats.notReached += unique.size - i; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; stats.notReached += unique.size - i; break; }
    i++;
    if (SLOTS > 1 && shardOf(base) !== SLOT) { stats.otherShard++; continue; }
    stats.candidates++;
    let twin = null;
    try { twin = (await retry(() => cat.item(base, base).read())).resource ?? null; } catch (e) { if (e?.code !== 404) { stats.failed++; continue; } }
    if (!twin) { stats.noTwin++; continue; }
    if (isChecklist(twin.source)) { stats.twinIsChecklist++; continue; }
    if (examples.length < 20) examples.push(`  ${base}  [${twin.source}] -> ${numbered.id}  [${numbered.source}]`);
    try {
      const res = await moveCatalogRow(cat, twin, numbered.id, { printRun: numbered.printRun }, { reason: "un-numbered twin folded into its one numbered checklist row (CF-A-KEY-NEEDS-BOTH-HALVES)", dryRun: !APPLY, salesContainer: pool, retry });
      stats.folded++;
      stats.salesRepointed += res?.salesRepointed ?? 0;
      stats.gradedRetired += res?.gradedChildrenRetired ?? 0;
    } catch (e) { stats.failed++; if (stats.failed <= 5) console.log(`  failed ${base}: ${String(e.message).slice(0, 100)}`); }
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  candidates (this slot)   ${f(stats.candidates)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  no un-numbered twin      ${f(stats.noTwin)}`);
  console.log(`  twin is checklist        ${f(stats.twinIsChecklist)}   <- the checklist lists both; left alone`);
  console.log(`  ${APPLY ? "FOLDED" : "WOULD FOLD"}                   ${f(stats.folded)}   <- sales re-pointed ${f(stats.salesRepointed)}, graded children retired ${f(stats.gradedRetired)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "fold-unnumbered-twins", intended: stats.candidates, written: stats.folded, skipped: stats.noTwin + stats.twinIsChecklist, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
