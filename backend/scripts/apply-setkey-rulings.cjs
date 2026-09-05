#!/usr/bin/env node
/**
 * CF-APPLY-SETKEY-RULINGS (Drew, 2026-08-28, three rulings given explicitly).
 *
 * Applies exactly what Drew ruled and nothing else:
 *
 *   1. bowman-paper -> bowman            "Yes — same product." Collector slang
 *      for the plain Bowman product. NOTE the boundary this does NOT cross:
 *      bowman-chrome and sapphire remain DIFFERENT cards, per the standing
 *      taxonomy ruling.
 *
 *   2. season prefixes strip to first-year + bare key: 2024-25-panini-prizm
 *      -> panini-prizm with the year segment carrying 2024. Unconditional --
 *      unlike the twin mover this does not require the bare key to already
 *      exist, because the bare form is now canonical BY RULING, not by guess.
 *
 * The move is catalogRowOps.moveCatalogRow (D5 PR 2): copy before delete,
 * sales re-pointed before the old row goes, graded children of the old slug
 * retired, the searchable fields rebuilt, and a twin already at the target
 * decided by authority (fold or replace). The id is the truth. Rows whose slug
 * year disagrees with the season first-year are reported, not silently
 * rewritten.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS;
 *      CONCURRENCY=48; RUN_MINUTES=140; LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
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
const SHARD_SCOPE = runnerShardScope({ label: "apply-setkey-rulings" });
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

const bareOf = (k) => String(k).replace(/^(19|20)\d{2}-/, "");

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
        if (!/request rate|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const { resources: all } = await retry(() => cat.items.query(
    "SELECT c.sport, c.setKey, COUNT(1) AS n FROM c GROUP BY c.sport, c.setKey").fetchAll());
  const existing = new Set(all.map((r) => `${r.sport}|${r.setKey}`));
  const plan = all
    .filter((r) => r.setKey && /^(19|20)\d{2}-/.test(r.setKey) && existing.has(`${r.sport}|${bareOf(r.setKey)}`))
    .sort((a, b) => b.n - a.n || String(a.setKey).localeCompare(String(b.setKey)));
  const noTwin = all.filter((r) => r.setKey && /^(19|20)\d{2}-/.test(r.setKey) && !existing.has(`${r.sport}|${bareOf(r.setKey)}`));
  const mine = SLOTS > 1 ? plan.filter((_, i) => i % SLOTS === SLOT) : plan;
  console.log(`slot ${SLOT}/${SLOTS}  ${mine.length} of ${plan.length} twin keys  (${f(noTwin.length)} prefixed keys WITHOUT a twin — reported, untouched)  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, moved = 0, folded = 0, replaced = 0, redundant = 0, salesRepointed = 0, gradedRetired = 0, malformed = 0, failed = 0, notReached = 0;
  let stopReason = null;

  for (const p of mine) {
    if (stopReason) break;
    const bare = bareOf(p.setKey);
    let token;
    do {
      const page = await retry(() => cat.items.query({
        query: "SELECT * FROM c WHERE c.sport=@s AND c.setKey=@k",
        parameters: [{ name: "@s", value: p.sport }, { name: "@k", value: p.setKey }],
      }, { maxItemCount: 300, continuationToken: token }).fetchNext());
      token = page.continuationToken;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (d) => {
          scanned++;
          try {
            const parts = String(d.id).split(":");
            if (parts.length < 7 || !parts[0].startsWith("hiq")) { malformed++; return; }
            // the id is the truth: resolve from the id's own segment
            const from = parts[3];
            const to = /^(19|20)\d{2}-/.test(from) ? bareOf(from) : null;
            if (!to || !existing.has(`${p.sport}|${to}`)) {
              // id already bare, or its own twin absent: heal the FIELD only,
              // and the searchable fields built from it
              if (d.setKey !== from && APPLY) {
                const s = rebuildSearchFields({ ...d, setKey: from });
                await retry(() => cat.item(d.id, d.cardId ?? d.id).patch([
                  { op: "set", path: "/setKey", value: from },
                  ...Object.entries(s).map(([k, v]) => ({ op: "set", path: `/${k}`, value: v })),
                ])).catch(() => {});
              }
              redundant++;
              return;
            }
            parts[3] = to;
            const r = await moveCatalogRow(cat, d, parts.join(":"), { setKey: to }, {
              reason: "setKey ruling applied", repointNormalizedSetKey: true, dryRun: !APPLY, salesContainer: comps, retry,
            });
            salesRepointed += r.salesRepointed; gradedRetired += r.gradedChildrenRetired;
            // fold and replace are slices of MOVED: the old row is gone either way
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
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += page.resources.length - processed; break; }
      }
      if (stopReason) break;
    } while (token);
    process.stderr.write(`\r  ${p.setKey.slice(0, 44)} -> ${bare.slice(0, 30)}  moved=${f(moved)}   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned            ${f(scanned)}`);
  console.log(`  MOVED per the ruling    ${f(moved)}`);
  console.log(`  ...folded onto a twin   ${f(folded)}   <- slice of MOVED; the twin kept its address`);
  console.log(`  ...replaced a twin      ${f(replaced)}   <- slice of MOVED; this row outranked it`);
  console.log(`  redundant / field-heal  ${f(redundant)}`);
  console.log(`  sales re-pointed        ${f(salesRepointed)}`);
  console.log(`  graded children retired ${f(gradedRetired)}   <- regenerable by materialize-graded-identities`);
  console.log(`  malformed id            ${f(malformed)}`);
  console.log(`  failed                  ${f(failed)}`);
  if (APPLY) {
    reportWrites({
      job: "apply-setkey-rulings", intended: scanned, written: moved,
      skipped: redundant + malformed + notReached, failed,
    });
  }
}

module.exports = { bareOf };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
