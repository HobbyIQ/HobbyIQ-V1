#!/usr/bin/env node
/**
 * CF-A-NUMBER-GLUED-TO-ITS-TOTAL (Drew, 2026-08-28, pokemon unification).
 *
 * pokemon-tcg-data checklist rows store "026189" where the card is 026/189 --
 * the printed number CONCATENATED with the set's printed total, sometimes
 * zero-padded to 3+3, sometimes not ("26189"). A sale says "154"; the checklist
 * says "154165"; card-level confirmation can never meet. This is why pokemon
 * annotated 100.0% unconfirmed while holding 111,892 checklist rows.
 *
 * THE TOTAL IDENTIFIES ITSELF. Within one set every card shares the same
 * printedTotal, so the constant trailing digits of a set's numbers ARE the
 * total. No external lookup: for suffix lengths 4..2, if one suffix value
 * covers >= 90% of the set's numeric card numbers, that suffix is the total
 * and the prefix (leading zeros stripped) is the card number.
 *
 * WHAT IT REFUSES:
 *   - a set with no dominant suffix is REPORTED, not guessed
 *   - non-numeric numbers (TG09, promos) are left untouched
 *   - a prefix that strips to nothing, or exceeds the total, disqualifies the
 *     ROW (secret rares exceed the total legitimately -- kept, flagged)
 *
 * The re-slug is catalogRowOps.moveCatalogRow (D5 PR 2): copy before delete,
 * sales re-pointed first, graded children of the old slug retired, a row
 * already at the clean number decided by authority. printedTotal is kept on
 * the row as its own field -- it is real information, just not a card number.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS;
 *      CONCURRENCY=48; RUN_MINUTES=140; LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));

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
const SHARD_SCOPE = runnerShardScope({ label: "repair-pokemon-glued-numbers" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();

/** The dominant constant suffix of a set's numeric card numbers, or null. */
function deriveTotal(numbers) {
  const numeric = numbers.filter((n) => /^\d{4,7}$/.test(n));
  if (numeric.length < 10) return null;
  for (const len of [4, 3, 2]) {
    const tally = new Map();
    for (const n of numeric) {
      if (n.length <= len) continue;
      const suf = n.slice(-len);
      tally.set(suf, (tally.get(suf) ?? 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= numeric.length * 0.9) return top[0];
  }
  return null;
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

  const { resources: sets } = await retry(() => cat.items.query(
    `SELECT c.setKey, COUNT(1) AS n FROM c WHERE c.sport='pokemon'
     AND STARTSWITH(c.source,'pokemon-tcg-data') GROUP BY c.setKey`).fetchAll());
  const all = sets.filter((s) => s.setKey).sort((a, b) => b.n - a.n || String(a.setKey).localeCompare(String(b.setKey)));
  const mine = SLOTS > 1 ? all.filter((_, i) => i % SLOTS === SLOT) : all;
  console.log(`slot ${SLOT}/${SLOTS}  ${mine.length} sets  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, repaired = 0, folded = 0, replaced = 0, salesRepointed = 0, gradedRetired = 0, noSuffix = 0, nonNumeric = 0, secretRare = 0, failed = 0, notReached = 0;
  const noSuffixEx = [];
  let stopReason = null;

  for (const s of mine) {
    if (stopReason) break;
    const { resources: rows } = await retry(() => cat.items.query({
      query: `SELECT c.id, c.cardId, c.cardNumber FROM c
              WHERE c.sport='pokemon' AND c.setKey=@k AND STARTSWITH(c.source,'pokemon-tcg-data')`,
      parameters: [{ name: "@k", value: s.setKey }],
    }).fetchAll());
    const total = deriveTotal(rows.map((r) => String(r.cardNumber)));
    if (!total) {
      noSuffix++;
      if (noSuffixEx.length < 6) noSuffixEx.push(`${s.setKey} (${rows.length} rows)`);
      scanned += rows.length;
      continue;
    }

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          const num = String(d.cardNumber);
          if (!/^\d{4,7}$/.test(num)) { nonNumeric++; return; }
          if (!num.endsWith(total) || num.length <= total.length) {
            // Secret rares run past the printed total ("205/165" glues without
            // the set's suffix). Real cards; flagged, not mangled.
            secretRare++;
            return;
          }
          const bare = String(Number(num.slice(0, -total.length)));
          if (!bare || bare === "0" || bare === "NaN") { failed++; return; }
          const parts = String(d.id).split(":");
          if (parts.length < 7) { failed++; return; }
          parts[4] = bare;
          const newSlug = parts.join(":");
          if (newSlug === d.id) return;

          // The listing is a projection; the move needs the whole row.
          const { resource: full } = await retry(() => cat.item(d.id, d.cardId ?? d.id).read());
          if (!full) return;
          const r = await moveCatalogRow(cat, full, newSlug, { cardNumber: bare, printedTotal: Number(total) }, {
            reason: "pokemon number unglued from printed total", dryRun: !APPLY, salesContainer: comps, retry,
          });
          salesRepointed += r.salesRepointed; gradedRetired += r.gradedChildrenRetired;
          // a row already sat at the clean number: folded onto it, or replaced it -- slices of UNGLUED
          if (r.action === "fold") folded++;
          else if (r.action === "replace") { replaced++; if (replaced <= 3) console.log(`  replaced at ${r.newSlug.slice(0, 58)}: ${r.decision}`); }
          repaired++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 58)}: ${String(e.message || e).slice(0, 58)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, rows.length);
      if (LIMIT && repaired >= LIMIT) { stopReason = "limit"; notReached += rows.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += rows.length - processed; break; }
    }
    process.stderr.write(`\r  ${s.setKey}  /${total}  scanned=${f(scanned)} repaired=${f(repaired)}   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned            ${f(scanned)}`);
  console.log(`  numbers UNGLUED         ${f(repaired)}`);
  console.log(`  ...folded onto existing ${f(folded)}   <- slice of UNGLUED; the row at the clean number kept its address`);
  console.log(`  ...replaced existing    ${f(replaced)}   <- slice of UNGLUED; this row outranked it`);
  console.log(`  sales re-pointed        ${f(salesRepointed)}`);
  console.log(`  graded children retired ${f(gradedRetired)}`);
  console.log(`  non-numeric (kept)      ${f(nonNumeric)}   <- TG09, promos: already real numbers`);
  console.log(`  secret rares (kept)     ${f(secretRare)}   <- run past the total; real cards`);
  console.log(`  sets with no suffix     ${f(noSuffix)}   <- reported, never guessed`);
  console.log(`  failed                  ${f(failed)}`);
  for (const e of noSuffixEx) console.log(`      ${e}`);
  if (APPLY) {
    reportWrites({
      job: "repair-pokemon-glued-numbers", intended: scanned, written: repaired,
      skipped: nonNumeric + secretRare + notReached, failed,
    });
  }
}

module.exports = { deriveTotal };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
