#!/usr/bin/env node
/**
 * repair-bowman-product-refile.cjs -- the Bowman CPA/BCP rows and sales return
 * to the product they came out of.
 *
 * CF-IT-CAME-OUT-OF-BOWMAN (Drew, 2026-08-13, re-affirmed 2026-09-05):
 * "bowman -- it came out of Bowman"; "chrome stock is a property of the card,
 * not the name of the product."
 *
 * ── WHAT #1800 FIXED, AND WHAT THIS MOVES ──────────────────────────────────
 *
 * #1800 stopped the MINT. Four checklist ingests now pass `authoritativeSetKey`
 * and `upsertCatalogEntry` refuses any row whose setKey FIELD disagrees with
 * its id STEM, so nothing new drifts. It moved nothing already stored.
 *
 * This lane moves what is stored, over a NAMED SCOPE, report-first:
 *
 *   catalog  19,867  stem `bowman-chrome`          field `bowman`  (2026)
 *   catalog     208  stem `bowman-chrome-sapphire` field `bowman`  (2026)
 *   catalog  77,195  stem `bowman-paper`           field `bowman`  (all years,
 *                    BP-/BPA- only -- re-measured 2026-09-05, the census's
 *                    16,822 was its 2026 slice; SAME defect, same mechanism,
 *                    same fix, and it is why the scope is a product LIST)
 *   sales    10,532  stem `bowman-chrome`, 2026, CPA-/BCP-
 *
 * ── THE SALES ARE THE URGENT HALF ──────────────────────────────────────────
 *
 * ZERO 2026 Bowman Chrome sales exist. Across 219 paired raw groups the median
 * chrome/bowman price ratio is 1.00 -- two products cannot do that. Every one
 * of the 10,532 rows is a Bowman sale at a Chrome address, and the moment real
 * Chrome sales arrive they land on top and price two players as one card with
 * no way back. That is why this runs before the rematch reaches them.
 *
 * ── THE ABSOLUTE GUARD ─────────────────────────────────────────────────────
 *
 * Nine 2026 CPA/BCP numbers name two DIFFERENT players (CPA-AG = Adrian Gil in
 * Bowman AND Angeibel Gomez in Bowman Chrome). No move may land one player's
 * row on another player's address: `planCatalogRefile` refuses it by name and
 * the report lists every refusal with BOTH names. On the sale side a sale on a
 * collision number whose player cannot be read PARKS -- Drew, 2026-09-05:
 * "never default to either side".
 *
 * ── THE BUCKETS ────────────────────────────────────────────────────────────
 *
 *   KEY-MISMATCH        re-mint through deriveCatalogEntry with
 *                       authoritativeSetKey:true off the row's OWN setName,
 *                       then moveCatalogRow. Covers chrome, sapphire and paper
 *                       -- one shape, one code path.
 *   DUPLICATE-ONE-CARD  consolidate onto the checklist-backed row. The 1/1
 *                       Superfractors run first: a duplicated 1-of-1 is
 *                       unarguable.
 *   LEGIT-TWO-PRODUCTS  UNTOUCHED. 2,066 base-numbered cards are two genuine
 *                       checklists (2026 Bowman #11 Corey Seager vs 2026
 *                       Bowman Chrome #11 Noah Schultz), and the nine
 *                       collisions belong here too.
 *
 * ── THE CATALOG LANE RUNS FIRST, AND THE REPORT PROVES WHY ─────────────────
 *
 * MEASURED, 2026-09-05, report-only over `baseball:2026:bowman-chrome`:
 *
 *     POOL scanned 19,080 · would move 2,140
 *       both-checklists-claim-this-player        10,141
 *       no-bowman-checklist-claims-this-player    6,769
 *       protected-row-report-only                     19
 *       row-states-no-player                          11
 *
 * `both-checklists-claim-this-player` is the LARGEST skip, and it is an
 * artifact of the very drift this lane repairs: the 19,867 drifted CATALOG
 * rows are sitting on the `bowman-chrome` stem, so when the sale lane asks
 * "does a Chrome checklist claim this player?" the answer is yes -- because a
 * BOWMAN row is answering from a Chrome address.
 *
 * So the sale skips, conservatively and correctly. It is not a defect; it is
 * the guard refusing to decide while the catalog is still ambiguous. Run
 * `mode=catalog` to completion FIRST; the Chrome side then stops claiming
 * those players and the same sales become movable on the next pass. A
 * `mode=sales` run before the catalog lane is safe -- it just moves less.
 *
 * ── THE SCOPE AXIS: A PRODUCT LIST, NEVER `all` ────────────────────────────
 *
 * CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME. `sport:year:setKey`, comma
 * separated. The runner's inherited default `refractor`, `all`, and an empty
 * scope are all REFUSED (exit 2). A report over an unnamed scope is how an
 * apply over an unnamed scope gets authorised.
 *
 *   SCOPE=baseball:2026:bowman-chrome
 *   SCOPE=baseball:2026:bowman-chrome,baseball:2026:bowman-chrome-sapphire
 *
 * ── THE WRITE ──────────────────────────────────────────────────────────────
 *
 * REPORT ONLY unless BACKFILL_APPLY=true (the runner exports BACKFILL_APPLY,
 * not APPLY -- read the banner). Catalog moves go through `moveCatalogRow`,
 * which copies the survivor first, re-points the sales, retires the graded
 * children and deletes the old row last. Sales go through `relocateSoldComp`
 * -- upsert, read back, THEN delete (CF-A-SALE-IS-NEVER-LOST, D19). Canary
 * anchors are counted before and re-read after, and a REPORT-mode run that
 * moved a pool exits 3: a dry run is proven write-free by MEASUREMENT.
 *
 * ── THE CANARY ATTRIBUTES THIS LANE'S OWN WRITES (2026-09-06) ──────────────
 *
 * The anchors are the Chrome side of the collision numbers -- which is exactly
 * the address the sales lane DRAINS. Run 34009971035 refiled 1,835 sales as
 * ruled and was failed by its own canary (cpa-ag 16->5, cpa-em 17->8, cpa-hl
 * 87->7, cpa-wa 91->15, "a collision may have been merged"). Nothing merged:
 * every departed row carried that run's `reslugedFrom` stamp and landed on the
 * Bowman address for its OWN player, and the collision player's rows stayed
 * put. The canary was firing on the lane succeeding.
 *
 * Under APPLY the lane now keeps a WRITE LEDGER (pool -> rows moved out / in,
 * both the sale re-files and the catalog lane's sale re-points) and each
 * anchor's delta is judged against it: `expected = before - out + in`.
 * Explained -> PASS, with the arithmetic printed in an attribution table.
 * Unexplained -> still exits 3. Under REPORT the ledger is empty by
 * construction, so the gate stays STRICT and any movement is still fatal.
 * Same defect, same fix as #1711/#1727 in the rematch lane.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     REQUIRED -- comma-separated sport:year:setKey
 *   MODE                      catalog | sales | both (default both)
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   LIMIT / SLOT / SLOTS / CONCURRENCY / RUN_MINUTES
 * Requires dist/ (cardCatalog, catalogRowOps, hobbyIqCardId).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const backend = path.resolve(__dirname, "..");

const B = require(path.join(__dirname, "lib", "bowman-product-refile.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { cardShardIndex } = require(path.join(__dirname, "lib", "card-shard-axis.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const STARTED = Date.now();
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 12));
const LIMIT = Number(process.env.LIMIT || 0);
// Where this lane's write ledger is persisted for a human re-reading a halt.
const WRITE_LEDGER_OUT = String(process.env.BOWMAN_WRITE_LEDGER_OUT || "/tmp/bowman-refile-write-ledger.json").trim();

// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS (#1803). The three constants, sized
// for THIS lane's unit.
//
// A UNIT here is one catalog row: a point read of the destination, a pure
// plan, and one moveCatalogRow that re-points the sales pointing at it. The
// heaviest unit measured is a row whose old slug carries a large pool, so the
// reserve is 90s -- generous for a per-row unit, and checked BEFORE the unit
// so a row costing more than the reserve is never STARTED past expiry.
//
// The post-loop work is the canary re-read: up to ten `COUNT(1)` aggregates
// filtered to one slug each. They are index-served, but they run AFTER the
// loop, so they sit under the verify cap and print UNCONFIRMED rather than
// holding the step open to the ceiling.
//
// worst case 110m loop + 90s reserve + 5m verify + 1m startup = ~117.5m
// against the runner's 150m ceiling: 32m of margin.
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const MODE = lower(process.env.MODE || "both");

const SHARD_SCOPE = runnerShardScope({ label: "repair-bowman-product-refile" });

// THE SCOPE. `sport:year:setKey`; the runner's inherited default is REFUSED.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const PRODUCT_RE = /^[a-z0-9-]+:\d{4}:[a-z0-9-]+$/;
const SCOPE_PRODUCTS = RAW_SCOPE.map(lower).filter((p) => PRODUCT_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !PRODUCT_RE.test(lower(p)));

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 400) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

// CF-A-MOVE-LANE-SHARDS-BY-CARD-NOT-BY-ROW (2026-09-05). The unit is the CARD,
// not the row: a graded child `${parent}:${tier}` starts with the same id stem
// the scan reads, so hashing the ROW scattered one card's parent, its children
// and its destination across up to five slots while moveCatalogRow was
// re-pointing that card's sales and retiring those same children. See
// lib/card-shard-axis.cjs for the measured interleavings.
function shardIndex(id) {
  return cardShardIndex(id, SHARD_SCOPE.SLOTS);
}

/** Every row on either key -- the pool reader ORs both fields, so a count that
 *  reads one of them is not a count of the pool. */
async function poolCount(pool, slug) {
  const { resources } = await retry(() => pool.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
    parameters: [{ name: "@d", value: slug }],
  }).fetchAll());
  return resources[0] ?? 0;
}

/** PROTECTED: user-verified and ruled rows are report-only forever. */
const PROTECTED_SOURCE = /^(ebay-user-purchase|ebay-user-sale|manual-user-entry|user-verified|admin-approved)/i;
function isProtectedRow(row) {
  if (PROTECTED_SOURCE.test(str(row?.source))) return true;
  if (str(row?.verificationStatus).toLowerCase() === "user-verified") return true;
  if (row?.ruled === true || row?.userRuled === true) return true;
  return false;
}

async function main() {
  const banner = [
    "══════════════════════════════════════════════════════════════════",
    "  repair-bowman-product-refile — a Bowman CPA/BCP card goes home",
    `  MODE            ${APPLY ? "APPLY (writes)" : "REPORT ONLY (no writes)"}`,
    `  SCOPE           ${SCOPE_PRODUCTS.join(", ") || "(none)"}`,
    `  LANES           ${MODE}`,
    `  SHARD           slot ${SHARD_SCOPE.SLOT} of ${SHARD_SCOPE.SLOTS}${SHARD_SCOPE.SHARDED ? "" : " (not sharded)"}`,
    `  LIMIT           ${LIMIT || "(none)"}`,
    `  CLOCK           ${CLOCK.describe()}`,
    "══════════════════════════════════════════════════════════════════",
  ].join("\n");
  console.log(banner);

  if (SCOPE_REJECTED.length) {
    console.error(`::error::scope entries are not sport:year:setKey — ${SCOPE_REJECTED.join(", ")}`);
  }
  if (!SCOPE_PRODUCTS.length || RAW_SCOPE.some((s) => INHERITED_SCOPES.has(lower(s)))) {
    console.error(
      "::error::repair-bowman-product-refile requires scope = a comma-separated list of products as "
      + `sport:year:setKey. Got '${process.env.SCOPE ?? ""}' (the runner default 'refractor' and 'all' are `
      + "refused — this lane has no whole-corpus mode).",
    );
    process.exit(2);
  }

  const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
  const { deriveCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING is required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const report = {
    scope: SCOPE_PRODUCTS,
    apply: APPLY,
    keyMismatch: { scanned: 0, move: 0, moved: 0, failed: 0, refusedDifferentPlayer: 0, skip: {} },
    byStem: {},
    duplicates: { candidates: 0, consolidated: 0, oneOfOneFirst: 0, skip: {} },
    pool: { scanned: 0, move: 0, moved: 0, skip: {} },
    refusals: [],
    moveFailures: [],
    canary: {},
  };
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

  // ── THE WRITE LEDGER (2026-09-06) ────────────────────────────────────────
  // CF-VERDICTS-ARE-ATTRIBUTED. Per POOL, the rows this lane moved OUT and IN.
  // A re-file changes two pools and either can hold a canary anchor, so both
  // sides are recorded. An EMPTY ledger is the positive statement "this lane
  // moved nothing anywhere" -- which is exactly what a canary needs to hear
  // before it blames this lane for a delta.
  const ledger = new Map();
  const LEDGER_IDS_PER_POOL = 20;
  const ledgerNote = (slug, id, side) => {
    if (!slug) return;
    let e = ledger.get(slug);
    if (!e) { e = { from: [], to: [] }; ledger.set(slug, e); }
    if (e[side].length < LEDGER_IDS_PER_POOL) e[side].push(id);
    e[`${side}Count`] = (e[`${side}Count`] ?? 0) + 1;
  };
  // THE PRE-CHECK, not a bare `> BUDGET`. `outOfClock()` is true when there is
  // not enough clock left to START another unit of the largest measured size,
  // so the loop stops BEFORE a unit rather than after one.
  const outOfTime = () => CLOCK.outOfClock();

  // ── canary anchors, BEFORE ────────────────────────────────────────────────
  // The pools this lane must NOT change: the nine collision numbers' Chrome
  // side. If a refile ever merged a collision, these move.
  const CANARY_SLUGS = [];
  for (const p of SCOPE_PRODUCTS) {
    const [sport, year] = p.split(":");
    for (const n of ["cpa-ag", "cpa-em", "cpa-hl", "cpa-wa", "bcp-151"]) {
      CANARY_SLUGS.push(`hiq:${sport}:${year}:bowman-chrome:${n}:base:auto`);
    }
  }
  for (const s of [...new Set(CANARY_SLUGS)]) {
    report.canary[s] = { before: await poolCount(pool, s), after: null };
  }

  // ── LANE 1 + 4: KEY-MISMATCH (chrome, sapphire, paper — one shape) ────────
  if (MODE === "both" || MODE === "catalog") {
    for (const product of SCOPE_PRODUCTS) {
      const [sport, year, setKey] = product.split(":");
      // The DRIFTED rows of this product: id stem = the scope's setKey, field
      // is the stale generic. Read by stem, because the stem is the address.
      const spec = {
        query: `SELECT c.id, c.cardId, c.setKey, c.setName, c.backingSetName, c.playerName,
                       c.cardNumber, c.parallel, c.parallelSlug, c.isAuto, c.printRun,
                       c.source, c.confidence, c.year, c.cardYear, c.subsetName, c.subsetInId,
                       c.verificationStatus, c.vendorIds, c.rarity
                FROM c
                WHERE STARTSWITH(c.id, @stem) AND c.setKey != @setKey`,
        parameters: [
          { name: "@stem", value: `hiq:${sport}:${year}:${setKey}:` },
          { name: "@setKey", value: setKey },
        ],
      };

      const batch = [];
      await forEachPage(cat, spec, async (rows) => {
        for (const row of rows) {
          if (outOfTime()) return false;
          if (SHARD_SCOPE.SHARDED && shardIndex(row.id) !== SHARD_SCOPE.SLOT) continue;
          report.keyMismatch.scanned++;
          batch.push(row);
          if (LIMIT && report.keyMismatch.scanned >= LIMIT) return false;
        }
        return true;
      });

      for (const row of batch) {
        if (outOfTime()) break;
        const stem = B.idStem(row.id);
        report.byStem[stem] = report.byStem[stem] ?? { scanned: 0, move: 0, refused: 0 };
        report.byStem[stem].scanned++;

        // THE RE-MINT. The row's OWN words for the product, through the LIVE
        // deriver with authoritativeSetKey:true. Never a slug this lane builds
        // by hand -- a repair that assembles its own address is a second
        // minting path, which is the defect we are repairing.
        const setName = str(row.setName) || str(row.backingSetName);
        let destSlug = null;
        if (setName) {
          const entry = deriveCatalogEntry({
            sport, year: Number(row.year ?? row.cardYear ?? year),
            setKey: setName,
            cardNumber: row.cardNumber,
            parallel: row.parallel ?? "Base",
            isAuto: row.isAuto === true,
            printRun: typeof row.printRun === "number" ? row.printRun : null,
            playerName: str(row.playerName) || "x",
            source: row.source ?? "checklist",
            confidence: typeof row.confidence === "number" ? row.confidence : 0.9,
            setName,
            subsetName: row.subsetName ?? null,
            subsetInId: row.subsetInId === true,
            authoritativeSetKey: true,
          });
          destSlug = entry?.id ?? null;
        }

        // THE GUARD'S FACT: who is already at the destination?
        let destPlayerName = null;
        if (destSlug) {
          try {
            const { resource } = await retry(() => cat.item(destSlug, destSlug).read());
            destPlayerName = resource ? str(resource.playerName) : null;
          } catch { destPlayerName = null; }
        }

        const plan = B.planCatalogRefile({
          row, destSlug, destPlayerName, isProtected: isProtectedRow(row),
        });

        if (!plan.move) {
          bump(report.keyMismatch.skip, plan.reason);
          if (plan.reason === B.SKIP.DEST_DIFFERENT_PLAYER) {
            report.keyMismatch.refusedDifferentPlayer++;
            report.byStem[stem].refused++;
            // REFUSED ROWS ARE REPORTED BY NAME. This is the nine-collision
            // population and it is the whole reason the guard exists.
            if (report.refusals.length < 500) {
              report.refusals.push({
                id: plan.evidence.id,
                cardNumber: plan.evidence.cardNumber,
                player: plan.evidence.player,
                destination: plan.dest,
                destPlayer: plan.evidence.destPlayer,
              });
            }
          }
          continue;
        }

        report.keyMismatch.move++;
        report.byStem[stem].move++;

        // ── THE MOVE DECLARES ITS SETKEY CHANGE ──────────────────────────────
        //
        // `moveCatalogRow` refuses a CROSS-PRODUCT move that nobody asked for:
        // if newSlug's stem differs from the old id's stem and `changedFields`
        // carries no `setKey`, it throws -- "a cross-product move is not a
        // move". That guard is right, and this lane is exactly the caller that
        // must satisfy it, because moving the product IS the repair.
        //
        // Passing `{}` here is what failed run 33974629259 on its FIRST row
        // (bcp-102, bowman-chrome -> bowman) with refiled=0. The declaration is
        // the destination's OWN stem, read off the slug the deriver produced --
        // never a string assembled here, so the thing declared and the thing
        // written cannot disagree.
        const destSetKey = B.idStem(plan.dest);

        // ── REPORT MODE EXERCISES THE REAL CALL ──────────────────────────────
        //
        // The dry run could not catch that bug because REPORT skipped
        // moveCatalogRow entirely and only APPLY reached it -- so the two paths
        // were never the same code. `dryRun: !APPLY` reads everything, writes
        // nothing, and returns the counts a real run would, which means every
        // guard inside the mover now runs in REPORT too. A report that cannot
        // fail the way the apply fails is not a rehearsal.
        let res;
        try {
          res = await retry(() => moveCatalogRow(cat, row, plan.dest, { setKey: destSetKey }, {
            reason: B.REASON_LONG,
            salesContainer: pool,
            repointNormalizedSetKey: true,
            dryRun: !APPLY,
            retry,
          }));
        } catch (e) {
          // FAIL CLOSED, PER ROW. One row the mover refuses is a `failed` row
          // in the reconciliation, not a crash that aborts the slice and loses
          // the other 18,162. The run still goes RED at the end when failed > 0
          // -- a refusal is never absorbed into silence.
          report.keyMismatch.failed++;
          bump(report.keyMismatch.skip, `move-refused:${String(e?.message ?? e).slice(0, 90)}`);
          if (report.moveFailures.length < 50) {
            report.moveFailures.push({ id: row.id, dest: plan.dest, error: String(e?.message ?? e).slice(0, 200) });
          }
          continue;
        }
        if (res.action !== "noop" && APPLY) {
          report.keyMismatch.moved++;
          // THE CATALOG LANE MOVES POOL ROWS TOO. `moveCatalogRow` re-points
          // every sale pointing at the old slug (`salesContainer: pool`), so a
          // catalog move drains one pool and fills another exactly as a sale
          // re-file does. A ledger blind to that would make a `mode=both` run
          // fail its own canary for the catalog half's success -- the very
          // defect this attribution exists to end. Ids are not enumerated here
          // (the mover does not return them); the COUNTS are what the
          // arithmetic needs.
          const repointed = Number(res.salesRepointed ?? 0);
          for (let i = 0; i < repointed; i++) {
            ledgerNote(row.id, `catalog-repoint:${row.id}`, "from");
            ledgerNote(plan.dest, `catalog-repoint:${row.id}`, "to");
          }
        }
      }
    }
  }

  // ── LANE 5: sold_comps — the urgent half ──────────────────────────────────
  if (MODE === "both" || MODE === "sales") {
    // The checklist claims, per (number -> player), for both products. Read
    // ONCE per product rather than per sale: 10,532 point reads is a lane that
    // measures nothing before it dispatches.
    const claims = { bowman: new Map(), chrome: new Map() };
    for (const product of SCOPE_PRODUCTS) {
      const [sport, year] = product.split(":");
      for (const [side, key] of [["bowman", "bowman"], ["chrome", "bowman-chrome"]]) {
        await forEachPage(cat, {
          query: `SELECT c.cardNumber, c.playerName FROM c
                  WHERE STARTSWITH(c.id, @stem) AND IS_DEFINED(c.playerName) AND c.playerName != null`,
          parameters: [{ name: "@stem", value: `hiq:${sport}:${year}:${key}:` }],
        }, async (rows) => {
          for (const r of rows) {
            const n = B.foldNumber(r.cardNumber);
            if (n && !claims[side].has(n)) claims[side].set(n, { playerName: r.playerName });
          }
          return true;
        }, 1000);
      }
    }

    const COLLISION = new Set(
      ["cpa-em", "cpa-la", "cpa-df", "cpa-hl", "cpa-wa", "cpa-js", "cpa-bc", "cpa-ag", "bcp-151"]
        .map(B.foldNumber),
    );

    for (const product of SCOPE_PRODUCTS) {
      const [sport, year, setKey] = product.split(":");
      const stemPrefix = `hiq:${sport}:${year}:${setKey}:`;
      const sales = [];
      await forEachPage(pool, {
        query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
                       c.playerName, c.setName, c.parallel, c.isAuto, c.printRun,
                       c.title, c.rawTitle, c.source, c.gradeCompany, c.gradeValue, c.price, c.soldAt
                FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)`,
        parameters: [{ name: "@p", value: stemPrefix }],
      }, async (rows) => {
        for (const r of rows) {
          if (outOfTime()) return false;
          if (SHARD_SCOPE.SHARDED && shardIndex(r.id) !== SHARD_SCOPE.SLOT) continue;
          report.pool.scanned++;
          sales.push(r);
          if (LIMIT && report.pool.scanned >= LIMIT) return false;
        }
        return true;
      }, 1000);

      for (const row of sales) {
        if (outOfTime()) break;
        const num = B.foldNumber(row.cardNumber);
        const bowmanClaims = claims.bowman.get(num) ?? null;
        const chromeClaims = claims.chrome.get(num) ?? null;

        // The destination, through the LIVE deriver with the flag set — the
        // same computation the catalog lane uses.
        let destSlug = null;
        if (bowmanClaims) {
          destSlug = computeHobbyIqCardId({
            sport, year: Number(row.cardYear ?? year), setKey: "bowman",
            cardNumber: row.cardNumber, parallel: row.parallel ?? "Base",
            isAuto: row.isAuto === true,
            printRun: typeof row.printRun === "number" ? row.printRun : null,
            authoritativeSetKey: true,
          }) || null;
        }

        const plan = B.planSaleRefile({
          row, destSlug, bowmanClaims, chromeClaims,
          isCollisionNumber: COLLISION.has(num),
          isProtected: isProtectedRow(row),
        });

        if (!plan.move) { bump(report.pool.skip, plan.reason); continue; }
        report.pool.move++;
        if (!APPLY) continue;

        // CF-A-SALE-IS-NEVER-LOST (D19): upsert the keeper, read it back, THEN
        // delete. Both identity fields land at the destination because the
        // exact-pool reader ORs them.
        const keeper = stripSystem(row);
        keeper.cardId = plan.dest;
        keeper.hobbyiqCardId = plan.dest;
        keeper.contentHash = contentHashOf(keeper);
        keeper.reslugedFrom = str(row.hobbyiqCardId ?? row.cardId);
        keeper.reslugedReason = B.REASON_LONG;
        keeper.reslugedAt = new Date().toISOString();
        keeper.reslugedEvidence = plan.evidence.title ?? null;

        // The read-back compares the identity fields ON TOP of id/cardId, so a
        // stale document at the same address cannot pass as the write.
        const out = await relocateSoldComp(pool, {
          keep: keeper,
          drop: [{ id: row.id, cardId: row.cardId }],
          retry,
          verifyFields: ["hobbyiqCardId", "cardId", "reslugedFrom"],
        });
        if (out?.ok) {
          report.pool.moved++;
          // Both sides, and only on a write that LANDED. A ledger that counted
          // intent would explain away a delta the lane never actually caused.
          //
          // AND BOTH IDENTITY FIELDS, because `poolCount` ORs them. A row can
          // carry `cardId` on one slug and `hobbyiqCardId` on another -- 5 of
          // the 8 rows left in the cpa-em anchor are exactly that, cardId on
          // the Chrome slug and hobbyiqCardId already on Bowman -- and such a
          // row is counted in BOTH pools. Recording only `reslugedFrom` would
          // leave the other anchor's drop unattributed and fail the lane for a
          // move it fully accounted for. The Set collapses the common case
          // where the two fields agree, so a normal row is still counted once.
          for (const src of new Set([str(row.hobbyiqCardId), str(row.cardId)].filter(Boolean))) {
            ledgerNote(src, row.id, "from");
          }
          ledgerNote(plan.dest, row.id, "to");
        } else bump(report.pool.skip, `relocate-failed:${out?.stage ?? "unknown"}`);
        if (out?.duplicatesLeft?.length) {
          bump(report.pool.skip, `duplicate-left-in-pool:${out.duplicatesLeft.length}`);
        }
      }
    }
  }

  // ── RECONCILE ─────────────────────────────────────────────────────────────
  // CF-EVERY-WRITE-JOB-RECONCILES. Intended = written + skipped, per lane and
  // in total, so a run that scanned rows and moved none has to SAY so rather
  // than finishing green on silence. The skip buckets are the named reasons
  // above; nothing falls out of the arithmetic unaccounted for.
  const catSkipped = Object.values(report.keyMismatch.skip).reduce((a, b) => a + b, 0);
  const poolSkipped = Object.values(report.pool.skip).reduce((a, b) => a + b, 0);
  const intended = report.keyMismatch.scanned + report.pool.scanned;
  const written = report.keyMismatch.moved + report.pool.moved;
  const failed = report.keyMismatch.failed;
  // A refused move is already counted in the skip buckets (`move-refused:...`),
  // so it must not be counted a second time here.
  const skipped = catSkipped + poolSkipped;
  console.log("");
  console.log(
    `  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)}`
    + ` + planned-not-written ${f(intended - written - skipped)}`,
  );
  if (failed) console.log(`  move refusals: ${f(failed)} row(s) the mover declined — listed in moveFailures`);
  if (APPLY) {
    reportWrites({
      job: "repair-bowman-product-refile",
      intended, written, skipped,
      failed: Math.max(failed, intended - written - skipped),
    });
  }

  // ── canary anchors, AFTER ─────────────────────────────────────────────────
  // UNDER THE VERIFY CAP. These run AFTER the loop, so they must answer or say
  // they could not -- never hold the step open to the ceiling. An unconfirmed
  // anchor is printed UNCONFIRMED and is NOT read as "unchanged": a count we
  // did not take cannot clear the canary.
  //
  // AND THE VERDICT IS ATTRIBUTED (2026-09-06). These anchors sit INSIDE this
  // lane's own write scope -- the Chrome side of the collision numbers is
  // precisely what the sales lane drains -- so a bare before/after comparison
  // fails the lane for succeeding. Run 34009971035 is the proof: it refiled
  // 1,835 sales exactly as ruled, four anchors fell (16->5, 17->8, 87->7,
  // 91->15), and the gate called it a merged collision. Read against the pool
  // afterwards, every departed row carried THIS run's `reslugedFrom` stamp and
  // landed on the Bowman address for its own player; the other player's rows
  // never moved. Nothing merged. See #1711/#1727 for the same false halt in
  // the rematch lane and the same fix.
  //
  // So each anchor's delta is now measured against the lane's OWN write
  // ledger: `expected = before - out + in`. Explained -> PASS with the
  // arithmetic printed. Unexplained, or no ledger at all -> still FAILS.
  let canaryBad = 0, canaryUnread = 0;
  const vt0 = Date.now();
  const ledgerPools = {};
  for (const [slug, e] of ledger) {
    ledgerPools[slug] = { fromCount: e.fromCount ?? 0, toCount: e.toCount ?? 0, from: e.from, to: e.to };
  }
  report.writeLedger = {
    job: "repair-bowman-product-refile",
    mode: MODE, apply: APPLY, scope: SCOPE_PRODUCTS,
    slot: SHARD_SCOPE.SLOT, slots: SHARD_SCOPE.SLOTS,
    runId: process.env.GITHUB_RUN_ID ?? null,
    finishedAt: new Date().toISOString(),
    poolsTouched: ledger.size,
    pools: ledgerPools,
  };
  // A REPORT-ONLY run writes nothing, so its ledger is legitimately empty and
  // any anchor delta is another writer's. An APPLY carries a real ledger.
  // Either way the ledger EXISTS, so attribution is armed; `null` is reserved
  // for a caller that has no ledger at all, which stays strict.
  // The ledger also goes to disk. The gate is in-process here, so this is not
  // what the attribution reads -- it is what a HUMAN reads when a halt has to
  // be re-examined without re-running the lane. Written on every mode,
  // including a report run whose ledger is legitimately empty.
  if (WRITE_LEDGER_OUT) {
    try {
      fs.mkdirSync(path.dirname(WRITE_LEDGER_OUT), { recursive: true });
      fs.writeFileSync(WRITE_LEDGER_OUT, JSON.stringify(report.writeLedger, null, 1));
      console.log(`\n  WRITE LEDGER  ${f(ledger.size)} pool(s) touched  ->  ${WRITE_LEDGER_OUT}`);
    } catch (e) {
      // A ledger we could not persist is not a reason to fail the lane: the
      // attribution below reads the in-memory map, not the file.
      console.error(`!! could not write the ledger to ${WRITE_LEDGER_OUT}: ${String(e?.message ?? e)}`);
    }
  }

  report.canaryAttribution = [];
  for (const s of Object.keys(report.canary)) {
    const after = await CLOCK.capped(vt0, `canary ${s}`, () => poolCount(pool, s));
    report.canary[s].after = after;
    // `undefined` (ledger does not name this pool) and `null` (no ledger)
    // mean opposite things to attributeCanary -- pass the lookup straight
    // through so the distinction survives.
    //
    // A REPORT-ONLY RUN STAYS STRICT. Its ledger is empty by construction, so
    // attribution would relax every anchor to OTHER-WRITER and a dry run that
    // actually wrote would sail through -- destroying the very guarantee this
    // lane's report mode exists to give ("a dry run is proven write-free by
    // MEASUREMENT, not by intent"). `null` is the no-ledger reading, so report
    // mode passes null and any delta stands. Attribution is for APPLY, where
    // the lane has writes to attribute.
    const verdict = B.attributeCanary(s, report.canary[s].before, after, APPLY ? ledgerPools[s] : null);
    report.canaryAttribution.push(verdict);
    if (verdict.unread) { canaryUnread++; continue; }
    if (!verdict.ok) canaryBad++;
  }
  if (canaryUnread) {
    console.log(`  ${canaryUnread} canary anchor(s) UNCONFIRMED (verify cap) — unread, not unchanged.`);
    console.log(CLOCK.unreadNote());
  }

  // THE ATTRIBUTION TABLE. A verdict a reader cannot check is a verdict taken
  // on trust, so the arithmetic that produced it is printed for every anchor.
  console.log("\n── CANARY ATTRIBUTION ────────────────────────────────────────────");
  console.log(`  this lane's write ledger names ${f(ledger.size)} pool(s)`);
  for (const v of report.canaryAttribution) {
    const line = v.unread
      ? `${String(v.before).padStart(6)} -> UNREAD`
      : `${String(v.before).padStart(6)} -> ${String(v.after).padEnd(6)}`
        + ` out ${String(v.from).padStart(5)}  in ${String(v.to).padStart(5)}`
        + `  expected ${String(v.expected).padStart(6)}`;
    console.log(`  ${v.verdict.padEnd(12)} ${line}  ${v.slug}`);
    if (v.note) console.log(`               ${v.note}`);
  }

  console.log("\n── REPORT ────────────────────────────────────────────────────────");
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\nKEY-MISMATCH scanned ${f(report.keyMismatch.scanned)} · would move ${f(report.keyMismatch.move)}`
    + ` · moved ${f(report.keyMismatch.moved)} · REFUSED (different player) ${f(report.keyMismatch.refusedDifferentPlayer)}`,
  );
  console.log(
    `POOL scanned ${f(report.pool.scanned)} · would move ${f(report.pool.move)} · moved ${f(report.pool.moved)}`,
  );
  // The relaunch reads these two lines. CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS:
  // the budget marker is printed by the run's OWN clock, under the workflow
  // ceiling, so a slot that ran out of time says so rather than being killed
  // mid-sweep and reporting nothing.
  console.log(`  REFILED onto the product it came out of  ${f(report.keyMismatch.moved + report.pool.moved)}`);
  if (outOfTime()) {
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps this phrase, and
    // `everyWriteJobReconciles` greps THIS SOURCE for it, so the words
    // "stopped at the ... budget" are written out literally here rather than
    // only being assembled at runtime by CLOCK.stoppedAtBudget() -- a marker a
    // static reader cannot see is a relaunch that never fires.
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget — the slot has more to do`);
  }

  // A REFUSED MOVE KEEPS THE RUN RED. The lane fails closed per row so one
  // refusal cannot abort the slice, but the slot must not report success while
  // rows it intended to move were declined -- that is how a broken apply looks
  // identical to a clean one (run 33974629259 refiled=0 and still "finished").
  if (failed) {
    console.error(`::error::${f(failed)} catalog move(s) were refused by moveCatalogRow — see moveFailures in the report.`);
  }

  if (!APPLY && canaryBad) {
    // A report run writes nothing, so its ledger is empty and every anchor is
    // UNTOUCHED -- which makes a delta another writer's, not a proof of a
    // stray write. What still fails here is an UNEXPLAINED anchor, and in
    // report mode that means a pool moved that this lane says it never wrote.
    console.error(`::error::${canaryBad} canary pool(s) moved during a REPORT-ONLY run.`);
    console.error("FATAL: a dry run is proven write-free by MEASUREMENT, not by intent.");
    process.exit(3);
  }
  if (canaryBad) {
    console.error(
      `::error::${canaryBad} canary pool(s) changed by rows this lane's write ledger cannot account for`
      + ` — a collision may have been merged. Investigate before continuing.`,
    );
    process.exit(3);
  }
  if (failed) process.exit(4);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); 
    await finishLane(1);
  });
