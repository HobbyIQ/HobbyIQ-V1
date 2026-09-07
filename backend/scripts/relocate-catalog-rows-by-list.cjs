#!/usr/bin/env node
/**
 * CF-THE-LIST-IS-THE-SCOPE, for card_catalog (2026-09-06).
 *
 * The catalog twin of relocate-pool-rows-by-list. It acts on the card_catalog
 * rows named EXPLICITLY in a committed list file, and on nothing else. A row
 * not in the file is never touched, so this lane cannot widen by accident the
 * way a `WHERE source = ...` sweep can -- which is exactly the accident this
 * lane was written to avoid.
 *
 * WHY IT EXISTS. The sportscardchecklist Bowman's Best incident asked for a
 * retire of 60 catalog rows scoped by (source, sport, year, setKey). Measured
 * read-only 2026-09-06, that predicate selects 292 rows in baseball/1997/
 * bowmans-best and 320 in basketball/1997/topps-stadium-club -- because the
 * SAME dated ingest wrote both the wrong rows and hundreds of correct ones
 * into the same product. Retiring on it would have taken out 232 Bowman's
 * Best and 240 Stadium Club rows, Michael Jordan among them. No predicate
 * available to a lane separates them; a reviewed list of ids does.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT "RETIRE" HAS TO MEAN HERE, AND WHY IT IS A DELETE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This is the load-bearing decision in this file, so it is written out.
 *
 * The pool lane's retire is a MARKER: it sets `flaggedWrong`, and that works
 * there because `flaggedWrong` is a field every FMV read already excludes
 * (exactPoolReader, tieredMomentum, treeGradeCurve, unifiedPricing,
 * hobbyIqFmv, and a dozen more). card_catalog has NO equivalent field, and
 * that is deliberate. catalogVisibility.ts:23-25 states the rule:
 *
 *     Every state is MATCHABLE. Sold comps roll up to verified, provisional
 *     and even excluded rows alike -- matching is about coverage, and an
 *     imperfect identity still beats an orphaned sale. Only VISIBILITY is
 *     tiered. Match paths (catalogVerify, resolveSetKey, checklistNarrow,
 *     catalogMatcher) read everything and must not use this module.
 *
 * Verified by reading every match path: catalogMatcher's point read and its
 * four candidate queries (Steps 2, 2b, 2c, 3), catalogIdentityResolver's stem
 * query, catalogVerify's two queries and resolveSetKey's one all filter on
 * IDENTITY fields only -- sport, year, setKey, cardNumber, isAuto, parallel,
 * playerName/playerSlug, id prefix. Not one of `retired`, `retiredAt`,
 * `supersededBy`, `deletedAt`, `isActive`, `status`, `tombstone`,
 * `excludedFromMatch` appears in any of them; `verificationStatus` is read
 * only by SEARCH; `flaggedWrong` and `identityUnverified` are sold_comps
 * fields. The single provenance field a matcher reads is `source`, and it
 * only ever demotes a VOTE (resolveSetKey) or breaks a TIE among numbered
 * twins (catalogIdentityResolver) -- it never removes a candidate from the
 * queries that return `best.id` and rebind sales.
 *
 * So: a soft label on a catalog row is a NO-OP for matching. A row stops
 * resolving when, and only when, it stops existing. This lane therefore
 * retires by DELETE, through catalogRowOps.retireCatalogRow -- the same
 * primitive every other `retire-*` catalog lane uses.
 *
 * THE COST LINE, STATED RATHER THAN DISCOVERED LATER. retireCatalogRow
 * deletes the row's graded children and then the row, and it re-points
 * NOTHING: its own docblock says "Nothing is stamped on the sales that
 * pointed here -- they are unplaced now, and the rematch owns unplaced
 * sales." That is the designed contract, not an oversight. Every entry in a
 * retire list is therefore also a decision to hand that row's sales to the
 * rematch, and the banner counts them so the size of that hand-off is visible
 * BEFORE the apply, not inferred from a pool query afterwards.
 *
 * THE ALTERNATIVE WAS REJECTED ON BLAST RADIUS. Adding an exclusion predicate
 * to the match paths would touch six live queries on the hottest read path in
 * the product, would need catalogQuerySchema.test.ts extended for a new field,
 * and would silently change the resolution of every row anyone had ever
 * flagged for any reason. A 140-row cleanup does not get to reshape the
 * matcher. If a soft-retire tier is ever wanted, it is its own change with its
 * own census -- not a side effect of this one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO SHAPES
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   retire   the row should not exist. Deleted via retireCatalogRow (graded
 *            children first, then the row). Its sales become unplaced and are
 *            counted in the banner.
 *
 *   reslug   the row is a real card at the wrong address. Moved via
 *            moveCatalogRow to `to`: copy, re-point that row's sales, retire
 *            the old slug's graded children, delete the old row -- in that
 *            order, so no sale is ever dangling. If `to` is occupied by a
 *            DIFFERENT card the entry is REFUSED and counted, never merged:
 *            an occupied address is a collision to report, not to route
 *            around.
 *
 * ORDER WITHIN A LIST IS THE AUTHOR'S. Entries are applied top to bottom, so a
 * list that must vacate an alias address before reslugging onto it says so by
 * putting the retire first. The lane does not reorder.
 *
 * REPORT FIRST, AND THE REPORT RUNS THE APPLY'S DERIVATION. Without
 * BACKFILL_APPLY=true this prints the whole plan -- every id, its current
 * address, its intended fate, and the evidence recorded in the file -- and
 * writes nothing.
 *
 * "Writes nothing" is NOT the same as "computes nothing", and conflating them
 * is what produced the 2026-09-07 incident: the report counted every reslug a
 * success before moveCatalogRow was ever called, reconciled 148/148, and the
 * apply of the same list on the same rows then FAILED 91 of them on a
 * derivation the report had never run. A report that cannot predict its apply
 * is worse than no report -- it is a green light for a write that will not
 * happen. So the reslug path now makes ONE moveCatalogRow call for both modes,
 * with `dryRun: !APPLY`: read everything, derive everything, write only when
 * armed. Anything moveCatalogRow would refuse, the report refuses too.
 *
 * The same day proved the point twice. The Crown Zenith Galarian Gallery list
 * (292 EN->EN reslugs) reported 292/292 and applied 0, failing every row on
 * "newSlug is not a hiq slug" -- a VALIDATION refusal, nothing to do with the
 * market guard or with occupancy. A report that skips the derivation cannot
 * predict ANY of the three, which is why the fix is one shared call rather
 * than three mirrored checks that would drift apart again.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/; REQUIRED -- this lane has no default list).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
// The dist/ and Cosmos requires live inside main(), as the pool lane does it:
// loading this module must not need a built tree, so the runner contract test
// can require it and drive the scope refusal without a compile step.

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3).
//
// `scope` is shared with every other lane on this runner and carries THEIR
// vocabulary ("refractor", "all", a product key). A scope that does not name a
// list is a REFUSAL.
//
// AND UNLIKE THE POOL LANE, THERE IS NO DEFAULT. The pool lane may fall back to
// its one documented population when SCOPE is absent. This lane must not: it
// DELETES catalog rows, the runner's own default for `scope` is the string
// "refractor", and a lane that deletes must never be one empty input away from
// running a list nobody named. Absent scope is fatal.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane DELETES catalog rows and has no default list — "
      + "name the committed .json list to run (e.g. SCOPE=data/catalog-relocations/<file>.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a list file. This lane's scope is a `
      + "committed .json list of row ids — never a predicate, a product key, or another "
      + "lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;
const f = (n) => Number(n).toLocaleString();

/**
 * An entry names ONE shape, and the shape is stated by `action` rather than
 * inferred from which fields happen to be present -- inference is how a typo'd
 * key becomes a silent no-op.
 *
 * Returns { ok, action, reason } where a falsy `ok` carries the refusal text.
 */
function classifyEntry(e) {
  const id = String(e?.id ?? "").trim();
  const action = String(e?.action ?? "").trim();
  const to = String(e?.to ?? "").trim();
  const reason = String(e?.reason ?? "").trim();
  if (!id) return { ok: false, why: "entry has no id" };
  if (!id.startsWith("hiq:")) return { ok: false, why: `id is not a hiq slug: ${id.slice(0, 60)}` };
  if (action !== "retire" && action !== "reslug") {
    return { ok: false, why: `action must be "retire" or "reslug", got ${JSON.stringify(e?.action ?? null)}` };
  }
  // The reason is what a reviewer reads in the diff and what the write stamps.
  // An unexplained delete is not reviewable.
  if (!reason) return { ok: false, why: `entry has no reason: ${id.slice(0, 60)}` };
  if (action === "reslug") {
    if (!to) return { ok: false, why: `reslug entry has no "to": ${id.slice(0, 60)}` };
    if (!to.startsWith("hiq:")) return { ok: false, why: `"to" is not a hiq slug: ${to.slice(0, 60)}` };
    if (to === id) return { ok: false, why: `reslug "to" equals the id: ${id.slice(0, 60)}` };
  } else if (to) {
    return { ok: false, why: `retire entry must not name a "to": ${id.slice(0, 60)}` };
  }
  return { ok: true, id, action, to, reason };
}

/**
 * Is the row at the destination the SAME card, or a different one?
 *
 * A reslug onto an address held by the same card (a re-run, or a graded child
 * regenerated meanwhile) is a fold moveCatalogRow can adjudicate. A reslug onto
 * a DIFFERENT player's card is the collision that produced this whole incident,
 * and it is refused rather than merged: two cards must never share a pricing
 * address, and picking a winner here would be picking one by accident.
 *
 * WHY THIS LANE IS NOT WIRED TO `playerEvidence` (CF-A-FOLD-NEVER-CHANGES-THE-
 * PLAYER, the evidence half). The other three fold lanes now gather corroboration
 * so a different-player collision can RESOLVE instead of always refusing. This
 * one deliberately does not, because this guard is STRICTER than the evidence
 * rule and must stay that way: it refuses every different-player destination,
 * including one the market would corroborate. Handing it evidence would let a
 * corroborated pair through and turn a refusal into a write -- WEAKENING a guard
 * on a lane that acts from a human-curated list and DELETES the source row.
 * There is no ambiguity here for evidence to settle: a curated list that names a
 * destination already occupied by another player is a mistake in the list, and
 * the answer is to report it to the human who wrote it.
 */
/** The setKey segment of a hiq slug, or "" when it is not one. */
function idSetKey(slug) {
  const parts = String(slug ?? "").split(":");
  return parts.length >= 5 && parts[0] === "hiq" ? parts[3] : "";
}

/**
 * The `changedFields` a reslug must pass to moveCatalogRow.
 *
 * moveCatalogRow separates two populations by ONE question: did the caller ASK
 * to change the product? A FOLD (renumber, parallel fix) asks for nothing and
 * its destination stem must equal the row's own; a RENAME names the product it
 * is moving to and is allowed to land there. A curated list states the whole
 * destination slug, so it answers that question by construction: when the
 * destination's stem differs from the id's, this entry IS a rename and must
 * say so. Returning `{}` for a same-stem move keeps every fold on the strict
 * path, unchanged.
 *
 * Nothing is invented here -- the key is read off the destination the list
 * author wrote, never re-derived from setName, and the market guard still has
 * to agree before it is used.
 */
function crossProductFields(id, to) {
  const from = idSetKey(id);
  const dest = idSetKey(to);
  return dest && from && dest !== from ? { setKey: dest } : {};
}

function occupiedByDifferentCard(incumbent, row) {
  if (!incumbent) return false;
  const name = (r) => String(r?.playerName ?? "").trim().toLowerCase();
  const a = name(incumbent);
  const b = name(row);
  // An unnamed side cannot be adjudicated either way. Blank is unknown, never
  // "the same", so an unnamed incumbent is treated as a different card and
  // refused -- the safe direction for a delete-bearing lane.
  if (!a || !b) return true;
  return a !== b;
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const {
    moveCatalogRow, retireCatalogRow,
  } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { marketVerdict } = require(path.join(__dirname, "lib", "market-guard.cjs"));

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
  console.log(`excluded by the audit   ${f((doc.excluded || []).length)}   <- deliberately NOT touched`);
  for (const r of doc.rulings || []) console.log(`  ruling: ${r}`);
  console.log("");

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
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
  const rowAt = async (slug) => {
    try { return (await retry(() => cat.item(slug, slug).read())).resource ?? null; }
    catch (err) { if (err?.code === 404 || err?.statusCode === 404) return null; throw err; }
  };
  // How many sales point at a slug. Printed for a retire so the size of the
  // hand-off to the rematch is visible BEFORE the apply.
  const salesAt = async (slug) => {
    try {
      const { resources } = await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s",
        parameters: [{ name: "@s", value: slug }],
      }, { maxItemCount: 1 }).fetchAll());
      return Number(resources[0] ?? 0) || 0;
    } catch { return null; }
  };

  let retired = 0, resluged = 0, alreadyRight = 0, notFound = 0, failed = 0;
  let refusedOccupied = 0, salesUnplaced = 0, salesRepointed = 0, gradedRetired = 0;
  let refusedCrossMarket = 0;
  const intended = entries.length;

  for (const e of entries) {
    const c = classifyEntry(e);
    if (!c.ok) { failed++; console.error(`  MALFORMED — ${c.why}`); continue; }
    const { id, action, to, reason } = c;
    const evidence = String(e.evidence ?? "").trim();

    const row = await rowAt(id);
    if (!row) {
      // Already gone is the target state for a retire, and it is a SKIP, not a
      // success: a re-run must not inflate the written count.
      alreadyRight += action === "retire" ? 1 : 0;
      notFound += action === "retire" ? 0 : 1;
      console.log(`  NOT FOUND  ${id.slice(0, 70)}`);
      continue;
    }

    if (action === "retire") {
      const pointing = await salesAt(id);
      console.log(`  RETIRE  ${id.slice(0, 70)}`);
      console.log(`      ${String(row.playerName ?? "(no player)")} — ${String(row.setName ?? "")}`.slice(0, 100));
      console.log(`      reason: ${reason.slice(0, 90)}`);
      if (evidence) console.log(`      evidence: ${evidence.slice(0, 90)}`);
      console.log(`      sales pointing here: ${pointing === null ? "unknown" : f(pointing)}   <- become UNPLACED, the rematch owns them`);
      if (pointing) salesUnplaced += pointing;
      if (!APPLY) { retired++; continue; }
      try {
        const res = await retireCatalogRow(cat, id, row.cardId ?? id, reason, { retry });
        gradedRetired += res?.gradedChildrenRetired ?? 0;
        // VERIFY BY READ. The delete is not believed on its own word.
        if (await rowAt(id)) {
          failed++;
          console.error("      FAILED: the row is still readable after the retire");
        } else retired++;
      } catch (err) {
        failed++;
        console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 80)}`);
      }
      continue;
    }

    // ── RESLUG ────────────────────────────────────────────────────────────
    const incumbent = await rowAt(to);
    if (occupiedByDifferentCard(incumbent, row)) {
      refusedOccupied++;
      console.error(`  REFUSED (occupied)  ${id.slice(0, 62)}`);
      console.error(`      -> ${to.slice(0, 70)}`);
      console.error(`      held by ${String(incumbent.playerName ?? "(unnamed)")}, moving ${String(row.playerName ?? "(unnamed)")}`);
      console.error("      an occupied address is a COLLISION to report, never to route around");
      continue;
    }
    console.log(`  RESLUG  ${id.slice(0, 62)}`);
    console.log(`      ->  ${to.slice(0, 70)}`);
    console.log(`      ${String(row.playerName ?? "(no player)")} — reason: ${reason.slice(0, 70)}`);
    if (evidence) console.log(`      evidence: ${evidence.slice(0, 90)}`);

    // THE DESTINATION NAMES THE PRODUCT. When `to` stems from a different
    // setKey than the row's id, this entry is a RENAME, and moveCatalogRow
    // refuses a product change nobody asked for -- so ASK, with the key the
    // list itself spelled. Silence here is what failed all 91 Japanese 151
    // rows on 2026-09-06: `{}` means "same product, new address", the
    // destination said sv2a, the id said 151, and buildIncoming threw.
    // A same-product move (a fold: renumber, parallel fix) still passes
    // nothing, so the stem must equal the old one -- that guard is untouched.
    const changed = crossProductFields(id, to);

    // ...AND THE MARKET GUARD VALIDATES IT. Honouring the list is not trusting
    // it blindly: a destination whose market contradicts the ROW's market is
    // refused before any derivation. sv2a is JA and these rows' setName says
    // Japanese, so this passes -- and an EN destination for a JA row never
    // would. Both sides must speak and disagree; silence never invents a
    // refusal (market-guard.cjs).
    const verdict = marketVerdict(row, changed.setKey ?? idSetKey(to), row.sport);
    if (!verdict.allowed) {
      refusedCrossMarket++;
      console.error(`  REFUSED (cross-market)  ${id.slice(0, 62)}`);
      console.error(`      -> ${to.slice(0, 70)}`);
      console.error(`      the row's market is ${verdict.rowMarket}, the destination's is ${verdict.toMarket}`);
      console.error("      a JA row may never land on an EN key, or the reverse");
      continue;
    }

    // ONE DERIVATION FOR BOTH PATHS. The report does NOT count a success it
    // never computed: it runs the SAME moveCatalogRow with dryRun, which
    // reads everything, runs buildIncoming and the survivor choice, and
    // writes nothing. A report that cannot predict its apply is the defect
    // -- report-first is only safe when report and apply share the
    // derivation. Only the write and the verify-by-read differ below.
    try {
      const res = await moveCatalogRow(cat, row, to, changed, {
        reason, dryRun: !APPLY, salesContainer: pool, known: incumbent, retry,
      });
      if (res?.action === "refused") {
        failed++;
        console.error(`      FAILED: ${String(res?.decision ?? "refused").slice(0, 80)}`);
        continue;
      }
      if (!APPLY) { resluged++; continue; }
      salesRepointed += res?.salesRepointed ?? 0;
      gradedRetired += res?.gradedChildrenRetired ?? 0;
      // VERIFY BY READ: the destination exists and the source is gone.
      const landed = await rowAt(to);
      const sourceGone = !(await rowAt(id));
      if (landed && sourceGone) resluged++;
      else {
        failed++;
        console.error(`      FAILED: landed=${Boolean(landed)} sourceVacated=${sourceGone} (action ${res?.action})`);
      }
    } catch (err) {
      failed++;
      console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope        ${f(intended)}`);
  console.log(`  RETIRED (deleted)       ${f(retired)}   <- deleted; a soft label does NOT stop a catalog row resolving`);
  console.log(`  RESLUGGED (moved)       ${f(resluged)}`);
  console.log(`  refused — occupied      ${f(refusedOccupied)}   <- a different card holds the target address`);
  console.log(`  refused — cross-market  ${f(refusedCrossMarket)}   <- a JA row may never land on an EN key, or the reverse`);
  console.log(`  already gone            ${f(alreadyRight)}`);
  console.log(`  not found               ${f(notFound)}`);
  console.log(`  failed                  ${f(failed)}`);
  console.log(`  sales made UNPLACED     ${f(salesUnplaced)}   <- the rematch owns these`);
  console.log(`  sales re-pointed        ${f(salesRepointed)}`);
  console.log(`  graded children retired ${f(gradedRetired)}`);
  // RECONCILE IN BOTH MODES. A report that cannot account for its own entries
  // is not a report worth reading, and the apply's arithmetic must have been
  // seen once before it runs.
  const written = retired + resluged;
  const skipped = alreadyRight + notFound;
  const refused = refusedOccupied + refusedCrossMarket;
  console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)} `
    + `+ refused ${f(refused)} + failed ${f(failed)}`);
  if (written + skipped + refused + failed !== intended) {
    console.error("  !! RECONCILE MISMATCH — an entry was neither written, skipped, refused nor failed");
    process.exitCode = 4;
  }
  if (APPLY) {
    reportWrites({
      job: "relocate-catalog-rows-by-list", intended,
      written, skipped, failed: failed + refused,
    });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}

module.exports = { SCOPE, APPLY, classifyEntry, occupiedByDifferentCard, crossProductFields, idSetKey };
