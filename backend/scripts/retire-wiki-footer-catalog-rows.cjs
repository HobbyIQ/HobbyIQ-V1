#!/usr/bin/env node
/**
 * CF-A-PAGE-FOOTER-IS-NOT-A-CARD (Drew, 2026-09-01: "Delete, but only with
 * zero comps").
 *
 * A MediaWiki page ends with "This page was last edited on 8 February 2023, at
 * 16:38." A scraper that reads every numbered-looking line off the rendered
 * page turns that sentence into a card: cardNumber "This", playerName "page was
 * last edited on...". 17 such rows exist across o-pee-chee years 1969-1989.
 *
 * They are not merely ugly. canonicalCardSearch already carries a junk-row
 * guard for exactly this shape ("no card number → no click-through"), which is
 * a reader working around bad data rather than the data being fixed.
 *
 * ZERO COMPS IS THE GATE, CHECKED PER ROW AT RUN TIME — not assumed from an
 * earlier measurement. A catalog row that sales point at is not junk whatever
 * its number looks like, and deleting it would orphan real money. Every row is
 * re-checked immediately before its own delete; one holding a comp is kept and
 * reported.
 *
 * DELETION IS BY EXPLICIT VOCABULARY, never a pattern. Only the spellings named
 * in JUNK_NUMBERS are eligible: "NNO" and "JOKER" are REAL card numbers in this
 * same container and a looser rule would take them.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/retire-wiki-footer-catalog-rows.cjs \
 *     --set-key=o-pee-chee [--expect=17] [--apply]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const SET_KEY = arg("set-key", "");
const EXPECT = arg("expect", "");

/** The exact spellings that are never a card number. NOT a pattern: "NNO"
 *  (no number) and "JOKER" are real, and a regex over words would delete them. */
const JUNK_NUMBERS = ["This", "this", "THIS", "undefined", "Undefined", "UNDEFINED"];
/** Corroboration: a real card's player is a person, not a sentence. */
const FOOTER_PLAYER = /page was last edited|retrieved from|categories:|navigation menu/i;

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!SET_KEY) { console.error("FATAL: --set-key is required; this script refuses whole-container scope."); process.exit(2); }

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");

  console.log(`[retire-wiki-footer-rows] mode=${APPLY ? "APPLY" : "DRY-RUN"}  setKey=${SET_KEY}\n`);

  const inList = JUNK_NUMBERS.map((_, i) => `@n${i}`).join(", ");
  const { resources: rows } = await cat.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.cardNumber, c.playerName, c.cardYear
            FROM c WHERE c.setKey = @sk AND c.cardNumber IN (${inList})`,
    parameters: [{ name: "@sk", value: SET_KEY }, ...JUNK_NUMBERS.map((v, i) => ({ name: `@n${i}`, value: v }))],
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`matched ${rows.length} rows with a junk card number`);
  if (EXPECT !== "" && rows.length !== Number(EXPECT)) {
    console.error(`\nFATAL: expected ${EXPECT}, matched ${rows.length}. Refusing.`);
    process.exit(3);
  }
  if (!rows.length) { console.log("nothing to do."); return; }

  const deletable = [], kept = [];
  for (const r of rows) {
    const { resources: n } = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: r.hobbyiqCardId }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    const comps = n[0] ?? 0;
    const looksLikeFooter = FOOTER_PLAYER.test(String(r.playerName || ""));
    if (comps > 0) { kept.push({ r, why: `${comps} comps` }); continue; }
    if (!looksLikeFooter) { kept.push({ r, why: "player is not footer text" }); continue; }
    deletable.push(r);
  }

  console.log(`  deletable (zero comps AND footer text): ${deletable.length}`);
  console.log(`  kept:                                   ${kept.length}`);
  for (const k of kept) console.log(`     KEEP (${k.why})  ${k.r.hobbyiqCardId}`);
  for (const r of deletable.slice(0, 8)) {
    console.log(`     ${r.cardYear} #${r.cardNumber}  ${JSON.stringify(String(r.playerName).slice(0, 54))}`);
  }

  if (!APPLY) { console.log(`\n(dry-run; would delete ${deletable.length})`); return; }

  let ok = 0, failed = 0;
  for (const r of deletable) {
    try { await cat.item(r.id, r.cardId).delete(); ok++; }
    catch (e) { failed++; if (failed <= 5) console.error(`  FAILED ${r.id}: ${String(e.message).slice(0, 130)}`); }
  }
  console.log(`\n[done] deleted=${ok} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
