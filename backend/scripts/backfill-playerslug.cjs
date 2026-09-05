#!/usr/bin/env node
/**
 * CF-A-KEY-NEEDS-BOTH-HALVES (Drew, 2026-08-28: "how can we get a better
 * baseball match").
 *
 * 65% of sampled unconfirmed baseball rows are PLAYER-KEY-ONLY misses: the
 * checklist holds the card at (year, setKey, cardNumber), but its rows carry
 * NO playerSlug -- the field predates the identity standard -- so the
 * cardNumber|playerSlug key can never meet. 2015-2021 Topps flagship, the
 * biggest unconfirmed products, are exactly this shape.
 *
 * The fix is derivation, not invention: playerSlug := slugify(playerName)
 * wherever playerName exists and the slug does not. The name is the
 * checklist's own word; the slug is its indexable form. Rows with no
 * playerName stay untouched -- there is nothing to derive from.
 *
 * Resumable by its own predicate (the missing field IS the work list), so a
 * relaunch that scans zero rows is a finished slot.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS;
 *      CONCURRENCY=64; RUN_MINUTES=140; LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 64));
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "backfill-playerslug" });
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
const slugify = (s) => String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");
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

  console.log(`slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  let scanned = 0, written = 0, emptyName = 0, failed = 0, notReached = 0;
  let stopReason = null;
  let token;
  do {
    const page = await retry(() => cat.items.query({
      // MODE=flagship scopes to the products where the scorecard's
      // unconfirmed rows actually live -- 21M rows at fleet rates is 20
      // hours, and the 14 Topps-family products that dominate the
      // unconfirmed list do not need to wait behind vendor-row cosmetics.
      query: `SELECT c.id, c.cardId, c.playerName, c.searchTokens FROM c
              WHERE IS_DEFINED(c.playerName) AND c.playerName != null
                AND (NOT IS_DEFINED(c.playerSlug) OR c.playerSlug = null OR c.playerSlug = "")${
                  String(process.env.MODE || "").toLowerCase() === "flagship"
                    ? " AND c.sport = 'baseball' AND (c.setKey = 'topps' OR STARTSWITH(c.setKey, 'topps-series') OR STARTSWITH(c.setKey, 'topps-update') OR c.setKey = 'topps-allen-and-ginter')"
                    : ""
                }`,
    }, { maxItemCount: 500, continuationToken: token }).fetchNext());
    token = page.continuationToken;

    const mine = SLOTS > 1 ? page.resources.filter((_, i) => (i + scanned) % SLOTS === SLOT) : page.resources;
    scanned += page.resources.length - mine.length;

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          const ps = slugify(d.playerName);
          if (!ps) { emptyName++; return; }
          if (!APPLY) { written++; return; }
          const tok = new Set((Array.isArray(d.searchTokens) ? d.searchTokens : []).map((x) => String(x).toLowerCase()).filter(Boolean));
          for (const w of ps.split("-")) if (w) tok.add(w);
          await retry(() => cat.item(d.id, d.cardId ?? d.id).patch([
            { op: "set", path: "/playerSlug", value: ps },
            { op: "set", path: "/searchTokens", value: [...tok] },
          ]));
          written++;
        } catch (e) {
          if (e.code === 404) return;
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 58)}: ${String(e.message || e).slice(0, 58)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && written >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (stopReason) break;
  } while (token);

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned           ${f(scanned)}`);
  console.log(`  playerSlug derived     ${f(written)}`);
  console.log(`  name slugified empty   ${f(emptyName)}`);
  console.log(`  failed                 ${f(failed)}`);
  if (APPLY) {
    reportWrites({ job: "backfill-playerslug", intended: scanned, written, skipped: emptyName + notReached, failed });
  }
}

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack ?? e?.message); 
    await finishLane(3);
  });
}
