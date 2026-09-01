#!/usr/bin/env node
/**
 * CF-THE-LIST-IS-THE-SCOPE (2026-09-01, four-values R2).
 *
 * Moves sold_comps rows named EXPLICITLY in a committed list file, and nothing
 * else. Every whole-scope write refuses without a scope; here the scope is not
 * a predicate that could match more than it meant to -- it is a file of ids,
 * reviewed in the diff before it ships. A row not in the file is never touched,
 * so this lane cannot widen by accident the way a `WHERE setKey = ...` sweep can.
 *
 * Two shapes, because the four-values audit found two distinct defects:
 *
 *   1. RELOCATE  (entry has fromCardId != toCardId)
 *      The row sits in the wrong partition. sold_comps is partitioned on
 *      /cardId, so this is a new document plus a delete of the old one, in that
 *      order, with a verified read between -- relocateSoldComp (D19) owns the
 *      ordering and this script never reimplements it. The moved row also
 *      carries the target's contentHash, or the store's pre-write dedup can
 *      never see it again.
 *
 *   2. REPOINT   (entry has repointHobbyiqCardId)
 *      The row is in the RIGHT partition but its hobbyiqCardId names a
 *      different card, and hobbyiqCardId is what the pricing engine reads.
 *      Aaron Judge's five 2017 Gold Label rows -- including a real $300 PSA 9
 *      sale of the exact card -- sat at
 *        cardId        = hiq:baseball:2017:topps-gold-label:86:class-1-blue:no-auto
 *        hobbyiqCardId = hiq:baseball:2017:topps:86:class-1-blue:no-auto
 *      so every read by hobbyiqCardId found zero and the card was priced from
 *      Raw x a ratio instead of from its own sale. No partition changes, so
 *      this is a patch in place, not a relocate.
 *
 * REPORT FIRST. Without BACKFILL_APPLY=true this prints the whole plan --
 * every id, its current address, its intended address, and the evidence
 * recorded in the file -- and writes nothing. Read the banner before applying.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/, defaults to the four-values list).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const {
  relocateSoldComp, stripSystem, contentHashOf,
} = require(path.join(__dirname, "lib/relocate-sold-comp.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const DEFAULT_LIST = "data/pool-relocations/2026-09-01-four-values.json";
// `scope` is shared with other lanes and carries THEIR vocabulary by default
// ("refractor", "all", a product key). Only a value that names a list file is
// a scope for THIS lane; anything else falls back to the committed default
// rather than being read as a path that does not exist.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE = RAW_SCOPE.endsWith(".json") ? RAW_SCOPE : DEFAULT_LIST;
const f = (n) => Number(n).toLocaleString();

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // The list IS the scope. A missing or empty file is a refusal, never a
  // silent no-op that looks like success.
  const listPath = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  if (!fs.existsSync(listPath)) {
    console.error(`FATAL: scope list not found: ${listPath}`);
    console.error("This lane refuses to run without an explicit committed list.");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  if (entries.length === 0) {
    console.error(`FATAL: ${SCOPE} names no entries — nothing is in scope.`);
    process.exit(1);
  }

  console.log(`scope file              ${SCOPE}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  console.log(`excluded by the audit   ${f((doc.excluded || []).length)}   <- deliberately NOT moved`);
  for (const r of doc.rulings || []) console.log(`  ruling: ${r}`);
  console.log("");

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const pool = db.container("sold_comps");
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

  let relocated = 0, repointed = 0, alreadyRight = 0, notFound = 0, failed = 0, duplicatesLeft = 0;
  const intended = entries.length;

  for (const e of entries) {
    const id = String(e.id ?? "").trim();
    const from = String(e.fromCardId ?? "").trim();
    const to = String(e.toCardId ?? "").trim();
    const repoint = String(e.repointHobbyiqCardId ?? "").trim();
    if (!id || !from) { failed++; console.error(`  malformed entry: ${JSON.stringify(e).slice(0, 90)}`); continue; }

    let doc0 = null;
    try { doc0 = (await retry(() => pool.item(id, from).read())).resource ?? null; }
    catch (err) { if (!(err?.code === 404 || err?.statusCode === 404)) throw err; }
    if (!doc0) {
      notFound++;
      console.log(`  NOT FOUND at ${from.slice(0, 54)}  id=${id.slice(0, 44)}`);
      continue;
    }

    // ── REPOINT: right partition, wrong hobbyiqCardId ──────────────────────
    if (repoint) {
      if (doc0.hobbyiqCardId === repoint) { alreadyRight++; continue; }
      console.log(`  REPOINT ${id.slice(0, 40)}`);
      console.log(`      hobbyiqCardId ${String(doc0.hobbyiqCardId).slice(0, 58)}`);
      console.log(`                 -> ${repoint.slice(0, 58)}`);
      console.log(`      why: ${String(e.evidence ?? "").slice(0, 150)}`);
      if (APPLY) {
        const next = stripSystem(doc0);
        next.hobbyiqCardId = repoint;
        try { await retry(() => pool.items.upsert(next)); repointed++; }
        catch (err) { failed++; console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 70)}`); }
      } else { repointed++; }
      continue;
    }

    // ── RELOCATE: wrong partition ─────────────────────────────────────────
    if (!to || to === from) { alreadyRight++; continue; }
    console.log(`  RELOCATE ${id.slice(0, 40)}  $${e.price ?? doc0.price}`);
    console.log(`      ${from.slice(0, 62)}`);
    console.log(`   -> ${to.slice(0, 62)}`);
    console.log(`      why: ${String(e.evidence ?? "").slice(0, 150)}`);
    if (!APPLY) { relocated++; continue; }

    const keep = stripSystem(doc0);
    keep.cardId = to;
    // A row that moves partition must carry the hash of its NEW cardId, or the
    // store's pre-write dedup can never match it again.
    keep.contentHash = contentHashOf(keep);
    // hobbyiqCardId is what the engine reads; a move that left it pointing at
    // the old card would move the row and not the sale.
    if (String(doc0.hobbyiqCardId ?? "") === from) keep.hobbyiqCardId = to;

    try {
      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id, cardId: from }], retry,
        verifyFields: ["cardId", "price", "soldAt", "contentHash"],
      });
      if (res.ok) relocated++;
      else {
        failed++;
        console.error(`      FAILED at ${res.stage}: ${String(res.error ?? "").slice(0, 70)}`);
      }
      if (res.duplicatesLeft?.length) {
        duplicatesLeft += res.duplicatesLeft.length;
        console.error(`      DUPLICATE LEFT IN POOL: ${res.duplicatesLeft.length}`);
      }
    } catch (err) {
      failed++;
      console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 70)}`);
    }
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope        ${f(intended)}`);
  console.log(`  RELOCATED (partition)   ${f(relocated)}`);
  console.log(`  REPOINTED (hiqCardId)   ${f(repointed)}`);
  console.log(`  already at the target   ${f(alreadyRight)}`);
  console.log(`  not found at fromCardId ${f(notFound)}`);
  console.log(`  failed                  ${f(failed)}`);
  console.log(`  duplicates left in pool ${f(duplicatesLeft)}   <- must be 0`);
  if (APPLY) {
    reportWrites({
      job: "relocate-pool-rows-by-list", intended,
      written: relocated + repointed, skipped: alreadyRight + notFound, failed,
    });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
