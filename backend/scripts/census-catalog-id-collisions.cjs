#!/usr/bin/env node
/**
 * CF-MEASURE-THE-CLOBBER (R30 follow-up, Drew 2026-09-13). READ ONLY.
 *
 * WHAT IT ANSWERS. `ingest-checklist-csv-to-catalog.cjs` computed every row's
 * id without reading the CSV's `category` column, so a product whose insert
 * sets restart their numbering at 1 wrote all of them onto ONE address. The
 * 2014 Panini Prizm FIFA World Cup file is the measured case: 5,462 upserts,
 * 2,949 distinct documents, and the LAST writer for each id decided which
 * player that card is. Nine inserts' #1 -- Cristiano Ronaldo, Lionel Messi,
 * Gonzalo Higuain, a mascot and a stadium poster among them -- all landed on
 *
 *     hiq:soccer:2014:panini-prizm-fifa-world-cup:1:base:no-auto
 *
 * whose base card is Rais M'Bolhi.
 *
 * The damage is INVISIBLE in the catalog alone: each surviving row is a
 * perfectly well-formed document, and nothing about it says it is standing on
 * nine other cards' addresses. It is only visible against the CHECKLIST -- the
 * artifact that can contradict it. So this script joins the two and names the
 * rows whose stored `playerName` is not the player the checklist puts at that
 * address.
 *
 * WHY IT IS NOT A REPAIR. It writes nothing, ever. The repair is a RE-INGEST
 * of the same staged directory once the file's insert-set keys are registered
 * (see the runbook section in the PR / lib/insert-set-key.cjs): upserts
 * overwrite the wrong-player documents in place, and the insert rows land on
 * their own keys instead of on top of base. This script is how you size that
 * job before it runs and confirm it afterwards -- findings are data, never
 * auto-fixes (project_pricing_invariant_auditor).
 *
 * IT ALSO MEASURES OLDER INGESTS. Any product with numbered insert sets
 * ingested before the fix has the same shape, which is why (sport, year,
 * setKey) is an argument rather than a hardcoded product.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required (READ ONLY -- no write path exists here)
 *   SPORT, YEAR, SET_KEY      the catalog cell to census
 *   DIR                       optional: the staged checklist directory whose
 *                             CSVs are the authority. Without it the script
 *                             reports the cell's population and the ids that
 *                             hold more rows than a single card should, and
 *                             says it could not name the wrong ones.
 *   LIMIT=0                   cap the rows listed (0 = all)
 */
const fs = require("node:fs");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
const { CosmosClient } = require("@azure/cosmos");
const { splitCsv, productOf } = require(path.join(__dirname, "ingest-checklist-csv-to-catalog.cjs"));
const INSERT_SET = require(path.join(__dirname, "lib", "insert-set-key.cjs"));

const SPORT = process.env.SPORT || "";
const YEAR = Number(process.env.YEAR || 0);
const SET_KEY = process.env.SET_KEY || "";
const DIR = process.env.DIR || "";
const LIMIT = Number(process.env.LIMIT || 0);

const f = (n) => Number(n).toLocaleString();

/** Fold a name the way a human comparison would: case, accents and
 *  punctuation are not a disagreement about WHO the card is. */
const foldPlayer = (v) => String(v ?? "")
  .normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!SPORT || !YEAR || !SET_KEY) { console.error("FATAL: SPORT, YEAR and SET_KEY are all required"); process.exit(1); }

  const db = new CosmosClient({ connectionString: process.env.COSMOS_CONNECTION_STRING }).database("hobbyiq");
  const catalog = db.container("card_catalog");

  // NARROW BY CONSTRUCTION. card_catalog is partitioned by id, so this is a
  // cross-partition read and the predicate is the only thing keeping it cheap.
  // One (sport, year, setKey) cell, the four fields the comparison needs, and
  // nothing else.
  const query = {
    query: `SELECT c.id, c.playerName, c.cardNumber, c.parallel, c.setKey, c.setName, c.source, c.isAuto, c.printRun
            FROM c WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year) AND c.setKey = @setKey`,
    parameters: [{ name: "@sport", value: SPORT }, { name: "@year", value: YEAR }, { name: "@setKey", value: SET_KEY }],
  };
  const stored = new Map();
  let ru = 0;
  const it = catalog.items.query(query, { maxItemCount: 1000 });
  while (it.hasMoreResults()) {
    const page = await it.fetchNext();
    ru += page.requestCharge || 0;
    for (const d of page.resources || []) stored.set(d.id, d);
  }
  console.log(`\ncatalog cell  ${SPORT} / ${YEAR} / ${SET_KEY}`);
  console.log(`  stored rows  ${f(stored.size)}   (${Math.round(ru)} RU, read only)`);

  if (!DIR) {
    console.log(`\nNo DIR given, so the checklist could not be consulted and NO row can be called wrong.`);
    console.log(`Re-run with DIR=<staged checklist directory> to name them.`);
    return;
  }
  if (!fs.existsSync(DIR)) { console.error(`FATAL: DIR not found: ${DIR}`); process.exit(1); }

  // THE CHECKLIST IS THE AUTHORITY. Rebuild the addresses this cell's staged
  // CSVs claim, using the SAME derivation the ingest uses, so a disagreement
  // here is a disagreement about the data and never about the arithmetic.
  const claims = new Map(); // id -> [{ player, category, cardNumber, parallel }]
  let checklistRows = 0, filesRead = 0;
  for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith(".csv")).sort()) {
    const csvPath = path.join(DIR, name);
    const product = productOf(csvPath);
    if (!product) continue;
    if (product.sport !== SPORT || Number(product.year) !== YEAR || product.setKey !== SET_KEY) continue;
    filesRead++;
    const rows = [];
    for (const L of fs.readFileSync(csvPath, "utf8").split("\n").slice(1)) {
      const t = L.trim(); if (!t) continue;
      const [category, cardNumber, parallel, isAuto, printRun, rawPlayer] = splitCsv(t);
      const player = cleanPlayerName(rawPlayer);
      if (!cardNumber || !player) continue;
      rows.push({ category, cardNumber, parallel, isAuto, printRun, player });
    }
    checklistRows += rows.length;
    // THE ADDRESS AS THE DEFECTIVE RUN COMPUTED IT -- the product key for every
    // row, category discarded. That is what the stored documents are keyed by,
    // so that is what the join must use. (After a fixed re-ingest, the insert
    // rows live on their own keys and simply are not in this cell any more,
    // which is itself the confirmation the repair landed.)
    for (const r of rows) {
      let id = null;
      try {
        id = computeHobbyIqCardId({
          sport: product.sport, year: product.year, setKey: product.setKey,
          cardNumber: String(r.cardNumber), parallel: r.parallel || "Base",
          isAuto: r.isAuto === "true", printRun: r.printRun ? Number(r.printRun) : null,
          authoritativeSetKey: true,
        });
      } catch { id = null; }
      if (!id) continue;
      if (!claims.has(id)) claims.set(id, []);
      claims.get(id).push(r);
    }
  }
  console.log(`  checklist    ${f(checklistRows)} rows in ${f(filesRead)} file(s) of ${DIR}`);
  console.log(`               claiming ${f(claims.size)} distinct ids  <- the gap to the row count IS the clobber`);

  // THREE VERDICTS, counted separately, because they are three different facts.
  let contested = 0, wrongPlayer = 0, agrees = 0, notStored = 0, unclaimed = 0;
  const listed = [];
  for (const [id, group] of claims) {
    const doc = stored.get(id);
    if (!doc) { notStored++; continue; }
    const names = group.map((r) => r.player);
    const match = names.some((n) => foldPlayer(n) === foldPlayer(doc.playerName));
    if (group.length > 1) {
      contested++;
      // A CONTESTED id is wrong whichever name it holds: it answers for more
      // than one card, and at most one of them can be right.
      if (LIMIT === 0 || listed.length < LIMIT) {
        listed.push({
          id, stored: doc.playerName, source: doc.source,
          claimants: group.map((r) => `[${r.category || "-"}] ${r.player}`),
          verdict: match ? "CONTESTED (stored name is one of them)" : "CONTESTED + stored name is NONE of them",
        });
      }
      if (!match) wrongPlayer++;
    } else if (!match) {
      wrongPlayer++;
      if (LIMIT === 0 || listed.length < LIMIT) {
        listed.push({
          id, stored: doc.playerName, source: doc.source,
          claimants: [`[${group[0].category || "-"}] ${group[0].player}`],
          verdict: "DISAGREES with the checklist",
        });
      }
    } else agrees++;
  }
  for (const id of stored.keys()) if (!claims.has(id)) unclaimed++;

  console.log(`\n  ids the checklist CONTESTS   ${f(contested)}   <- more than one checklist row computes this id; it answers for several cards`);
  console.log(`  rows whose player is WRONG   ${f(wrongPlayer)}   <- stored playerName is not any player the checklist puts here`);
  console.log(`  rows that AGREE              ${f(agrees)}`);
  console.log(`  claimed ids not in the cell  ${f(notStored)}   <- the checklist names a card the catalog does not hold`);
  console.log(`  stored ids the checklist does not claim ${f(unclaimed)}   <- another source's rows, or a product this directory does not cover`);

  if (listed.length) {
    console.log(`\n  ${f(listed.length)} rows${LIMIT ? ` (LIMIT=${f(LIMIT)})` : ""}:`);
    for (const l of listed) {
      console.log(`    ${l.id}`);
      console.log(`        stored: "${l.stored}"  (source ${l.source})  — ${l.verdict}`);
      for (const c of l.claimants) console.log(`        checklist: ${c}`);
    }
  }
  console.log(`\nNOTHING WAS WRITTEN. The repair is a re-ingest of ${DIR} after this product's`);
  console.log(`insert-set keys are registered; see lib/insert-set-key.cjs.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}

module.exports = { foldPlayer };
