#!/usr/bin/env node
/**
 * CF-RETIRE-UNREFERENCED-GRADED-ROWS (Drew, 2026-08-26).
 *
 * Removes the 16,273,427 graded catalog rows that sit under a foreign partition
 * key. They are unreferenced and unreachable, and they are over a third of a
 * 48M row container.
 *
 * WHY THEY ARE SAFE TO REMOVE, measured rather than assumed:
 *
 *   1. NOTHING LOOKS THEM UP. catalogMatcher never builds a graded slug -- it
 *      point-reads (slug, slug) on the base card. Pricing never reads them
 *      either: canonicalFmv derives a graded price as raw anchor x
 *      gradeMultiplier from GRADE_CALIBRATION.
 *
 *   2. SALES DO NOT POINT AT THEM. Of 15,673,468 slugged sales, 97 carry a
 *      grade suffix -- 0.0006%. Sales keep the grade in gradeCompany /
 *      gradeValue and slug to the BASE card.
 *
 *   3. THEY ARE ALREADY INVISIBLE. id != cardId means a point read on
 *      (slug, slug) cannot reach them at all. Anything depending on them by
 *      point read is already failing today.
 *
 *   4. THEY ARE REGENERABLE. explodeCatalogGrades rebuilds a graded row from
 *      its parent in one pass, now that it writes to the contract (#1278).
 *
 * THE 97 ARE PROTECTED ANYWAY. Every graded slug referenced by a sale is loaded
 * at startup and skipped, so the handful of rows that ARE pointed at survive
 * even though the arithmetic says they hardly matter. It costs one query.
 *
 * MANIFEST FIRST. A dry run writes every id it intends to delete to
 * /tmp/retire-graded-manifest.txt and deletes nothing. Two numbers I stated
 * confidently today were wrong -- a 2.7M "identity parents" figure and a 30,829
 * anime figure -- both because I read one predicate and reported another. This
 * is 16.3M irreversible deletes, so the list gets read before it gets run.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY=true                actually delete (default: manifest only)
 *   CONCURRENCY=64
 *   LIMIT=0                   stop after N deletes (0 = no limit)
 *   MANIFEST=/path            where to write the id list
 */
const fs = require("node:fs");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 64);
const LIMIT = Number(process.env.LIMIT || 0);
const MANIFEST = process.env.MANIFEST || "/tmp/retire-graded-manifest.txt";

// CF-RETIRE-SPLITS-ACROSS-SLOTS (Drew, 2026-08-26). One worker deletes ~22,100
// rows/min, so 15.4M is roughly 11 hours. Racing several unpartitioned workers
// over the same scan buys nothing -- one deletes, the rest collect 404s -- so
// split the setKey space server-side, exactly as the re-home does. Slots never
// overlap and need no coordination. SLOTS=1 is the previous behaviour.
const SLOT = Number(process.env.SLOT ?? 0);
const SLOTS = Number(process.env.SLOTS ?? 1);

function slotRange(slot, slots) {
  if (!Number.isFinite(slots) || slots <= 1) return null;
  const A = "abcdefghijklmnopqrstuvwxyz".split("");
  const per = Math.ceil(A.length / slots);
  const lo = slot === 0 ? "" : (A[slot * per] ?? "~");
  const hi = slot === slots - 1 ? "~" : (A[(slot + 1) * per] ?? "~");
  return { lo, hi };
}

/** Graded rows stranded under a foreign partition key. */
const TARGET =
  "STARTSWITH(c.id,'hiq:') AND c.id != c.cardId AND IS_DEFINED(c.cardId) " +
  "AND c.cardId != null AND IS_DEFINED(c.gradeTier)";

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), sc = db.container("sold_comps");
  const f = (n) => Number(n).toLocaleString();

  const queryWithRetry = async (container, spec, opts) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await container.items.query(spec, opts).fetchNext(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // ---- the protected set: every graded slug a sale actually points at -------
  console.log("loading graded slugs referenced by sales...");
  const protectedSlugs = new Set();
  {
    let token;
    do {
      const page = await queryWithRetry(sc, {
        query: `SELECT c.hobbyiqCardId AS s FROM c WHERE IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
                AND (CONTAINS(c.hobbyiqCardId,':psa-') OR CONTAINS(c.hobbyiqCardId,':bgs-')
                  OR CONTAINS(c.hobbyiqCardId,':sgc-') OR CONTAINS(c.hobbyiqCardId,':cgc-')
                  OR CONTAINS(c.hobbyiqCardId,':raw'))`,
      }, { maxItemCount: 1000, continuationToken: token });
      token = page.continuationToken;
      for (const r of page.resources) if (r.s) protectedSlugs.add(r.s);
    } while (token);
  }
  console.log(`  ${f(protectedSlugs.size)} graded slugs are referenced by at least one sale — these will be SKIPPED\n`);

  let scanned = 0, attempted = 0, deleted = 0, failed = 0, gone = 0, kept = 0;
  const out = APPLY ? null : fs.createWriteStream(MANIFEST, { flags: "w" });

  const range = slotRange(SLOT, SLOTS);
  const scopedTarget = range
    ? `${TARGET} AND c.setKey >= '${range.lo}' AND c.setKey < '${range.hi}'`
    : TARGET;
  if (range) console.log(`slot ${SLOT}/${SLOTS}  setKey range [${range.lo || "''"} .. ${range.hi})`);

  let token, pages = 0;
  do {
    const page = await queryWithRetry(cat,
      { query: `SELECT c.id, c.cardId, c.gradeTier, c.source FROM c WHERE ${scopedTarget}` },
      { maxItemCount: 500, continuationToken: token });
    token = page.continuationToken;

    const work = [];
    for (const r of page.resources) {
      scanned++;
      if (protectedSlugs.has(r.id)) { kept++; continue; }
      if (!APPLY) { out.write(`${r.id}\t${r.cardId}\t${r.gradeTier}\t${r.source}\n`); continue; }
      work.push(r);
    }

    for (let i = 0; i < work.length; i += CONCURRENCY) {
      await Promise.all(work.slice(i, i + CONCURRENCY).map(async (r) => {
        attempted++;
        try { await cat.item(r.id, r.cardId).delete(); deleted++; }
        catch (e) {
          if (e.code === 404) { gone++; return; }
          failed++;
          if (failed <= 5) console.error("  delete failed " + String(r.id).slice(0, 60) + ": " + String(e.message || e).slice(0, 70));
        }
      }));
      if (LIMIT && deleted >= LIMIT) { token = undefined; break; }
    }
    if (++pages % 20 === 0) process.stderr.write(`\r  scanned ${f(scanned)}  deleted ${f(deleted)}  kept ${f(kept)}   `);
  } while (token);
  process.stderr.write("\n");
  if (out) out.end();

  console.log(`\n${APPLY ? "APPLY" : "MANIFEST ONLY — nothing deleted"}`);
  console.log(`  matched the target        ${f(scanned)}`);
  console.log(`  protected (a sale uses it) ${f(kept)}`);
  console.log(`  deleted                   ${f(deleted)}`);
  console.log(`  already gone (404)        ${f(gone)}`);
  console.log(`  failed                    ${f(failed)}`);
  if (!APPLY) console.log(`\n  manifest written to ${MANIFEST}  — read it before running with APPLY=true`);
  if (APPLY) reportWrites({ job: "retire-unreferenced-graded-rows", intended: attempted, written: deleted, skipped: gone, failed });
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
