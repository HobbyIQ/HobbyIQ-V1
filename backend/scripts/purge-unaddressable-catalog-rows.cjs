#!/usr/bin/env node
/**
 * purge-unaddressable-catalog-rows.cjs
 *
 * card_catalog holds 81,714 rows (measured 2026-08-30) whose id carries a
 * character the Cosmos SDK refuses in a resource id ('/', '\', '#', '?'):
 * old-scheme ids such as `variant::hiq:baseball:2018:bowman:108/165:base:no-auto`
 * where a print run was parsed as the card number. Nothing can point-read,
 * replace or delete them (`item(id).read()` throws "Illegal characters"), so
 * every repair and retire job fails on them forever, no holding points at
 * them, and the checklist never minted them (bccp / tree-builder-v1 / pool).
 *
 * The only door is the server: a stored procedure deletes by the row's own
 * `_self` link inside its partition. This script creates/replaces that
 * procedure on APPLY, then walks the rows shard by partition key and purges
 * them one partition at a time.
 *
 * Guards (refusals, reported on their own lines, never folded into skipped):
 *   - a row whose source is not in PURGE_SOURCES (default the three measured
 *     sources) is REFUSED — a whole-scope delete needs its names;
 *   - a row any holding points at is REFUSED (cardId or hobbyiqCardId);
 *   - REPORT ONLY unless BACKFILL_APPLY=true; the dry run does not create the
 *     stored procedure.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY; PURGE_SOURCES; SLOT/SLOTS
 *      (hash of the partition key); CONCURRENCY=8 partitions in flight;
 *      RUN_MINUTES=140 (prints the budget marker the runner relaunches on);
 *      LIMIT (rows, bounded run).
 */
const path = require("node:path");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { CosmosClient } = require("@azure/cosmos");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const PURGE_SOURCES = new Set(String(process.env.PURGE_SOURCES || "bccp,tree-builder-v1,pool").split(",").map((s) => s.trim()).filter(Boolean));
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
const SHARD_SCOPE = runnerShardScope({ label: "purge-unaddressable-catalog-rows" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString("en-US");
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const ILLEGAL = ["/", "\\", "#", "?"];
const hasIllegal = (id) => ILLEGAL.some((ch) => String(id).includes(ch));

const SPROC_ID = "purgeBySelfLinks";
// Server-side JS: delete each self link in order; stop cleanly when the server
// declines more work (its own bounded execution) and report how far it got.
const SPROC_BODY = `function purgeBySelfLinks(links) {
  var ctx = getContext(), coll = ctx.getCollection(), res = ctx.getResponse();
  var i = 0, deleted = 0;
  function finish(done) { res.setBody({ processed: i, deleted: deleted, done: done }); }
  function next() {
    if (i >= links.length) { finish(true); return; }
    var accepted = coll.deleteDocument(links[i], {}, function (err) {
      if (err) { if (err.number === 404) { i++; next(); return; } throw err; }
      i++; deleted++; next();
    });
    if (!accepted) finish(false);
  }
  next();
}`;

async function retry(fn, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (e?.code === 404 || e?.code === 400) throw e; await new Promise((r) => setTimeout(r, Math.min(15000, 500 * 2 ** i))); }
  }
  throw last;
}

async function ensureSproc(cat) {
  const sp = cat.scripts.storedProcedure(SPROC_ID);
  try {
    const { resource } = await sp.read();
    if (resource?.body === SPROC_BODY) return "present";
    await sp.replace({ id: SPROC_ID, body: SPROC_BODY });
    return "replaced";
  } catch (e) {
    if (e?.code !== 404) throw e;
    await cat.scripts.storedProcedures.create({ id: SPROC_ID, body: SPROC_BODY });
    return "created";
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const port = db.container("portfolio");

  console.log(`purge-unaddressable-catalog-rows  slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY (deletes)" : "REPORT ONLY"}  budget ${RUN_MS / 60000}m  PURGE_SOURCES=${[...PURGE_SOURCES].join(",")}${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // Holdings that point at an unaddressable id — a refusal list, expected empty.
  // `holdings` is a MAP keyed by holding id (not an array): `JOIN h IN c.holdings`
  // iterates nothing, so the docs are read and walked here.
  const held = new Set();
  let docsSeen = 0, holdingsSeen = 0;
  const docIter = port.items.query("SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)", { maxItemCount: 50 });
  while (docIter.hasMoreResults()) {
    const page = await retry(() => docIter.fetchNext());
    for (const d of page.resources ?? []) {
      docsSeen++;
      const list = Array.isArray(d.holdings) ? d.holdings : Object.values(d.holdings ?? {});
      for (const h of list) {
        holdingsSeen++;
        for (const k of ["hobbyiqCardId", "cardId"]) { const v = String(h?.[k] ?? ""); if (v && hasIllegal(v)) held.add(v); }
      }
    }
  }
  console.log(`holdings pointing at unaddressable ids: ${f(held.size)} (walked ${f(holdingsSeen)} holdings in ${f(docsSeen)} docs)${held.size ? "  <- those rows are REFUSED" : ""}`);
  if (!holdingsSeen) { console.error("FATAL: walked 0 holdings — the guard cannot vouch for anything; refusing to run"); process.exit(2); }

  // The rows: grouped by partition key, sharded by that key so a partition's rows purge together.
  const query = "SELECT c.id, c.cardId, c.source, c._self FROM c WHERE CONTAINS(c.id, '/') OR CONTAINS(c.id, '#') OR CONTAINS(c.id, '?') OR CONTAINS(c.id, '\\\\')";
  const groups = new Map();
  const bySource = new Map();
  let scanned = 0, refusedSource = 0, refusedHeld = 0, otherSlot = 0;
  const iter = cat.items.query(query, { maxItemCount: 1000 });
  while (iter.hasMoreResults()) {
    const page = await retry(() => iter.fetchNext());
    for (const r of page.resources ?? []) {
      if (!hasIllegal(r.id)) continue; // defensive: the query is the contract, the check is the truth
      const pk = r.cardId ?? r.id;
      if (shardOf(pk) !== SLOT) { otherSlot++; continue; }
      scanned++;
      bySource.set(r.source ?? "(none)", (bySource.get(r.source ?? "(none)") ?? 0) + 1);
      if (!PURGE_SOURCES.has(String(r.source))) { refusedSource++; continue; }
      if (held.has(r.id)) { refusedHeld++; continue; }
      if (!groups.has(pk)) groups.set(pk, []);
      groups.get(pk).push(r);
    }
  }
  console.log(`\nshard ${SLOT}/${SLOTS}: ${f(scanned)} unaddressable rows in ${f(groups.size)} partitions (${f(otherSlot)} rows belong to other slots)`);
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(s).padEnd(40)} ${f(n)}${PURGE_SOURCES.has(String(s)) ? "" : "   <- not in PURGE_SOURCES: REFUSED"}`);
  let shown = 0;
  for (const rows of groups.values()) { for (const r of rows) { if (shown++ >= 5) break; console.log(`  sample: ${r.id}  (${r.source})`); } if (shown >= 5) break; }

  let purged = 0, failed = 0, notReached = 0, partitionsDone = 0;
  let stopReason = null;
  if (!APPLY) {
    notReached = scanned - refusedSource - refusedHeld;
  } else {
    console.log(`\nstored procedure ${SPROC_ID}: ${await ensureSproc(cat)}`);
    const sp = cat.scripts.storedProcedure(SPROC_ID);
    const queue = [...groups.entries()];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        if (stopReason) return;
        if (LIMIT && purged >= LIMIT) { stopReason = "limit"; return; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; return; }
        const [pk, rows] = queue[cursor++];
        let links = rows.map((r) => r._self);
        try {
          while (links.length) {
            const { resource } = await retry(() => sp.execute(pk, [links]));
            const processed = Number(resource?.processed ?? 0);
            purged += Number(resource?.deleted ?? 0);
            if (resource?.done) break;
            if (!processed) throw new Error("stored procedure made no progress");
            links = links.slice(processed);
          }
          partitionsDone++;
        } catch (e) {
          failed += rows.length;
          console.log(`  failed partition ${pk} (${rows.length} rows): ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    for (let i = cursor; i < queue.length; i++) notReached += queue[i][1].length;
    // A partition that was picked up but stopped by the marker mid-way: its remaining rows are not reached either.
    const accounted = purged + failed + notReached + refusedSource + refusedHeld;
    if (accounted < scanned) notReached += scanned - accounted;
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  scanned            ${f(scanned)}`);
  console.log(`  PURGED             ${f(purged)}   <- ${f(partitionsDone)} partitions`);
  console.log(`  refused (source)   ${f(refusedSource)}`);
  console.log(`  refused (held)     ${f(refusedHeld)}`);
  console.log(`  failed             ${f(failed)}`);
  console.log(`  not reached        ${f(notReached)}`);
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  if (APPLY) reportWrites({ job: "purge-unaddressable-catalog-rows", intended: scanned, written: purged, skipped: refusedSource + refusedHeld + notReached, failed });
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
