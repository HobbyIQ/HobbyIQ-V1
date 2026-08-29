#!/usr/bin/env node
/**
 * identity-triangulation.cjs -- a sale, a holding, and a search must resolve
 * to the SAME checklist-minted card. This measures whether they do.
 *
 * CF-TRIANGULATE (Drew, 2026-08-29 checklist D2; acceptance line of the
 * rebuild plan). Read-only. Samples checklist-source identity rows that have
 * at least one pooled sale, and for each runs the three live paths:
 *
 *   sale     -> canonicalize() with the sale's own structured fields
 *               (the recordSoldComp path)
 *   holding  -> canonicalize() with holding-shaped fields (setName as a
 *               collector would type it, parallel text, card number)
 *   search   -> searchCatalog() with the sale's TITLE as the query, top hit
 *
 * and compares each answer to the checklist row's id. Every disagreement is
 * printed with its shape so it can be fixed in the path that is wrong, not
 * papered over. The source passed to canonicalize is "harness": not a user
 * source, not "checklist", so nothing can seed.
 *
 * Env: COSMOS_CONNECTION_STRING; SAMPLE=200; SPORT (default baseball);
 *      YEAR_MIN=2016; SEED=7 (deterministic sample).
 */
"use strict";
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { canonicalize } = require(path.join(backend, "dist", "services", "catalog", "catalogMatcher.service.js"));
const { searchCatalog } = require(path.join(backend, "dist", "services", "catalog", "catalogSearch.service.js"));

const SAMPLE = Number(process.env.SAMPLE || 200);
const SPORT = String(process.env.SPORT || "baseball").toLowerCase();
const YEAR_MIN = Number(process.env.YEAR_MIN || 2016);
const SEED = Number(process.env.SEED || 7);
const f = (n) => Number(n).toLocaleString();
const CHECKLIST_SQL = "(c.source = 'bccp' OR STARTSWITH(c.source,'baseballcardpedia') OR STARTSWITH(c.source,'checklist') OR STARTSWITH(c.source,'beckett') OR STARTSWITH(c.source,'tcgdex') OR STARTSWITH(c.source,'cardboardchecklist'))";

// deterministic pseudo-random so two runs sample the same cards
let seed = SEED; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient(conn).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");

  // candidate checklist rows: a spread of products, then pick SAMPLE with sales
  const { resources: rows } = await cat.items.query({
    query: `SELECT TOP 4000 c.id, c.year, c.setKey, c.setName, c.cardNumber, c.playerName, c.parallel, c.isAuto, c.printRun FROM c WHERE c.sport = @sp AND c.year >= @y AND NOT IS_DEFINED(c.gradeTier) AND ${CHECKLIST_SQL} AND IS_DEFINED(c.playerName)`,
    parameters: [{ name: "@sp", value: SPORT }, { name: "@y", value: YEAR_MIN }],
  }, { maxItemCount: 1000 }).fetchAll();
  const shuffled = rows.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);

  const results = []; let tried = 0;
  for (const card of shuffled) {
    if (results.length >= SAMPLE) break;
    tried++;
    const { resources: sales } = await pool.items.query({ query: "SELECT TOP 1 c.id, c.title, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.sport FROM c WHERE c.hobbyiqCardId = @s", parameters: [{ name: "@s", value: card.id }] }).fetchAll();
    if (!sales.length) continue;
    const sale = sales[0];
    const r = { id: card.id, title: String(sale.title ?? "").slice(0, 80) };
    try {
      const a = await canonicalize({ sport: SPORT, year: Number(sale.cardYear ?? card.year), setName: String(sale.setName ?? card.setName ?? card.setKey), cardNumber: String(sale.cardNumber ?? card.cardNumber), parallel: sale.parallel ?? null, isAuto: Boolean(sale.isAuto ?? card.isAuto), player: sale.playerName ?? card.playerName, source: "harness" });
      r.sale = a.slug; r.saleBy = a.matchedBy;
    } catch (e) { r.sale = "ERR " + String(e.message).slice(0, 40); }
    try {
      const h = await canonicalize({ sport: SPORT, year: card.year, setName: String(card.setName ?? card.setKey), cardNumber: String(card.cardNumber), parallel: card.parallel && card.parallel !== "Base" ? card.parallel : null, isAuto: Boolean(card.isAuto), printRun: card.printRun ?? null, player: card.playerName, source: "harness" });
      r.holding = h.slug; r.holdingBy = h.matchedBy;
    } catch (e) { r.holding = "ERR " + String(e.message).slice(0, 40); }
    try {
      const s = await searchCatalog({ query: String(sale.title ?? `${card.year} ${card.setName ?? card.setKey} ${card.playerName} #${card.cardNumber} ${card.parallel ?? ""}`), limit: 5 });
      const top = s.hits?.[0];
      r.search = top ? String(top.id ?? top.cardId ?? top.slug ?? "") : "(no hit)";
    } catch (e) { r.search = "ERR " + String(e.message).slice(0, 40); }
    results.push(r);
  }

  const agree = (k) => results.filter((r) => r[k] === r.id).length;
  const all3 = results.filter((r) => r.sale === r.id && r.holding === r.id && r.search === r.id).length;
  console.log(`\nIDENTITY TRIANGULATION  sport=${SPORT} years>=${YEAR_MIN}  sampled ${results.length} checklist cards with sales (tried ${tried})`);
  console.log(`  sale    -> same card   ${f(agree("sale"))} / ${results.length}   (${(100 * agree("sale") / results.length).toFixed(1)}%)`);
  console.log(`  holding -> same card   ${f(agree("holding"))} / ${results.length}   (${(100 * agree("holding") / results.length).toFixed(1)}%)`);
  console.log(`  search  -> same card   ${f(agree("search"))} / ${results.length}   (${(100 * agree("search") / results.length).toFixed(1)}%)`);
  console.log(`  ALL THREE agree        ${f(all3)} / ${results.length}   (${(100 * all3 / results.length).toFixed(1)}%)   <- the acceptance number`);
  const bad = results.filter((r) => !(r.sale === r.id && r.holding === r.id && r.search === r.id)).slice(0, 25);
  if (bad.length) {
    console.log(`\n  disagreements (first ${bad.length}):`);
    for (const r of bad) {
      console.log(`  ${r.id}`);
      if (r.sale !== r.id) console.log(`     sale    -> ${r.sale}  [${r.saleBy ?? ""}]`);
      if (r.holding !== r.id) console.log(`     holding -> ${r.holding}  [${r.holdingBy ?? ""}]`);
      if (r.search !== r.id) console.log(`     search  -> ${r.search}   q="${r.title}"`);
    }
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
