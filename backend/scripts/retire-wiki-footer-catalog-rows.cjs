#!/usr/bin/env node
/**
 * CF-A-PAGE-FOOTER-IS-NOT-A-CARD (Drew, 2026-09-01: "Delete, but only with
 * zero comps").
 *
 * A MediaWiki page ends with "This page was last edited on 8 February 2023, at
 * 16:38." A scraper that reads every numbered-looking line off the rendered
 * page turns that sentence into a card: cardNumber "This", playerName "page was
 * last edited on...".
 *
 * They are not merely ugly. canonicalCardSearch already carries a junk-row
 * guard for exactly this shape ("no card number -> no click-through"), which is
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
 * same container and a looser rule would take them. The junk number alone is
 * NOT sufficient either — the playerName must independently read as page
 * furniture, because "This set is exclusive to Series One packs sold at Walmart
 * stores." is prose scraped off the same page and is NOT a footer. 62 such rows
 * exist and this lane keeps every one of them.
 *
 * ── WHAT THE 2026-09-06 CENSUS ACTUALLY FOUND ────────────────────────────────
 *
 * The header this file shipped with said "17 such rows exist across o-pee-chee
 * years 1969-1989". That was the population of the ONE product the lane was
 * written against. Read across the whole container (read-only, 2026-09-06) the
 * real population is:
 *
 *   3,136 footer rows, baseball, 1949-2025, across 585 DISTINCT setKeys
 *     2,132 source baseballcardpedia
 *       737 source baseballcardpedia-graded
 *       267 source catalog-explode-actuals-2026-08-12
 *
 * and 310 of those 585 setKeys hold exactly ONE row. #1903's `deferred` block
 * names 191 of them because its own scope was baseball 1993-2005; every one of
 * the 191 is a subset of this population, and 2,945 more sit outside it.
 *
 * THAT NUMBER IS WHY SET_KEY IS A LIST. A lane whose scope axis admits exactly
 * one product would need 585 dispatches to finish its own population, 310 of
 * them to delete a single row. That is not a scope guard, it is a reason the
 * lane never runs — and a lane that never runs is how 3,136 junk rows outlived
 * the fix written for them. SET_KEY is now a comma-separated list, so a slice
 * is named by an operator and a whole-container sweep is still refused: the
 * refusal that matters is "say which products", not "say ONE product".
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/retire-wiki-footer-catalog-rows.cjs \
 *     --set-key=bowman-chrome,bowmans-best [--expect=274] [--apply]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
// CF-ONE-WAY-TO-MOVE-A-CATALOG-ROW. A retire goes through catalogRowOps, not
// through a hand-rolled container.item().delete(). The hand-rolled version
// this replaces also left any GRADED CHILDREN of the deleted row pointing at
// a parent that no longer existed; retireCatalogRow retires them first.
const { retireCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. The reconciliation is the shared helper,
// not a local print of the same equation — a hand-rolled one is invisible to
// the net that asserts every writer reconciles.
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit are the SHARED helper, never a local copy: #1859 is
// what a private copy of capped() costs (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
// The runner exports BACKFILL_APPLY and SET_KEY/SETKEY_LIKE, not --flags
// (CF-THE-RUNNER-EXPORTS-BACKFILL-APPLY-NOT-APPLY). Read both spellings, and
// trim both sides (CF-ENV-VAR-TRIM-SYMMETRY).
const env = (n, d = "") => String(process.env[n] ?? "").trim() || d;
const APPLY = process.argv.includes("--apply") || env("BACKFILL_APPLY") === "true";
const SET_KEY_RAW = arg("set-key", env("SET_KEY") || env("SETKEY_LIKE"));
/** The scope, as the list it always needed to be. Trimmed both sides per key,
 *  de-duplicated, empties dropped — a trailing comma is a typo, not a scope. */
const SET_KEYS = [...new Set(SET_KEY_RAW.split(",").map((s) => s.trim()).filter(Boolean))];
const EXPECT = arg("expect", env("EXPECT"));

const STARTED = Date.now();
/** THE THREE CONSTANTS, declared by name (lib/runner-budget.cjs). Spelled out
 *  here rather than left implicit in the budget() call because the pins that
 *  govern budgeted lanes — runnerBudgetMargin and laneExitsWhenWorkIsDone —
 *  select their population on the literal `RUN_MINUTES`/`BUDGET_MS`. A lane
 *  that carries a real clock but never spells it is a lane NO pin governs,
 *  which is precisely how this one drifted: it had neither a budget nor an
 *  exit, and both suites skipped it in silence rather than failing it by name.
 *
 *  THE UNIT IS ONE setKey, and the largest measured is bowman-chrome at 165
 *  rows. The gate costs a serial cross-partition COUNT per row, measured at
 *  191 ms/row against prod on 2026-09-06, so that unit is ~32s of gate plus
 *  its deletes. 3 minutes is that worst case with room, checked BEFORE the
 *  unit starts rather than at the loop top (the #1799 defect). */
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 100);
const RESERVE_MS = Number(process.env.RESERVE_MS || 3 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 5 * 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS, startedAt: STARTED });

/** The exact spellings that are never a card number. NOT a pattern: "NNO"
 *  (no number) and "JOKER" are real, and a regex over words would delete them. */
const JUNK_NUMBERS = ["This", "this", "THIS", "undefined", "Undefined", "UNDEFINED"];
/** Corroboration: a real card's player is a person, not a sentence. */
const FOOTER_PLAYER = /page was last edited|retrieved from|categories:|navigation menu/i;

const f = (n) => Number(n ?? 0).toLocaleString("en-US");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!SET_KEYS.length) {
    console.error("FATAL: --set-key is required; this script refuses whole-container scope."
      + " Pass one key or a comma-separated list (e.g. --set-key=bowman-chrome,bowmans-best).");
    process.exit(2);
  }

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");

  console.log(`[retire-wiki-footer-rows] mode=${APPLY ? "APPLY" : "DRY-RUN"}  setKeys=${SET_KEYS.length}`);
  console.log(`  scope: ${SET_KEYS.join(", ")}`);
  console.log(`  ${CLOCK.describe()}\n`);

  const inList = JUNK_NUMBERS.map((_, i) => `@n${i}`).join(", ");
  const skList = SET_KEYS.map((_, i) => `@sk${i}`).join(", ");
  const { resources: rows } = await cat.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.cardNumber, c.playerName, c.cardYear, c.setKey
            FROM c WHERE c.setKey IN (${skList}) AND c.cardNumber IN (${inList})`,
    parameters: [
      ...SET_KEYS.map((v, i) => ({ name: `@sk${i}`, value: v })),
      ...JUNK_NUMBERS.map((v, i) => ({ name: `@n${i}`, value: v })),
    ],
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`matched ${f(rows.length)} rows with a junk card number`);
  if (EXPECT !== "" && rows.length !== Number(EXPECT)) {
    console.error(`\nFATAL: expected ${EXPECT}, matched ${rows.length}. Refusing.`);
    process.exit(3);
  }
  if (!rows.length) { console.log("nothing to do."); return { client, budget: CLOCK }; }

  // Group by setKey so the unit the clock reserves for is the unit the loop
  // actually does, and so a stop mid-scope names the products left over.
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.setKey)) byKey.set(r.setKey, []);
    byKey.get(r.setKey).push(r);
  }

  const deletable = [], kept = [];
  let stoppedAtBudget = false, notReached = 0;
  const pending = [...byKey.keys()];
  for (let k = 0; k < pending.length; k++) {
    // THE PRE-CHECK: before the unit, never after it.
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      for (let j = k; j < pending.length; j++) notReached += byKey.get(pending[j]).length;
      break;
    }
    for (const r of byKey.get(pending[k])) {
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
  }

  console.log(`  deletable (zero comps AND footer text): ${f(deletable.length)}`);
  console.log(`  kept:                                   ${f(kept.length)}`);
  if (notReached) console.log(`  not reached (budget):                   ${f(notReached)}`);
  for (const k of kept.slice(0, 20)) console.log(`     KEEP (${k.why})  ${k.r.hobbyiqCardId}`);
  if (kept.length > 20) console.log(`     ... and ${f(kept.length - 20)} more kept`);

  // Per-setKey, so an operator planning the next slice reads the counts rather
  // than re-deriving them (CF-COUNT-BY-SOURCE-NOT-ROW-COUNT in miniature).
  const perKey = new Map();
  for (const r of deletable) perKey.set(r.setKey, (perKey.get(r.setKey) ?? 0) + 1);
  console.log("\n  deletable per setKey:");
  for (const [sk, n] of [...perKey.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(5)}  ${sk}`);
  }
  for (const r of deletable.slice(0, 8)) {
    console.log(`     ${r.cardYear} ${r.setKey} #${r.cardNumber}  ${JSON.stringify(String(r.playerName).slice(0, 54))}`);
  }

  if (!APPLY) {
    // A REPORT THAT DOES NOT COUNT THE CHILDREN UNDERSTATES THE DELETE.
    // retireCatalogRow retires a row's graded children FIRST, so what an apply
    // actually removes is deletable + their children — and the version of this
    // lane that shipped printed only the first number. `dryRun: true` walks the
    // same path and counts without writing, which is what the option is for.
    //
    // IT IS OPT-IN BECAUSE IT IS NOT FREE. The children probe is one
    // STARTSWITH cross-partition scan PER ROW (GRADED_CHILDREN_QUERY), measured
    // at ~4s/row against prod on 2026-09-06: fine for the 109 rows of one
    // product (~7 min), roughly three and a half HOURS across the full 3,136 —
    // past the budget, for a number an apply reports anyway. So a report counts
    // them when asked (COUNT_CHILDREN=true) and otherwise says plainly that it
    // did not, rather than printing a silent understatement.
    let children = null;
    if (env("COUNT_CHILDREN") === "true") {
      children = 0;
      for (const r of deletable) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
        const res = await retireCatalogRow(
          cat, r.id, r.cardId,
          "wiki page footer scraped as a card (zero comps, re-checked at delete)",
          { dryRun: true },
        );
        children += res.gradedChildrenRetired;
      }
    }
    console.log(children === null
      ? `\n(dry-run; would delete ${f(deletable.length)} rows, PLUS their graded children`
        + ` — NOT COUNTED here: pass COUNT_CHILDREN=true to probe them, ~4s/row)`
      : `\n(dry-run; would delete ${f(deletable.length)} rows`
        + ` + ${f(children)} graded children = ${f(deletable.length + children)} total)`);
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361) + "a marker assembled at runtime is a
    // marker the source never printed" (#1844). The runner greps this phrase
    // and the pins grep THIS SOURCE for it, so the words "stopped at the ...
    // budget" are a SOURCE LITERAL rather than a call into the helper — a
    // marker a static reader cannot see is a relaunch that never fires.
    if (stoppedAtBudget) console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget — the relaunch continues from here`);
    return { client, budget: CLOCK };
  }

  // RECONCILED COUNTERS: intended is counted here, where the writes run, so
  // intended == deleted + failed + skipped always holds.
  const intended = deletable.length;
  let ok = 0, failed = 0, children = 0, skipped = 0;
  for (let i = 0; i < deletable.length; i++) {
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      skipped = deletable.length - i;
      break;
    }
    const r = deletable[i];
    try {
      const res = await retireCatalogRow(cat, r.id, r.cardId, "wiki page footer scraped as a card (zero comps, re-checked at delete)");
      if (res.rowDeleted) ok++; else failed++;
      children += res.gradedChildrenRetired;
    } catch (e) {
      failed++;
      if (failed <= 5) console.error(`  FAILED ${r.id}: ${String(e.message).slice(0, 130)}`);
    }
  }
  console.log(`\n[done] deleted=${f(ok)} gradedChildrenRetired=${f(children)} failed=${f(failed)} skipped=${f(skipped)}`);

  // VERIFY BY READ, under the shared cap. A count that cannot be confirmed is
  // printed UNCONFIRMED, never as a zero.
  const vt0 = Date.now();
  const remaining = await CLOCK.capped(vt0, "footer rows still resident in scope", async (abortSignal) => {
    const { resources } = await cat.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.setKey IN (${skList}) AND c.cardNumber IN (${inList})`,
      parameters: [
        ...SET_KEYS.map((v, i) => ({ name: `@sk${i}`, value: v })),
        ...JUNK_NUMBERS.map((v, i) => ({ name: `@n${i}`, value: v })),
      ],
    }, { enableCrossPartitionQuery: true, abortSignal }).fetchAll();
    return resources[0] ?? 0;
  });
  // A count the cap cut short is UNCONFIRMED, and an UNCONFIRMED count is
  // UNREAD, not zero (feedback_never_dismiss_small_numbers_as_noise). Both
  // phrases are SOURCE LITERALS for the same reason the budget marker is: the
  // pin reads this file, not the helper's return value.
  console.log(`  VERIFY BY READ  junk-number rows left in scope: ${remaining === null ? "UNCONFIRMED (verify cap)" : f(remaining)}`);
  if (remaining === null) {
    console.log("  the verify count is UNREAD, not zero — the writes above reconciled and are durable.");
  }

  if (stoppedAtBudget) console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget — the relaunch continues from here`);

  // RECONCILIATION, through the one helper. `intended` is the deletable set,
  // so the kept rows are already outside it; rows the budget did not reach are
  // declared as SKIPPED rather than left to read as loss.
  // A shortfall sets process.exitCode = 4 — red, not green.
  reportWrites({
    job: `retire-wiki-footer-catalog-rows ${SET_KEYS.join("+")}`,
    intended, written: ok, failed, skipped,
  });
  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too — a failure
// path that exits and a success path that hopes is the asymmetry that cost
// four reconciled-clean runs their exit codes.
if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}

module.exports = { JUNK_NUMBERS, FOOTER_PLAYER };
