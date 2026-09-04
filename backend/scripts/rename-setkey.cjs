#!/usr/bin/env node
/**
 * rename-setkey.cjs -- apply ONE ruled setKey rename, by Drew's word only.
 *
 * CF-RULED-RENAME (Drew, 2026-08-29 checklist B3): `topps-allen-ginter` and
 * `topps-allen-and-ginter` are one product spelled two ways. Counted by SOURCE
 * (never by raw rows -- vendor-only keys flatter themselves): 656,161 checklist
 * rows say "allen-and-ginter" (baseballcardpedia, Beckett), 71,472 say
 * "allen-ginter" (checklistcenter, insider, cardboardchecklist). The majority
 * checklist form is canonical.
 *
 * This script knows nothing about which keys are twins. FROM and TO come from
 * the dispatch; the caller carries the ruling. It never guesses a family
 * (bowman-chrome != bowman stays inviolate).
 *
 * Per identity row with setKey=FROM (and sport=SPORT): newSlug = the id with
 * segment 3 rewritten, then catalogRowOps.moveCatalogRow (D5 PR 2) does the
 * move -- copy, re-point sales, retire graded children of the old slug, delete
 * old -- and decides a collision at newSlug by authority (checklist > vendor >
 * derived; then vendorIds, sales, confidence):
 *   no row at newSlug            -> moved
 *   the incumbent keeps the slug -> folded (its vendorIds unioned with ours)
 *   this row outranks it         -> replaced
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; FROM; TO; SPORT;
 *      SLOT/SLOTS (hash of id); CONCURRENCY=16; RUN_MINUTES=140; LIMIT.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(__dirname, "..", "dist", "services", "ops", "writeReconciliation.js"));
const { moveCatalogRow } = require(path.join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// The runner carries the ruling in `scope` as "sport:from>to", e.g.
// "baseball:topps-allen-ginter>topps-allen-and-ginter"; FROM/TO/SPORT env win if set.
const ruling = String(process.env.RULING || process.env.SCOPE || "");
const rm = ruling.match(/^([a-z0-9-]+):([a-z0-9-]+)>([a-z0-9-]+)$/i);
const SPORT = String(process.env.SPORT || (rm ? rm[1] : "")).toLowerCase();
const FROM = String(process.env.FROM || (rm ? rm[2] : "")).toLowerCase();
const TO = String(process.env.TO || (rm ? rm[3] : "")).toLowerCase();
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
const SHARD_SCOPE = runnerShardScope({ label: "rename-setkey" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 16));
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;

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
  if (!SPORT || !FROM || !TO || FROM === TO) { console.error("FATAL: need a ruling — SCOPE='sport:from>to' (or FROM/TO/SPORT env), from != to"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  console.log(`RULING ${SPORT}: ${FROM} -> ${TO}   slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY" : "REPORT ONLY"}  budget ${RUN_MS / 60000}m\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, otherShards = 0, moved = 0, folded = 0, replaced = 0, malformed = 0, salesRepointed = 0, gradedDeleted = 0, failed = 0, notReached = 0;
  let stopReason = null, token;
  const query = { query: "SELECT * FROM c WHERE c.sport = @sp AND c.setKey = @k AND NOT IS_DEFINED(c.gradeTier)", parameters: [{ name: "@sp", value: SPORT }, { name: "@k", value: FROM }] };

  do {
    const page = await retry(() => cat.items.query(query, { maxItemCount: 200, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    const mine = page.resources.filter((d) => shardOf(d.id) === SLOT);
    otherShards += page.resources.length - mine.length;
    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          const parts = String(d.id).split(":");
          if (parts.length < 7 || parts[3] !== FROM) { malformed++; return; }
          parts[3] = TO;
          const r = await moveCatalogRow(cat, d, parts.join(":"), { setKey: TO }, {
            reason: `ruled setKey rename ${FROM} -> ${TO}`, repointNormalizedSetKey: true, dryRun: !APPLY, salesContainer: pool, retry,
          });
          salesRepointed += r.salesRepointed; gradedDeleted += r.gradedChildrenRetired;
          if (r.action === "move") moved++; else if (r.action === "fold") folded++; else if (r.action === "replace") replaced++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 70)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && (moved + folded + replaced) >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (stopReason) break;
  } while (token);

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned (this slot)   ${f(scanned)}   (+${f(otherShards)} belonging to other slots)`);
  console.log(`  MOVED to ${TO.padEnd(24)} ${f(moved)}`);
  console.log(`  FOLDED (target had it)     ${f(folded)}`);
  console.log(`  REPLACED a lower twin      ${f(replaced)}`);
  console.log(`  sales re-pointed           ${f(salesRepointed)}`);
  console.log(`  graded children deleted    ${f(gradedDeleted)}`);
  console.log(`  malformed id (left)        ${f(malformed)}`);
  console.log(`  failed                     ${f(failed)}`);
  if (APPLY) reportWrites({ job: "rename-setkey", intended: scanned, written: moved + folded + replaced, skipped: malformed + notReached, failed });
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
