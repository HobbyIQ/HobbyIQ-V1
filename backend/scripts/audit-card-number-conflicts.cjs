#!/usr/bin/env node
/**
 * CF-CARD-NUMBER-CONFLICT-AUDIT (Drew, 2026-08-18: "we should do matches of
 * names, parallels year and sets, and if a card number is off — which happens,
 * we should fix it").
 *
 * Finds cards whose IDENTITY agrees but whose CARD NUMBER does not, so a
 * number typo can be corrected against the rest of its own evidence.
 *
 * THE KEY, AND WHY IT NEEDS THE PREFIX. Drew's formulation was name + parallel
 * + year + set. Measured on 2026 Bowman + Bowman Chrome (98,194 catalog rows),
 * that key is NOT unique — only 84.7% of tuples map to a single number:
 *
 *   jac caglianone|2026|bowman|base -> BS-4, CRA-CAG, FD-10, ES-23, BA-27,
 *                                      RMA-JC, 75, P-23, BWC-13, BST-14,
 *                                      PRV-JC, PC-17, DPPA-WC, MF-7
 *
 * Those are not 14 wrong numbers, they are 14 different INSERTS of one player
 * in one product — Sterling, Future Definition, Elite Signatures. "Repairing"
 * them against each other would merge fourteen real cards, which is the exact
 * pooling defect this codebase spent 2026-08-18 undoing.
 *
 * The card-number PREFIX is the subset identifier (BCP-, CPA-, FD-, ES-). Add
 * it and the key becomes 99.85% unique: 60,536 of 60,626 tuples map to exactly
 * one number. The 90 that do not are the actual defects:
 *
 *   jj wetherholt|bowman-chrome|base|CRA -> CRA-JW, CRA-JWE   initials typo
 *   wilder dalis |bowman-chrome|base|BCP -> BCP-150, BCP-188  one is wrong
 *   eric hartman |bowman-chrome|lava     -> 129, BCP102       missing hyphen
 *
 * READ-ONLY, AND IT DOES NOT VOTE. It reports each conflict with the evidence
 * behind every candidate number — row count and source — but never picks a
 * winner. A majority vote is precisely the wrong instrument here: the
 * 2025 topps-chrome f15-6 slug carries 406 Ohtani sales on a card the catalog
 * says is Bryce Harper, so "most rows win" would confidently pick wrong. The
 * CHECKLIST decides, and checklist-backed sources are flagged per candidate so
 * that decision is one lookup away.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-card-number-conflicts.cjs \
 *     [--year=2026] [--setKey=bowman] [--top=40] [--minRows=1]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const YEAR = arg("year", "");
const SETKEY = arg("setKey", "");
const TOP = Number(arg("top", "40"));
const MIN_ROWS = Number(arg("minRows", "1"));

/** Checklist-backed sources — these settle a conflict. Vendor/auto-seed rows
 *  do not, however many of them there are. */
const CHECKLIST_SOURCES = /checklistcenter|baseballcardpedia|bccp|tcdb|beckett/i;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const prefixOf = (n) => {
  const s = String(n ?? "").toUpperCase().trim();
  const m = s.match(/^([A-Z]+)-/);
  return m ? m[1] : "(numeric)";
};

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  const where = ["IS_DEFINED(c.cardNumber)", "IS_DEFINED(c.playerName)"];
  if (YEAR) where.push(`c.cardYear = ${Number(YEAR)}`);
  if (SETKEY) where.push(`c.setKey = "${SETKEY}"`);

  const iter = cat.items.query(
    `SELECT c.playerName, c.cardYear, c.setKey, c.parallel, c.cardNumber, c.source
       FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 2000 },
  );

  // key -> number -> { rows, sources:Set }
  const groups = new Map();
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      scanned++;
      const player = norm(r.playerName);
      const number = String(r.cardNumber ?? "").toUpperCase().trim();
      if (!player || !number || number === "NULL") continue;
      const key = [player, r.cardYear, r.setKey, norm(r.parallel), prefixOf(number)].join("|");
      let byNum = groups.get(key);
      if (!byNum) groups.set(key, (byNum = new Map()));
      let e = byNum.get(number);
      if (!e) byNum.set(number, (e = { rows: 0, sources: new Set() }));
      e.rows++;
      if (r.source) e.sources.add(r.source);
    }
    if (scanned % 100000 < 2000) process.stderr.write(`\r  scanned=${scanned} keys=${groups.size}   `);
  }
  process.stderr.write("\n");

  const conflicts = [];
  for (const [key, byNum] of groups) {
    if (byNum.size < 2) continue;
    const cands = [...byNum.entries()]
      .map(([number, e]) => ({
        number,
        rows: e.rows,
        checklistBacked: [...e.sources].some((s) => CHECKLIST_SOURCES.test(s)),
        sources: [...e.sources].slice(0, 3),
      }))
      .filter((c) => c.rows >= MIN_ROWS)
      .sort((a, b) => b.rows - a.rows);
    if (cands.length < 2) continue;
    const backed = cands.filter((c) => c.checklistBacked);
    conflicts.push({
      key,
      cands,
      // Decidable when exactly ONE candidate has checklist backing — then the
      // checklist has already answered and the others are the typos.
      verdict: backed.length === 1 ? `checklist says ${backed[0].number}`
        : backed.length === 0 ? "NO checklist backing — cannot settle"
        : "MULTIPLE checklist-backed — genuinely different cards, leave alone",
    });
  }
  conflicts.sort((a, b) => b.cands.reduce((s, c) => s + c.rows, 0) - a.cands.reduce((s, c) => s + c.rows, 0));

  const decidable = conflicts.filter((c) => c.verdict.startsWith("checklist says"));
  const unbacked = conflicts.filter((c) => c.verdict.startsWith("NO checklist"));
  const multi = conflicts.filter((c) => c.verdict.startsWith("MULTIPLE"));

  console.log(`\nscanned=${scanned.toLocaleString()} identityKeys=${groups.size.toLocaleString()}`);
  console.log(`conflicting keys: ${conflicts.length.toLocaleString()}  (${(conflicts.length / groups.size * 100).toFixed(2)}% — the rest agree)\n`);
  console.log(`  DECIDABLE  exactly one checklist-backed number : ${decidable.length}`);
  console.log(`  UNBACKED   no checklist behind any candidate   : ${unbacked.length}`);
  console.log(`  LEAVE      several checklist-backed numbers    : ${multi.length}   <- real distinct cards\n`);

  for (const c of decidable.slice(0, TOP)) {
    console.log(`  ${c.key}`);
    console.log(`     ${c.verdict}`);
    for (const x of c.cands) {
      console.log(`       ${x.checklistBacked ? "CHECKLIST" : "   vendor"}  ${String(x.number).padEnd(12)} rows=${String(x.rows).padStart(4)}  ${x.sources.join(",")}`);
    }
  }
  if (unbacked.length) {
    console.log(`\n  --- UNBACKED (need a checklist before anything can be fixed) ---`);
    for (const c of unbacked.slice(0, 10)) {
      console.log(`  ${c.key}  ->  ${c.cands.map((x) => `${x.number}(${x.rows})`).join(", ")}`);
    }
  }
  console.log("\nREAD-ONLY — nothing was written, and no winner was chosen by row count.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
