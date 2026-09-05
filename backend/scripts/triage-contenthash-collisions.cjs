#!/usr/bin/env node
/**
 * triage-contenthash-collisions.cjs -- D30's refusal, given a name.
 *
 * THE PROBLEM THIS EXISTS FOR. D30's contentHash pre-flight is a COUNT. The
 * eight football shards (2024, SCOPE=refractor, slots 0..7/8) all refused:
 * 278 collisions in 103 groups, and not one of them named. A count cannot
 * unblock a fold. It cannot say whether those 278 are the same sale ingested
 * twice -- which we should exclude -- or two different cards that a retracted
 * normalization rule squashed together, which we must MOVE APART and never
 * touch with a dedup. Guessing wrong in either direction is unrecoverable in
 * one of them: exclude two distinct cards' sales and the pool loses real
 * sales; fold two copies of one sale and every FMV built on that pool
 * double-counts it.
 *
 * So this script re-derives the population D30 refuses over -- the same
 * groupKeyOf grouping, the same shardOfIdentity axis, the same salesUnder()
 * width, the same contentHashOf against the WINNER's partition -- and emits one
 * classified line per collision group. It is the report that unblocks the folds.
 *
 * -- TWO POPULATIONS, LABELLED HONESTLY (D7) --------------------------------
 *
 * An earlier build claimed to triage "EXACTLY the population D30 refuses over"
 * and did not. It iterated EVERY multi-row identity group, while D30's plan
 * filters each group through `kindInMode`, the D23 rename-owned skip, the
 * mid-rename address check and `decideDuplicateGroup` -- most groups never reach
 * D30's pre-flight at all. And it bucketed on the LEGACY hash, which D30's
 * pre-flight never computes. Both differences widen the report, which is the
 * safe direction, but a number that cannot be reconciled against the 278/103
 * cannot unblock the thing that refused with 278/103.
 *
 * So the report now names both, and they are counted separately:
 *
 *   D30-REFUSAL SET     the groups D30's OWN plan would reach, under the same
 *                       MODE (D30_MODE, default `all` -- what the eight football
 *                       shards dispatched), through the same skips and the same
 *                       decideDuplicateGroup ruling, bucketed on the FRESH hash
 *                       only, exactly as `preflightHashCollisions` does. THIS is
 *                       the number that reconciles against the fold's refusal.
 *
 *   FULL COLLISION SET  every multi-row group, legacy hashes included. Wider by
 *                       construction, and the only place the DISTINCT-CARDS
 *                       population is visible at all -- those rows collide ONLY
 *                       on the pre-D31 hash, so the fresh-hash-only refusal set
 *                       contains none of them.
 *
 * The compound consequence, stated plainly: relocating DISTINCT-CARDS rows
 * CANNOT lower the 278, because D30 never counted them. Only flagging
 * TRUE-DUPEs lowers it -- and only once D30's `salesUnder` stops counting
 * flagged rows, which is the D5 fix in consolidate-catalog-duplicates.cjs.
 *
 * READ-ONLY BY CONSTRUCTION in its default mode. `MODE=report` (the default)
 * has no write path at all. `MODE=apply-true-dupes` writes exactly one thing:
 * flaggedWrong=true plus provenance, on rows this script itself PROVED are the
 * same physical sale. DISTINCT-CARDS and AMBIGUOUS are never auto-acted on.
 *
 * -- WHY A FLAG AND NOT A DELETE -------------------------------------------
 *
 * The pool is the moat: a sale, once deleted, is gone, and its vendor may never
 * re-emit it. Exclusion is achieved with flaggedWrong=true, which every FMV read
 * path already filters (canonicalFmv.service.ts:1073,:1292; marketMovers,
 * playerDetail, priceSeries, setDetail and verifyQueue routes; cohortBacktest).
 * The row stays readable, the mark is auditable through `dedupSupersededBy` /
 * `dedupReason` / `dedupAt`, and a wrong ruling is reversible by clearing one
 * boolean. `supersededBy` is NOT a field sold_comps has and this does not
 * invent one -- a new filter surface would have to be threaded through every
 * one of those read paths before it excluded anything at all.
 *
 * KNOWN RESIDUAL RISK -- CLOSED 2026-09-01. Recorded here because this script
 * is what mass-produces flagged rows, and the hazard was real until the fix.
 *
 * The disclosure said: "Every FMV READ path filters it" is true, but the
 * pre-write INGEST dedup is not a read path and does NOT filter it --
 * soldCompsStore.service.ts:1495 and persistVendorSalesToPool.service.ts:1081
 * both queried contentHash with no flaggedWrong predicate, and
 * scoreForCanonical never read the flag. So a row this script flagged could
 * (a) outscore and silently drop a genuine later sale colliding on the full
 * contentHash, or (b) be HARD DELETED when that later sale outscored it --
 * losing the provenance trail this script wrote.
 *
 * BOTH ARE FIXED. Both ingest queries now carry
 * `(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)`, and
 * scoreForCanonical subtracts a floor-clearing 1000 from a flagged row so it
 * ranks below every live one. A flagged row is no longer a dedup partner for a
 * live incoming sale in either direction. Deliberate exception: a flagged
 * INCOMING doc (cardsight $0.99 / outlier guards) still dedups against flagged
 * rows, or those guards would resurrect the duplicates they suppress.
 * Pinned in backend/tests/ingestFlaggedDedupProtection.test.ts.
 *
 * The precondition on running apply-true-dupes broadly is therefore MET: the
 * ingest queries were the blocker, and they are fixed. That fix is backend/src
 * and reaches prod only on the "Daily 5AM ET Refresh & Deploy" dispatch --
 * confirm the deployed /api/health shaShort carries it before a corpus-wide
 * apply, not merely that the PR merged.
 *
 * -- THE THREE CLASSES ------------------------------------------------------
 *
 * The rule itself lives in scripts/lib/collision-triage.cjs so the tests pin
 * the code that runs. In short: TRUE-DUPE needs positive proof of SAMENESS (a
 * shared sourceExternalId -- the eBay item id, half of the doc id
 * `{source}::{sourceExternalId}`); DISTINCT-CARDS needs positive proof of
 * DIFFERENCE (external ids differ AND a raw identity axis differs, e.g. the
 * `Uncommon` / `Uncommon Refractor` pair the retracted " Refractor" strip
 * squashed); anything else is AMBIGUOUS and goes to Drew.
 *
 * Env: COSMOS_CONNECTION_STRING; SPORTS/SPORT, YEARS, SCOPE (the same scope
 *      refusal D30 has -- a whole-catalog triage must be asked for by name);
 *      SLOT/SLOTS (the same hash-of-identity axis, so slot N here reads slot
 *      N's groups there); MODE=report|apply-true-dupes; BACKFILL_APPLY=true
 *      (the runner exports BACKFILL_APPLY, not APPLY) is required ON TOP of
 *      MODE=apply-true-dupes before anything is written; RUN_MINUTES=140;
 *      LIMIT=0; TRIAGE_OUT (default data/contenthash-collision-triage.json).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// -- THE SCOPE REFUSAL RUNS FIRST, ABOVE EVERY require() THAT CAN THROW ------
// Copied in SHAPE from consolidate-catalog-duplicates on purpose (#1565): with
// a stale or absent dist/, a refusal placed below the requires is unreachable
// and the job dies on a MODULE_NOT_FOUND that merely LOOKS like a refusal. This
// script reads the whole catalog if you let it, so it must say its own name.
const SPORTS = String(process.env.SPORTS || process.env.SPORT || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
if (!SPORTS.length && !YEARS.length && SCOPE !== "all") {
  console.error("FATAL: no SPORTS and no YEARS. This would triage the ENTIRE catalog.");
  console.error("       Pass SPORTS=football and/or YEARS=2024,2025,... , or SCOPE=all to mean it.");
  process.exit(1);
}
// SCOPE IS NOT A FILTER HERE, AND IT NEVER WAS IN D30 EITHER (D7).
//
// In both scripts SCOPE is only ever tested `!== "all"`, as the escape hatch
// above. Nothing narrows on it: the catalog query filters on SPORTS and YEARS
// and nothing else. So the eight football shards dispatched with
// `-f scope=refractor` were NOT scoped to refractors -- that value narrowed
// nothing there, and would narrow nothing here.
//
// A value that is silently ignored is worse than one that is rejected: it makes
// the run's own banner a lie, and the 278 gets attributed to a slice it was
// never measured on. So an unrecognised SCOPE is a REFUSAL, and it names the
// axes that do work.
if (SCOPE && SCOPE !== "all") {
  console.error(`FATAL: SCOPE="${SCOPE}" cannot narrow anything -- this script has no scope filter.`);
  console.error(`       SCOPE is read for one purpose only: SCOPE=all means "yes, the whole catalog".`);
  console.error(`       The axes that DO narrow a run are SPORTS, YEARS and SLOT/SLOTS.`);
  console.error(`       (consolidate-catalog-duplicates is the same: its SCOPE=refractor narrowed nothing.)`);
  if (SCOPE === "refractor") {
    console.error(``);
    console.error(`       You have almost certainly INHERITED this value rather than chosen it: the`);
    console.error(`       backfill-runner's \`scope\` input DEFAULTS to "refractor". That default is why`);
    console.error(`       the eight football shards were dispatched with -f scope=refractor and why the`);
    console.error(`       278 was never actually measured on a refractor-only slice.`);
    console.error(`       Re-dispatch with -f scope=all and narrow with -f sports / -f years / -f slot.`);
  }
  process.exit(1);
}

const MODES = ["report", "apply-true-dupes"];
const MODE = String(process.env.MODE || "report").trim().toLowerCase();
if (!MODES.includes(MODE)) {
  console.error(`FATAL: MODE="${MODE}" is not one of: ${MODES.join(", ")}`);
  console.error("       report            classify every collision, write nothing (default)");
  console.error("       apply-true-dupes  additionally flag the TRUE-DUPE rows this run proved");
  process.exit(1);
}

// WHICH D30 MODE'S REFUSAL SET TO REPLICATE. This script's own MODE selects
// report-vs-write; D30's MODE selects which KINDS of duplicate group it folds,
// and the two spaces are disjoint. So the replication reads its own env var,
// defaulting to `all` -- which is what the eight football shards ran, since
// they passed no mode and D30 defaults to `all`.
//
// Deliberately NOT a workflow_dispatch input: the runner is at 24/25 and this
// is a report-shaping knob, not a scope. The default reproduces the fleet.
const D30_MODES = ["all", "colour", "spelling", "numbered", "no-auto-ghost", "setkey", "cpa"];
const D30_MODE = String(process.env.D30_MODE || "all").trim().toLowerCase();
if (!D30_MODES.includes(D30_MODE)) {
  console.error(`FATAL: D30_MODE="${D30_MODE}" is not one of: ${D30_MODES.join(", ")}`);
  console.error("       This selects which of D30's kinds the REFUSAL SET replicates.");
  process.exit(1);
}

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const D = (...p) => require(path.join(backend, "dist", ...p));
const { shardOfIdentity, DEFAULT_FORCE_AUTO_PREFIXES, printRunOf, cleanParallelSlug } = D("services", "catalog", "foldTwinRuleChecklistNumbered.js");
// The REFUSAL-SET replication imports D30's own rule functions rather than
// re-deriving them. A local copy of `kindOf` or of the fold decision would
// replicate a population that merely resembles D30's, which is the exact defect
// this deliverable exists to fix.
const {
  groupKeyOf, decideDuplicateGroup, isRenameOwnedProduct, colourFormOf, isCpaCollapseRow,
} = D("services", "catalog", "duplicateWinnerRule.js");
const { catalogAuthorityOf } = D("services", "catalog", "catalogAuthority.service.js");
const { reportWrites } = D("services", "ops", "writeReconciliation.js");
const { contentHashOf, legacyContentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
const { classifyCollision, decideRelocationBasis } = require(path.join(backend, "scripts", "lib", "collision-triage.cjs"));
const isChecklistSource = (source) => catalogAuthorityOf(String(source ?? "")) === "checklist";

// BACKFILL_APPLY alone is NOT enough: the write mode must ALSO be named. A
// runner dispatch that carries apply=true for some other lane cannot turn a
// report into a write by accident.
const APPLY = (process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true") && MODE === "apply-true-dupes";
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "triage-contenthash-collisions" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const RUN_MS = RUN_MINUTES * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const TRIAGE_OUT = String(process.env.TRIAGE_OUT || path.join(backend, "data", "contenthash-collision-triage.json"));
// The SAME force-auto prefixes D30 groups with. A different list here would put
// a card in a different group than the fold does, and triage a population that
// is not the one that refused.
const FORCE_AUTO_PREFIXES = String(process.env.FORCE_AUTO_PREFIXES || DEFAULT_FORCE_AUTO_PREFIXES.join(","))
  .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);

const f = (n) => Number(n ?? 0).toLocaleString();
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const short = (s, n = 70) => String(s ?? "").slice(0, n);

/**
 * Every pool row under a slug -- the exact key AND the keys that extend it
 * (`:num-N`, a grade segment). The same width D30's pre-flight probes, because
 * a narrower read would triage a different population than the one that
 * refused. READ ONLY. The projection carries sourceExternalId and the raw
 * identity fields, which the pre-flight's own projection does not need but the
 * CLASSIFICATION cannot work without.
 */
async function salesUnder(pool, slug) {
  const out = [];
  const it = pool.items.query(
    {
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.sourceExternalId, c.title,
                     c.parallel, c.cardNumber, c.price, c.soldAt, c.observedAt,
                     c.gradeCompany, c.gradeValue, c.isAuto, c.printRun, c.playerName,
                     c.setName, c.cardYear, c.sport, c.team, c.imageUrl, c.normalizedSetKey,
                     c.verifiedByUser, c.flaggedWrong
              FROM c WHERE c.hobbyiqCardId = @s OR STARTSWITH(c.hobbyiqCardId, @p)`,
      parameters: [{ name: "@s", value: slug }, { name: "@p", value: `${slug}:` }],
    },
    { maxItemCount: 200 },
  );
  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources ?? []) out.push(row);
  }
  return out;
}

/**
 * D30's `kindOf`, imported-by-parts rather than re-invented. Kept byte-faithful
 * to consolidate-catalog-duplicates.cjs:166 -- if that rule changes, THIS is the
 * copy that must change with it, and the contract test asserts both spell the
 * same kinds.
 */
function kindOf(rows) {
  const clean = [...new Set(rows.map((r) => cleanParallelSlug(r.parallelSlug)))];
  const setKeys = [...new Set(rows.map((r) => String(r.setKey ?? "").toLowerCase()))];
  const idSetKeys = [...new Set(rows.map((r) => String(r.id ?? "").split(":")[3] ?? ""))];
  const runs = [...new Set(rows.map((r) => printRunOf(r)))];
  if (setKeys.length > 1 || idSetKeys.length > 1) {
    if (rows.some((r) => isCpaCollapseRow(r))) return "cross-product-cpa";
    return "id-setkey-drift";
  }
  if (rows.some((r) => r.isAuto !== true) && rows.some((r) => r.isAuto === true)) return "no-auto-ghost";
  if (runs.includes(null) && runs.some((n) => n !== null)) return "numbered-vs-unnumbered";
  if (clean.length > 1) {
    const bases = [...new Set(clean.map((s) => colourFormOf(s).base))];
    if (bases.length === 1 && clean.some((s) => colourFormOf(s).finish)) return "colour-vs-colour-refractor";
    if (clean.some((s) => /superfractor/.test(s))) return "superfractor-spelling";
    if (clean.some((s) => /^base-/.test(String(s)))) return "base-glue";
    if (clean.some((s) => /refractor/.test(s))) return "refractor-spelling";
    return "hyphen-spelling";
  }
  return "other";
}

/** D30's `kindInMode`, against D30_MODE rather than this script's own MODE. */
function kindInD30Mode(kind) {
  if (D30_MODE === "all") return true;
  switch (D30_MODE) {
    case "colour": return kind === "colour-vs-colour-refractor";
    case "spelling": return ["refractor-spelling", "superfractor-spelling", "base-glue", "hyphen-spelling", "true-colour"].includes(kind);
    case "numbered": return kind === "numbered-vs-unnumbered";
    case "no-auto-ghost": return kind === "no-auto-ghost";
    case "setkey": return kind === "id-setkey-drift";
    case "cpa": return kind === "cross-product-cpa" || kind === "id-setkey-drift";
    default: return false;
  }
}

/**
 * WOULD D30'S PLAN REACH THIS GROUP? (D7)
 *
 * Replicates consolidate-catalog-duplicates.cjs:356-462 in order -- the kind
 * filter, the D23 rename-owned skip, the fold decision, and the mid-rename
 * address check -- and returns the winner D30 would hash against, or the reason
 * it never reaches the pre-flight.
 *
 * `rulings` is deliberately EMPTY here. D30 loads Drew's holding-identity
 * rulings to REFUSE folds that would retire a ruled id; a ruling can only
 * REMOVE a group from D30's plan, never add one, so an empty set makes this
 * replication a superset of D30's own and the refusal count a ceiling rather
 * than an undercount. Erring wide is the safe direction for a number whose job
 * is to say "the fold is still blocked".
 */
function d30PlanReach(rows) {
  const kind = kindOf(rows);
  if (!kindInD30Mode(kind)) return { reached: false, kind, why: "out-of-mode" };
  if (kind === "id-setkey-drift" && rows.some((r) => isRenameOwnedProduct(r.setKey))) {
    return { reached: false, kind, why: "d23-rename-owned" };
  }
  const decision = decideDuplicateGroup({ rows, rulings: [], forceAutoPrefixes: FORCE_AUTO_PREFIXES });
  if (decision.kind === "not-a-group") return { reached: false, kind, why: `not-a-group:${decision.why}` };
  if (decision.kind === "ambiguous") return { reached: false, kind, why: `ambiguous:${decision.why}` };

  const { winner, losers } = decision;
  const midRename = [winner, ...losers].some((r) => {
    const seg = String(r.id ?? "").split(":")[3] ?? "";
    const field = String(r.setKey ?? "").trim().toLowerCase();
    return field !== "" && seg !== "" && seg !== field;
  });
  if (midRename) return { reached: false, kind, why: "mid-rename-address" };

  return { reached: true, kind, winner, losers };
}

/** The one write this script can make: exclude a row, and say why, reversibly.
 *  ONLY-IMPROVE -- a row already flagged is never unflagged and never
 *  re-stamped, so a re-run cannot overwrite an earlier (possibly human) reason. */
async function flagSuperseded(pool, row, survivingId, reason) {
  if (row.flaggedWrong === true) return "already-flagged";
  await retry(() => pool.item(row.id, row.cardId).patch([
    { op: "set", path: "/flaggedWrong", value: true },
    { op: "set", path: "/flaggedReason", value: "dedup-superseded" },
    { op: "set", path: "/dedupSupersededBy", value: String(survivingId) },
    { op: "set", path: "/dedupReason", value: String(reason) },
    { op: "set", path: "/dedupAt", value: new Date().toISOString() },
  ]));
  return "flagged";
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");

  console.log(`triage-contenthash-collisions  MODE=${MODE}  ${APPLY ? "APPLY (TRUE-DUPE flags only)" : "REPORT ONLY -- nothing is written"}`);
  console.log(`  scope        sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}  years=${YEARS.length ? YEARS.join(",") : "(all)"}${SCOPE === "all" ? "  SCOPE=all" : ""}`);
  console.log(`               SCOPE narrows NOTHING in this script or in D30 -- SPORTS/YEARS/SLOT are the axes that do. A non-'all' SCOPE is refused, not ignored.`);
  console.log(`  shard        slot ${SLOT}/${SLOTS}  on hash(groupKey) -- the SAME axis D30 shards on, so slot N here reads slot N's groups there`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget       ${RUN_MINUTES}m`);
  console.log(`  populations  (a) D30-REFUSAL SET [D30_MODE=${D30_MODE}] -- D30's own plan, fresh hash, live rows: reconciles against the fold's refusal`);
  console.log(`               (b) FULL COLLISION SET -- every multi-row group, legacy hashes included: wider, and where DISTINCT-CARDS lives`);
  console.log(`  classes      TRUE-DUPE (shared id, identity agrees -- the ONLY auto-flagged class) | CONFLICTED-DUPE (shared id, identity DISAGREES -> Drew)`);
  console.log(`               DISTINCT-CARDS (ids differ + identity differs -> D31 relocation) | AMBIGUOUS (neither proof -> Drew)`);
  if (MODE === "apply-true-dupes" && !APPLY) console.log(`  NOTE         MODE=apply-true-dupes but BACKFILL_APPLY is not true -- this is still a report.`);

  // -- pass 1: the same grouping D30 does ------------------------------------
  const where = ['STARTSWITH(c.id, "hiq:")', "NOT IS_DEFINED(c.gradeTier)"];
  const params = [];
  if (SPORTS.length) { where.push("ARRAY_CONTAINS(@sports, c.sport)"); params.push({ name: "@sports", value: SPORTS }); }
  if (YEARS.length) { where.push("ARRAY_CONTAINS(@years, c.year)"); params.push({ name: "@years", value: YEARS }); }
  const q = {
    query: `SELECT c.id, c.cardId, c.source, c.sport, c.year, c.setKey, c.cardNumber, c.parallelSlug, c.isAuto, c.printRun, c.playerName FROM c WHERE ${where.join(" AND ")}`,
    parameters: params,
  };

  const groups = new Map();
  let rowsRead = 0, rowsOtherShard = 0;
  {
    const it = cat.items.query(q, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        rowsRead++;
        const key = groupKeyOf(r, FORCE_AUTO_PREFIXES);
        if (SLOTS > 1 && shardOfIdentity(key, SLOTS, sha1) !== SLOT) { rowsOtherShard++; continue; }
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
    }
  }
  console.log(`\n  pass 1: ${f(rowsRead)} non-graded rows read; ${f(rowsOtherShard)} on other slots; ${f(groups.size)} identity groups here`);

  // -- pass 2: re-derive the collisions, and CLASSIFY each one ---------------
  // The partition the rows are HASHED against is not a ruling. Every row in the
  // group lands in the same one, so any stable choice leaves the set of
  // colliding rows identical -- the longest id is used, and where D30's own plan
  // reaches this group its winner is used instead, so the refusal set hashes
  // against exactly the partition the fold would create.
  //
  // Naming a RELOCATION DESTINATION is a different question, and the longest id
  // is not an answer to it. See `decideRelocationBasis` (D6).
  const stats = { groups: 0, multiRow: 0, groupsWithCollisions: 0, collisions: 0, salesProbed: 0, notReached: 0,
    trueDupe: 0, conflictedDupe: 0, distinctCards: 0, ambiguous: 0, rowsToFlag: 0, rowsToRelocate: 0, legacyOnly: 0,
    flagged: 0, alreadyFlagged: 0, flagFailed: 0,
    // D7: the D30-REFUSAL SET, counted separately and reconcilable against the
    // fold's own 278/103. Every one of these is computed the way
    // preflightHashCollisions computes it: D30's plan, the fresh hash only, and
    // -- since the D5 fix -- live rows only.
    d30Planned: 0, d30Collisions: 0, d30GroupsWithCollisions: 0, d30FlaggedExcluded: 0 };
  const d30Unreached = new Map();
  const byReason = new Map();
  const findings = [];
  let stopReason = null;

  let gi = 0;
  for (const [key, rows] of groups) {
    if (LIMIT && gi >= LIMIT) { stats.notReached += groups.size - gi; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`; stats.notReached += groups.size - gi; break; }
    gi++;
    stats.groups++;
    if (rows.length < 2) continue;
    stats.multiRow++;

    // D7: does D30's OWN plan reach this group? Everything below is measured
    // twice -- once over every multi-row group (the FULL COLLISION SET), once
    // over just these (the D30-REFUSAL SET).
    const reach = d30PlanReach(rows);
    if (reach.reached) stats.d30Planned++;
    else d30Unreached.set(reach.why, (d30Unreached.get(reach.why) ?? 0) + 1);

    const longestId = [...rows].map((r) => String(r.id)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    // Where D30 would fold, hash against the partition D30 would fold ONTO.
    const winnerId = reach.reached ? String(reach.winner.id) : longestId;

    // Hash every sale under every row in the group against the winner's
    // partition. Rows that share a hash are exactly what D30 refuses over.
    //
    // BOTH HASH FORMS ARE PROBED, and the legacy one is why this script exists.
    // D30's pre-flight computes only the fresh `contentHashOf`, in which D31
    // hashes the parallel WHOLE -- so `Uncommon` and `Uncommon Refractor` no
    // longer collide there. But a row STORED before D31 carries the legacy
    // hash, where the trailing " Refractor" was stripped and the two forms
    // hashed identically. Those stored rows are precisely the DISTINCT-CARDS
    // population, and a fresh-hash-only probe cannot see a single one of them.
    // Measured on the pair the doctrine names: legacy collides, fresh does not.
    const byHash = new Map();
    const salesByRow = new Map();
    for (const r of rows) {
      const sales = await salesUnder(pool, String(r.id));
      salesByRow.set(String(r.id), sales);
      for (const sale of sales) {
        stats.salesProbed++;
        const at = { ...sale, cardId: winnerId };
        // The legacy form is the SUPERSET: where the two agree it is the same
        // string, so bucketing on it alone finds every collision either form
        // would, and never splits a pair the fresh hash would have joined.
        const h = legacyContentHashOf(at);
        const arr = byHash.get(h) ?? [];
        arr.push({ sale, fresh: contentHashOf(at) });
        byHash.set(h, arr);
      }
    }

    // -- THE D30-REFUSAL SET, replicated exactly (D7) -------------------------
    // preflightHashCollisions seeds a set with the WINNER's own sales, then
    // walks each loser's; a hash already in the set is one collision. The FRESH
    // hash only -- D30 never computes the legacy form -- and, since the D5 fix,
    // LIVE rows only, because a flagged row is resolved and not evidence of an
    // outstanding collision. That last clause is what makes this number FALL
    // after an apply-true-dupes pass; without it the fold refuses identically
    // forever.
    if (reach.reached) {
      const live = (id) => (salesByRow.get(String(id)) ?? []).filter((s) => {
        if (s.flaggedWrong === true) { stats.d30FlaggedExcluded++; return false; }
        return true;
      });
      const seen = new Set();
      let hit = 0;
      for (const s of live(reach.winner.id)) seen.add(contentHashOf({ ...s, cardId: winnerId }));
      for (const loser of reach.losers) {
        for (const s of live(loser.id)) {
          const h = contentHashOf({ ...s, cardId: winnerId });
          if (seen.has(h)) hit++; else seen.add(h);
        }
      }
      if (hit > 0) { stats.d30Collisions += hit; stats.d30GroupsWithCollisions++; }
    }

    const clusters = [...byHash.entries()].filter(([, arr]) => arr.length > 1);
    if (clusters.length === 0) continue;
    stats.groupsWithCollisions++;

    for (const [hash, entries] of clusters) {
      const cluster = entries.map((e) => e.sale);
      // Does this cluster still collide under the CURRENT hash, or only under
      // the legacy one? "legacy-only" means the rows were written before D31
      // and the fix has already parted them for every FUTURE write -- the
      // stored rows are what remain to be moved.
      const freshForms = new Set(entries.map((e) => e.fresh));
      const era = freshForms.size === 1 ? "current+legacy" : "legacy-only";
      if (era === "legacy-only") stats.legacyOnly++;
      // A cluster of N identical hashes is N-1 collisions, the same arithmetic
      // the pre-flight's seen-set does (the first row seeds, the rest hit).
      stats.collisions += cluster.length - 1;
      const verdict = classifyCollision(cluster);
      const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
      bump(byReason, `${verdict.class}: ${verdict.reason}`);

      const finding = {
        groupKey: key, winnerId, contentHash: hash, hashEra: era, class: verdict.class, reason: verdict.reason,
        // D7: which population is this cluster in? A cluster D30's plan never
        // reaches is real, but it is not part of what the fold refused over.
        inD30RefusalSet: reach.reached && era === "current+legacy",
        d30Unreachable: reach.reached ? null : reach.why,
        rows: cluster.map((r) => ({
          id: r.id, cardId: r.cardId, hobbyiqCardId: r.hobbyiqCardId, source: r.source,
          sourceExternalId: r.sourceExternalId ?? null, title: r.title ?? null,
          parallel: r.parallel ?? null, cardNumber: r.cardNumber ?? null,
          gradeCompany: r.gradeCompany ?? null, gradeValue: r.gradeValue ?? null,
          isAuto: r.isAuto ?? null, printRun: r.printRun ?? null,
          price: r.price, soldAt: r.soldAt, flaggedWrong: r.flaggedWrong === true,
        })),
      };

      console.log(`\n  [${verdict.class}] ${key}`);
      console.log(`    partition ${winnerId}`);
      console.log(`    hash      ${hash}   (${cluster.length} rows -> ${cluster.length - 1} collision(s))  [${era}]`);
      console.log(`    why       ${verdict.reason}`);
      console.log(`    set       ${finding.inD30RefusalSet ? "D30-REFUSAL SET (this one blocks the fold)" : `FULL COLLISION SET only (${reach.reached ? "legacy-only hash — D30 never computes it" : `D30 skips this group: ${reach.why}`})`}`);

      if (verdict.class === "TRUE-DUPE") {
        stats.trueDupe++;
        stats.rowsToFlag += verdict.flag.length;
        finding.survivorId = verdict.survivor?.id ?? null;
        finding.flagIds = verdict.flag.map((r) => r.id);
        finding.sharedExternalIds = verdict.sharedIds ?? [];
        console.log(`    SURVIVOR  ${verdict.survivor?.id}  [${verdict.survivor?.source}]  ext=${verdict.survivor?.sourceExternalId}`);
        console.log(`              "${short(verdict.survivor?.title)}"  $${verdict.survivor?.price}  ${verdict.survivor?.soldAt}`);
        for (const r of verdict.flag) {
          console.log(`    FLAG      ${r.id}  [${r.source}]  ext=${r.sourceExternalId}`);
          console.log(`              "${short(r.title)}"  $${r.price}  ${r.soldAt}${r.flaggedWrong === true ? "   (already flagged)" : ""}`);
        }
      } else if (verdict.class === "CONFLICTED-DUPE") {
        // D1. A shared item id says one listing; a differing cardNumber or
        // parallel says two cards. One ingester filed this sale against the
        // WRONG CARD, and that is a matcher finding -- auto-flagging the loser
        // would bury it under a `dedup-superseded` mark and leave the survivor
        // on whichever card happened to be richer.
        stats.conflictedDupe++;
        finding.axes = verdict.axes;
        finding.sharedExternalIds = verdict.sharedIds ?? [];
        for (const a of verdict.axes) {
          console.log(`    CONFLICTING AXIS  ${a.field}: ${a.values.map((v) => JSON.stringify(v)).join("  vs  ")}`);
        }
        for (const c of verdict.conflicts ?? []) {
          console.log(`    SHARED ITEM ID  ${c.sharedId}  -- one listing, ${c.rows.length} rows that disagree about the card`);
          for (const r of c.rows) {
            console.log(`      ?       ${r.id}  [${r.source}]  #${r.cardNumber ?? "-"}  parallel=${JSON.stringify(r.parallel)}  ${r.gradeCompany ?? "RAW"}${r.gradeValue ?? ""}`);
            console.log(`              "${short(r.title)}"  $${r.price}  ${r.soldAt}`);
          }
        }
        console.log(`    -> WRONG-CARD INGEST, NOT A DUPLICATE. Never auto-flagged; a person rules on which card is right.`);
      } else if (verdict.class === "DISTINCT-CARDS") {
        stats.distinctCards++;
        stats.rowsToRelocate += verdict.relocate.length;
        finding.axes = verdict.axes;
        // D6: the DESTINATION is named by the catalog, not by string length.
        // The checklist-backed row of the group decides; where none is, or where
        // two disagree, no row here has the authority and the answer is
        // UNRESOLVED. Review-only either way -- this names a target for the D31
        // relocation lane and performs nothing.
        const basis = decideRelocationBasis(rows, isChecklistSource);
        finding.destinationBasis = basis;
        console.log(`    BASIS     ${basis.kind}: ${basis.why}`);
        finding.relocate = verdict.relocate.map((r) => ({
          id: r.id, from: r.hobbyiqCardId ?? null, trueSlug: trueSlugOf(r, basis),
        }));
        for (const a of verdict.axes) {
          console.log(`    COLLAPSED AXIS  ${a.field}: ${a.values.map((v) => JSON.stringify(v)).join("  vs  ")}`);
        }
        for (const r of verdict.relocate) {
          console.log(`    RELOCATE  ${r.id}  [${r.source}]  ext=${r.sourceExternalId}`);
          console.log(`              parallel=${JSON.stringify(r.parallel)}  #${r.cardNumber ?? "-"}  $${r.price}  ${r.soldAt}`);
          console.log(`              from ${r.hobbyiqCardId ?? "(none)"}`);
          console.log(`              ->   ${trueSlugOf(r, basis)}   (D31 lane: move, never delete)`);
        }
      } else {
        stats.ambiguous++;
        for (const r of cluster) {
          console.log(`    ?         ${r.id}  [${r.source}]  ext=${r.sourceExternalId}`);
          console.log(`              "${short(r.title)}"  parallel=${JSON.stringify(r.parallel)}  $${r.price}  ${r.soldAt}`);
        }
        console.log(`    -> HUMAN RULING REQUIRED. Never auto-acted on.`);
      }

      findings.push(finding);

      // -- the ONLY write, and only for what THIS run proved ------------------
      if (APPLY && verdict.class === "TRUE-DUPE" && verdict.survivor) {
        for (const r of verdict.flag) {
          try {
            const res = await flagSuperseded(pool, r, verdict.survivor.id, `contenthash-triage:${verdict.reason}`);
            if (res === "flagged") stats.flagged++; else stats.alreadyFlagged++;
          } catch (e) {
            stats.flagFailed++;
            if (stats.flagFailed <= 5) console.log(`    flag failed ${r.id}: ${String(e?.message ?? e).slice(0, 160)}`);
          }
        }
      }
    }
  }

  // -- report ----------------------------------------------------------------
  console.log(`\n${APPLY ? "APPLIED (TRUE-DUPE flags only)" : "REPORT ONLY -- nothing written"}`);
  console.log(`  identity groups examined   ${f(stats.groups)}`);
  console.log(`  of those, multi-row        ${f(stats.multiRow)}`);
  console.log(`  sales probed               ${f(stats.salesProbed)}`);

  // -- POPULATION (a): what D30 ACTUALLY refuses over (D7) -------------------
  console.log(`\n  (a) D30-REFUSAL SET   [D30_MODE=${D30_MODE}]  <- reconcile THIS against the fold's own count`);
  console.log(`      D30's plan reaches       ${f(stats.d30Planned)} group(s) of the ${f(stats.multiRow)} multi-row here`);
  console.log(`      COLLISIONS               ${f(stats.d30Collisions)} in ${f(stats.d30GroupsWithCollisions)} group(s)`);
  console.log(`      flagged rows excluded    ${f(stats.d30FlaggedExcluded)}   <- already resolved; D30's salesUnder now skips them (D5)`);
  if (d30Unreached.size) {
    console.log(`      groups D30's plan SKIPS  ${f(stats.multiRow - stats.d30Planned)}, by reason:`);
    for (const [why, n] of [...d30Unreached.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${String(f(n)).padStart(8)}  ${why}`);
    }
  }

  // -- POPULATION (b): everything that collides at all -----------------------
  console.log(`\n  (b) FULL COLLISION SET   <- every multi-row group, LEGACY hashes included`);
  console.log(`      groups WITH collisions   ${f(stats.groupsWithCollisions)}`);
  console.log(`      COLLISIONS               ${f(stats.collisions)}`);
  console.log(`        of which legacy-only   ${f(stats.legacyOnly)}   <- collide only on the PRE-D31 hash, which D30 NEVER computes`);
  console.log(`  not reached                ${f(stats.notReached)}`);
  console.log(`\n  WHY THE TWO DIFFER: (b) counts groups D30's plan skips entirely, and clusters that`);
  console.log(`  collide only under the legacy hash. Relocating those CANNOT lower (a) -- D30 never`);
  console.log(`  counted them. Only flagging TRUE-DUPEs lowers (a), and only because D30's salesUnder`);
  console.log(`  now excludes flagged rows (D5).`);
  console.log(`\n  BY CLASS (clusters, over the FULL set):`);
  console.log(`    TRUE-DUPE                ${f(stats.trueDupe)}   rows to flag     ${f(stats.rowsToFlag)}`);
  console.log(`    CONFLICTED-DUPE          ${f(stats.conflictedDupe)}   -> Drew   <- shared item id, DISAGREEING identity: a wrong-card ingest, NEVER auto-flagged`);
  console.log(`    DISTINCT-CARDS           ${f(stats.distinctCards)}   rows to relocate ${f(stats.rowsToRelocate)}   <- D31 lane, NEVER flagged`);
  console.log(`    AMBIGUOUS                ${f(stats.ambiguous)}   -> Drew`);
  const clusters = stats.trueDupe + stats.conflictedDupe + stats.distinctCards + stats.ambiguous;
  console.log(`    RECONCILES               ${f(clusters)} clusters classified, every one in exactly one class  ${clusters === findings.length ? "OK" : "MISMATCH"}`);
  console.log(`\n  BY REASON:`);
  for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(6)}  ${reason}`);

  if (MODE === "apply-true-dupes") {
    console.log(`\n  THE WRITE (flaggedWrong -- never a delete; every FMV read path filters it):`);
    console.log(`    flagged                  ${f(stats.flagged)}`);
    console.log(`    already flagged (skip)   ${f(stats.alreadyFlagged)}   <- only-improve: never unflagged, never re-stamped`);
    console.log(`    failed                   ${f(stats.flagFailed)}`);
    console.log(`    reconciled: intended ${f(stats.rowsToFlag)} = written ${f(stats.flagged)} + skipped ${f(stats.alreadyFlagged)} + failed ${f(stats.flagFailed)}`);
  }

  try {
    fs.mkdirSync(path.dirname(TRIAGE_OUT), { recursive: true });
    fs.writeFileSync(TRIAGE_OUT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      scope: { sports: SPORTS, years: YEARS, scope: SCOPE || null, slot: SLOT, slots: SLOTS, mode: MODE, d30Mode: D30_MODE, applied: APPLY },
      populations: {
        d30RefusalSet: { groupsPlanned: stats.d30Planned, collisions: stats.d30Collisions, groupsWithCollisions: stats.d30GroupsWithCollisions, flaggedRowsExcluded: stats.d30FlaggedExcluded, unreachedByReason: Object.fromEntries(d30Unreached) },
        fullCollisionSet: { groupsWithCollisions: stats.groupsWithCollisions, collisions: stats.collisions, legacyOnly: stats.legacyOnly },
      },
      stats, findings,
    }, null, 2));
    console.log(`\n  findings -> ${TRIAGE_OUT}  (${f(findings.length)} cluster(s))`);
  } catch (e) {
    console.log(`\n  could not write ${TRIAGE_OUT}: ${String(e?.message ?? e)}`);
  }

  if (stopReason) console.log(`\n  ${stopReason}`);
  if (APPLY) reportWrites({ job: "triage-contenthash-collisions", intended: stats.rowsToFlag, written: stats.flagged, skipped: stats.alreadyFlagged, failed: stats.flagFailed });

  // The report is the deliverable, so it exits 0 with collisions outstanding --
  // unlike D30, which must refuse. Naming them IS the success condition here.
}

/**
 * The slug a DISTINCT-CARDS row should live at: the BASIS address with the row's
 * OWN raw parallel restored. This NAMES a target for the D31 relocation lane; it
 * does not perform one, and it never mints a catalog row (a sale never mints a
 * row). Where the row already carries a slug that differs from the basis, that
 * slug is the answer and is left alone.
 *
 * D6: the basis comes from `decideRelocationBasis` -- the group's
 * checklist-backed catalog row. It is NOT the longest id string, which is what
 * the first build used and which flipped the printed destination between
 * `...:uncommon:...` and `...:base-uncommon:...` on four characters of length.
 * Where no checklist row can name it, this returns UNRESOLVED rather than
 * inventing an address: a destination nobody can vouch for is worse than an
 * admitted gap, because the D31 lane would act on it.
 */
function trueSlugOf(row, basis) {
  if (!basis || basis.kind !== "checklist-backed" || !basis.basis) {
    return `UNRESOLVED -- checklist ruling needed (${basis?.why ?? "no basis"})`;
  }
  const base = String(basis.basis);
  const own = String(row?.hobbyiqCardId ?? "");
  if (own && own !== base && !own.startsWith(`${base}:`)) return `${own}   (already distinct -- verify against the checklist)`;
  const parallel = String(row?.parallel ?? "").trim();
  if (!parallel) return `${base}   (no raw parallel to distinguish it -- needs a checklist ruling)`;
  const slug = parallel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const segs = base.split(":");
  // hiq:<sport>:<year>:<setKey>:<cardNumber>:<parallel>:<auto> -- replace the
  // parallel segment, which is what the retracted strip collapsed.
  if (segs.length >= 6) { segs[5] = slug; return segs.join(":"); }
  return `${base}#parallel=${slug}`;
}

main().catch((e) => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
