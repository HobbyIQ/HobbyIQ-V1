#!/usr/bin/env node
/**
 * CF-RETIRE-THE-ROWS-I-FLATTENED (Drew, 2026-08-24).
 *
 * attest-unnumbered-by-player ran before the attestation guard existed. It
 * hardcoded parallel "Base", isAuto false and printRun null on every row it
 * minted, on the assumption that a set with no card numbers is a 1950s set with
 * no parallels either. True for Red Man and Berk Ross; false for everything
 * modern, where a missing card number usually means the PARSER missed it.
 *
 * Measured after the fact: 878 of 7,666 rows (11.5%), carrying 18,134 sales,
 * were minted from titles that plainly named a variant --
 *
 *   "2024 Panini Photogenic Progressions Derrick Henry Blue Foil /99"
 *   "2023 Panini Black Tank Bigsby Rookie Auto /50 No 125"
 *
 * A Blue Foil /99 sale filed into the base pool does not just fail to price
 * itself, it MOVES THE BASE PRICE. This undoes that.
 *
 * PER-SALE, not per-row. A group is (set, player), so it can legitimately hold
 * base sales AND parallel sales. Retracting the whole group would throw away
 * the base ones, which are correctly filed. Each sale is re-judged on its OWN
 * title; a row is deleted only once nothing points at it any more.
 *
 * Retracted sales return to hobbyiqCardId = null -- exactly where they were
 * this morning. Unresolved is not a loss here: it is the honest state, and the
 * re-run with the guard in place will resolve the ones it can.
 *
 *   BACKFILL_APPLY   "true" to write; anything else reports only
 *   BATCH            catalogBatch to audit (default the unnumbered pass)
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { unparsedVariantReason } = require(path.join(ROOT, "dist/services/catalog/attestationGuard.js"));
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. The reconciliation is the shared helper,
// not a local print of the same equation -- a hand-rolled one is invisible to
// the net that asserts every writer reconciles. This lane printed its counters
// and called nothing, so it was one of those invisible writers.
const { reportWrites } = require(path.join(ROOT, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit are the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const BATCH = process.env.BATCH || "unnumbered-by-player-2026-08-24";
const STAMP = process.env.STAMP || "unnumbered-by-player-2026-08-24";

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes BOTH containers --
// it retracts sold_comps identities and then DELETES the card_catalog rows left
// with nothing pointing at them -- and declared no budget at all. A STAMP whose
// batch is larger than one 150-minute step holds could therefore only end by
// being KILLED at the ceiling, half the sales retracted and an unknown number
// of catalog rows deleted, with no marker, no reconcile and no finishLane line
// to say which half.
//
// THE UNIT IS ONE ROW, in both write loops, and they are the same shape: the
// retract loop does one point read plus one whole-document `replace` per sale;
// the orphan loop does one point read plus one point `delete` per catalog row.
// Neither fans out and neither batches, so the worst single unit is one point
// read plus one write against a container that may be throttling -- seconds,
// not minutes. 60 seconds exceeds that by a wide margin and is the right order:
// a reserve sized to a whole page here would idle the lane for no reason, and
// one sized below a single throttled round trip would not be a reserve at all.
//
// VERIFY_MS is nominal -- the post-loop report reads NOTHING, and the pre-loop
// scan is a page walk rather than an aggregate. Worst case is
// 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const f = (n) => Number(n ?? 0).toLocaleString("en-US");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log("  " + CLOCK.describe());

  // Every sale this batch resolved, re-judged on its own title.
  const retract = [];
  const survivors = new Set();
  const reasons = new Map();
  let scanned = 0, token;
  // Set the moment any phase runs out of clock. The SCAN is read-only, but a
  // stop inside it is the more dangerous one: `retract` and `orphaned` are
  // derived from EVERY sale the stamp resolved, and `orphaned` in particular is
  // "rows with no SURVIVING sale pointing at them". A scan cut short has not
  // seen the survivors yet, so it would name catalog rows as orphans that are
  // not orphans and DELETE them. So a scan stop refuses the write phase outright
  // rather than applying to a partial population.
  let stoppedAtBudget = false, scanIncomplete = false;
  do {
    // THE PRE-CHECK, above the unit's work: before the page is fetched.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; scanIncomplete = true; break; }
    const page = await sold.items.query(
      // c.identityResolvedBy["by"] -- BY is a Cosmos SQL reserved word, so the
      // dotted form returns "One of the input values is invalid" rather than an
      // empty result. Same collision as c["set"] in f7b00d5d.
      { query: "SELECT c.id, c.cardId, c.title, c.setName, c.hobbyiqCardId FROM c " +
               "WHERE c.identityResolvedBy[\"by\"] = @s",
        parameters: [{ name: "@s", value: STAMP }] },
      { maxItemCount: 500, continuationToken: token },
    ).fetchNext();
    token = page.continuationToken;
    for (const r of page.resources) {
      scanned++;
      // The rows this batch wrote carry no parallel/auto/printRun at all, so
      // judge the title against an empty parse -- which is what was stored.
      const why = unparsedVariantReason({ title: r.title, setName: r.setName });
      if (why) { retract.push(r); reasons.set(why, (reasons.get(why) || 0) + 1); }
      else if (r.hobbyiqCardId) survivors.add(r.hobbyiqCardId);
    }
  } while (token);

  const orphaned = new Set(retract.map((r) => r.hobbyiqCardId).filter(Boolean));
  for (const s of survivors) orphaned.delete(s);

  console.log("sales stamped by " + STAMP + " : " + scanned);
  console.log("  retract (title names an unparsed variant): " + retract.length +
              "   [" + [...reasons].map(([k, v]) => k + " " + v).join(", ") + "]");
  console.log("  keep    (correctly filed base cards)     : " + (scanned - retract.length));
  console.log("  rows left with nothing pointing at them  : " + orphaned.size);
  for (const r of retract.slice(0, 6)) {
    console.log("     " + r.hobbyiqCardId + "\n          " + String(r.title || "").slice(0, 96));
  }

  if (!APPLY) {
    console.log("\nREPORT ONLY - nothing written.");
    if (stoppedAtBudget) console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the scan is UNFINISHED; the relaunch continues from here`);
    return { client, budget: CLOCK };
  }

  // A PARTIAL SCAN MAY NOT DRIVE A DELETE. `orphaned` is computed by removing
  // every SURVIVING sale's slug from the retracted set, so a scan that stopped
  // early has not seen the survivors that would have rescued those rows. Acting
  // on it would delete catalog rows real sales still point at -- turning a
  // wrong match into a missing one, the exact harm the sibling lane refuses on.
  if (scanIncomplete) {
    console.error("\nREFUSING TO WRITE: the scan stopped at the budget, so `orphaned` is"
      + " derived from a PARTIAL population and would name live rows as orphans.");
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the scan is UNFINISHED and nothing was written; the relaunch continues from here`);
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  // THE POPULATION IS KNOWN UP FRONT. Both write loops iterate lists this run
  // already fetched in full, so a budget stop CAN name exactly what it did not
  // reach -- unlike a lane that discovers its rows page by page.
  let unset = 0, deleted = 0, failed = 0, notReached = 0;
  for (let i = 0; i < retract.length; i++) {
    // THE PRE-CHECK: before this row's read+replace, never after it.
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      notReached += retract.length - i;
      break;
    }
    const r = retract[i];
    try {
      const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
      if (!d) continue;
      d.hobbyiqCardId = null;
      d.identityRetracted = {
        by: "retire-flattened-attestations", was: r.hobbyiqCardId,
        reason: unparsedVariantReason({ title: r.title, setName: r.setName }),
        at: new Date().toISOString(),
      };
      delete d.identityResolvedBy;
      await sold.item(r.id, r.cardId ?? r.id).replace(d);
      unset++;
    } catch { failed++; }
  }
  // Only rows the batch itself created, and only once nothing points at them.
  // A budget stop in the retract loop STOPS HERE TOO: a row whose retract never
  // ran still has that sale pointing at it, so deleting it now would orphan a
  // live sale. The remaining orphans are counted as not reached, not deleted.
  const orphanList = [...orphaned];
  for (let i = 0; i < orphanList.length; i++) {
    if (stoppedAtBudget || CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      notReached += orphanList.length - i;
      break;
    }
    const id = orphanList[i];
    try {
      const row = (await cat.item(id, id).read()).resource;
      if (!row || row.catalogBatch !== BATCH) continue;   // never touch another batch's row
      await cat.item(id, id).delete();
      deleted++;
    } catch { failed++; }
  }
  console.log("\nsales retracted " + unset + "   catalog rows deleted " + deleted + "   failed " + failed);
  if (notReached) console.log("  not reached (budget)  " + f(notReached));

  // RECONCILIATION, through the one helper. `intended` is both write lists
  // together, because both are populations this run committed to acting on;
  // rows the budget did not reach are declared SKIPPED rather than left to read
  // as loss. A shortfall sets process.exitCode = 4 -- red, not green.
  const intended = retract.length + orphanList.length;
  const written = unset + deleted;
  console.log("  reconciled: intended " + f(intended) + " = written " + f(written)
    + " + skipped " + f(notReached) + " + failed " + f(failed));
  if (written + notReached + failed !== intended) {
    console.error("  !! RECONCILE MISMATCH -- an entry was neither written, skipped nor failed");
    process.exitCode = 4;
  }
  reportWrites({
    job: "retire-flattened-attestations " + STAMP,
    intended, written, skipped: notReached, failed,
    notes: "sales retracted " + unset + "; catalog rows deleted " + deleted,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${f(notReached)} of ${f(intended)} not reached; the relaunch continues from here`);
    console.log("  the retract is IDEMPOTENT: a sale already retracted no longer carries the"
      + " stamp this lane selects on, so the continuation re-derives cheaply and writes only"
      + " what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error("FATAL:", e?.stack || e?.message || String(e));
    await finishLane(3, { budget: CLOCK });
  });
