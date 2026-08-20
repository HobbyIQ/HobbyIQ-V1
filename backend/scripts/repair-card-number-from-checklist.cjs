#!/usr/bin/env node
/**
 * CF-CARD-NUMBER-REPAIR (Drew, 2026-08-18: "if a card number is off — which
 * happens, we should fix it").
 *
 * Moves SALES that carry a wrong card number into the pool of the card they
 * actually are, using the checklist as the authority.
 *
 * WHY sold_comps AND NOT card_catalog. The catalog is where the CONFLICT is
 * discovered, but it is the wrong place to repair. Correcting a catalog row's
 * cardNumber changes its identity into one that usually ALREADY EXISTS — the
 * sal stewart case has 12 vendor rows on "6" and 10 checklist rows on
 * "91CB-21", so rewriting the 12 would duplicate the 10. That is a merge, not
 * a field update, and merging catalog rows is a bigger, less reversible call.
 *
 * Sales have no such problem: every sale is a distinct event, so moving one to
 * the right card is a pure gain and duplicates are impossible by construction.
 * It is also where the value is — a sale in the wrong pool is a wrong price.
 *
 * THE CORRECTION MAP COMES FROM THE CHECKLIST, NEVER FROM A VOTE. Built only
 * from DECIDABLE conflicts: an identity key where exactly ONE candidate number
 * is checklist-backed. Everything else is skipped:
 *
 *   UNBACKED  no checklist behind any candidate  -> acquire a checklist first
 *   LEAVE     several checklist-backed numbers   -> genuinely different cards
 *
 * The first conflict this found is why voting is banned here:
 *
 *   sal stewart|2026|topps-chrome|base
 *      vendor    "6"      rows=12   <- the WRONG number is more popular
 *      CHECKLIST 91CB-21  rows=10
 *
 * IDENTITY KEY = player + year + setKey + parallel + cardNumber PREFIX. The
 * prefix is load-bearing: without it, name+year+set+parallel is only 84.7%
 * unique and lumps 14 distinct inserts of one player together (Sterling,
 * Future Definition, Elite Signatures). With it, 99.85%.
 *
 * BARE-NUMERIC NUMBERS ARE EXCLUDED. They have no prefix to carry the subset,
 * so the key cannot separate a base card from an insert —
 * michael jordan|2026|hoops|base|(numeric) shows 45 numbers at one row each,
 * a mis-slugged pile rather than a number conflict. Repairing off that key
 * would invent identity.
 *
 * cardNumberBefore + hobbyiqCardIdBefore record the originals.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-card-number-from-checklist.cjs \
 *     [--year=2026] [--apply] [--pool=8] [--top=25]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { canAdjudicate } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const YEAR = arg("year", "");
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "25"));

/** Delegates to catalogAuthority — see CF-CATALOG-AUTHORITY. */
const isChecklistSource = (source) => canAdjudicate(source);
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const prefixOf = (n) => {
  const s = String(n ?? "").toUpperCase().trim();
  const m = s.match(/^([A-Z]+)-/);
  return m ? m[1] : null;          // null = bare numeric, deliberately excluded
};
const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");

  console.log(`[repair-card-number] mode=${APPLY ? "APPLY" : "DRY-RUN"}${YEAR ? ` year=${YEAR}` : " (all years)"}\n`);

  // ---- 1. Build the correction map from the CATALOG -----------------------
  const catWhere = ["IS_DEFINED(c.cardNumber)", "IS_DEFINED(c.playerName)"];
  if (YEAR) catWhere.push(`c.cardYear = ${Number(YEAR)}`);
  // PAGINATE, do not fetchAll. The first version pulled a whole year of
  // card_catalog in one call — 2,000,000 rows for 2024 — and Cosmos threw 429
  // with x-ms-throttle-retry-count=3 after 31s of backoff, at the container's
  // 20k RU. The audit script that produced these findings paginates with
  // maxItemCount for exactly this reason; the repair has to as well or it can
  // never run on the years it was written for.
  const catIter = cat.items.query(
    `SELECT c.playerName, c.cardYear, c.setKey, c.parallel, c.cardNumber, c.source
       FROM c WHERE ${catWhere.join(" AND ")}`,
    { maxItemCount: 2000 },
  );
  const catRows = [];
  while (catIter.hasMoreResults()) {
    const { resources } = await catIter.fetchNext();
    for (const r of resources || []) catRows.push(r);
    if (catRows.length % 200000 < 2000) process.stderr.write(`\r  catalog scanned=${catRows.length}   `);
  }
  process.stderr.write("\n");

  const groups = new Map();  // key -> number -> {rows, checklist}
  for (const r of catRows) {
    const player = norm(r.playerName);
    const number = String(r.cardNumber ?? "").toUpperCase().trim();
    const pfx = prefixOf(number);
    if (!player || !number || number === "NULL" || !pfx) continue;   // bare-numeric excluded
    const key = [player, r.cardYear, r.setKey, norm(r.parallel), pfx].join("|");
    let byNum = groups.get(key);
    if (!byNum) groups.set(key, (byNum = new Map()));
    let e = byNum.get(number);
    if (!e) byNum.set(number, (e = { rows: 0, checklist: false }));
    e.rows++;
    if (r.source && isChecklistSource(r.source)) e.checklist = true;
  }

  /** key -> { correct, wrong:Set } for DECIDABLE conflicts only. */
  const corrections = new Map();
  let leaveMulti = 0, unbacked = 0;
  for (const [key, byNum] of groups) {
    if (byNum.size < 2) continue;
    const backed = [...byNum.entries()].filter(([, e]) => e.checklist);
    if (backed.length === 0) { unbacked++; continue; }
    if (backed.length > 1) { leaveMulti++; continue; }
    const correct = backed[0][0];
    const wrong = new Set([...byNum.keys()].filter((n) => n !== correct));
    corrections.set(key, { correct, wrong });
  }

  console.log(`catalog rows=${catRows.length.toLocaleString()} identityKeys=${groups.size.toLocaleString()}`);
  console.log(`  DECIDABLE (repairable) : ${corrections.size}`);
  console.log(`  UNBACKED  (skipped)    : ${unbacked}`);
  console.log(`  LEAVE     (skipped)    : ${leaveMulti}\n`);
  if (corrections.size === 0) { console.log("nothing to repair."); return 0; }

  for (const [k, v] of [...corrections.entries()].slice(0, TOP)) {
    console.log(`  ${k}\n     -> ${v.correct}   (replacing ${[...v.wrong].join(", ")})`);
  }

  // ---- 2. Apply to SALES ---------------------------------------------------
  const soldWhere = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)", "IS_DEFINED(c.playerName)"];
  if (YEAR) soldWhere.push(`c.cardYear = ${Number(YEAR)}`);
  const iter = sold.items.query(
    `SELECT c.id, c.cardId, c.playerName, c.cardYear, c.parallel, c.cardNumber, c.hobbyiqCardId
       FROM c WHERE ${soldWhere.join(" AND ")}`,
    { maxItemCount: 2000 },
  );

  const work = [];
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      scanned++;
      const p = String(r.hobbyiqCardId).split(":");
      if (p.length < 7) continue;
      const number = String(r.cardNumber ?? "").toUpperCase().trim();
      const pfx = prefixOf(number);
      if (!pfx) continue;
      // setKey + parallel taken from the SLUG so the sale is matched on the
      // same normalized identity the catalog key was built from.
      const key = [norm(r.playerName), r.cardYear, p[3], norm(r.parallel), pfx].join("|");
      const fix = corrections.get(key);
      if (!fix || !fix.wrong.has(number)) continue;
      p[4] = slugify(fix.correct);
      work.push({ r, number: fix.correct, slug: p.join(":") });
    }
    if (scanned % 250000 < 2000) process.stderr.write(`\r  sales scanned=${scanned} toFix=${work.length}   `);
  }
  process.stderr.write("\n");

  console.log(`\nsales scanned=${scanned.toLocaleString()}  sales to repair=${work.length.toLocaleString()}`);

  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await sold.item(w.r.id, w.r.cardId).patch([
          { op: "add", path: "/cardNumberBefore", value: w.r.cardNumber },
          { op: "add", path: "/hobbyiqCardIdBefore", value: w.r.hobbyiqCardId },
          { op: "set", path: "/cardNumber", value: w.number },
          { op: "set", path: "/hobbyiqCardId", value: w.slug },
        ]);
        done++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.r.id}: ${String(e.message).slice(0, 90)}`);
      }
    }
  }));

  console.log(`repaired=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
