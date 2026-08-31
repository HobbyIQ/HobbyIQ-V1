#!/usr/bin/env node
/**
 * repair-finest-sport-conflation.cjs -- CF-1993-FINEST-SPORT-CONFLATION
 * (Drew, 2026-08-31). 1993 Topps Finest is TWO products under one key: a
 * baseball set ("1993 Topps Finest") and a basketball set ("1993-94 Topps
 * Finest"). They share a cardNumber space -- #99 is Jose Canseco AND Shaquille
 * O'Neal -- and a population of rows carries the WRONG sport segment.
 *
 * The decision rules live in services/catalog/finestSportConflationRule.ts and
 * are shared with the tests; this script is the Cosmos plumbing around them.
 * Read that file for WHY the title is the authority and why a cross-sport
 * player name raises a row without deciding it.
 *
 * WHAT THIS DOES, in three independent passes (each counted on its own lines):
 *
 *   PASS A  catalog rows whose sport segment is wrong -> re-key.
 *   PASS B  pool rows whose slug sport is wrong -> re-key with the catalog, via
 *           relocate-sold-comp. The sold_comps slugs carry the SAME wrong sport,
 *           so a catalog fix alone would strand the sales.
 *   PASS C  the two data defects: fabricated printRun 241 (blanked) and the
 *           smeared cardNumber 1927 (PARKED and reported -- no evidence exists
 *           to repair it; see the rule file).
 *
 * SCOPE IS HARD-BOUNDED. Drew approved 1993 topps-finest ONLY. YEAR/SETKEY are
 * env-overridable so the same code can be pointed at a sibling family after a
 * separate ruling, but they DEFAULT to 1993 / topps-finest and the banner names
 * the scope out loud. There is no SCOPE=all: a whole-catalog sport re-key is
 * not a thing this script will do.
 *
 * A CATALOG ROW IS NEVER MOVED ONTO A LIVE ROW BLINDLY. If the destination slug
 * already exists (the correct row is already there), the wrong row is a
 * DUPLICATE of it, not a thing to overwrite: its sales are relocated onto the
 * survivor and the empty wrong row is retired. One card, one row, one pool.
 *
 * PARTITION KEYS. card_catalog is partitioned on /cardId and sold_comps on
 * /cardId; the sport segment is part of the id AND of cardId, so every repair
 * here crosses a partition and CANNOT be a patch. Catalog rows go through
 * moveCatalogRow, pool rows through relocateSoldComp (upsert -> verify
 * read-back -> delete). The one exception is the printRun blanking, which does
 * not change the key and so is a true in-place patch.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (REPORT ONLY by
 *      default); YEAR=1993; SETKEY=topps-finest; RUN_MINUTES=140; LIMIT=0;
 *      CENSUS=true to add the read-only cross-family blast-radius census.
 */
"use strict";
const path = require("path");

// ── the scope refusal runs FIRST, above any require() that can throw ────────
// (the fold-twins lesson: a stale dist/ made a refusal unreachable and the job
// exited on a MODULE_NOT_FOUND that merely LOOKED like a refusal).
const YEAR = Number(process.env.YEAR || 1993);
const SETKEY = String(process.env.SETKEY || "topps-finest").trim().toLowerCase();
if (!Number.isFinite(YEAR) || YEAR < 1900 || !SETKEY) {
  console.error("FATAL: YEAR and SETKEY must both be real. This script re-keys the SPORT segment;");
  console.error("       it refuses to run unbounded. Default scope is YEAR=1993 SETKEY=topps-finest.");
  process.exit(1);
}

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const {
  decideFinestSport, slugSport, withSport, canonSport, normPlayer, titleNamesPlayer, gradeParentOf,
  isFabricatedPrintRun, isSmearedCardNumber, SMEARED_CARD_NUMBER, FABRICATED_PRINT_RUN,
} = require(path.join(backend, "dist", "services", "catalog", "finestSportConflationRule.js"));
const { moveCatalogRow, retireCatalogRow } = require(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));
const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const RUN_MS = RUN_MINUTES * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const CENSUS = process.env.CENSUS === "true";

const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`repair-finest-sport-conflation   ${APPLY ? "APPLY" : "REPORT ONLY -- nothing is written"}`);
  console.log(`  scope        year=${YEAR} setKey=${SETKEY}   (Drew approved 1993 topps-finest only)`);
  console.log(`  authority    the TITLE: sport word first, then the 1993-94 season form.`);
  console.log(`               AMBIGUOUS stays put and is counted; nothing is moved on a guess.`);
  console.log(`  budget       ${RUN_MINUTES}m`);

  const stats = {
    catScanned: 0, catWrong: 0, catMovedOntoNew: 0, catMergedIntoExisting: 0,
    catAmbiguous: 0, catNoEvidence: 0, catAgree: 0, catFailed: 0,
    poolScanned: 0, poolWrong: 0, poolRelocated: 0, poolRelocateFailed: 0,
    poolAmbiguous: 0, poolNoEvidence: 0, poolAgree: 0, poolWithCatalog: 0, poolWithCatalogFailed: 0,
    printRunBlanked: 0, printRunFailed: 0, smearedParked: 0, gradedChildrenSkipped: 0,
    notReached: 0,
  };
  const byReason = {};
  const bySignal = {};
  const samples = [], mergeSamples = [], parkSamples = [], ambiguousSamples = [];
  const destWithoutCatalogRow = new Set();
  let stopReason = null;

  // ── PASS A: catalog rows ──────────────────────────────────────────────────
  // The catalog row carries no title of its own in most cases, so its sport is
  // adjudicated by the POOL rows that sit on its slug -- the sales are the only
  // per-card text this product has. A catalog row with no sales and no title is
  // undecidable and stays put.
  const catRows = [];
  {
    const it = cat.items.query({
      query: `SELECT c.id, c.cardId, c.sport, c.source, c.cardNumber, c.playerName,
                     c.parallel, c.printRun, c.gradeTier, c.title
              FROM c WHERE c.year = @y AND c.setKey = @s`,
      parameters: [{ name: "@y", value: YEAR }, { name: "@s", value: SETKEY }],
    }, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) { catRows.push(r); stats.catScanned++; }
    }
  }

  // Title evidence for a catalog row, gathered from the pool.
  //
  // THE KEY IS (slug-without-sport, PLAYER), NOT the slug alone. Keying on the
  // slug alone is what the first dry run got wrong, and wrongly: the two
  // products share a number space, so `...:97:base:no-auto` collects BOTH Larry
  // Walker's baseball sales AND a Steve Smith basketball sale. The basketball
  // sale was the only one whose title carried decidable evidence, so a
  // slug-keyed tally read "basketball, unanimous" and proposed moving Larry
  // Walker -- a Montreal Expo -- into the basketball product. Five more genuine
  // MLB players (David Cone, Cecil Fielder, Robin Ventura, Fred McGriff, Lee
  // Smith) came out of that same hole.
  //
  // The player name is what actually distinguishes the two cards that share a
  // number, so a sale only speaks for a catalog row when it names that row's
  // player. A row whose player the pool never names gets no evidence and stays
  // exactly where it is.
  const evidence = new Map(); // `${keyNoSport}|${player}` -> { basketball: n, baseball: n }
  const poolRows = [];
  {
    const it = pool.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.title, c.parallel,
                     c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.isAuto
              FROM c WHERE CONTAINS(c.hobbyiqCardId, @frag)`,
      parameters: [{ name: "@frag", value: `:${YEAR}:${SETKEY}:` }],
    }, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) { poolRows.push(r); stats.poolScanned++; }
    }
  }
  // Which players does the catalog know for each number-slug? A sale is
  // attributed to whichever of them its title actually names.
  const playersForSlug = new Map(); // keyNoSport -> Set<player>
  for (const row of catRows) {
    const p = normPlayer(row.playerName);
    if (!p) continue;
    // Keyed on the ungraded parent, so a graded child's player is known to the
    // parent's bucket and the sales there can be attributed to him.
    const k = withSport(gradeParentOf(String(row.id)), "*");
    const s = playersForSlug.get(k) ?? new Set();
    s.add(p);
    playersForSlug.set(k, s);
  }
  for (const r of poolRows) {
    const v = decideFinestSport(r.title);
    if (!v.decided) continue;
    const k = withSport(gradeParentOf(String(r.hobbyiqCardId ?? "")), "*");
    const title = normPlayer(r.title);
    for (const p of playersForSlug.get(k) ?? []) {
      // The sale must NAME this row's player. Two cards share the number; only
      // the name says which of them was sold.
      if (!titleNamesPlayer(title, p)) continue;
      const ek = `${k}|${p}`;
      const e = evidence.get(ek) ?? { basketball: 0, baseball: 0 };
      e[v.sport]++;
      evidence.set(ek, e);
    }
  }
  console.log(`\n  pass A: ${f(stats.catScanned)} catalog rows; ${f(stats.poolScanned)} pool rows read for title evidence`);
  console.log(`          ${f(evidence.size)} distinct slugs carry decided title evidence`);

  // Index the catalog by id so a merge target can be recognised without a read.
  const catById = new Map(catRows.map((r) => [String(r.id), r]));

  // A GRADED CHILD IS NEVER MOVED ON ITS OWN. moveCatalogRow refuses a graded
  // slug outright (`newSlug is not a hiq slug`) and it is right to: a graded row
  // is not an identity, it is a tier hanging off one. Moving the ungraded parent
  // retires its graded children as part of the move, and the grade ladder
  // rebuilds them under the correct sport. Twelve rows failed the first dry run
  // this way; they are counted here instead, as the collateral they are.
  const ungraded = catRows.filter((r) => gradeParentOf(String(r.id)) === String(r.id));
  stats.gradedChildrenSkipped = catRows.length - ungraded.length;

  let ai = 0;
  for (const row of ungraded) {
    if (LIMIT && ai >= LIMIT) { stats.notReached += ungraded.length - ai; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`; stats.notReached += ungraded.length - ai; break; }
    ai++;

    const cur = canonSport(row.sport);
    const player = normPlayer(row.playerName);
    // A GRADED row carries no sales of its own -- the sales sit on the ungraded
    // parent slug, so `...:212:refractor:no-auto:psa-8` has a pool count of
    // zero and would be undecidable forever. Its identity is the parent's plus
    // a grade, and the sport segment is the same question for both, so it reads
    // the PARENT's evidence. Measured: 17 of the mis-sported catalog rows are
    // graded children and every one of them is invisible without this.
    const key = withSport(gradeParentOf(String(row.id)), "*");
    // No player name on the row = no way to tell which of the two cards sharing
    // this number it is. Undecidable by construction; leave it alone.
    const ev = player ? evidence.get(`${key}|${player}`) : null;
    // A row's OWN title, when it has one, is evidence too.
    const own = decideFinestSport(row.title);

    let want = null, signal = null;
    if (own.decided) { want = own.sport; signal = own.signal; }
    else if (ev) {
      const bk = ev.basketball, bb = ev.baseball;
      // Require the evidence to be one-sided. A slug whose sales name BOTH
      // sports is a split pool, not a verdict -- #110 holds two Ken Griffey Jr
      // sales and one Mats Sundin sale under a single wrong hockey slug. Those
      // are reported, never re-keyed wholesale.
      if (bk > 0 && bb === 0) { want = "basketball"; signal = "pool-title"; }
      else if (bb > 0 && bk === 0) { want = "baseball"; signal = "pool-title"; }
      else { stats.catAmbiguous++; byReason["pool-evidence-split"] = (byReason["pool-evidence-split"] ?? 0) + 1;
        if (ambiguousSamples.length < 12) ambiguousSamples.push(`  ${row.id}  pool says basketball:${bk} baseball:${bb} — split pool, left alone`);
        continue; }
    }

    if (!want) {
      stats.catNoEvidence++;
      byReason[own.decided ? "?" : own.reason] = (byReason[own.decided ? "?" : own.reason] ?? 0) + 1;
      continue;
    }
    if (want === cur) { stats.catAgree++; bySignal[signal] = (bySignal[signal] ?? 0) + 1; continue; }

    stats.catWrong++;
    bySignal[signal] = (bySignal[signal] ?? 0) + 1;
    const targetId = withSport(String(row.id), want);
    const line = `  ${row.id}\n      -> ${targetId}   [${signal}] ${row.playerName ?? "(no player)"}`;

    try {
      // Move the sales that live in the WRONG row's partition first, so the
      // catalog row is never deleted out from under a sale.
      await relocatePoolRowsFor(pool, String(row.id), targetId, stats, want);

      if (catById.has(targetId)) {
        // The correct row already exists: this is a duplicate, not a move.
        stats.catMergedIntoExisting++;
        if (mergeSamples.length < 12) mergeSamples.push(`${line}   (destination EXISTS — sales moved, wrong row retired)`);
        await retireCatalogRow(
          cat, String(row.id), row.cardId,
          `CF-1993-FINEST-SPORT-CONFLATION: duplicate of ${targetId} under the correct sport`,
          { retry, dryRun: !APPLY },
        );
      } else {
        stats.catMovedOntoNew++;
        if (samples.length < 15) samples.push(line);
        await moveCatalogRow(cat, row, targetId, { sport: want }, {
          reason: `CF-1993-FINEST-SPORT-CONFLATION: sport segment was ${cur}, title evidence says ${want}`,
          dryRun: !APPLY, salesContainer: pool, retry,
        });
        catById.set(targetId, { ...row, id: targetId, sport: want });
      }
    } catch (e) {
      stats.catFailed++;
      if (stats.catFailed <= 5) console.log(`  FAILED ${row.id}: ${String(e.message).slice(0, 150)}`);
    }
  }

  // ── PASS B: pool rows whose slug sport is wrong but whose catalog row was
  // not itself moved (a sale can be mis-slugged on its own). ────────────────
  for (const r of poolRows) {
    const cur = canonSport(slugSport(String(r.hobbyiqCardId ?? "")));
    const v = decideFinestSport(r.title);
    if (!v.decided) {
      if (v.reason === "no-evidence") stats.poolNoEvidence++;
      else { stats.poolAmbiguous++; byReason[v.reason] = (byReason[v.reason] ?? 0) + 1; }
      continue;
    }
    if (v.sport === cur) { stats.poolAgree++; continue; }
    stats.poolWrong++;
    // Pass A already relocated everything under a catalog slug it moved. What
    // remains here is a sale whose own title disagrees with a slug the catalog
    // considers correct -- the split-pool case (Mats Sundin under #110).
    const targetId = withSport(String(r.hobbyiqCardId), v.sport);
    destWithoutCatalogRow.add(targetId);
    if (parkSamples.length < 15) {
      parkSamples.push(`  ${r.hobbyiqCardId}\n      -> ${targetId}   [${v.signal}] ${String(r.title).slice(0, 84)}`);
    }
    try {
      const keep = {
        ...stripSystem(r), cardId: targetId, hobbyiqCardId: targetId, sport: v.sport,
        reslugedFrom: r.cardId, reslugedReason: "CF-1993-FINEST-SPORT-CONFLATION: title names the other sport",
        reslugedAt: new Date().toISOString(),
      };
      keep.contentHash = contentHashOf(keep);
      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id: r.id, cardId: r.cardId }], retry,
        verifyFields: ["cardId", "hobbyiqCardId", "sport"], dryRun: !APPLY,
      });
      if (res.ok) stats.poolRelocated++; else stats.poolRelocateFailed++;
    } catch { stats.poolRelocateFailed++; }
  }

  // ── PASS C: the two data defects ─────────────────────────────────────────
  for (const row of catRows) {
    if (isSmearedCardNumber(row.cardNumber)) {
      // PARKED, not repaired. No playerName, no sales, no title: nothing
      // attests the true number. Inventing #19 from the shape of the typo is
      // exactly the guess this repair refuses to make.
      stats.smearedParked++;
      parkSamples.push(`  PARKED cardNumber=${SMEARED_CARD_NUMBER}: ${row.id}\n      printRun=${row.printRun} playerName=${row.playerName ?? "null"} — no evidence of the true number; a human rules on this.`);
    }
    if (isFabricatedPrintRun(row.printRun)) {
      // A pre-serial product cannot carry a stated run. Blank means unknown.
      // This does NOT change the key, so it is a true in-place patch.
      try {
        if (APPLY) {
          await retry(() => cat.item(row.id, row.cardId ?? row.id).patch([
            { op: "set", path: "/printRun", value: null },
            { op: "add", path: "/printRunBlankedAt", value: new Date().toISOString() },
            { op: "add", path: "/printRunBlankedReason", value: `CF-1993-FINEST-SPORT-CONFLATION: /${FABRICATED_PRINT_RUN} is a hobby estimate on a pre-serial product, never a stated run` },
          ]));
        }
        stats.printRunBlanked++;
      } catch (e) {
        stats.printRunFailed++;
        console.log(`  printRun blank FAILED ${row.id}: ${String(e.message).slice(0, 120)}`);
      }
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`\n  CATALOG (pass A)`);
  console.log(`    rows scanned              ${f(stats.catScanned)}`);
  console.log(`    graded children          ${f(stats.gradedChildrenSkipped)}   <- never moved alone; the parent's move retires them and the ladder rebuilds them`);
  console.log(`    sport already correct     ${f(stats.catAgree)}`);
  console.log(`    ${APPLY ? "RE-KEYED" : "WOULD RE-KEY"}              ${f(stats.catWrong)}`);
  console.log(`      onto a NEW slug         ${f(stats.catMovedOntoNew)}`);
  console.log(`      merged into an EXISTING correct row ${f(stats.catMergedIntoExisting)}   <- duplicate; sales moved, wrong row retired`);
  console.log(`    AMBIGUOUS, left alone     ${f(stats.catAmbiguous)}   <- pool evidence names both sports (a split pool)`);
  console.log(`    no evidence, left alone   ${f(stats.catNoEvidence)}`);
  console.log(`    failed                    ${f(stats.catFailed)}`);
  console.log(`\n  POOL (pass B)`);
  console.log(`    rows scanned              ${f(stats.poolScanned)}`);
  console.log(`    slug sport already correct ${f(stats.poolAgree)}`);
  console.log(`    ${APPLY ? "RELOCATED" : "WOULD RELOCATE"}             ${f(stats.poolWrong)}   (ok ${f(stats.poolRelocated)}, failed ${f(stats.poolRelocateFailed)})   <- the sale's OWN title disagrees with its slug`);
  console.log(`    moved with their catalog row ${f(stats.poolWithCatalog)}   (failed ${f(stats.poolWithCatalogFailed)})   <- disjoint from the line above; pass A carried these`);
  console.log(`    ambiguous / other sport   ${f(stats.poolAmbiguous)}`);
  console.log(`    no sport evidence in title ${f(stats.poolNoEvidence)}   <- silent title; row stays exactly as it is`);
  console.log(`\n  DATA DEFECTS (pass C)`);
  console.log(`    printRun /${FABRICATED_PRINT_RUN} blanked        ${f(stats.printRunBlanked)}   (failed ${f(stats.printRunFailed)})   <- pre-serial product; blank means unknown`);
  console.log(`    cardNumber ${SMEARED_CARD_NUMBER} PARKED       ${f(stats.smearedParked)}   <- reported, NOT repaired: no evidence of the true number`);
  console.log(`\n    not reached               ${f(stats.notReached)}`);

  if (Object.keys(bySignal).length) {
    console.log(`\n  deciding signal:`);
    for (const [k, v] of Object.entries(bySignal).sort((a, b) => b[1] - a[1])) console.log(`    ${String(f(v)).padStart(8)}  ${k}`);
  }
  if (Object.keys(byReason).length) {
    console.log(`\n  why a row was left alone:`);
    for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`    ${String(f(v)).padStart(8)}  ${k}`);
  }
  // Where the relocated sales LAND. A destination with no catalog row is not a
  // failure -- FMV reads the pool by hobbyiqCardId and prices it fine -- but it
  // IS an acquisition list: these are the basketball rows the checklist has not
  // minted yet (the Shaq ruling manifest says the full basketball checklist
  // "comes separately"). Reported so the gap is visible rather than silent, and
  // NOT minted here: derived rows never outvote a checklist.
  if (destWithoutCatalogRow.size) {
    const known = new Set(catRows.map((r) => String(r.id)));
    const orphans = [...destWithoutCatalogRow].filter((d) => !known.has(d));
    console.log(`\n  DESTINATIONS WITH NO CATALOG ROW: ${f(orphans.length)} of ${f(destWithoutCatalogRow.size)}`);
    console.log(`    the sales price correctly (FMV reads the pool by slug); this is the acquisition`);
    console.log(`    list for the 1993-94 basketball checklist. Nothing is minted here.`);
    for (const d of orphans.slice(0, 12)) console.log(`      ${d}`);
    if (orphans.length > 12) console.log(`      ... and ${f(orphans.length - 12)} more`);
  }

  if (samples.length) { console.log(`\n  sample catalog re-keys:`); for (const s of samples) console.log(s); }
  if (mergeSamples.length) { console.log(`\n  sample merges into an existing correct row:`); for (const s of mergeSamples) console.log(s); }
  if (ambiguousSamples.length) { console.log(`\n  sample AMBIGUOUS (left alone):`); for (const s of ambiguousSamples) console.log(s); }
  if (parkSamples.length) { console.log(`\n  sample pool re-keys / parked rows:`); for (const s of parkSamples) console.log(s); }

  if (CENSUS) await census(cat);

  if (APPLY) {
    // DISJOINT counters: a slice is never a sibling counter.
    reportWrites({
      job: "repair-finest-sport-conflation",
      intended: stats.catWrong + stats.printRunBlanked + stats.printRunFailed + stats.catFailed
        + stats.catAgree + stats.catAmbiguous + stats.catNoEvidence,
      written: stats.catMovedOntoNew + stats.catMergedIntoExisting + stats.printRunBlanked,
      skipped: stats.catAgree + stats.catAmbiguous + stats.catNoEvidence,
      failed: stats.catFailed + stats.printRunFailed,
    });
    console.log(`  collateral (not catalog rows): pool relocated ${f(stats.poolRelocated)} | with their catalog row ${f(stats.poolWithCatalog)} | relocate failed ${f(stats.poolRelocateFailed + stats.poolWithCatalogFailed)} | parked ${f(stats.smearedParked)}`);
  }
  if (stopReason) console.log(`\n${stopReason}`);
}

/**
 * Re-key every pool row sitting in the wrong catalog row's partition.
 *
 * A sale is only moved when its OWN title does not contradict the destination.
 * The #110 case is why: that slug holds two Ken Griffey Jr sales (baseball) and
 * one Mats Sundin sale (hockey). Moving the partition wholesale would carry a
 * hockey sale into a baseball pool.
 */
async function relocatePoolRowsFor(pool, wrongId, targetId, stats, wantSport) {
  const it = pool.items.query(
    { query: "SELECT * FROM c WHERE c.cardId = @t", parameters: [{ name: "@t", value: wrongId }] },
    { partitionKey: wrongId, maxItemCount: 200 },
  );
  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources ?? []) {
      const v = decideFinestSport(row.title);
      if (v.decided && v.sport !== wantSport) continue; // its own title says otherwise: pass B reports it
      const keep = {
        ...stripSystem(row), cardId: targetId, hobbyiqCardId: targetId, sport: wantSport,
        reslugedFrom: wrongId,
        reslugedReason: "CF-1993-FINEST-SPORT-CONFLATION: catalog row re-keyed to the correct sport",
        reslugedAt: new Date().toISOString(),
      };
      keep.contentHash = contentHashOf(keep);
      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id: row.id, cardId: wrongId }], retry,
        verifyFields: ["cardId", "hobbyiqCardId", "sport"], dryRun: !APPLY,
      });
      // Counted SEPARATELY from pass B. These sales move because their CATALOG
      // row moved; pass B's move because their own title disagrees with a slug
      // the catalog considers correct. Summing them into one counter made the
      // report read "WOULD RELOCATE 394 (ok 397)" -- more successes than
      // intentions, which means neither number can be trusted.
      if (res.ok) stats.poolWithCatalog++; else stats.poolWithCatalogFailed++;
    }
  }
}

/**
 * READ-ONLY blast-radius census. Does this conflation shape exist in other
 * year/set families? The signature is not "one setKey carries two sports" --
 * Topps and Fleer legitimately printed every sport under one brand each year.
 * It is a PLAYER appearing under two sports inside one (year, setKey), which is
 * what a shared, mis-split number space produces.
 *
 * Reports only. Nothing outside the approved 1993 topps-finest scope is fixed.
 */
async function census(cat) {
  console.log(`\n  ── CROSS-FAMILY CENSUS (read-only; nothing outside ${YEAR} ${SETKEY} is repaired) ──`);
  const { resources } = await cat.items.query(
    `SELECT c.year, c.setKey, c.sport, COUNT(1) AS n FROM c WHERE c.year >= 1980 AND c.year <= 2000 GROUP BY c.year, c.setKey, c.sport`,
  ).fetchAll();
  const fam = new Map();
  for (const r of resources) {
    const k = `${r.year}|${r.setKey}`;
    const e = fam.get(k) ?? {};
    e[r.sport || "(none)"] = r.n;
    fam.set(k, e);
  }
  const multi = [...fam].filter(([, e]) => Object.keys(e).filter((s) => s !== "(none)").length > 1);
  const minorTotal = multi.reduce((a, [, e]) => {
    const sorted = Object.values(e).sort((x, y) => y - x);
    return a + sorted.slice(1).reduce((s, n) => s + n, 0);
  }, 0);
  console.log(`    (year,setKey) pairs 1980-2000 carrying >1 sport: ${f(multi.length)}`);
  console.log(`    rows outside each pair's dominant sport:          ${f(minorTotal)}`);
  console.log(`    NOTE most of that is LEGITIMATE: 1981 topps really is baseball+football+hockey+basketball.`);
  console.log(`         The conflation signature is a PLAYER under two sports in one family.`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
