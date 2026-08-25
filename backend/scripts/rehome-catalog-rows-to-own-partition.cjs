#!/usr/bin/env node
// CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW (Drew, 2026-08-25).
//
// card_catalog partitions on /cardId. ~17.7M rows carry a CORRECT canonical
// slug in `id` and a VENDOR id in `cardId`:
//
//   id     hiq:baseball:2025:bowman-chrome:cpa-csc:base:auto:bgs-8
//   cardId 1775832219776x807179689237410600          <- Bubble vendor id
//   source cardhedge-graded
//
// The data is right. The address is wrong. `cat.item(slug, slug)` -- the ~1 RU
// point read the entire match path uses -- cannot see any of them, so a whole
// grade ladder is invisible to the thing that prices it.
//
// WHY dedupe-catalog-partition-shadows DOES NOT COVER THIS. That script groups
// by id and acts only on groups of MORE THAN ONE row. These are SINGLETONS: a
// sample of 25 found 12/12 with no row at (id, id) at all. There is nothing to
// merge and no keeper to choose -- the row simply needs to be at its own
// address. Running the dedupe job on these would report zero work forever.
//
// WRITE FIRST, THEN DELETE. A partition key is immutable, so this is
// copy-and-remove. Interrupted after the copy you have a duplicate, which the
// dedupe job already knows how to resolve. Interrupted after a delete-first you
// have nothing. So: write the copy, READ IT BACK, and only then remove the
// original. A copy that cannot be read back is never followed by a delete.
//
// The old partition key was a vendor id and is preserved in vendorIds -- a CH
// lookup resolves by vendor cardId and losing that is a silent break.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   APPLY=true                actually write (default dry-run)
//   YEARS=2025,2026           years to sweep (default: all)
//   SETKEY_LIKE=bowman        substring the setKey must contain (default: any)
//   CONCURRENCY=16
//   LIMIT=0                   stop after N re-homes (0 = no limit)

const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const LIMIT = Number(process.env.LIMIT || 0);
const YEARS = String(process.env.YEARS || "").split(",").map((y) => Number(y.trim())).filter(Boolean);
const SETKEY_LIKE = String(process.env.SETKEY_LIKE || "").toLowerCase();
// Cap the SCAN itself, so a dry-run can size a slice without walking all of it.
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 0);

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  let scanned = 0, candidates = 0, rehomed = 0, alreadyThere = 0, failed = 0, verifyFailed = 0;
  // CF-COUNT-WHAT-THE-LOOP-TOUCHES. `candidates` counts rows the SCAN found;
  // `attempted` counts rows the work loop actually took up. They differ the
  // moment LIMIT stops the run mid-page: the remainder of that page was seen
  // but never tried, and charging it to `intended` reports a shortfall that
  // did not happen (88 phantom rows on the first 5,000-row slice). This is the
  // same mistake dedupe-catalog-partition-shadows made -- taking intent from
  // the scan rather than from the loop -- so it gets the same fix.
  let attempted = 0;
  const samples = [];

  const where = ["STARTSWITH(c.id,'hiq:')", "c.id != c.cardId", "IS_DEFINED(c.cardId)", "c.cardId != null"];
  if (YEARS.length) where.push(`c.year IN (${YEARS.join(",")})`);
  if (SETKEY_LIKE) where.push(`CONTAINS(LOWER(c.setKey ?? ''), '${SETKEY_LIKE.replace(/'/g, "")}')`);

  let token, pages = 0;
  do {
    const page = await cat.items.query(
      { query: `SELECT * FROM c WHERE ${where.join(" AND ")}` },
      { maxItemCount: 200, continuationToken: token },
    ).fetchNext();
    token = page.continuationToken;

    const work = [];
    for (const r of page.resources) {
      scanned++;
      candidates++;
      if (samples.length < 6) samples.push(`${r.id}\n        was in partition ${r.cardId}  (src ${r.source})`);
      work.push(r);
    }

    if (APPLY && work.length) {
      for (let i = 0; i < work.length; i += CONCURRENCY) {
        await Promise.all(work.slice(i, i + CONCURRENCY).map(async (r) => {
          attempted++;
          const oldKey = r.cardId;
          try {
            // Already at its own address? Then this is the duplicate case, not
            // the singleton case -- leave it for dedupe-catalog-partition-shadows
            // rather than deleting a row whose twin we did not inspect.
            let existing = null;
            try { existing = (await cat.item(r.id, r.id).read()).resource ?? null; } catch (e) { if (e.code !== 404) throw e; }
            if (existing) { alreadyThere++; return; }

            // The old partition key was a vendor id. A CH lookup resolves by
            // vendor cardId, so it has to survive the move.
            const vendorIds = { ...(r.vendorIds ?? {}) };
            if (!String(oldKey).startsWith("hiq:")) {
              const k = String(r.source ?? "vendor");
              if (!vendorIds[k]) vendorIds[k] = oldKey;
            }
            const moved = { ...r, cardId: r.id, vendorIds,
              rehomedFrom: oldKey, rehomedAt: new Date().toISOString() };
            delete moved._rid; delete moved._self; delete moved._etag; delete moved._attachments; delete moved._ts;

            await cat.items.upsert(moved);

            // Read it back at the NEW address before removing the old one. A
            // copy that cannot be read is not a copy.
            let landed = null;
            try { landed = (await cat.item(r.id, r.id).read()).resource ?? null; } catch (e) { if (e.code !== 404) throw e; }
            if (!landed) { verifyFailed++; return; }

            await cat.item(r.id, oldKey).delete();
            rehomed++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.error("  rehome failed " + String(r.id).slice(0, 60) + ": " + String(e.message || e).slice(0, 80));
          }
        }));
        if (LIMIT && rehomed >= LIMIT) { token = undefined; break; }
      }
    }
    pages++;
    if (pages % 25 === 0) {
      process.stderr.write(`\r  scanned ${scanned}  rehomed ${rehomed}  already ${alreadyThere}  failed ${failed}   `);
    }
    if (SCAN_LIMIT && scanned >= SCAN_LIMIT) break;
  } while (token);
  process.stderr.write("\n");

  const scope = (YEARS.length ? "years=" + YEARS.join(",") : "years=all") +
                (SETKEY_LIKE ? "  setKey~" + SETKEY_LIKE : "");
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}  ${scope}`);
  console.log(`  rows in a foreign partition   ${candidates.toLocaleString()}`);
  console.log(`  re-homed to their own slug    ${rehomed.toLocaleString()}`);
  console.log(`  already had a row at (id,id)  ${alreadyThere.toLocaleString()}   (duplicate case -> dedupe job)`);
  console.log(`  copy could not be read back   ${verifyFailed.toLocaleString()}   (NOT deleted)`);
  console.log(`  failed                        ${failed.toLocaleString()}`);
  if (LIMIT && candidates > attempted) {
    console.log(`  not attempted                 ${(candidates - attempted).toLocaleString()}   (LIMIT reached; seen, not tried)`);
  }
  if (samples.length) {
    console.log(`\n  sample:`);
    for (const s of samples) console.log("     " + s);
  }
  if (APPLY) {
    reportWrites({
      job: "rehome-catalog-rows-to-own-partition",
      intended: attempted, written: rehomed,
      skipped: alreadyThere + verifyFailed, failed,
    });
  }
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
