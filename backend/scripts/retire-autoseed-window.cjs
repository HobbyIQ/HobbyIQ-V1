#!/usr/bin/env node
/**
 * CF-RETIRE-WHAT-THE-EMISSION-MINTED (Drew, 2026-08-28: "want to make sure
 * the card catalog is not writing from sales index").
 *
 * The one-pool emission lowered the catalog-match gate per call so unmatched
 * vendor sales could enter the pool — and recordSoldComp's fire-and-forget
 * ensureCatalogRow minted a sales-derived catalog row for each one:
 * 7,679 ingest-auto-seed rows in twenty minutes, exactly the self-confirming
 * class this rebuild exists to end. The writer is fixed (#1353: vendor sales
 * never mint cards). This retires what it minted in that window.
 *
 * NARROW BY CONSTRUCTION: source = ingest-auto-seed AND observedAt inside the
 * window, AND zero sales point at the row. A row a sale points at is left and
 * reported — its sale is the unmatched one, and the rematch owns it. Copy
 * nothing, invent nothing: this only deletes rows that a sale minted and no
 * sale needs.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SINCE (ISO, default
 *      2026-08-29T01:40:00Z); UNTIL (ISO, default now); CONCURRENCY=32;
 *      RUN_MINUTES=140; LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const SINCE = process.env.SINCE || "2026-08-29T01:40:00Z";
const UNTIL = process.env.UNTIL || new Date().toISOString();
// CF-RETIRE-UNCONFIRMED (Drew, 2026-08-29 "do it"). SCOPE=unconfirmed (or the
// runner's MODE=unconfirmed) retires every sale-minted row the annotation judged
// unconfirmed -- no checklist card behind it, any sport, no time window. The
// card-confirmed sale-minted rows are NOT touched: they are real cards whose
// rung the ladders will fold; Ohtani's 2018 Topps Chrome Refractor is one.
// The runner exports SCOPE=refractor by default (repair-refractor-mislabel's
// input), so MODE must outrank SCOPE here or the unconfirmed pass silently
// runs the window pass (dry run 33252844937 did exactly that).
const SCOPE = [String(process.env.MODE || ""), String(process.env.SCOPE || "")].map((v) => v.toLowerCase()).includes("unconfirmed") ? "unconfirmed" : "window";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const LIMIT = Number(process.env.LIMIT || 0);
// CF-RETIRE-SHARDS (2026-08-29). The unconfirmed pass is 383,803 rows with
// 238,640 pointing sales -- hours of work; one slot in one 140-minute budget
// cannot finish it. Rows shard by a hash of their id; a budget stop prints the
// line the runner's relaunch step greps for.
const crypto = require("crypto");
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
const SHARD_SCOPE = runnerShardScope({ label: "retire-autoseed-window" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const f = (n) => Number(n).toLocaleString();

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), comps = db.container("sold_comps");
  const retry = async (fn, tries = 10) => {
    let wait = 800;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 20000);
      }
    }
  };

  console.log(`slot ${SLOT}/${SLOTS}  ` + (SCOPE === "unconfirmed" ? `scope UNCONFIRMED sale-minted rows (any sport, any time)  ${APPLY ? "APPLY (deletes)" : "REPORT ONLY"}
` : `window ${SINCE} .. ${UNTIL}  ${APPLY ? "APPLY (deletes)" : "REPORT ONLY"}
`));
  let scanned = 0, retired = 0, keptHasSales = 0, failed = 0, notReached = 0;
  let stopReason = null;
  let token;
  do {
    const page = await retry(() => cat.items.query({
      query: SCOPE === "unconfirmed"
        ? "SELECT c.id, c.cardId FROM c WHERE c.source = 'ingest-auto-seed' AND c.checklistBacking = 'unconfirmed' AND NOT IS_DEFINED(c.gradeTier)"
        : "SELECT c.id, c.cardId FROM c WHERE c.source = 'ingest-auto-seed' AND c.observedAt >= @since AND c.observedAt <= @until",
      parameters: SCOPE === "unconfirmed" ? [] : [{ name: "@since", value: SINCE }, { name: "@until", value: UNTIL }],
    }, { maxItemCount: 300, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    const mine = SLOTS > 1 ? page.resources.filter((d) => shardOf(d.id) === SLOT) : page.resources;
    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          // A sale pointing at one of these rows is not a reason to keep the
          // row: the row was minted BY that sale at the sale's own parser slug
          // (6,897 of 6,933 in the dry run). Under the ruling the sale stays
          // UNPLACED -- catalogMatched=false -- and the rematch re-resolves it
          // when its checklist lands. So the pointing sales are stamped, then
          // the sale-minted row is retired.
          const { resources: sales } = await retry(() => comps.items.query({
            query: "SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @s",
            parameters: [{ name: "@s", value: d.id }],
          }).fetchAll());
          if (sales.length) keptHasSales++;   // counted as "had sales", not kept
          if (!APPLY) { retired++; return; }
          for (const s of sales) {
            await retry(() => comps.item(s.id, s.cardId).patch([
              { op: "set", path: "/catalogMatched", value: false },
              { op: "set", path: "/catalogUnplacedReason", value: SCOPE === "unconfirmed" ? "sale-minted row retired (unconfirmed by any checklist); acquisition list" : "sale-minted row retired; awaiting checklist" },
            ])).catch(() => { /* a missed stamp costs nothing; the rematch re-resolves regardless */ });
          }
          await retry(() => cat.item(d.id, d.cardId ?? d.id).delete()).catch((e) => { if (e.code !== 404) throw e; });
          retired++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 60)}: ${String(e.message || e).slice(0, 60)}`);
        }
      }));
  console.log(`  ${SHARD_SCOPE.banner()}`);
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && retired >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += page.resources.length - processed; break; }
    }
    if (stopReason) break;
  } while (token);

  if (stopReason) console.log(`\nstopped at ${stopReason}`);
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing deleted"}`);
  console.log(`  rows scanned                 ${f(scanned)}`);
  console.log(`  RETIRED (sale-minted, unused) ${f(retired)}`);
  console.log(`  ...that a sale pointed at    ${f(keptHasSales)}   <- sale stamped unplaced; the rematch owns it`);
  console.log(`  failed                       ${f(failed)}`);
  if (APPLY) reportWrites({ job: "retire-autoseed-window", intended: scanned, written: retired, skipped: notReached, failed });
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message); process.exit(3); });
}
