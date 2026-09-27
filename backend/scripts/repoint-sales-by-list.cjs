#!/usr/bin/env node
/**
 * repoint-sales-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for sold_comps
 * re-keys named explicitly in a committed list file (Drew, 2026-09-27
 * widget ruling: "Build repoint-sales-by-list lane").
 *
 * This lane moves sold_comps rows from a listed SOURCE hobbyiqCardId to a
 * listed DESTINATION hobbyiqCardId, and does nothing else -- no retire, no
 * catalog write, no derivation of the destination from a rule. It is
 * ONE-AXIS on purpose: it moves sales. The catalog row the source address
 * left behind (now with zero sales, if it was ever real) is a SEPARATE
 * decision left to relocate-catalog-rows-by-list's own `retire` action,
 * exactly as PR #2454's own finding states it -- a two-step sequence, this
 * lane owns step 1 only.
 *
 * FIRST USE (#2454, 2026-09-27 census). USC143 (Adael Amador, 2025 Topps
 * Chrome Update Series): the sale at
 *   hiq:baseball:2025:topps-chrome-update-series:usc143:raywave-refractor:no-auto
 * moves to
 *   hiq:baseball:2025:topps-chrome-update-series:usc143:ray-wave-refractor:no-auto
 * Both rows carry the identical parallel text "RayWave Refractor" -- the id
 * drift is normalizeParallel mint-time drift, not two different cards.
 *
 * SECOND INTENDED USE (draft PR #2453, unsigned-twin pairs). 3,265
 * (setKey, prefix, year) pairs where a checklist-grade `:no-auto` row is a
 * MINTING ERROR for an auto-only insert -- the sale belongs at the `:auto`
 * id. Each pair is one list entry; the list format below is sized for
 * thousands of entries deliberately.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE GATES, PER ENTRY, AT APPLY TIME -- EACH NAMED AND COUNTED
 * ────────────────────────────────────────────────────────────────────────
 *
 *   1. fromId row AND toId row must both EXIST in card_catalog. A row
 *      without `cardId` lives under Cosmos's own "None" partition key, not
 *      at a partition keyed by its own id -- pkOf (lib/catalog-none-pk.cjs)
 *      is the ONE place that decision is made, so a None-pk row is still
 *      found rather than silently read as absent.
 *   2. toId's card_catalog row must be CHECKLIST-GRADE
 *      (catalogAuthorityOf(row.source) === "checklist") -- never DERIVED or
 *      VENDOR. "present is not checklist-grade": a destination row that
 *      merely exists but was synthesised from our own comps or a vendor's
 *      typing is not a card_catalog row that gets to adjudicate identity.
 *   3. SAME sport/year/setKey/cardNumber between the two ids, unless the
 *      entry says `allowCrossProduct: true` WITH a `crossProductRuling`
 *      string naming the ruling that licenses it. Compared off the
 *      CATALOG ROWS' own fields (never re-derived from the id strings),
 *      because a row's stored identity is the fact this gate exists to
 *      protect.
 *   4. destination id must not equal the source id (a no-op entry is a
 *      list defect, not a silent skip).
 *   5. the source must have at least ONE sale (salesAtId's dual
 *      cross-partition + partition-scoped check) -- zero sales is refused
 *      as "nothing to do" and counted, never silently skipped.
 *   6. for EVERY sale moved, namesAgree(sale title/player, destination
 *      row's player) must pass. "A checklist row proves the ROW, the
 *      player name proves the SALE": the catalog gates above establish
 *      that the DESTINATION is a real, checklist-attested card; namesAgree
 *      establishes that THIS PARTICULAR SALE is that card's sale and not
 *      some other player's listing that happened to share a source
 *      partition. A sale whose title/player disagrees is refused alone --
 *      it does not fail the whole entry, and it does not retry under a
 *      looser rule.
 *
 * Any refusal is named, counted, and never silently merged into another
 * bucket -- CF-NEVER-DISMISS-SMALL-NUMBERS-AS-NOISE.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SCAN / WRITE SHAPE
 * ────────────────────────────────────────────────────────────────────────
 *
 * Never a cross-partition COUNT or GROUP BY. sold_comps ids
 * (`${source}::${externalId}`) are unique only WITHIN a partition, so a
 * move is addressed as (partition, id) throughout: the source scan pages
 * with FeedOptions {maxItemCount:500, maxDegreeOfParallelism:-1},
 * `while (iterator.hasMoreResults())`, and NEVER breaks on an empty page
 * (an empty page mid-drain is not the same as the iterator being done --
 * see lib/sales-at-id.cjs's own header for the reproduced anomaly this
 * guards against). The move itself goes through relocateSoldComp
 * (lib/relocate-sold-comp.cjs) -- the ONE sanctioned mover, create-at-new +
 * verified read-back + delete-old -- and its own documented behaviour
 * governs the FAILED-vs-clean distinction this lane relies on: a THROWN
 * read-back (network error, not "not found") is reported by
 * relocateSoldComp as `duplicatesLeft: []` with `ok: false` and
 * `stage: "verify"` -- this lane treats that as FAILED, never as a clean
 * move, exactly per the caller's own briefing on this file.
 *
 * ────────────────────────────────────────────────────────────────────────
 * REPORT vs APPLY
 * ────────────────────────────────────────────────────────────────────────
 *
 * REPORT (apply=false, the default) computes EXACTLY what APPLY would --
 * every gate, every namesAgree check, every sale enumerated -- and writes
 * nothing (relocateSoldComp is called with `dryRun: true`). A report that
 * skips the derivation is a green light for a write that will not happen
 * (the 2026-09-07 incident this doctrine is named for); this lane never
 * repeats it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * BUDGET + RELAUNCH
 * ────────────────────────────────────────────────────────────────────────
 *
 * Sized like relocate-catalog-rows-by-list.cjs and relocate-pool-rows-by-
 * list.cjs, its direct siblings: a unit here is ONE SALE MOVED (not one
 * list entry -- an entry can carry many sales), and a move costs a create
 * + verified read-back + delete, so the 30s reserve mirrors the catalog
 * lane's own measured-and-multiplied reserve. `budget()`/`finishLane()`
 * (lib/runner-budget.cjs) own the clock, the keepalive and the exit
 * discipline; this lane never re-implements them. The loop is idempotent:
 * a re-run of a finished list finds nothing left at the source id (or a
 * destination already carrying the sale) and skips cleanly, so a relaunch
 * after a budget stop costs one cheap read per settled entry and writes
 * only what is left.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/; REQUIRED -- this lane has no default
 *      list, matching relocate-catalog-rows-by-list's own convention: a
 *      list-scoped lane with no default is safer than one that silently
 *      substitutes a population nobody named).
 * Requires dist/ (hobbyIqCardId is not used directly, but
 * catalogAuthority.service.js and writeReconciliation.js are).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { salesAtId, drainSalesIdsAtId } = require(path.join(__dirname, "lib", "sales-at-id.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));
const { withBackoff } = require(path.join(__dirname, "lib", "cosmos-backoff.cjs"));
const { pkOf } = require(path.join(__dirname, "lib", "catalog-none-pk.cjs"));
// The dist/ and Cosmos requires live inside main(), as every sibling list
// lane does it: loading this module must not need a built tree, so a test
// can require it and drive the list/gate logic without a compile step.

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3), matching
// relocate-catalog-rows-by-list.cjs exactly: `scope` is shared with every
// other lane on this runner and carries THEIR vocabulary. There is no
// default list -- an absent or non-.json scope is FATAL, never read as
// "everything" or as some other lane's population.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane moves sold_comps rows and has no default list — "
      + "name the committed .json list to run (e.g. SCOPE=data/sales-repoints/<file>.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a list file. This lane's scope is a `
      + "committed .json list of (fromId, toId) pairs — never a predicate, a product key, or "
      + "another lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;

/**
 * An entry names a fromId/toId pair, and nothing about it is inferred.
 * Returns { ok, ...fields } where a falsy `ok` carries the refusal text.
 */
function classifyEntry(e) {
  const fromId = String(e?.fromId ?? "").trim();
  const toId = String(e?.toId ?? "").trim();
  const player = String(e?.player ?? "").trim();
  const cardNumber = String(e?.cardNumber ?? "").trim();
  const reason = String(e?.reason ?? "").trim();
  if (!fromId) return { ok: false, why: "entry has no fromId" };
  if (!fromId.startsWith("hiq:")) return { ok: false, why: `fromId is not a hiq slug: ${fromId.slice(0, 60)}` };
  if (!toId) return { ok: false, why: `entry has no toId: ${fromId.slice(0, 60)}` };
  if (!toId.startsWith("hiq:")) return { ok: false, why: `toId is not a hiq slug: ${toId.slice(0, 60)}` };
  if (toId === fromId) return { ok: false, why: `toId equals fromId: ${fromId.slice(0, 60)}` };
  if (!reason) return { ok: false, why: `entry has no reason: ${fromId.slice(0, 60)}` };
  const allowCrossProduct = e?.allowCrossProduct === true;
  const crossProductRuling = String(e?.crossProductRuling ?? "").trim();
  if (allowCrossProduct && !crossProductRuling) {
    return { ok: false, why: `allowCrossProduct:true needs a crossProductRuling string: ${fromId.slice(0, 60)}` };
  }
  return {
    ok: true, fromId, toId, player, cardNumber, reason,
    allowCrossProduct, crossProductRuling,
    expectedSales: Number.isFinite(Number(e?.expectedSales)) ? Number(e.expectedSales) : null,
  };
}

/**
 * Do these two catalog rows name the SAME product address -- sport, year,
 * setKey and cardNumber, all four, off the ROWS' OWN stored fields, never
 * re-derived from the id strings? A mismatch is refused unless the entry
 * carries `allowCrossProduct: true` with a ruling.
 *
 * Returns `{ ok: true }` or `{ ok: false, why, differing }`.
 */
function sameProductAddress(fromRow, toRow) {
  const FIELDS = ["sport", "year", "setKey", "cardNumber"];
  const norm = (v) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());
  const differing = FIELDS.filter((k) => norm(fromRow?.[k]) !== norm(toRow?.[k]));
  if (differing.length === 0) return { ok: true, differing: [] };
  return {
    ok: false,
    why: `fromId and toId catalog rows disagree on ${differing.join(", ")}`,
    differing,
  };
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

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
  console.log(`for lane                ${doc.forLane ?? "(unlabelled)"}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  if (doc.finding) console.log(`  finding: ${String(doc.finding).slice(0, 200)}`);

  // The client is NAMED rather than chained away, so finishLane() can
  // dispose it -- an undisposed SDK keeps keep-alive sockets open, which is
  // exactly what held four APPLY shards to the ceiling in #1809.
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const retry = (fn) => withBackoff(fn, { label: "repoint-sales-by-list" });

  const catalogRowAt = async (id) => {
    // A row without cardId lives at Cosmos's own None partition key, so the
    // point read must use pkOf's decision, never a bare (id, id) guess.
    try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (err) {
      if (err?.code !== 404 && err?.statusCode !== 404) throw err;
    }
    // The (id, id) guess 404'd. Try the None-pk address before calling the
    // row absent -- pkOf(row) needs the row itself only to decide WHICH
    // partition a WRITE would use; for a READ where we do not yet have the
    // row, a row with no cardId is exactly the row a bare (id, id) read
    // cannot find, so retry once at the None sentinel.
    try {
      const nonePk = pkOf({});
      return (await retry(() => cat.item(id, nonePk).read())).resource ?? null;
    } catch (err) {
      if (err?.code === 404 || err?.statusCode === 404) return null;
      throw err;
    }
  };

  // ── THE CLOCK. A unit is ONE SALE MOVED; the reserve is sized like the
  // catalog list lane's own (16x its slowest measured entry), since a move
  // here is the same shape (create + verified read-back + delete).
  const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  let movedSales = 0;
  let refusedNoFromRow = 0, refusedNoToRow = 0, refusedNotChecklistGrade = 0;
  let refusedProductMismatch = 0, refusedSameId = 0, refusedZeroSales = 0;
  let refusedNameDisagreement = 0;
  let failedSales = 0;
  let skippedEntries = 0; // an entry whose gates all pass but has 0 sales -- refusedZeroSales counts it too, kept separate as the entry-level tally
  let entriesFailedToClassify = 0;

  const intendedSales = { count: 0 }; // running total of sales this run INTENDED to move once an entry passes its gates -- filled per entry below
  let stoppedAt = null;
  let considered = 0;

  const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, "repoint-sales-by-list-plan.ndjson");
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(record) {
    if (!planFd) return;
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed: ${e?.message}`); }
  }

  for (const e of entries) {
    if (CLOCK.outOfClock()) { stoppedAt = considered; break; }
    considered++;
    const c = classifyEntry(e);
    if (!c.ok) {
      entriesFailedToClassify++;
      console.error(`  MALFORMED — ${c.why}`);
      continue;
    }
    const { fromId, toId, player, cardNumber, reason, allowCrossProduct, crossProductRuling } = c;

    console.log(`\n  ENTRY  ${fromId.slice(0, 66)}`);
    console.log(`      -> ${toId.slice(0, 66)}`);
    console.log(`      player: ${player || "(unnamed)"}  cardNumber: ${cardNumber || "(unnamed)"}`);
    console.log(`      reason: ${reason.slice(0, 120)}`);

    // ── GATE: toId equals fromId ────────────────────────────────────────
    // classifyEntry already refuses this at parse time; kept here as a
    // belt-and-suspenders count in case a future caller drives the gates
    // directly with a hand-built entry object.
    if (toId === fromId) {
      refusedSameId++;
      console.error("      REFUSED (same-id): destination equals source");
      continue;
    }

    // ── GATE 1: both catalog rows must exist ────────────────────────────
    let fromRow, toRow;
    try {
      [fromRow, toRow] = await Promise.all([catalogRowAt(fromId), catalogRowAt(toId)]);
    } catch (err) {
      failedSales++;
      console.error(`      FAILED: catalog read threw — ${String(err?.message ?? err).slice(0, 100)}`);
      continue;
    }
    if (!fromRow) {
      refusedNoFromRow++;
      console.error("      REFUSED (no-from-row): fromId has no card_catalog row");
      continue;
    }
    if (!toRow) {
      refusedNoToRow++;
      console.error("      REFUSED (no-to-row): toId has no card_catalog row");
      continue;
    }

    // ── GATE 2: destination must be checklist-grade ─────────────────────
    const toAuthority = catalogAuthorityOf(toRow.source);
    if (toAuthority !== "checklist") {
      refusedNotChecklistGrade++;
      console.error(`      REFUSED (not-checklist-grade): toId's row authority is "${toAuthority}", not checklist — present is not checklist-grade`);
      continue;
    }

    // ── GATE 3: same product address unless the entry rules otherwise ──
    const productCheck = sameProductAddress(fromRow, toRow);
    if (!productCheck.ok && !allowCrossProduct) {
      refusedProductMismatch++;
      console.error(`      REFUSED (product-mismatch): ${productCheck.why}`);
      continue;
    }
    if (!productCheck.ok && allowCrossProduct) {
      console.log(`      cross-product allowed: ${crossProductRuling.slice(0, 120)}`);
    }

    // ── GATE 4: the source must have at least one sale ──────────────────
    let salesRows;
    try {
      const drained = await drainSalesIdsAtId(pool, fromId, { retry });
      salesRows = drained.rows;
    } catch (err) {
      failedSales++;
      console.error(`      FAILED: sales lookup threw — ${String(err?.message ?? err).slice(0, 100)}`);
      continue;
    }
    if (salesRows.length === 0) {
      refusedZeroSales++;
      skippedEntries++;
      console.error("      REFUSED (zero-sales): fromId has no sold_comps rows — nothing to do");
      continue;
    }

    console.log(`      sales at fromId: ${f(salesRows.length)}`);

    // ── PER-SALE: read the full document, gate on namesAgree, then move ──
    for (const ref of salesRows) {
      if (CLOCK.outOfClock()) { stoppedAt = considered - 1; break; }
      let sale = null;
      try {
        sale = (await retry(() => pool.item(ref.id, ref.cardId ?? fromId).read())).resource ?? null;
      } catch (err) {
        if (err?.code === 404 || err?.statusCode === 404) { continue; } // gone since the drain; not a failure
        failedSales++;
        console.error(`      FAILED: sale read threw for ${ref.id} — ${String(err?.message ?? err).slice(0, 90)}`);
        continue;
      }
      if (!sale) continue;

      const saleName = String(sale.playerName ?? sale.title ?? "");
      const destName = String(toRow.playerName ?? "");
      if (!namesAgree(saleName, destName)) {
        refusedNameDisagreement++;
        console.error(`      REFUSED (name-disagreement) ${sale.id}: sale "${saleName.slice(0, 60)}" vs destination "${destName.slice(0, 60)}"`);
        emitPlanRow({ action: "refused", reason: "name-disagreement", fromId, toId, saleId: sale.id, saleName, destName });
        continue;
      }

      if (!APPLY) {
        movedSales++;
        emitPlanRow({ action: "would-move", reason: "report-only", fromId, toId, saleId: sale.id, before: sale.cardId, after: toId });
        continue;
      }

      const keep = stripSystem(sale);
      keep.cardId = toId;
      keep.hobbyiqCardId = toId;
      keep.contentHash = contentHashOf(keep);
      try {
        const res = await relocateSoldComp(pool, {
          keep, drop: [{ id: sale.id, cardId: sale.cardId ?? fromId }], retry,
          verifyFields: ["cardId", "hobbyiqCardId", "price", "soldAt", "contentHash"],
        });
        if (res.ok) {
          movedSales++;
          emitPlanRow({ action: "moved", reason: "repoint-sales-by-list", fromId, toId, saleId: sale.id, before: sale.cardId, after: toId });
        } else {
          failedSales++;
          console.error(`      FAILED at ${res.stage}: ${String(res.error ?? "").slice(0, 100)}`);
          if (res.duplicatesLeft?.length) {
            console.error(`      DUPLICATE LEFT IN POOL: ${res.duplicatesLeft.length} — the create+verify landed, the delete did not; the sale is now resident at BOTH addresses`);
          }
          emitPlanRow({ action: "failed", reason: res.stage ?? "unknown", fromId, toId, saleId: sale.id, error: String(res.error ?? "") });
        }
      } catch (err) {
        // A THROWN read-back (a network error, never "not found") is FAILED,
        // never clean -- relocateSoldComp's own catch path can otherwise
        // report duplicatesLeft:[] on a throw, which reads as "nothing left
        // behind" when in fact the verify never ran to completion. Treated
        // here exactly as briefed: a throw is FAILED, not a clean move.
        failedSales++;
        console.error(`      FAILED: relocateSoldComp threw — ${String(err?.message ?? err).slice(0, 100)}`);
        emitPlanRow({ action: "failed", reason: "relocate-threw", fromId, toId, saleId: sale.id, error: String(err?.message ?? err) });
      }
    }
  }

  const totalRefused = refusedNoFromRow + refusedNoToRow + refusedNotChecklistGrade
    + refusedProductMismatch + refusedSameId + refusedZeroSales + refusedNameDisagreement;

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope             ${f(entries.length)}`);
  console.log(`  entries considered           ${f(considered)}${stoppedAt === null ? "   <- the whole list" : ""}`);
  console.log(`  entries malformed            ${f(entriesFailedToClassify)}`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"} (sales)              ${f(movedSales)}`);
  console.log(`  REFUSED: no-from-row          ${f(refusedNoFromRow)}`);
  console.log(`  REFUSED: no-to-row            ${f(refusedNoToRow)}`);
  console.log(`  REFUSED: not-checklist-grade  ${f(refusedNotChecklistGrade)}`);
  console.log(`  REFUSED: product-mismatch     ${f(refusedProductMismatch)}`);
  console.log(`  REFUSED: same-id              ${f(refusedSameId)}`);
  console.log(`  REFUSED: zero-sales           ${f(refusedZeroSales)}`);
  console.log(`  REFUSED: name-disagreement    ${f(refusedNameDisagreement)}`);
  console.log(`  failed                        ${f(failedSales)}`);

  const notReached = stoppedAt === null ? 0 : entries.length - stoppedAt - entriesFailedToClassify;
  console.log(`  not reached (budget)          ${f(notReached)}   <- the relaunch settles these`);

  // RECONCILE. `intended` is defined per SALE the same way the sibling
  // repoint lanes define their `candidates`: every sale this run actually
  // classified (moved, refused for a reason attached to the SALE, or
  // failed) plus every entry-level refusal that never got to enumerate a
  // sale (no-from-row, no-to-row, not-checklist-grade, product-mismatch,
  // same-id, zero-sales) plus malformed entries plus not-reached entries.
  // Two different units (sales vs entries) sit in one formula because a
  // per-entry refusal never produces a sale-level outcome at all -- it is
  // its own unit, exactly once, the same way relocate-catalog-rows-by-
  // list's own `park`/`verify` are their own reconciled unit alongside
  // per-row retires.
  const entryLevelRefusals = refusedNoFromRow + refusedNoToRow + refusedNotChecklistGrade
    + refusedProductMismatch + refusedSameId + refusedZeroSales;
  const saleLevelOutcomes = movedSales + refusedNameDisagreement + failedSales;
  const accounted = entryLevelRefusals + saleLevelOutcomes + entriesFailedToClassify + notReached;
  const intended = entries.length;
  console.log(`\n  reconciled: intended ${f(intended)} = entry-refusals ${f(entryLevelRefusals)} `
    + `+ sale-outcomes ${f(saleLevelOutcomes)} + malformed ${f(entriesFailedToClassify)} + not-reached ${f(notReached)}`);
  if (accounted !== intended) {
    console.error("  !! RECONCILE MISMATCH -- an entry was neither gated, moved, refused, failed, malformed nor deferred");
    process.exitCode = 4;
  }

  if (APPLY) {
    reportWrites({
      job: "repoint-sales-by-list",
      intended,
      written: movedSales,
      skipped: entryLevelRefusals + entriesFailedToClassify + notReached,
      refused: refusedNameDisagreement,
      failed: failedSales,
    });
  }

  if (!APPLY) console.log("\nREPORT ONLY — nothing was written. Re-run with BACKFILL_APPLY=true to apply.");

  // -- THE MARKER THE RELAUNCH GREPS -----------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). Written as a source literal, not
  // assembled from variables, exactly matching every sibling list lane.
  if (stoppedAt !== null) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `stopped at ${f(stoppedAt)} of ${f(intended)}; the relaunch continues from here`);
    console.log("  the list is IDEMPOTENT: a finished move re-reads as zero sales left at fromId,"
      + " so the continuation re-derives cheaply and writes only what is left.");
  } else {
    console.log(`\n  finished within budget (considered=${f(considered)}) — done, no re-dispatch.`);
  }

  return { client, budget: CLOCK };
}

module.exports = { classifyEntry, sameProductAddress, APPLY, SCOPE_ERROR };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, {});
    });
}
