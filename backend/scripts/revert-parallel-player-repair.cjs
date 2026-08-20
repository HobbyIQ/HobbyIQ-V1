#!/usr/bin/env node
/**
 * CF-REVERT-PARALLEL-REPAIR (Drew, 2026-08-17).
 *
 * Undoes repair-parallel-player-names for a product, restoring playerName from
 * the playerNameRepairedFrom breadcrumb that repair wrote.
 *
 * WHY IT EXISTS. The gold-medallion repair assumed Gold Medallion was a finish
 * parallel of 1995-96 Fleer. TCDB's own set page lists every 1995-96 Fleer
 * related set — Class Encounters, Double Double, End 2 End, Flair Hardwood
 * Leader, Franchise Futures, NBA All Stars, Rookie Phenom, Rookie Phenom Hot
 * Pack — and Gold Medallion is not among them. It belongs to ULTRA
 * (1995-96 Ultra - Gold Medallion). Fleer and Ultra share a numbering RANGE but
 * agree on the player only 41 times in 197 (20.8%), because each orders its own
 * roster alphabetically by team.
 *
 * So those rows were Ultra cards mis-filed under setKey=fleer, and inheriting
 * Fleer's player overwrote correct data with wrong data: 124 of 141 rows had
 * been Ultra-correct (#25 Michael Jordan -> Will Perdue). Only 17 were junk.
 *
 * The real defect is the SLUG — setKey should be ultra, not fleer — not the
 * playerName. Restoring first, re-slugging is a separate decision.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/revert-parallel-player-repair.cjs \
 *     --sport=basketball --year=1995 --set-key=fleer [--apply]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const SPORT = arg("sport", ""), YEAR = Number(arg("year", "0")), SET_KEY = arg("set-key", "");
const APPLY = has("apply");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!SPORT || !YEAR || !SET_KEY) { console.error("need --sport= --year= --set-key="); process.exit(2); }

  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  const { resources } = await cat.items.query({
    query: `SELECT c.id, c.cardId, c.cardNumber, c.playerName, c.playerNameRepairedFrom
            FROM c WHERE c.sport=@sp AND c.year=@y AND c.setKey=@k AND IS_DEFINED(c.playerNameRepairedFrom)`,
    parameters: [{ name: "@sp", value: SPORT }, { name: "@y", value: YEAR }, { name: "@k", value: SET_KEY }],
  }, { maxItemCount: -1 }).fetchAll();

  console.log(`[revert] ${SPORT} ${YEAR} ${SET_KEY}  mode=${APPLY ? "APPLY" : "DRY-RUN"}  rows=${resources.length}\n`);
  resources.slice(0, 8).forEach((r) => console.log(`   #${r.cardNumber}  "${r.playerName}" -> "${r.playerNameRepairedFrom}"`));
  if (!APPLY) { console.log(`\nDRY-RUN — re-run with --apply to write`); return 0; }

  let ok = 0, failed = 0;
  for (const r of resources) {
    try {
      // Pre-cardId rows carry no partition-key path; those use the "none" key.
      await cat.item(r.id, r.cardId === undefined ? {} : r.cardId).patch([
        { op: "set", path: "/playerName", value: r.playerNameRepairedFrom },
        { op: "remove", path: "/playerNameRepairedFrom" },
        { op: "remove", path: "/playerNameRepairedAt" },
      ]);
      ok++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.log(`   revert failed ${r.id}: ${String(e.message).slice(0, 90)}`);
    }
  }
  console.log(`\nreverted=${ok} failed=${failed}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
