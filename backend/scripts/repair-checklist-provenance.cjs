#!/usr/bin/env node
/**
 * CF-CHECKLIST-PROVENANCE (Drew, 2026-09-01: "we can target and confirm").
 *
 * `source` on a catalog row must name the publisher the row actually came
 * from. catalogVisibility tiers search results by it, and a row stamped with
 * the wrong publisher is unauditable — you cannot tell whether the evidence
 * behind a card is a Beckett guide or a vendor guess.
 *
 * ingest-scraped-checklist.cjs defaults SOURCE_LABEL to "baseballcardpedia",
 * so the 78 rows ingested on 2026-08-31 (#1612) carry
 * `baseballcardpedia-scraped-2026-08-31` while actually coming from TCDB and
 * Beckett:
 *
 *     50 rows  2018 Bowman Chrome NSCC Wrapper Redemption   <- tcdb
 *     28 rows  2018 Bowman Chrome Rookie Image Variations   <- beckett
 *
 * RE-RUNNING THE INGEST DOES NOT FIX IT, which is why this script exists.
 * upsertCatalogEntry only writes a field when the new value IMPROVES on the
 * stored one, and `source` is not in that set — so a re-ingest with the right
 * SOURCE_LABEL is a silent no-op. Verified 2026-08-31: re-ran both files with
 * SOURCE_LABEL=tcdb / =beckett, wrote=50 and wrote=28, source unchanged.
 *
 * NARROW BY CONSTRUCTION. This is a provenance correction, not a sweep. It
 * targets rows matching ALL THREE of:
 *   - the exact wrong source stamp (--wrong-source)
 *   - the setKey the checklist landed on (--set-key)
 *   - the cardYear (--year)
 * and, for the variations, the parallel as well (--parallel), because those
 * share a setKey with the whole of Bowman Chrome. Anything wider would restamp
 * rows this session never wrote. A --limit ceiling refuses to run if the match
 * count exceeds what the caller expects.
 *
 * REVERSIBLE via /sourceBefore. Partition key is /cardId, so this is a patch,
 * and the previous value is kept on the row rather than discarded.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-checklist-provenance.cjs \
 *     --wrong-source=baseballcardpedia-scraped-2026-08-31 \
 *     --set-key=bowman-chrome-nscc --year=2018 \
 *     --new-source=tcdb-scraped-2026-08-31 --expect=50 [--apply]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
// The row-op, not a hand-rolled patch: CF-GUARD-THE-CATALOG-WRITE-CONTRACT.
const { patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const WRONG = arg("wrong-source", "");
const NEW = arg("new-source", "");
const SET_KEY = arg("set-key", "");
const YEAR = arg("year", "");
const PARALLEL = arg("parallel", "");
const EXPECT = arg("expect", "");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  // A whole-scope write with no scope is exactly the shape that restamps rows
  // it was never meant to touch. Refuse rather than guess.
  if (!WRONG || !NEW || !SET_KEY || !YEAR) {
    console.error("FATAL: --wrong-source, --new-source, --set-key and --year are all required.");
    console.error("       This script refuses to run at whole-container scope.");
    process.exit(2);
  }
  if (WRONG === NEW) {
    console.error("FATAL: --wrong-source equals --new-source; nothing to do.");
    process.exit(2);
  }

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  console.log(`[repair-checklist-provenance] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope: setKey=${SET_KEY} year=${YEAR}${PARALLEL ? ` parallel=${JSON.stringify(PARALLEL)}` : ""}`);
  console.log(`  source: ${JSON.stringify(WRONG)} -> ${JSON.stringify(NEW)}\n`);

  const params = [
    { name: "@src", value: WRONG },
    { name: "@sk", value: SET_KEY },
    { name: "@yr", value: Number(YEAR) },
  ];
  let where = "c.source = @src AND c.setKey = @sk AND c.cardYear = @yr";
  if (PARALLEL) {
    where += " AND c.parallel = @par";
    params.push({ name: "@par", value: PARALLEL });
  }

  const { resources: rows } = await cat.items.query(
    {
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardNumber,
                     c.source, c.sourceBefore
              FROM c WHERE ${where}`,
      parameters: params,
    },
    { enableCrossPartitionQuery: true },
  ).fetchAll();

  console.log(`matched ${rows.length} rows`);
  if (EXPECT !== "" && rows.length !== Number(EXPECT)) {
    console.error(`\nFATAL: expected ${EXPECT} rows, matched ${rows.length}.`);
    console.error("       The scope does not describe what you think it does. Refusing.");
    process.exit(3);
  }
  if (!rows.length) { console.log("nothing to do."); return; }

  for (const r of rows.slice(0, 8)) {
    console.log(`  ${r.hobbyiqCardId}  ${r.playerName}`);
  }
  if (rows.length > 8) console.log(`  … and ${rows.length - 8} more`);

  if (!APPLY) {
    console.log(`\n(dry-run; would restamp ${rows.length} rows)`);
    return;
  }

  let ok = 0, failed = 0;
  for (const r of rows) {
    // /cardId is the partition key. Patch keeps every other field untouched
    // and preserves the previous value for reversal.
    try {
      await patchCatalogRowFields(cat, r.id, r.cardId, { source: NEW });
      ok++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.error(`  FAILED ${r.id}: ${String(e.message).slice(0, 120)}`);
    }
  }
  console.log(`\n[done] restamped=${ok} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
