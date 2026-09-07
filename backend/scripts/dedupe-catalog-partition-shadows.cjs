#!/usr/bin/env node
/**
 * CF-ONE-ROW-PER-CANONICAL-SLUG (Drew, 2026-08-25: "clean up the extras so it
 * has ONE").
 *
 * CPA-MG 2026 holds 693 catalog rows. The first two explanations were both
 * wrong and both would have been destructive:
 *
 *   NOT the parallels. 32 distinct parallels is close to right; the card has a
 *   21-rung authority ladder plus real ones the checklists missed.
 *
 *   NOT the grades. 25 rows per parallel is ONE ROW PER GRADE --
 *   :psa-8, :psa-9-5, :cgc-8-5, :sgc-10 -- and a PSA 10 is a different card
 *   economically from a raw one. Collapsing that key deletes 24 of every 25
 *   rows, which is the exact mistake a previous bloat investigation made.
 *
 * The duplication is the PARTITION KEY. The canonical slug sits correctly in
 * `id`, but `cardId` -- which is the partition key -- holds a CardHedge vendor
 * id, so the same logical card exists once per vendor id that ever mentioned
 * it. Cosmos permits it because uniqueness is scoped per partition:
 *
 *   id=hiq:baseball:2026:bowman:cpa-mg:base:auto:psa-8  cardId=1778541457955x30032...
 *   id=hiq:baseball:2026:bowman:cpa-mg:base:auto:psa-8  cardId=1778541267418x36455...
 *   id=hiq:baseball:2026:bowman:cpa-mg:base:auto:psa-8  cardId=1778541266932x94661...
 *
 * 432 of 693 rows on that one card are shadows of this kind -- 62%.
 *
 * THE VENDOR IDS ARE LOAD-BEARING. The CardHedge lookup path resolves by
 * vendor cardId, so every shadow's vendorIds mapping is merged onto the
 * canonical row BEFORE the shadow is retired. Getting that order wrong breaks
 * CH lookups silently, which is the worst possible failure to add.
 *
 * Each shadow is catalogRowOps.moveCatalogRow's rehome (D5 PR 4): the row is
 * copied to (id, id) -- its vendor partition key kept under its source in
 * vendorIds, a row already there decided by authority and its vendorIds
 * unioned -- and only then is the shadow deleted. Richest shadow first, so
 * when no row sits at (id, id) yet the first rehome creates it and the rest
 * fold onto it. Nothing about the card changes, so sales and graded children
 * are untouched.
 *
 * Every retirement prints its (id, cardId) pair, so the run log is the undo
 * record.
 *
 *   BACKFILL_APPLY  "true" to write; anything else reports only
 *   YEARS           comma list (default 2026)
 *   SETKEY_LIKE     substring the setKey must contain (default "bowman")
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(ROOT, "dist/services/ops/writeReconciliation.js"));
const { moveCatalogRow } = require(path.join(ROOT, "dist/services/catalog/catalogRowOps.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const YEARS = String(process.env.YEARS || "2026").split(",").map(Number).filter(Boolean);
const SETKEY_LIKE = String(process.env.SETKEY_LIKE || "bowman").toLowerCase();
// Retire duplicate rows that carry no partition key at all. Off by default:
// see CF-A-MISSING-PARTITION-KEY-IS-STILL-A-KEY at the delete site.
const RETIRE_NO_PK = String(process.env.RETIRE_NO_PARTITION_KEY || "") === "true";

// -- THE CLOCK ---------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane had no clock: it looped
// every year in YEARS and printed its counters and its reportWrites only after
// the last one. Run past the runner's 150-minute step and it is KILLED, not
// stopped -- no marker, no reconcile, no finishLane line -- and #1913's killed
// branch then withholds the re-dispatch, so the unreached years never happen.
//
// THE UNIT IS ONE YEAR, and it is the largest unit this lane has by a wide
// margin. A year is TWO expensive phases back to back: first a full
// cross-partition page walk of card_catalog for that year (1,000 rows a page,
// and the predicate is CONTAINS(LOWER(c.setKey), @k) -- a SCAN, not an index
// seek), and then, for every duplicated slug it found, a moveCatalogRow per
// shadow. Each of those is a point read of the full row, a copy write and a
// delete. The 2026 bowman run this file documents counted 15,876 surplus rows
// in ONE year: at moveCatalogRow's measured ~1.8 s/row of write cost that year
// is hours, and even a modest year is many minutes. 5 minutes is the reserve
// because the check has to be able to refuse a year BEFORE its scan begins --
// once the page walk starts there is no further checkpoint, and admitting one
// more year past expiry is exactly the #1799 loop-top defect.
//
// VERIFY_MS is nominal: this lane runs NO post-loop aggregate -- nothing is
// read after the write loop, the counters are held in memory -- so the cap has
// nothing to bound here and only sizes the pin's worst case (110 + 5m + 1m +
// 1m startup = 117m, 33m under the 150-minute ceiling).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 5 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  // NAMED, not chained away: finishLane() disposes it. The old form chained
  // straight through to .container(), which left no handle to dispose -- and an
  // undisposed SDK client's keep-alive sockets are precisely the ref'd handle
  // that holds a finished process to the runner's ceiling (#1809).
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`  clock:  ${CLOCK.describe()}`);

  const retry = async (fn) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || a >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };

  let intended = 0, merged = 0, retired = 0, failed = 0, skipped = 0;

  // Years the budget never STARTED. YEARS is known up front -- it is an env
  // list, fixed before the first query -- so a partial run says exactly how
  // many years are left rather than leaving the slot UNFINISHED.
  let stoppedAtBudget = false, yearsNotReached = 0;
  for (let yi = 0; yi < YEARS.length; yi++) {
    const year = YEARS[yi];
    // THE PRE-CHECK: before the year, never after it. There is no checkpoint
    // inside a year -- the scan runs to exhaustion and the retire loop follows
    // it -- so this is the only place the clock can refuse one, and it must
    // refuse it BEFORE the scan starts.
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      yearsNotReached = YEARS.length - yi;
      break;
    }
    // Group by canonical slug. Only hiq: ids participate -- a vendor-id row
    // that is not ALSO a duplicate of a canonical slug is a legitimate vendor
    // record and is left completely alone.
    const groups = new Map();
    let token, scanned = 0;
    do {
      const page = await retry(() => cat.items.query(
        { query: "SELECT c.id, c.cardId, c.setKey, c.source, c.vendorIds, c.verificationStatus " +
                 "FROM c WHERE c.year = @y AND STARTSWITH(c.id, 'hiq:') AND CONTAINS(LOWER(c.setKey ?? ''), @k)",
          parameters: [{ name: "@y", value: year }, { name: "@k", value: SETKEY_LIKE }] },
        { maxItemCount: 1000, continuationToken: token },
      ).fetchNext());
      token = page.continuationToken;
      for (const r of page.resources) {
        scanned++;
        if (!groups.has(r.id)) groups.set(r.id, []);
        groups.get(r.id).push(r);
      }
    } while (token);

    const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
    // CF-COUNTERS-THAT-DO-NOT-ADD-UP (Drew, 2026-08-25). This was
    // `v.length - 1` -- "every row but one" -- which silently assumes one row
    // in the group is ALREADY keyed by its own slug and will be kept in place.
    // When none is, the retire loop below skips nothing (its guard is
    // `s.cardId === id`) and acts on all v.length rows, so the run claimed more
    // work than it declared: intended 15,876 against written 14,827 + skipped
    // 5,120 on the 2026-08-25 bowman run, over by 4,071.
    //
    // The reconciler clamped that difference at zero and printed the total as a
    // balanced equation, so it read as green. Count what the loop will actually
    // touch, using the loop's own predicate, and the two cannot drift again.
    const surplus = dupes.reduce((a, [id, v]) => a + v.filter((r) => r.cardId !== id).length, 0);
    const orphanGroups = dupes.filter(([id, v]) => !v.some((r) => r.cardId === id)).length;
    intended += surplus;

    console.log("  " + year + "  scanned " + scanned.toLocaleString() +
                "  canonical slugs " + groups.size.toLocaleString() +
                "  slugs with shadows " + dupes.length.toLocaleString() +
                "  surplus rows " + surplus.toLocaleString() +
                "  groups with no canonical row " + orphanGroups.toLocaleString());

    // Classify the surplus before deleting any of it. The two mechanisms need
    // different handling: a vendor-keyed shadow can be addressed and deleted
    // normally, a row written with NO partition key cannot be addressed the
    // same way and is reported rather than guessed at.
    const kinds = new Map();
    for (const [, v] of dupes) {
      for (const r of v) {
        if (r.cardId === v[0].id) continue;
        const k = r.cardId === undefined || r.cardId === null ? "no-partition-key"
                : String(r.cardId).startsWith("hiq:") ? "other-slug" : "vendor-keyed";
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
    }
    console.log("      surplus by kind: " + [...kinds].map(([k, v]) => k + " " + v).join(" · "));

    if (!APPLY) {
      for (const [id, v] of dupes.slice(0, 3)) {
        console.log("      " + id + "   x" + v.length);
        for (const r of v.slice(0, 3)) console.log("          cardId=" + r.cardId + "  src=" + r.source);
      }
      continue;
    }

    for (const [id, rowsForId] of dupes) {
      // The rows this group will act on -- the same predicate `surplus` counted
      // and the loop below guards on. Named once so the two cannot diverge.
      // Every shadow ends in exactly one of retired / skipped / failed.
      const toRetire = rowsForId.filter((r) => r.cardId !== id)
        .sort((a, b) => Object.keys(b.vendorIds ?? {}).length - Object.keys(a.vendorIds ?? {}).length);
      let retiredHere = 0;

      for (const s of toRetire) {
        if (s.cardId === undefined || s.cardId === null) {
          // CF-A-MISSING-PARTITION-KEY-IS-STILL-A-KEY (Drew, 2026-08-25).
          // This used to skip unconditionally, on the belief that a row
          // written with no partition key "cannot be addressed by (id,
          // cardId) the way the others can". It can:
          //
          //   cat.item(id, undefined).read() -> 200, cardId=undefined
          //   cat.item(id, id).read()        -> 200, the canonical row
          //
          // Two distinct, separately addressable documents. Every one of the
          // 5,142 left in 2026 bowman is this shape, and skipping them meant
          // the job could never make progress on them however often it ran.
          //
          // Opt-in, because deleting by a partition key the SDK infers rather
          // than one we pass explicitly is a targeting risk I have verified
          // by READ and not by delete. And verify immediately before each
          // delete: the row must still be the keyless one, and the canonical
          // row must already exist, or we would be deleting the last copy.
          // This stays a hand-addressed delete: catalogRowOps addresses a row
          // by `cardId ?? id`, which for a keyless row is the canonical one.
          if (!RETIRE_NO_PK) { skipped++; continue; }
          try {
            const shadow = (await cat.item(s.id, undefined).read()).resource;
            const canonical = (await cat.item(id, id).read()).resource;
            if (!shadow || shadow.cardId !== undefined || !canonical) { skipped++; continue; }
            await cat.item(s.id, undefined).delete();
            retired++; retiredHere++;
            console.log("      RETIRED (no partition key) " + s.id);
          } catch { failed++; }
          continue;
        }
        try {
          // The projection above is not the whole row; the rehome copies the row.
          const full = (await retry(() => cat.item(s.id, s.cardId).read()).catch((e) => {
            if (e?.code === 404) return { resource: undefined };
            throw e;
          })).resource;
          if (!full) { skipped++; continue; }
          const r = await moveCatalogRow(cat, full, id, {}, {
            reason: "partition shadow folded onto its own slug (CF-ONE-ROW-PER-CANONICAL-SLUG)",
            retry,
          });
          retired++; retiredHere++;
          console.log("      RETIRED " + s.id + "  cardId=" + s.cardId + "  (" + r.action + ")");
        } catch { failed++; }
      }
      if (retiredHere) merged++;
    }
  }

  console.log("");
  console.log("canonical rows written " + merged + "   shadows retired " + retired +
              "   skipped " + skipped + "   failed " + failed);
  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps stdout for
  // `stopped at the .*budget`, so the phrase is a SOURCE LITERAL rather than
  // built from a variable holding the words: a marker assembled at runtime is
  // a marker the source never printed, and the relaunch never fires on it.
  //
  // Printed BEFORE the report-only return below, so a dry run that stopped
  // early says so too -- a report that silently covered half its years is a
  // plan nobody knows is partial.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${yearsNotReached} year(s) not reached; the relaunch continues from here`);
    console.log("  the fold is IDEMPOTENT: a shadow already rehomed is no longer a surplus"
      + " row in the next scan, so the continuation re-derives cheaply and writes only"
      + " what is left. Pass YEARS= to name the remainder directly.");
  }

  if (!APPLY) { console.log("REPORT ONLY - nothing written."); return { client, budget: CLOCK }; }
  if (!RETIRE_NO_PK && skipped) {
    console.log("  " + skipped + " keyless duplicate rows were left in place. " +
                "They ARE addressable -- re-run with RETIRE_NO_PARTITION_KEY=true to retire them.");
  }
  // A PARTIAL RUN STILL RECONCILES. `intended` is accumulated PER YEAR, inside
  // the loop, so it only ever counts surplus rows from years the clock actually
  // started -- the identity is over what was SEEN, and a budget stop cannot
  // read as loss. The years never reached carry no row count at all (their
  // pages were never walked), so they are stated in YEARS rather than
  // fabricated as rows.
  console.log("  reconciled: intended " + intended + " = written " + retired +
              " + skipped " + skipped + " + failed " + failed +
              "  (years not reached: " + yearsNotReached + ")");
  if (retired + skipped + failed !== intended) {
    console.error("  !! RECONCILE MISMATCH -- a surplus row was neither retired, skipped nor failed");
    process.exitCode = 4;
  }
  reportWrites({ job: "dedupe-catalog-partition-shadows", intended, written: retired, skipped, failed });
  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a
// failure path that exits and a success path that hopes is the asymmetry that
// cost four reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error("FATAL:", e?.stack || e?.message || String(e));
    await finishLane(3, { budget: CLOCK });
  });
