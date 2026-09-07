#!/usr/bin/env node
/**
 * CF-THE-LIST-IS-THE-SCOPE (2026-09-01, four-values R2).
 *
 * Moves sold_comps rows named EXPLICITLY in a committed list file, and nothing
 * else. Every whole-scope write refuses without a scope; here the scope is not
 * a predicate that could match more than it meant to -- it is a file of ids,
 * reviewed in the diff before it ships. A row not in the file is never touched,
 * so this lane cannot widen by accident the way a `WHERE setKey = ...` sweep can.
 *
 * Two shapes, because the four-values audit found two distinct defects:
 *
 *   1. RELOCATE  (entry has fromCardId != toCardId)
 *      The row sits in the wrong partition. sold_comps is partitioned on
 *      /cardId, so this is a new document plus a delete of the old one, in that
 *      order, with a verified read between -- relocateSoldComp (D19) owns the
 *      ordering and this script never reimplements it. The moved row also
 *      carries the target's contentHash, or the store's pre-write dedup can
 *      never see it again.
 *
 *   2. REPOINT   (entry has repointHobbyiqCardId)
 *      The row is in the RIGHT partition but its hobbyiqCardId names a
 *      different card, and hobbyiqCardId is what the pricing engine reads.
 *      Aaron Judge's five 2017 Gold Label rows -- including a real $300 PSA 9
 *      sale of the exact card -- sat at
 *        cardId        = hiq:baseball:2017:topps-gold-label:86:class-1-blue:no-auto
 *        hobbyiqCardId = hiq:baseball:2017:topps:86:class-1-blue:no-auto
 *      so every read by hobbyiqCardId found zero and the card was priced from
 *      Raw x a ratio instead of from its own sale. No partition changes, so
 *      this is a patch in place, not a relocate.
 *
 * REPORT FIRST. Without BACKFILL_APPLY=true this prints the whole plan --
 * every id, its current address, its intended address, and the evidence
 * recorded in the file -- and writes nothing. Read the banner before applying.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/, defaults to the four-values list).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
// The clock is a MODULE-scope require deliberately: lib/runner-budget.cjs has
// no dist/ dependency, so the contract test can still load this module without
// a built tree, and `budget()`/`finishLane()` are in scope for the .catch
// below as well as for main().
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
// The dist/ and Cosmos requires live inside main(), as the D33 lane does it:
// loading this module must not need a built tree, so the runner contract test
// can require it and drive the scope refusal without a compile step.

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const DEFAULT_LIST = "data/pool-relocations/2026-09-01-four-values.json";
// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3).
//
// `scope` is shared with every other lane on this runner and carries THEIR
// vocabulary ("refractor", "all", a product key). This lane used to treat any
// such value as "no list given" and silently substitute the committed default
// — so a dispatcher who typed `scope=all` meaning "everything", or who left a
// previous lane's `scope=refractor` in the box, got a live APPLY against a
// list they never named and whose banner they never read. The list IS the
// scope here; a scope that does not name a list is a REFUSAL, not a default.
//
// An ABSENT scope still means the committed default: that is this lane's one
// documented population, it is reviewed in the diff, and its banner names it.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
if (RAW_SCOPE && !RAW_SCOPE.endsWith(".json")) {
  console.error(`FATAL: SCOPE="${RAW_SCOPE}" does not name a list file.`);
  console.error("This lane's scope is a committed .json list of row ids — never a");
  console.error("predicate, a product key, or another lane's vocabulary. Pass a path");
  console.error(`ending in .json, or leave SCOPE empty for the default (${DEFAULT_LIST}).`);
  process.exit(1);
}
const SCOPE = RAW_SCOPE || DEFAULT_LIST;
const f = (n) => Number(n).toLocaleString();

// ── THE CLOCK ────────────────────────────────────────────────────────────────
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane is the POOL sibling of
// relocate-catalog-rows-by-list, and it had the identical defect: it looped
// over its whole list with no clock at all, so a list longer than one
// 150-minute step could only end by being KILLED at the ceiling — no marker,
// no reconcile, no finishLane line, and #1913's KILLED branch then correctly
// withholding the re-dispatch, leaving the work half done and the run red.
//
// THE UNIT IS ONE ENTRY, and an entry's cost is dominated by its WRITE half:
// relocateSoldComp does a read, a create at the new partition, a verified
// read-back and a delete at the old one. Run 34079952456 measured the catalog
// sibling's apply at 1.826 s/entry against a 0.076 s/entry report — the write
// half is ~1.75s of that, and this lane's partition MOVE is strictly more work
// than that one's delete. A 90-second reserve is ~50x the slowest entry that
// measurement supports, which is the point: the reserve must exceed the worst
// single unit a throttled container can produce, not the average one.
//
// Every count this lane prints is accumulated inside the loop, so there is no
// post-loop aggregate to cap; VERIFY_MS is nominal and only sizes the pin's
// worst case (110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling).
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

/**
 * CF-ONE-CARD-ONE-ROW-ONE-POOL -- a moved row carries ONE identity.
 *
 * A sold_comps row has TWO identity fields: `cardId` (the partition key) and
 * `hobbyiqCardId` (what the pricing engine reads). The exact-pool reader ORs
 * them, so a row whose two halves name different cards is pulled into BOTH
 * pools -- and a relocation that moves only one half has not moved the sale,
 * it has duplicated its influence.
 *
 * This lane used to rewrite hobbyiqCardId only when it already equalled
 * `from`:
 *
 *     if (String(doc0.hobbyiqCardId ?? "") === from) keep.hobbyiqCardId = to;
 *
 * That guard is false for exactly the population these repairs target. A
 * split-identity row is one whose hobbyiqCardId is ALREADY something other
 * than its cardId, so the equality never held, the partition moved, the
 * hobbyiqCardId stayed, and the old pool kept the row. The four-values apply
 * half-moved 44 Gonzalez rows this way: every entry named
 * fromCardId=...bowman-chrome:cpa-jg:refractor:auto:num-499 while the stored
 * hobbyiqCardId read ...bowman:cpa-jg:refractor:auto:num-499 -- a THIRD slug,
 * equal to neither `from` nor `to`, so the guard was false 44 times out of 44.
 * Verification counted partitions only and looked exact.
 *
 * The rule has no exceptions: when an entry moves a row to `to`, both fields
 * land at `to`. A stored third slug is still overwritten -- it is by
 * definition not where this row belongs -- but it is RETURNED so the caller
 * can name it in the row's outcome line, because silently discarding an
 * identity we did not expect is how the first half-move went unnoticed.
 *
 * Returns { hobbyiqCardId, thirdSlug } where `thirdSlug` is the discarded
 * stored value when it named neither `from` nor `to`, and null otherwise.
 */
function planRelocatedIdentity({ storedHobbyiqCardId, from, to }) {
  const stored = String(storedHobbyiqCardId ?? "").trim();
  const thirdSlug = stored && stored !== from && stored !== to ? stored : null;
  return { hobbyiqCardId: to, thirdSlug };
}

async function main() {
  const { CosmosClient } = require("@azure/cosmos");
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const {
    relocateSoldComp, stripSystem, contentHashOf,
  } = require(path.join(__dirname, "lib/relocate-sold-comp.cjs"));

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // The list IS the scope. A missing or empty file is a refusal, never a
  // silent no-op that looks like success.
  const listPath = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  if (!fs.existsSync(listPath)) {
    console.error(`FATAL: scope list not found: ${listPath}`);
    console.error("This lane refuses to run without an explicit committed list.");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  if (entries.length === 0) {
    console.error(`FATAL: ${SCOPE} names no entries — nothing is in scope.`);
    process.exit(1);
  }

  console.log(`scope file              ${SCOPE}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  console.log(`excluded by the audit   ${f((doc.excluded || []).length)}   <- deliberately NOT moved`);
  for (const r of doc.rulings || []) console.log(`  ruling: ${r}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  // The client is NAMED rather than chained away, so finishLane() can dispose
  // it: an undisposed SDK keeps keep-alive sockets open, and a live handle is
  // what held four reconciled-clean runs to the ceiling (#1809).
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database("hobbyiq");
  const pool = db.container("sold_comps");
  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };

  let relocated = 0, repointed = 0, alreadyRight = 0, notFound = 0, failed = 0, duplicatesLeft = 0;
  let thirdSlug = 0, retired = 0, parked = 0;
  const intended = entries.length;

  // How far the loop actually got. `stoppedAt` stays null when every entry was
  // considered; a number means the budget stopped the loop BEFORE that index,
  // and the banner and the marker both report it.
  let stoppedAt = null;
  let considered = 0;

  for (const e of entries) {
    // THE PRE-CHECK, ONCE, ABOVE EVERY SHAPE. It sits here — above the parse,
    // above the shape fork, above the read — precisely so that no branch
    // (relocate / repoint / retire / park) can be the one that forgets it. A
    // check inside one arm leaves the other three unbudgeted, which is the
    // same defect merely quartered.
    //
    // And it is a PRE-check: `outOfClock()` is true when less than the reserve
    // remains, so the entry that would overrun is never STARTED. Checking
    // after the entry admits one more unit of unbounded size past expiry —
    // the loop-top defect #1799 named.
    if (CLOCK.outOfClock()) { stoppedAt = considered; break; }
    considered++;
    const id = String(e.id ?? "").trim();
    const from = String(e.fromCardId ?? "").trim();
    const to = String(e.toCardId ?? "").trim();
    const repoint = String(e.repointHobbyiqCardId ?? "").trim();
    // CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE (2026-09-05). Two more shapes,
    // both patches in place: no partition moves and no document is removed.
    const retire = String(e.retireSupersededBy ?? "").trim();
    const park = e.parkIdentityUnverified === true;
    if (!id || !from) { failed++; console.error(`  malformed entry: ${JSON.stringify(e).slice(0, 90)}`); continue; }
    // An entry names ONE shape. Two shapes on one row is a list defect, and a
    // silent precedence order is how the wrong one gets applied.
    const shapes = [to && to !== from ? "relocate" : null, repoint ? "repoint" : null, retire ? "retire" : null, park ? "park" : null].filter(Boolean);
    if (shapes.length > 1) { failed++; console.error(`  entry names ${shapes.length} shapes (${shapes.join(" + ")}): ${id.slice(0, 44)}`); continue; }

    let doc0 = null;
    try { doc0 = (await retry(() => pool.item(id, from).read())).resource ?? null; }
    catch (err) { if (!(err?.code === 404 || err?.statusCode === 404)) throw err; }
    if (!doc0) {
      notFound++;
      console.log(`  NOT FOUND at ${from.slice(0, 54)}  id=${id.slice(0, 44)}`);
      continue;
    }

    // ── RETIRE: the copy the title does NOT name ──────────────────────────
    //
    // CF-THE-TITLE-DECIDES (Drew, 2026-09-05). One eBay sale filed under two
    // PRODUCTS is not two sales. The title states which product it is; the
    // copy under the other product is superseded, and it is MARKED, never
    // deleted -- `flaggedWrong` is what every FMV read already excludes, and a
    // marker is reversible where a delete is not.
    //
    // ONLY-IMPROVE: a row already flagged is never re-stamped, so a re-run
    // cannot overwrite an earlier (possibly human) reason.
    if (retire) {
      if (doc0.flaggedWrong === true) { alreadyRight++; continue; }
      console.log(`  RETIRE  ${id.slice(0, 40)}  $${e.price ?? doc0.price}`);
      console.log(`      at  ${from.slice(0, 62)}`);
      console.log(`      superseded by ${retire.slice(0, 58)}`);
      console.log(`      why: ${String(e.evidence ?? "").slice(0, 150)}`);
      if (APPLY) {
        try {
          await retry(() => pool.item(id, from).patch([
            { op: "set", path: "/flaggedWrong", value: true },
            { op: "set", path: "/flaggedReason", value: "dedup-superseded" },
            { op: "set", path: "/dedupSupersededBy", value: retire },
            { op: "set", path: "/dedupReason", value: String(e.evidence ?? "title states the other product") },
            { op: "set", path: "/dedupAt", value: new Date().toISOString() },
          ]));
          retired++;
        } catch (err) { failed++; console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 70)}`); }
      } else { retired++; }
      continue;
    }

    // ── PARK: the title names NEITHER product ─────────────────────────────
    //
    // Drew, 2026-09-05: park BOTH copies rather than guess. `identityUnverified`
    // is the same label retire-self-derived-identities uses, and it keeps the
    // row out of every pool without asserting which card it belongs to.
    if (park) {
      if (doc0.identityUnverified === true) { alreadyRight++; continue; }
      console.log(`  PARK    ${id.slice(0, 40)}  $${e.price ?? doc0.price}`);
      console.log(`      at  ${from.slice(0, 62)}`);
      console.log(`      why: ${String(e.evidence ?? "").slice(0, 150)}`);
      if (APPLY) {
        try {
          await retry(() => pool.item(id, from).patch([
            { op: "set", path: "/identityUnverified", value: true },
            { op: "set", path: "/identityUnverifiedAt", value: new Date().toISOString() },
            { op: "set", path: "/identityUnverifiedBy", value: "relocate-pool-rows-by-list" },
            { op: "set", path: "/identityUnverifiedReason", value: String(e.evidence ?? "title names neither product") },
          ]));
          parked++;
        } catch (err) { failed++; console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 70)}`); }
      } else { parked++; }
      continue;
    }

    // ── REPOINT: right partition, wrong hobbyiqCardId ──────────────────────
    if (repoint) {
      if (doc0.hobbyiqCardId === repoint) { alreadyRight++; continue; }
      console.log(`  REPOINT ${id.slice(0, 40)}`);
      console.log(`      hobbyiqCardId ${String(doc0.hobbyiqCardId).slice(0, 58)}`);
      console.log(`                 -> ${repoint.slice(0, 58)}`);
      console.log(`      why: ${String(e.evidence ?? "").slice(0, 150)}`);
      if (APPLY) {
        const next = stripSystem(doc0);
        next.hobbyiqCardId = repoint;
        // CF-ONE-WRITE-PATH-FOR-SOLD-COMPS (2026-09-07). A REPOINT does not move
        // partition, so it needs no delete -- but it DOES rewrite an identity
        // field, and until now it wrote whatever the list file said without
        // asking whether it was an address. It goes through the same mover as
        // the RELOCATE four branches down: same guard, same verified read-back,
        // with `drop` empty because nothing is being left behind.
        //
        // `contentHash` is NOT recomputed: it hashes cardId, and cardId is
        // unchanged here. Recomputing on a hobbyiqCardId change would move the
        // dedup key for a row that never moved partition.
        const res = await relocateSoldComp(pool, {
          keep: next, drop: [], retry,
          verifyFields: ["cardId", "hobbyiqCardId", "price", "soldAt"],
        });
        if (res.ok) repointed++;
        else { failed++; console.error(`      FAILED at ${res.stage}: ${String(res.error ?? "").slice(0, 70)}`); }
      } else { repointed++; }
      continue;
    }

    // ── RELOCATE: wrong partition ─────────────────────────────────────────
    if (!to || to === from) { alreadyRight++; continue; }
    console.log(`  RELOCATE ${id.slice(0, 40)}  $${e.price ?? doc0.price}`);
    console.log(`      ${from.slice(0, 62)}`);
    console.log(`   -> ${to.slice(0, 62)}`);
    console.log(`      why: ${String(e.evidence ?? "").slice(0, 150)}`);
    if (!APPLY) { relocated++; continue; }

    const keep = stripSystem(doc0);
    keep.cardId = to;
    // A moved row carries ONE identity. Both fields land at `to`; a third slug
    // in the stored hobbyiqCardId is overwritten too, and named in the log.
    const identity = planRelocatedIdentity({ storedHobbyiqCardId: doc0.hobbyiqCardId, from, to });
    keep.hobbyiqCardId = identity.hobbyiqCardId;
    if (identity.thirdSlug) {
      thirdSlug++;
      console.log(`      THIRD SLUG: stored hobbyiqCardId was neither from nor to`);
      console.log(`                  ${identity.thirdSlug.slice(0, 62)}`);
      console.log(`               -> ${to.slice(0, 62)}`);
    }
    // A row that moves partition must carry the hash of its NEW cardId, or the
    // store's pre-write dedup can never match it again. Hashed AFTER both
    // identity fields are final.
    keep.contentHash = contentHashOf(keep);

    try {
      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id, cardId: from }], retry,
        // hobbyiqCardId is verified, so a half-move FAILS instead of reporting
        // success: the read-back must show the field actually landed at `to`.
        verifyFields: ["cardId", "hobbyiqCardId", "price", "soldAt", "contentHash"],
      });
      if (res.ok) relocated++;
      else {
        failed++;
        console.error(`      FAILED at ${res.stage}: ${String(res.error ?? "").slice(0, 70)}`);
      }
      if (res.duplicatesLeft?.length) {
        duplicatesLeft += res.duplicatesLeft.length;
        console.error(`      DUPLICATE LEFT IN POOL: ${res.duplicatesLeft.length}`);
      }
    } catch (err) {
      failed++;
      console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 70)}`);
    }
  }

  // Entries the budget never reached. They are NOT failures and NOT skips:
  // nothing was read and nothing was decided about them, so they are their own
  // line in the reconcile and the relaunch is what settles them.
  const notReached = stoppedAt === null ? 0 : intended - stoppedAt;

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope        ${f(intended)}`);
  console.log(`  entries considered      ${f(considered)}${stoppedAt === null ? "   <- the whole list" : ""}`);
  console.log(`  RELOCATED (partition)   ${f(relocated)}`);
  console.log(`  REPOINTED (hiqCardId)   ${f(repointed)}`);
  console.log(`  RETIRED (flaggedWrong)  ${f(retired)}   <- marked, never deleted`);
  console.log(`  PARKED (identityUnver.) ${f(parked)}   <- no pool, no guess`);
  console.log(`  already at the target   ${f(alreadyRight)}`);
  console.log(`  not found at fromCardId ${f(notFound)}`);
  console.log(`  failed                  ${f(failed)}`);
  console.log(`  duplicates left in pool ${f(duplicatesLeft)}   <- must be 0`);
  console.log(`  third-slug hobbyiqCardId ${f(thirdSlug)}   <- overwritten to the target, listed above`);
  console.log(`  not reached (budget)    ${f(notReached)}   <- the relaunch settles these`);

  // A PARTIAL RUN STILL RECONCILES. The identity has to hold over what the
  // loop CONSIDERED, not over the file, or a budget stop reads as thousands of
  // lost entries. `not reached` carries the remainder explicitly so the two
  // numbers an operator cares about -- what happened, and what is left -- are
  // both on the page rather than one being inferred from the other's absence.
  const written = relocated + repointed + retired + parked;
  const skipped = alreadyRight + notFound;
  console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)} `
    + `+ failed ${f(failed)} + not reached ${f(notReached)}`);
  if (written + skipped + failed + notReached !== intended) {
    console.error("  !! RECONCILE MISMATCH -- an entry was neither written, skipped, failed nor deferred");
    process.exitCode = 4;
  }
  if (APPLY) {
    reportWrites({
      job: "relocate-pool-rows-by-list", intended,
      written, skipped: skipped + notReached, failed,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS --------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps stdout for
  // `stopped at the .*budget`, so the phrase is written here as a SOURCE
  // LITERAL rather than assembled from variables: a marker built by
  // concatenation is a marker a refactor can silently reword, and a reworded
  // marker ends the fan-out after one slice with the run green -- the quiet
  // version of the bug #1913 made loud.
  if (stoppedAt !== null) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `stopped at ${f(stoppedAt)} of ${f(intended)}; the relaunch continues from here`);
    console.log("  the list is IDEMPOTENT: a finished relocate re-reads as `already at the target`,"
      + " and a finished retire or park already carries its field, so the continuation re-derives"
      + " cheaply and writes only what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Whether the loop finished or
// the budget stopped it, this lane EXITS -- it never ends by hoping the event
// loop drains. A failure path that exits and a success path that hopes is
// exactly the asymmetry that cost four reconciled-clean runs their exit codes.
// `process.exitCode` may already carry a reconcile mismatch, and that is the
// code finishLane is handed.
if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, { budget: CLOCK });
    });
}

module.exports = { DEFAULT_LIST, SCOPE, APPLY, planRelocatedIdentity };
