#!/usr/bin/env node
/**
 * CF-PARALLEL-INHERITS-PLAYER (Drew, 2026-08-17).
 *
 * A parallel does not change who is on the card. 1995-96 Fleer #22 is Michael
 * Jordan, so #22 Gold Medallion is also Michael Jordan. Ours said Alonzo
 * Mourning:
 *
 *     :22:base:no-auto              Michael Jordan    tcdb-scraped
 *     :22:gold-medallion:no-auto    Alonzo Mourning   sold-comps-stub
 *     :22:silver-spotlight:no-auto  Jason Kidd        sold-comps-stub
 *
 * Those rows were seeded from sale titles, so the player is whoever the parser
 * happened to read — not who the card depicts. A search for the Jordan Gold
 * Medallion cannot find it, and it is a valuable card.
 *
 * THE DANGER THIS SCRIPT IS BUILT AROUND. An INSERT has its own numbering, so
 * its #3 is a different card from base #3:
 *
 *     :3:base:no-auto               Craig Ehlo     <- base checklist
 *     :3:class-encounters:no-auto   Grant Hill     <- insert, ALSO correct
 *
 * Inheriting the base player there would corrupt a correct row. A true finish
 * parallel shares the base checklist's numbering; an insert does not. That is
 * a TAXONOMY question, and collector taxonomy is authoritative — so this script
 * never decides it. It reports each parallel with the evidence and repairs only
 * the ones named explicitly via --parallels.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-parallel-player-names.cjs \
 *     --sport=basketball --year=1995 --set-key=fleer            # report only
 *     ... --parallels=gold-medallion,silver-spotlight [--apply] # repair those
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

const SPORT = arg("sport", "");
const YEAR = Number(arg("year", "0"));
const SET_KEY = arg("set-key", "");
const ONLY = String(arg("parallels", "")).split(",").map((s) => s.trim()).filter(Boolean);
const APPLY = has("apply");

/** Sources that are a published checklist — authoritative for who is on a card.
 *  Everything else was derived from sales or auto-seeded at ingest. */
const isChecklistSource = (s) => /^(tcdb|beckett|cardboardconnection|hobbymonitor|baseballcardpedia|bccp|checklistcenter)/i.test(String(s || ""));

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!SPORT || !YEAR || !SET_KEY) { console.error("need --sport= --year= --set-key="); process.exit(2); }

  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  const { resources } = await cat.items.query({
    // cardId is the container's partition key (/cardId) and mirrors id. Patching
    // with any other value returns "Entity with the specified id does not
    // exist" — a partition miss reads exactly like a missing row.
    query: `SELECT c.id, c.cardId, c.cardNumber, c.playerName, c.source, c.setKey, c.year, c.sport
            FROM c WHERE c.sport=@sp AND c.year=@y AND c.setKey=@k`,
    parameters: [{ name: "@sp", value: SPORT }, { name: "@y", value: YEAR }, { name: "@k", value: SET_KEY }],
  }, { maxItemCount: -1 }).fetchAll();

  // Segment 5 of hiq:sport:year:setKey:cardNumber:parallel:auto is the parallel.
  const parallelOf = (id) => String(id).split(":")[5] || "base";

  // Base truth: the base row from a published checklist.
  const baseTruth = new Map();
  for (const r of resources) {
    if (parallelOf(r.id) !== "base") continue;
    if (!isChecklistSource(r.source)) continue;
    baseTruth.set(String(r.cardNumber).toUpperCase(), r.playerName);
  }

  // Group the non-base rows.
  const groups = new Map();
  for (const r of resources) {
    const par = parallelOf(r.id);
    if (par === "base") continue;
    if (!groups.has(par)) groups.set(par, []);
    groups.get(par).push(r);
  }

  console.log(`[repair-parallel-players] ${SPORT} ${YEAR} ${SET_KEY}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`base checklist rows (authoritative): ${baseTruth.size}\n`);
  console.log("parallel                        rows  inBase  agree  DIFFER  hasChecklist  maxNum");
  console.log("-".repeat(84));

  const plan = [];
  for (const [par, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    let inBase = 0, agree = 0, differ = 0, maxNum = 0, checklistBacked = false;
    const fixes = [];
    for (const r of rows) {
      if (isChecklistSource(r.source)) checklistBacked = true;
      const n = Number(String(r.cardNumber).replace(/\D/g, ""));
      if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
      const truth = baseTruth.get(String(r.cardNumber).toUpperCase());
      if (truth === undefined) continue;
      inBase++;
      if (String(truth).toLowerCase().trim() === String(r.playerName).toLowerCase().trim()) agree++;
      else { differ++; if (!isChecklistSource(r.source)) fixes.push({ r, truth }); }
    }
    console.log(`${par.padEnd(30)}${String(rows.length).padStart(6)}${String(inBase).padStart(8)}` +
      `${String(agree).padStart(7)}${String(differ).padStart(8)}${(checklistBacked ? "  YES" : "  no").padStart(14)}${String(maxNum).padStart(8)}`);
    if (ONLY.includes(par)) plan.push(...fixes);
  }

  if (ONLY.length === 0) {
    console.log(`\nNo --parallels given, so nothing will be repaired. Read the table above:`);
    console.log(`  hasChecklist=YES  -> an insert/subset with its OWN numbering. Do NOT inherit base players.`);
    console.log(`  maxNum near the base set size and inBase high -> looks like a true finish parallel.`);
    console.log(`  Re-run with --parallels=a,b,c to repair only the ones you confirm are finishes.`);
    return 0;
  }

  console.log(`\nplanned repairs: ${plan.length} rows across ${ONLY.length} parallel(s)`);
  plan.slice(0, 12).forEach((p) => console.log(`   ${p.r.id}\n      "${p.r.playerName}" -> "${p.truth}"`));
  if (!APPLY) { console.log(`\nDRY-RUN — re-run with --apply to write`); return 0; }

  let ok = 0, failed = 0;
  for (const { r, truth } of plan) {
    try {
      // Rows written before cardId existed carry NO partition-key path at all
      // (all the sold-comps-stub ones do). Cosmos addresses those with the
      // empty-object "none" partition key; passing the id instead returns
      // "Entity with the specified id does not exist", so a partition miss is
      // indistinguishable from a deleted row. Verified against
      // :22:gold-medallion, which reads fine with {} and 404s with the id.
      await cat.item(r.id, r.cardId === undefined ? {} : r.cardId).patch([
        { op: "set", path: "/playerName", value: truth },
        { op: "add", path: "/playerNameRepairedFrom", value: r.playerName },
        { op: "add", path: "/playerNameRepairedAt", value: new Date().toISOString() },
      ]);
      ok++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 90)}`);
    }
  }
  console.log(`\nrepaired=${ok} failed=${failed}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
