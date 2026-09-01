#!/usr/bin/env node
/**
 * CF-CHECKLIST-ROWS-MUST-BE-FINDABLE (Drew, 2026-09-01: "are they the same
 * format and inside the catalog?").
 *
 * They were not. A checklist row that exists but carries no `searchTokens` is
 * invisible: catalogSearch discriminates with
 * `ARRAY_CONTAINS(c.searchTokens, @t)`, so a row without them can never be
 * returned no matter how exactly a query names the card.
 *
 * Measured 2026-09-01, 2018 Bowman Chrome:
 *
 *     2026 bowman-chrome checklist rows   2179 / 2179 have searchTokens
 *     2018 bccp ladder rows               3102 / 3102 have searchTokens
 *     the 78 rows ingested by #1612           0 /   78
 *
 * The cause is structural, not a one-off: `deriveCatalogEntry` — what
 * ingest-scraped-checklist.cjs builds its docs from — does not populate
 * searchText / searchTokens / displayName at all. cardCatalog.service documents
 * this as the reason 59 of 61 catalog writers hand-roll their own doc rather
 * than route through the canonical constructor ("a canonical path that silently
 * loses 99%-present fields does not get adopted"). So EVERY checklist ingested
 * through that script is search-invisible until healed.
 *
 * ONE IMPLEMENTATION. The fields are rebuilt by `rebuildSearchFields` from
 * catalogRowOps — the same function catalogRowOps uses on a move — and NOT by a
 * private copy here. A second spelling of the search text is how a row becomes
 * "stale" to the coverage canary while looking fine.
 *
 * SCOPED. Requires --set-key and --year; refuses whole-container scope. Only
 * touches rows that are actually missing the fields, so it is idempotent and
 * re-running it is a no-op.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-missing-search-fields.cjs \
 *     --set-key=bowman-chrome-nscc --year=2018 [--parallel="..."] [--expect=50] [--apply]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { rebuildSearchFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const SET_KEY = arg("set-key", "");
const YEAR = arg("year", "");
const PARALLEL = arg("parallel", "");
const SOURCE_PREFIX = arg("source-prefix", "");
const EXPECT = arg("expect", "");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (!SET_KEY || !YEAR) {
    console.error("FATAL: --set-key and --year are required; this script refuses whole-container scope.");
    process.exit(2);
  }

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  console.log(`[repair-missing-search-fields] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope: setKey=${SET_KEY} year=${YEAR}${PARALLEL ? ` parallel=${JSON.stringify(PARALLEL)}` : ""}${SOURCE_PREFIX ? ` source^=${SOURCE_PREFIX}` : ""}\n`);

  const params = [
    { name: "@sk", value: SET_KEY },
    { name: "@yr", value: Number(YEAR) },
  ];
  let where = "c.setKey = @sk AND c.cardYear = @yr AND NOT IS_DEFINED(c.searchTokens)";
  if (PARALLEL) { where += " AND c.parallel = @par"; params.push({ name: "@par", value: PARALLEL }); }
  if (SOURCE_PREFIX) { where += " AND STARTSWITH(c.source ?? '', @sp)"; params.push({ name: "@sp", value: SOURCE_PREFIX }); }

  const { resources: rows } = await cat.items.query(
    { query: `SELECT * FROM c WHERE ${where}`, parameters: params },
    { enableCrossPartitionQuery: true },
  ).fetchAll();

  console.log(`matched ${rows.length} rows missing searchTokens`);
  if (EXPECT !== "" && rows.length !== Number(EXPECT)) {
    console.error(`\nFATAL: expected ${EXPECT}, matched ${rows.length}. Refusing.`);
    process.exit(3);
  }
  if (!rows.length) { console.log("nothing to do (already healed)."); return; }

  let ok = 0, failed = 0, shown = 0;
  for (const r of rows) {
    // setName is what the search text leads with. These rows were ingested
    // without one, so derive the display spelling from the key rather than
    // leaving the tokens without the product in them.
    const setName = r.setName
      || `${r.cardYear} ${String(r.setKey || "").replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}`;
    const fields = rebuildSearchFields({
      sport: r.sport, year: r.cardYear ?? r.year, setKey: r.setKey, setName,
      cardNumber: r.cardNumber, playerName: r.playerName, parallel: r.parallel,
      parallelSlug: r.parallelSlug, printRun: r.printRun, subsetName: r.subsetName ?? null,
    });
    if (shown < 5) {
      console.log(`  ${r.hobbyiqCardId}`);
      console.log(`     displayName  = ${JSON.stringify(fields.displayName)}`);
      console.log(`     searchTokens = ${JSON.stringify(fields.searchTokens)}`);
      shown++;
    }
    if (!APPLY) { ok++; continue; }
    const ops = [
      { op: "add", path: "/searchText", value: fields.searchText },
      { op: "add", path: "/searchTokens", value: fields.searchTokens },
      { op: "add", path: "/displayName", value: fields.displayName },
    ];
    if (!r.setName) ops.push({ op: "add", path: "/setName", value: setName });
    try {
      await cat.item(r.id, r.cardId).patch(ops);
      ok++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.error(`  FAILED ${r.id}: ${String(e.message).slice(0, 140)}`);
    }
  }
  console.log(APPLY ? `\n[done] healed=${ok} failed=${failed}` : `\n(dry-run; would heal ${ok} rows)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
