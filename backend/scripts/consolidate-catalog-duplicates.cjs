#!/usr/bin/env node
/**
 * consolidate-catalog-duplicates.cjs -- D30. One card, one row, one pool.
 *
 * Drew, 2026-08-30 09:50Z: "we need to find any duplicate cards in the card
 * catalog and consolidate all sales onto it. This will be a big big big issue
 * for us if sales are split across different cards in the card catalog of the
 * same card." Rulings 12:50Z: one fleet, all kinds in parallel; where two
 * checklist sources spell one card two ways, the majority of checklist sources
 * for that product wins, tie -> the longer form.
 *
 * -- THE POOL RE-KEY IS THE REAL WORK, NOT THE ROW FOLD ----------------------
 *
 * Measured 2026-08-30 19:31Z over baseball 2024-26 + football: 698,294 sales
 * sit on a NON-WINNER row (BB 377,040, FB 321,254) against only 309,461 rows to
 * move and 6 holdings to re-point. A fleet that folds rows correctly and moves
 * sales sloppily has done the easy 30% and broken the pool.
 *
 * -- THREE DEFECTS IN THE MODULES THIS SCRIPT CALLS, ALL MEASURED ------------
 *
 * (1) REACH. `decideChecklistNumberedFold` REFUSES when the twin is itself
 *     checklist authority (skip:"twin-is-checklist") -- by design, that is
 *     cross-source's job. But 65,856 of baseball's 78,560 numbered-vs-unnumbered
 *     groups have BOTH rows checklist: the dominant real shape is
 *     checklistcenter (un-numbered) vs checklistinsider (/75) on 2024
 *     bowman-chrome-sapphire. A thin wrapper over that module would report a
 *     green run reaching ~22% of its own kind -- "refuted only on REACH", the
 *     D29 CPA round-1 outcome. So the cross-checklist case is decided HERE, by
 *     duplicateWinnerRule, and R1 is still called for the population it owns.
 *     `numberedReach` in the report sizes exactly this.
 *
 * (2) SALES LEFT BEHIND. `moveCatalogRow` re-points sales with
 *     `WHERE c.hobbyiqCardId = @s` -- EXACT match on the old id
 *     (catalogRowOps.service.ts:568). Pool keys routinely EXTEND the row id with
 *     `:num-N` and/or a grade segment. Measured on one real loser,
 *     `2025:topps-chrome:105:base:no-auto` has 31 exact-match sales and 9 more
 *     under extending keys -- those 9 would be stranded on a deleted row. So
 *     `salesUnder()` enumerates `id OR STARTSWITH(id + ':')` and attributes each
 *     key to the LONGEST matching row in the group, so a numbered twin's sales
 *     are never stolen from it.
 *
 * (3) PARTITION KEY. `moveCatalogRow` patches /hobbyiqCardId in place, which is
 *     right only while the sale's partition key (/cardId) is not the loser's own
 *     slug. Measured: 474,654 of 1,257,125 2025-baseball pool rows (37.8%) and
 *     332,308 of 2,516,369 football rows (13.2%) carry a hiq slug as cardId.
 *     Those go through relocateSoldComp (upsert -> verify read-back -> delete)
 *     and are counted on their OWN line: `salesRelocated` is different work from
 *     `salesRepointed` and the two are NEVER summed.
 *
 * (3b) THE contentHash HAZARD, refused BEFORE any write (D30-R2). The strip of
 *     a trailing " Refractor" is GONE from computeContentHash and from
 *     relocate-sold-comp -- D31 retracted the rule that made it safe, and with
 *     it in place a `Gold` sale and a `Gold Refractor` sale hashed identically
 *     inside one partition, where the store's pre-write dedup reads that as the
 *     same sale and swallows a real one at ingest.
 *
 *     Collisions can still exist between sales a fold brings together, so they
 *     are counted by a read-only PRE-FLIGHT over the whole plan and APPLY
 *     refuses UP FRONT with zero writes. The first build probed inside the write
 *     loop and refused after it, which wrote the collisions it then refused
 *     over. The seen-set is seeded with the WINNER's own sales; scoping it per
 *     loser made the first build's 530 a floor rather than a count.
 *
 * (3c) ONLY AN UNRESOLVED TRUE DUPE BLOCKS (D30-R3). A hash cluster counts as
 *     BLOCKING only when >= 2 LIVE rows in it share a `sourceExternalId`. Rows
 *     with DISTINCT external ids that merely hash alike are two REAL sales that
 *     happened at one price on one day -- corroborated data, never corruption --
 *     and different sourceExternalId has never meant collapse (af14c29c). They
 *     are printed as a non-blocking `corroborated` count and travel with the
 *     partition like any other row. Measured: after the TRUE-DUPE flagging pass
 *     the football/2024 residual was 729 of exactly that shape, and all eight
 *     slots still refused -- a permanent block with nothing left to triage.
 *     See `clusterIsBlocking` for why the key is the bare external id.
 *
 * (4) THE GROUPING KEY IS D30's OWN (D30-R2). D29's `identityKeyOf` embeds the
 *     RAW setKey field -- right for R1, and pinned by its own tests -- but it
 *     means two SPELLINGS of one product never meet, so MODE=setkey was a no-op
 *     and `cross-product-cpa` was never emitted. `groupKeyOf` normalizes the
 *     PRODUCT and only the product. Measured live: of 62,650 baseball drift
 *     observations ZERO differ in the setKey FIELD -- every one is the D23
 *     rename having renamed the field while the id still reads the old spelling
 *     -- so `kindOf` compares the id segment too, as the measurement does.
 *
 * (5) THE PRE-FLIGHT COUNTS LIVE ROWS ONLY (D5). `salesUnder` now filters
 *     `flaggedWrong != true`. The contentHash triage
 *     (triage-contenthash-collisions.cjs) resolves a collision by PROVING two
 *     rows are one physical sale and marking the loser `flaggedWrong=true` --
 *     the pool's exclusion mark, filtered by every FMV read path, never a
 *     delete. Without the predicate the pre-flight kept hashing and counting the
 *     rows the triage had just resolved, so the eight football shards would have
 *     refused on the SAME 278 after a full apply-true-dupes pass and the unblock
 *     could never unblock anything.
 *
 *     `moveSalesAndRow` is deliberately NOT filtered: the pre-flight asks "what
 *     is still unresolved?", the move asks "what belongs to this card?", and a
 *     flagged row belongs to it. It travels with its partition, flags intact.
 *     See the comment on `moveSalesAndRow` for why leaving it behind would
 *     orphan it and break its provenance trail.
 *
 * -- WHAT THIS SCRIPT DOES NOT DO -------------------------------------------
 *
 * It never re-implements D29. MODE=numbered calls `decideChecklistNumberedFold`
 * for R1's population; MODE=cpa calls `decideCpaProduct`. Print-run conflicts
 * and player-differs are NOT duplicates and are never folded. A sale never
 * mints a row. FMV is never a median.
 *
 * SCOPE narrows NOTHING here -- it is read only as the `SCOPE=all` escape hatch
 * for the no-sports/no-years refusal. The eight football shards' historical
 * `-f scope=refractor` therefore narrowed nothing. SPORTS, YEARS and SLOT/SLOTS
 * are the axes that do.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (report only by
 *      default -- the runner exports BACKFILL_APPLY, not APPLY); SLOT/SLOTS;
 *      RUN_MINUTES=140; SPORTS/SPORT; YEARS; SCOPE=all; MODE=all|colour|
 *      spelling|numbered|no-auto-ghost|setkey|cpa; LIMIT=0; PROBE_SHARDS=true;
 *      AMBIGUOUS_OUT (default data/catalog-duplicates-ambiguous.json).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// -- THE SCOPE REFUSAL RUNS FIRST, BEFORE ANY require() THAT CAN THROW -------
// A whole-scope write must be asked for by name (the MODE=source lesson: it
// defaulted to baseballcardpedia and reported 13.14M rows as a dry run). This
// gate sits ABOVE the @azure/cosmos and dist/ requires ON PURPOSE: with a stale
// or absent `dist`, a refusal below them is unreachable and the job exits on a
// MODULE_NOT_FOUND that merely LOOKS like a refusal (#1565). The scope check
// needs no compiled code, so nothing about the build can decide whether it fires.
const SPORTS = String(process.env.SPORTS || process.env.SPORT || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
if (!SPORTS.length && !YEARS.length && SCOPE !== "all") {
  console.error("FATAL: no SPORTS and no YEARS. This would consolidate the ENTIRE catalog.");
  console.error("       Pass SPORTS=baseball and/or YEARS=2024,2025,... , or SCOPE=all to mean it.");
  process.exit(1);
}

const MODES = ["colour", "spelling", "numbered", "no-auto-ghost", "setkey", "cpa"];
const MODE = String(process.env.MODE || "all").trim().toLowerCase();
if (MODE !== "all" && !MODES.includes(MODE)) {
  console.error(`FATAL: MODE="${MODE}" is not one of: all, ${MODES.join(", ")}`);
  process.exit(1);
}

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const D = (...p) => require(path.join(backend, "dist", ...p));
const { moveCatalogRow, retireCatalogRow, isGradedChildOf } = D("services", "catalog", "catalogRowOps.service.js");
const { catalogAuthorityOf } = D("services", "catalog", "catalogAuthority.service.js");

const {
  printRunOf, shardOfIdentity, decideChecklistNumberedFold,
  pickChecklistNumberedTarget, cleanParallelSlug, DEFAULT_FORCE_AUTO_PREFIXES,
} = D("services", "catalog", "foldTwinRuleChecklistNumbered.js");
const {
  decideDuplicateGroup, isRenameOwnedProduct, colourFormOf, canonicalSpellingOf,
  oneSourceNamesBothColourForms, sourceKeyOf,
  groupKeyOf, groupProductKeyOf, isCpaCollapseRow, ownsPoolKey,
} = D("services", "catalog", "duplicateWinnerRule.js");
const { decideCpaProduct } = D("services", "catalog", "cpaProductRule.js");
const { reportWrites } = D("services", "ops", "writeReconciliation.js");
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "consolidate-catalog-duplicates" });
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
const PROBE_SHARDS = process.env.PROBE_SHARDS === "true";
const PROBE_SLOTS = Number(process.env.PROBE_SLOTS || 8);
const AMBIGUOUS_OUT = String(process.env.AMBIGUOUS_OUT || path.join(backend, "data", "catalog-duplicates-ambiguous.json"));
const AMBIGUOUS_MAX = Number(process.env.AMBIGUOUS_MAX || 20000);
const FORCE_AUTO_PREFIXES = String(process.env.FORCE_AUTO_PREFIXES || DEFAULT_FORCE_AUTO_PREFIXES.join(","))
  .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);

const f = (n) => Number(n).toLocaleString();
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const isChecklist = (source) => catalogAuthorityOf(String(source ?? "")) === "checklist";
const modeOn = (m) => MODE === "all" || MODE === m;

/** Drew's rulings. A fold that would RETIRE a ruled id is reported, never applied. */
function loadRulings() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(backend, "data", "holding-identity-rulings.json"), "utf8"));
    return Array.isArray(doc?.rulings) ? doc.rulings : [];
  } catch { return []; }
}

/**
 * WHICH KIND is this group, for the per-kind counters. Named from the rows, not
 * from the decision, so the dry run can be compared against the measurement's
 * by-kind table (numbered-vs-unnumbered 78,560 BB / 24,087 FB, and so on).
 */
function kindOf(rows) {
  const clean = [...new Set(rows.map((r) => cleanParallelSlug(r.parallelSlug)))];
  // THE DRIFT IS IN THE ID AS OFTEN AS IN THE FIELD, and the measurement counts
  // both: `setKeysRaw.size > 1 || idSetKeys.size > 1` (measure-d31.cjs:443).
  // Measured live 2026-08-30, baseball 2024-26: of 62,650 drift observations
  // ZERO have differing setKey FIELDS -- every one is the D23 rename having
  // renamed the field while the id still reads the old spelling
  // (`topps-206: topps~topps-206`). A kind that looked only at the field would
  // still report this population as empty.
  const setKeys = [...new Set(rows.map((r) => String(r.setKey ?? "").toLowerCase()))];
  const idSetKeys = [...new Set(rows.map((r) => String(r.id ?? "").split(":")[3] ?? ""))];
  const runs = [...new Set(rows.map((r) => printRunOf(r)))];
  if (setKeys.length > 1 || idSetKeys.length > 1) {
    // The bowman/bowman-chrome CPA collapse is its OWN kind: it is the only
    // place two DIFFERENT products share one identity, and D29 R2 decides it.
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

/** Does this kind belong to the mode being run? */
function kindInMode(kind) {
  if (MODE === "all") return true;
  switch (MODE) {
    case "colour": return kind === "colour-vs-colour-refractor";
    case "spelling": return ["refractor-spelling", "superfractor-spelling", "base-glue", "hyphen-spelling", "true-colour"].includes(kind);
    case "numbered": return kind === "numbered-vs-unnumbered";
    case "no-auto-ghost": return kind === "no-auto-ghost";
    case "setkey": return kind === "id-setkey-drift";
    case "cpa": return kind === "cross-product-cpa" || kind === "id-setkey-drift";
    default: return false;
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps"), portfolio = db.container("portfolio");
  const rulings = loadRulings();

  // -- banner: name the scope out loud --------------------------------------
  console.log(`consolidate-catalog-duplicates  MODE=${MODE}  ${APPLY ? "APPLY" : "REPORT ONLY -- nothing is written"}`);
  console.log(`  scope        sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}  years=${YEARS.length ? YEARS.join(",") : "(all)"}${SCOPE === "all" ? "  SCOPE=all" : ""}`);
  console.log(`  shard        slot ${SLOT}/${SLOTS}  on hash(identityKey) -- a whole identity group lands on ONE slot`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget       ${RUN_MINUTES}m   rulings loaded: ${rulings.length}   force-auto: ${FORCE_AUTO_PREFIXES.join(",")}`);
  console.log(`  NOTE         the catalog is MOVING under the D23 rename x16; counts are re-derived every run.`);

  // -- pass 1: GROUP BY identity key ----------------------------------------
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
        // THE D30 GROUPING KEY, not D29's identityKeyOf. identityKeyOf puts the
        // RAW setKey field in the key -- correct for R1, and pinned by its own
        // tests -- but it means two SPELLINGS of one product never meet, which
        // makes MODE=setkey and the cross-product half of MODE=cpa unreachable.
        // groupKeyOf normalizes the PRODUCT's spelling and nothing else.
        const key = groupKeyOf(r, FORCE_AUTO_PREFIXES);
        if (SLOTS > 1 && shardOfIdentity(key, SLOTS, sha1) !== SLOT) { rowsOtherShard++; continue; }
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
    }
  }
  console.log(`\n  pass 1: ${f(rowsRead)} non-graded rows read; ${f(rowsOtherShard)} on other slots; ${f(groups.size)} identity groups here`);

  if (PROBE_SHARDS) {
    // Read-only: PROVE the axis is balanced and reaches every slot BEFORE a
    // fleet is dispatched (the setKey-range lesson -- 89% of a retire on one
    // worker and 66,711 rows unreachable). Run at SLOTS=1 for a true picture.
    const counts = new Array(PROBE_SLOTS).fill(0);
    for (const key of groups.keys()) counts[shardOfIdentity(key, PROBE_SLOTS, sha1)]++;
    const total = groups.size || 1;
    console.log(`\n  SHARD PROBE over ${f(groups.size)} identity groups, modelling a ${PROBE_SLOTS}-slot fleet:`);
    if (SLOTS > 1) console.log(`    WARNING: this run is itself sharded at SLOTS=${SLOTS}; probe at SLOTS=1 for a true picture.`);
    counts.forEach((c, i) => console.log(`    slot ${i}  ${String(f(c)).padStart(10)}  ${(100 * c / total).toFixed(2)}%`));
    const skew = (Math.max(...counts) * PROBE_SLOTS) / total;
    console.log(`    max slot share ${(100 * Math.max(...counts) / total).toFixed(2)}%  (ideal ${(100 / PROBE_SLOTS).toFixed(2)}%)  skew ${skew.toFixed(3)}x  empty slots: ${counts.filter((c) => c === 0).length}`);
  }

  // -- pass 2 ---------------------------------------------------------------
  const stats = {
    groups: 0, consolidated: 0, ambiguous: 0, notAGroup: 0, failed: 0, notReached: 0, outOfMode: 0,
    rowsFolded: 0, gradedRetired: 0,
    salesRepointed: 0, salesRelocated: 0, salesRelocateFailed: 0, salesExtending: 0,
    holdingsRepointed: 0, holdingDocsWalked: 0, holdingsWalked: 0,
    skippedRenameOwned: 0, hashCollisionRisk: 0,
    r1Reached: 0, r1Skipped: 0, cpaFold: 0, cpaKeepBoth: 0, cpaAbstain: 0,
  };
  const byKind = new Map();
  const byWinnerBy = new Map();
  const byAmbiguous = new Map();
  const byNotAGroup = new Map();
  const ambiguousOut = [];
  const samples = [];
  /** Groups DECIDED as consolidate, held until the pre-flight has passed. */
  const plan = [];
  let stopReason = null;

  const bumpMap = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const bumpKind = (kind, field) => {
    const e = byKind.get(kind) ?? { groups: 0, consolidated: 0, ambiguous: 0, notAGroup: 0, salesSplit: 0, salesMoved: 0 };
    e[field]++;
    byKind.set(kind, e);
  };

  const holdingsIndex = await buildHoldingsIndex(portfolio, stats);

  // -- PRE-FLIGHT: the contentHash collision guard, BEFORE any write ---------
  //
  // WHY THIS IS A PASS AND NOT A COUNTER. The first build probed the hash
  // inside moveSalesAndRow, incremented a counter, and refused AFTER the group
  // loop finished. Under APPLY that refusal is theatre: every colliding sale
  // is already upserted or patched onto the winner's partition by the time
  // exit(2) fires, and exit(2) only spares the groups the loop had not reached
  // yet. Since contentHash is the store's partition-scoped PRE-WRITE dedup
  // key, each collision landed means a future genuine sale is silently
  // swallowed at ingest -- the exact outcome the guard exists to prevent.
  //
  // So the probe runs FIRST, over the same groups the loop will process, with
  // zero writes; APPLY refuses UP FRONT and nothing has moved. REPORT ONLY
  // still counts and prints, which is how the number reaches Drew.
  //
  // THE SEEN-SET IS SEEDED WITH THE WINNER'S OWN SALES. The first build scoped
  // it per LOSER, so a loser colliding with the WINNER's existing sales, or
  // with a different loser's, was never counted -- its 530 was a floor. The
  // set here is per WINNER PARTITION, which is the scope the dedup actually
  // uses.
  async function preflightHashCollisions(plan) {
    let blocking = 0, groupsWithCollisions = 0, salesProbed = 0, corroborated = 0, corroboratedGroups = 0;
    const examples = [];
    for (const { key, winner, losers } of plan) {
      const winnerId = String(winner.id);
      // Every row that lands in the winner's partition, bucketed by the hash it
      // will carry there. A bucket of 1 is no collision at all; a bucket of >= 2
      // is a cluster the classifier below rules on.
      const byHash = new Map();
      const add = (row) => {
        salesProbed++;
        const h = contentHashOf({ ...row, cardId: winnerId });
        const arr = byHash.get(h) ?? [];
        arr.push(row);
        byHash.set(h, arr);
      };
      // SEED: the sales already sitting on the winner. A loser's sale that
      // hashes to one of these collides the moment it lands.
      for (const row of await salesUnder(pool, winnerId)) add(row);
      for (const loser of losers) {
        for (const row of await salesUnder(pool, String(loser.id))) add(row);
      }

      let hit = 0, ok = 0;
      for (const cluster of byHash.values()) {
        if (cluster.length < 2) continue;
        const extra = cluster.length - 1;          // rows beyond the first = the collisions
        if (clusterIsBlocking(cluster)) { hit += extra; blocking += extra; }
        else { ok += extra; corroborated += extra; }
      }
      if (hit > 0) {
        groupsWithCollisions++;
        if (examples.length < 10) examples.push(`    ${key}  ->  ${winnerId}  (${hit} BLOCKING collision(s))`);
      }
      if (ok > 0) corroboratedGroups++;
    }
    return { collisions: blocking, groupsWithCollisions, salesProbed, examples, corroborated, corroboratedGroups };
  }

  let gi = 0;
  for (const [key, rows] of groups) {
    if (LIMIT && gi >= LIMIT) { stats.notReached += groups.size - gi; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`; stats.notReached += groups.size - gi; break; }
    gi++;
    stats.groups++;

    const kind = kindOf(rows);
    if (!kindInMode(kind)) { stats.outOfMode++; continue; }
    bumpKind(kind, "groups");

    // THE D23 RENAME STILL OWNS 33 `spelled` PRODUCTS. Folding a setKey-drift
    // group inside one would move rows to an address that is about to change
    // under us, so it is skipped behind its OWN counter rather than silently.
    if (kind === "id-setkey-drift" && rows.some((r) => isRenameOwnedProduct(r.setKey))) {
      stats.skippedRenameOwned++;
      continue;
    }

    const decision = decideDuplicateGroup({ rows, rulings, forceAutoPrefixes: FORCE_AUTO_PREFIXES });

    if (decision.kind === "not-a-group") {
      stats.notAGroup++; bumpMap(byNotAGroup, decision.why); bumpKind(kind, "notAGroup");
      continue;
    }

    if (decision.kind === "ambiguous") {
      stats.ambiguous++; bumpKind(kind, "ambiguous");
      const reason = decision.why === "two-checklist-print-runs-one-product"
        ? (decision.nearMiss ? "two-checklist-print-runs-one-product:near-miss" : "two-checklist-print-runs-one-product:distinct-rungs")
        : decision.why;
      bumpMap(byAmbiguous, reason);
      if (ambiguousOut.length < AMBIGUOUS_MAX) {
        ambiguousOut.push({
          identityKey: key, kind, reason, detail: decision.detail,
          rows: rows.map((r) => ({ id: r.id, source: r.source, parallelSlug: r.parallelSlug, printRun: printRunOf(r), playerName: r.playerName ?? null })),
        });
      }
      continue;
    }

    // -- consolidate --------------------------------------------------------
    const { winner, losers, winnerBy } = decision;
    bumpMap(byWinnerBy, winnerBy);

    // R1 REACH, sized rather than assumed. This is the number that says whether
    // MODE=numbered actually reached its kind or merely reported green on ~22%.
    if (kind === "numbered-vs-unnumbered") {
      const picked = pickChecklistNumberedTarget(rows, isChecklist);
      if ("target" in picked) {
        const reach = losers.some((l) => {
          const d = decideChecklistNumberedFold({ target: picked.target, twin: l, targetIsChecklist: true, twinIsChecklist: isChecklist(l.source), forceAutoPrefixes: FORCE_AUTO_PREFIXES });
          return d.fold === true;
        });
        if (reach) stats.r1Reached++; else stats.r1Skipped++;
      } else stats.r1Skipped++;
    }

    if (MODE === "cpa" || MODE === "all") {
      const cpa = decideCpaProduct(rows.map((r) => ({ id: r.id, setKey: String(r.setKey ?? ""), source: String(r.source ?? ""), playerName: r.playerName, printRun: r.printRun, parallelSlug: r.parallelSlug })));
      if (cpa.kind === "fold") stats.cpaFold++;
      else if (cpa.kind === "keep-both") {
        // Two dedicated products both listing the number: R2 says BOTH stay.
        stats.cpaKeepBoth++;
        stats.ambiguous++; bumpKind(kind, "ambiguous"); bumpMap(byAmbiguous, "two-dedicated-cpa-products");
        if (ambiguousOut.length < AMBIGUOUS_MAX) {
          ambiguousOut.push({ identityKey: key, kind, reason: "two-dedicated-cpa-products", detail: cpa.reason, rows: rows.map((r) => ({ id: r.id, source: r.source, setKey: r.setKey })) });
        }
        continue;
      } else stats.cpaAbstain++;
    }

    if (samples.length < 25) {
      samples.push(`  [${kind}/${winnerBy}] ${losers.map((l) => l.id).join(", ")}  ->  ${winner.id}  [${winner.source}]`);
    }

    // THE WINNER MUST BE A ROW moveCatalogRow CAN WRITE TO.
    //
    // `buildIncoming` THROWS when a slug's setKey segment disagrees with the
    // row's own setKey FIELD -- "a key needs both halves" (#1348), and that
    // guard is right: a row whose id says one product while its field says
    // another is exactly the fragmentation it exists to end.
    //
    // The D30 grouping key now reaches those rows on purpose. Measured live on
    // the baseball slice: `hiq:...:bowman-chrome:bcp-52:base:no-auto`
    // [checklistinsider] and `hiq:...:bowman:bcp-52:base:no-auto` [beckett]
    // are one Ethan Dorchies card and BOTH carry setKey `bowman` -- the D23
    // rename renamed the fields and has not yet re-keyed the ids. They are a
    // real duplicate, but the winner's ADDRESS is mid-flight, and folding onto
    // an address that is about to change is the hazard the rename-owned skip
    // already exists for.
    //
    // So this is a SKIP on the rename's counter, not a failure: the rename
    // finishes, the id catches up with the field, and the next pass folds it.
    // Left as a throw it showed up as `failed 20` -- an error counter carrying
    // a decision, which hides a real refusal behind what reads as a bug.
    // The check covers EVERY row in the fold, not just the winner: moveCatalogRow
    // builds the incoming row from the LOSER's fields at the WINNER's slug, so a
    // loser whose own id and field disagree throws just the same. Measured: the
    // winner-only form left 2 failures in the baseball slice, both CPA groups
    // where the mid-rename row was a loser.
    const midRename = [winner, ...losers].some((r) => {
      const seg = String(r.id ?? "").split(":")[3] ?? "";
      const field = String(r.setKey ?? "").trim().toLowerCase();
      return field !== "" && seg !== "" && seg !== field;
    });
    if (midRename) {
      stats.skippedRenameOwned++;
      continue;
    }

    // DECIDED, NOT WRITTEN. The plan is built in full so the contentHash
    // pre-flight can see every group this run would touch BEFORE any write.
    plan.push({ key, kind, rows, winner, losers, reason: decision.reason });
  }

  // -- the pre-flight refusal, BEFORE the write phase -----------------------
  const preflight = await preflightHashCollisions(plan);
  stats.hashCollisionRisk = preflight.collisions;
  console.log(`
  contentHash PRE-FLIGHT (read-only, before any write):`);
  console.log(`    groups planned             ${f(plan.length)}`);
  console.log(`    sales probed               ${f(preflight.salesProbed)}   <- the WINNER's own sales seed the set, then every loser's`);
  console.log(`    COLLISIONS                 ${f(preflight.collisions)} in ${f(preflight.groupsWithCollisions)} group(s)   <- BLOCKING only: >=2 live rows share a sourceExternalId`);
  console.log(`    corroborated (non-blocking) ${f(preflight.corroborated)} in ${f(preflight.corroboratedGroups)} group(s)   <- DISTINCT external ids: two REAL sales, carried with the partition`);
  if (preflight.examples.length) { console.log(`    colliding groups:`); for (const ex of preflight.examples) console.log(ex); }

  if (APPLY && preflight.collisions > 0) {
    console.error(`
FATAL: ${f(preflight.collisions)} BLOCKING contentHash collisions across ${f(preflight.groupsWithCollisions)} group(s).`);
    console.error(`       Each is >= 2 LIVE rows sharing one sourceExternalId -- one listing ingested twice, still`);
    console.error(`       unresolved. Folding them would put two sales the store reads as "the same sale" into one`);
    console.error(`       cardId partition, and a genuine future sale would be swallowed at ingest.`);
    console.error(`       Run triage-contenthash-collisions.cjs: it flags the TRUE-DUPE losers (which this pre-flight`);
    console.error(`       then stops counting) and sends CONFLICTED-DUPE wrong-card ingests to a person.`);
    console.error(`       Distinct-externalId sales that merely hash alike are NOT counted here -- different item id`);
    console.error(`       is two real sales, and they never blocked a fold.`);
    console.error(`       NOTHING HAS BEEN WRITTEN. The refusal is PRE-FLIGHT by design: the first build probed`);
    console.error(`       inside the write loop and refused after it, so it wrote the collisions it then refused over.`);
    process.exit(2);
  }

  // -- the write phase ------------------------------------------------------
  for (const { key, kind, rows, winner, losers, reason } of plan) {
    try {
      let movedSales = 0;
      for (const loser of losers) {
        // (2)+(3): the FULL sales width under this loser, each key attributed to
        // the LONGEST matching row so a numbered twin keeps its own sales.
        const res = await moveSalesAndRow(cat, pool, { winner, loser, rows, reason, stats });
        movedSales += res.moved;
        await repointHoldings(portfolio, holdingsIndex, loser.id, winner.id, stats);
        stats.rowsFolded++;
      }
      stats.consolidated++;
      bumpKind(kind, "consolidated");
      const e = byKind.get(kind);
      if (movedSales > 0) { e.salesSplit++; e.salesMoved += movedSales; }
    } catch (e) {
      stats.failed++;
      if (stats.failed <= 5) console.log(`  failed ${key}: ${String(e.message).slice(0, 160)}`);
    }
  }

  // -- report ---------------------------------------------------------------
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  identity groups examined   ${f(stats.groups)}`);
  console.log(`  out of MODE=${MODE}            ${f(stats.outOfMode)}`);
  console.log(`  CONSOLIDATED (groups)      ${f(stats.consolidated)}   rows folded ${f(stats.rowsFolded)}`);
  console.log(`  AMBIGUOUS -> Drew          ${f(stats.ambiguous)}`);
  console.log(`  not a group (never folded) ${f(stats.notAGroup)}`);
  console.log(`  skipped: D23 rename owns   ${f(stats.skippedRenameOwned)}   <- a 'spelled' product; the rename is still moving it`);
  console.log(`  failed                     ${f(stats.failed)}`);
  console.log(`  not reached                ${f(stats.notReached)}`);
  // groups scanned = consolidated + ambiguous + not-a-group + failed + not-reached
  // (+ out-of-mode + rename-skipped, which are disjoint from all of the above).
  const accounted = stats.consolidated + stats.ambiguous + stats.notAGroup + stats.failed + stats.notReached + stats.outOfMode + stats.skippedRenameOwned;
  console.log(`  RECONCILES                 ${f(accounted)} vs ${f(stats.groups + stats.notReached)} scanned+unreached  ${accounted === stats.groups + stats.notReached ? "OK" : "MISMATCH"}`);

  console.log(`\n  THE POOL (the real work -- disjoint counters, never summed):`);
  console.log(`    sales re-pointed (patch)   ${f(stats.salesRepointed)}   <- partition key was NOT the loser slug`);
  console.log(`    sales relocated (re-key)   ${f(stats.salesRelocated)}   <- partition key WAS the loser slug; upsert-verify-delete`);
  console.log(`    of which extending keys    ${f(stats.salesExtending)}   <- ':num-N'/grade keys moveCatalogRow alone would strand`);
  console.log(`    sales relocate failed      ${f(stats.salesRelocateFailed)}`);
  console.log(`    holdings re-pointed        ${f(stats.holdingsRepointed)}   (walked ${f(stats.holdingsWalked)} holdings / ${f(stats.holdingDocsWalked)} docs)`);
  console.log(`    graded children retired    ${f(stats.gradedRetired)}`);
  console.log(`    contentHash COLLISIONS     ${f(stats.hashCollisionRisk)}   <- BLOCKING (shared sourceExternalId); measured PRE-FLIGHT, APPLY refuses up front while any are outstanding`);

  if (stats.r1Reached + stats.r1Skipped > 0) {
    const tot = stats.r1Reached + stats.r1Skipped;
    console.log(`\n  R1 REACH on numbered-vs-unnumbered: ${f(stats.r1Reached)} of ${f(tot)} (${(100 * stats.r1Reached / tot).toFixed(1)}%) are in decideChecklistNumberedFold's declared reach;`);
    console.log(`    ${f(stats.r1Skipped)} are the cross-checklist shape it skips by design and duplicateWinnerRule decides here.`);
  }

  console.log(`\n  by KIND (groups / consolidated / ambiguous / not-a-group / sales-split / sales moved):`);
  for (const [k, e] of [...byKind.entries()].sort((a, b) => b[1].groups - a[1].groups)) {
    console.log(`    ${k.padEnd(28)} ${String(f(e.groups)).padStart(9)} ${String(f(e.consolidated)).padStart(9)} ${String(f(e.ambiguous)).padStart(9)} ${String(f(e.notAGroup)).padStart(9)} ${String(f(e.salesSplit)).padStart(9)} ${String(f(e.salesMoved)).padStart(9)}`);
  }

  console.log(`\n  by WINNER RULE:`);
  for (const [k, v] of [...byWinnerBy.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${String(f(v)).padStart(10)}`);

  console.log(`\n  AMBIGUOUS by reason (disjoint; first match names the group):`);
  for (const [k, v] of [...byAmbiguous.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(52)} ${String(f(v)).padStart(10)}`);
  console.log(`  NEEDS DREW total ${f(stats.ambiguous)}`);

  console.log(`\n  NOT A GROUP by reason (never folded):`);
  for (const [k, v] of [...byNotAGroup.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${String(f(v)).padStart(10)}`);

  if (samples.length) { console.log(`\n  samples:`); for (const s of samples) console.log(s); }

  // -- the ambiguous list ---------------------------------------------------
  if (ambiguousOut.length) {
    const out = {
      _doc: "D30 groups the fleet REFUSED to decide. Reasons are disjoint; the first match names the group. Print-run conflicts and player-differs are NOT here -- they are not duplicates at all.",
      generatedAt: new Date().toISOString(),
      scope: { sports: SPORTS, years: YEARS, scopeAll: SCOPE === "all", mode: MODE, slot: SLOT, slots: SLOTS },
      counts: Object.fromEntries([...byAmbiguous.entries()].sort((a, b) => b[1] - a[1])),
      total: stats.ambiguous,
      truncatedTo: ambiguousOut.length < stats.ambiguous ? ambiguousOut.length : null,
      groups: ambiguousOut,
    };
    const dest = SLOTS > 1 ? AMBIGUOUS_OUT.replace(/\.json$/, `.slot-${SLOT}.json`) : AMBIGUOUS_OUT;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(`\n  ambiguous list written: ${dest}  (${f(ambiguousOut.length)} of ${f(stats.ambiguous)} groups)`);
  }

  if (APPLY) {
    // DISJOINT counters. Sub-totals of `written` go on their OWN line and are
    // never folded into `skipped` -- a slice is not a sibling counter.
    reportWrites({
      job: `consolidate-catalog-duplicates:${MODE}`,
      intended: stats.consolidated + stats.ambiguous + stats.notAGroup + stats.outOfMode + stats.skippedRenameOwned + stats.failed,
      written: stats.consolidated,
      skipped: stats.ambiguous + stats.notAGroup + stats.outOfMode + stats.skippedRenameOwned,
      failed: stats.failed,
    });
    console.log(`  written sub-totals (not skipped): rows folded ${f(stats.rowsFolded)}`);
    console.log(`  collateral (not rows written): sales patched ${f(stats.salesRepointed)} | sales relocated ${f(stats.salesRelocated)} | graded retired ${f(stats.gradedRetired)} | holdings ${f(stats.holdingsRepointed)}`);
  }
  if (stopReason) console.log(`\n${stopReason}`);
}

/**
 * THE FULL SALES WIDTH UNDER A LOSER, then the row move.
 *
 * moveCatalogRow re-points only `hobbyiqCardId = @exact`. Pool keys EXTEND the
 * row id (`:num-N`, a grade segment), so this enumerates `id OR STARTSWITH(id +
 * ':')` and attributes each key to the LONGEST matching row in the group -- a
 * key that extends a NUMBERED twin belongs to that twin, not to this loser, and
 * stealing it would move a real /N card's sales onto the un-numbered winner.
 *
 * A sale whose PARTITION KEY is the loser slug cannot be patched across
 * partitions and goes through relocateSoldComp; everything else is patched in
 * place by the move. The two are counted separately and never summed.
 */
/**
 * Every LIVE pool row under a slug -- the exact-match key AND the keys that
 * extend it (`:num-N`, a grade segment). READ ONLY: this is the pre-flight
 * probe's reader and never writes. Attribution to the longest matching row is
 * the CALLER's job (see `ownsKey`); here the full width is what the collision
 * probe needs to see.
 *
 * -- WHY FLAGGED ROWS ARE EXCLUDED (D5) -------------------------------------
 *
 * `flaggedWrong = true` is the pool's exclusion mark. Every FMV read path
 * already filters it (canonicalFmv.service.ts:1073,:1292; marketMovers,
 * playerDetail, priceSeries, setDetail, verifyQueue; cohortBacktest), and the
 * contentHash triage sets it on rows it has PROVED are the same physical sale.
 *
 * Without this predicate the pre-flight counted those rows, hashed them, and
 * refused over them -- so the eight football shards would have refused
 * IDENTICALLY after a full apply-true-dupes pass, and the triage that exists to
 * unblock the fold could never unblock it. Counting them is counting resolved
 * work as outstanding.
 *
 * The row is still THERE -- the pool is the moat and nothing was deleted. It is
 * merely not evidence of an unresolved collision any more.
 *
 * -- WHAT THIS PREDICATE DOES *NOT* CLAIM (retraction, R2 judge) ------------
 *
 * An earlier draft of this comment justified the exclusion by asserting that a
 * flagged row "cannot swallow a genuine future sale, because the ingest-time
 * dedup that would swallow it is comparing against rows the reads already
 * ignore." That is FALSE and is retracted here. The FMV *read* paths filter
 * flaggedWrong; the pre-write dedup is a DIFFERENT query and does not:
 *
 *   soldCompsStore.service.ts:1495
 *     SELECT * FROM c WHERE ARRAY_CONTAINS(@h, c.contentHash)   -- no predicate
 *   persistVendorSalesToPool.service.ts:1081
 *     SELECT c.id FROM c WHERE c.hobbyiqCardId=@hiq AND c.contentHash=@ch
 *
 * (Those line numbers are the ones the defect was FOUND at, kept so the
 * retraction stays checkable against the history. The fix that closed it moved
 * them: the queries now sit at soldCompsStore.service.ts:1544 and
 * persistVendorSalesToPool.service.ts:1089.)
 *
 * and `scoreForCanonical` (soldCompsStore.service.ts:676) never reads the flag.
 * So a flagged row still participates in ingest dedup, with two consequences:
 *
 *   (1) it can OUTSCORE a genuine incoming sale (a real-eBay-id flagged row
 *       scores 95.86 against a ch-daily:: incoming at 85.88), and the incoming
 *       sale is dropped at :1519 as `deduped`; and
 *   (2) if the incoming sale outscores it instead, :1524 HARD DELETES the
 *       flagged row -- destroying the dedupSupersededBy provenance trail.
 *
 * Both were narrow: they needed a genuine later sale colliding on the full
 * contentHash -- (cardId, parallel, isAuto, grade, price, soldAt) -- with an
 * already-flagged row, i.e. same card AND same price AND the same second.
 *
 * CLOSED 2026-09-01. Both ingest queries now carry
 * `(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)`, and
 * `scoreForCanonical` subtracts a floor-clearing 1000 from a flagged row so it
 * loses to every live one. A flagged row can no longer drop a genuine incoming
 * sale, nor be hard-deleted by one. The one deliberate exception: when the
 * INCOMING doc is itself flagged (the cardsight $0.99 / outlier guards mint
 * that at ingest) it still dedups against flagged rows, or those guards would
 * resurrect the duplicates they exist to suppress. Pinned in
 * backend/tests/ingestFlaggedDedupProtection.test.ts.
 *
 * The exclusion above never rested on the retracted claim anyway. It rests on
 * the narrower true one: a flagged row is excluded from every FMV read, so it
 * is not an outstanding collision for the PRE-FLIGHT to refuse over.
 */
async function salesUnder(pool, slug) {
  const out = [];
  const it = pool.items.query(
    {
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.parallel, c.price, c.soldAt,
                     c.gradeCompany, c.gradeValue, c.isAuto, c.flaggedWrong,
                     c.source, c.sourceExternalId
              FROM c WHERE (c.hobbyiqCardId = @s OR STARTSWITH(c.hobbyiqCardId, @p))
                AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)`,
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
 * -- WHICH HASH CLUSTERS ACTUALLY BLOCK THE FOLD (D30-R3) -------------------
 *
 * THE DEFECT THIS ENDS. After a full TRUE-DUPE flagging pass -- 179 groups /
 * 189 rows, now invisible to the flag-aware pre-flight of D5 -- ALL EIGHT
 * football/2024 dry-run slots still refused. The residual is class AMBIGUOUS
 * 729: rows with DISTINCT sourceExternalIds that hash identically because the
 * same card genuinely sold at the same price on the same day, and contentHash
 * -- (cardId, parallel, isAuto, grade, price, soldAt) -- has no field that can
 * tell two such sales apart.
 *
 * Standing doctrine (the af14c29c lesson, and collision-triage's own rule):
 * DIFFERENT sourceExternalId = TWO REAL SALES, NEVER collapsed. A pre-flight
 * that FATALs on them calls legitimate corroborated data corruption and blocks
 * the fold permanently -- there is no triage pass that can ever clear them,
 * because there is nothing wrong to clear. The eight slots would refuse
 * forever on data that is correct.
 *
 * THE CRITERION. A cluster BLOCKS only when it holds an UNRESOLVED TRUE DUPE:
 * >= 2 live rows sharing a sourceExternalId. That is the triage's own proof of
 * sameness, and it is exactly the entry condition for both classes that need a
 * ruling before a fold is safe:
 *
 *   TRUE-DUPE       shared id, identity agrees   -> triage flags the loser; the
 *                   D5 predicate then makes it invisible here and the fold
 *                   proceeds. Blocking is what MAKES that pass meaningful.
 *   CONFLICTED-DUPE shared id, identity DISAGREES -> a wrong-card ingest, and
 *                   NEVER auto-flagged: a person rules on it. The triage writes
 *                   no marker on the row for this class (verified: the CONFLICTED
 *                   branch only reports), so shared-externalId IS the visible
 *                   criterion -- and because a shared id is that class's own
 *                   entry condition, keying on it catches every one of them.
 *
 * Everything else in a cluster is distinct-externalId: separate listings, each
 * its own real sale. Those are counted and printed as CORROBORATED, and
 * `moveSalesAndRow` carries them with the partition like any ordinary row.
 *
 * WHY THE BARE EXTERNAL ID AND NOT (source, sourceExternalId). collision-triage
 * proves sameness on `externalIdOf` alone, and cross-SOURCE shared ids are the
 * common real case -- the D5 fixture's own flag reason is
 * `shared-sourceExternalId-cross-source`, one eBay item ingested by both
 * tca-ebay and cardhedge. Adding `source` to the key would split those pairs
 * apart and wave the exact true dupes the guard exists for straight through.
 * The bare id is the strictly safer key and the one the triage already uses.
 *
 * A row with NO external id can never PROVE sameness with another, so it never
 * blocks -- same rule, and same reasoning, as externalIdOf returning null.
 */
function clusterIsBlocking(cluster) {
  const byExternal = new Map();
  for (const row of cluster) {
    const raw = row?.sourceExternalId;
    if (raw === null || raw === undefined) continue;
    const ext = String(raw).trim();
    if (!ext.length) continue;
    const n = (byExternal.get(ext) ?? 0) + 1;
    if (n > 1) return true;   // two live rows, one listing: unresolved true dupe
    byExternal.set(ext, n);
  }
  return false;
}

/**
 * -- THE FLAGGED ROW'S DISPOSITION UNDER A MOVE, DECIDED (D5) ---------------
 *
 * `salesUnder` above excludes flagged rows because the PRE-FLIGHT is asking
 * "what is still unresolved?" and a flagged row is resolved. This function is
 * asking a different question -- "what belongs to this loser?" -- and the answer
 * for a flagged row is the same as for any other: it belongs to the card, and
 * the card is moving.
 *
 * So the move is UNFILTERED, deliberately, and the flag travels untouched:
 *
 *   MOVED, not left behind. Leaving flagged rows on a retired loser slug orphans
 *   them: the catalog row is gone, so the sale references an address nothing
 *   resolves, and the provenance trail from `dedupSupersededBy` to the surviving
 *   row crosses a partition that no longer has a card. The pool is the moat --
 *   that includes the history of what we excluded and why.
 *
 *   STILL FLAGGED. `flaggedWrong`, `flaggedReason`, `dedupSupersededBy`,
 *   `dedupReason` and `dedupAt` are not in the patch below and are not in the
 *   `keep` projection's overrides, so the relocation carries them verbatim. A
 *   fold is a change of address, not a re-adjudication: a row a human or the
 *   triage ruled on stays ruled on. Clearing a flag here would silently
 *   resurrect an excluded sale into a pool that had already excluded it, and
 *   double-count it in every FMV built on that partition.
 *
 * The two behaviours are therefore asymmetric ON PURPOSE, and the asymmetry is
 * the point: excluded from the COUNT of outstanding collisions, included in the
 * MOVE of the card's history.
 */
async function moveSalesAndRow(cat, pool, { winner, loser, rows, reason, stats }) {
  const loserId = String(loser.id);
  const winnerId = String(winner.id);
  // Every OTHER row's id in the group: a pool key extending one of these is not
  // this loser's to move.
  const rivals = rows.map((r) => String(r.id)).filter((id) => id !== loserId);
  // LONGEST match wins. The rule lives in duplicateWinnerRule so the test can
  // pin the code that runs rather than a local copy of it.
  const ownsKey = (key) => ownsPoolKey(key, loserId, rivals);

  let moved = 0;
  const it = pool.items.query(
    {
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.isAuto FROM c WHERE c.hobbyiqCardId = @s OR STARTSWITH(c.hobbyiqCardId, @p)",
      parameters: [{ name: "@s", value: loserId }, { name: "@p", value: `${loserId}:` }],
    },
    { maxItemCount: 200 },
  );
  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources ?? []) {
      const key = String(row.hobbyiqCardId ?? "");
      if (!ownsKey(key)) continue;
      if (key !== loserId) stats.salesExtending++;

      // The winner-side key keeps whatever the loser key EXTENDED, so a
      // `:num-N`/grade suffix survives the move onto the winner.
      const suffix = key.length > loserId.length ? key.slice(loserId.length) : "";
      const newHiq = `${winnerId}${suffix}`;

      // The contentHash collision probe does NOT live here. It ran as a
      // read-only PRE-FLIGHT over the whole plan before this phase started, so a
      // colliding run refuses with zero writes rather than counting damage it
      // has already done. See `preflightHashCollisions`.

      if (String(row.cardId ?? "") === loserId) {
        // The partition key IS the loser slug: a cross-partition re-key.
        const full = await retry(() => pool.item(row.id, row.cardId).read());
        const src = full?.resource;
        if (!src) continue;
        const keep = {
          ...stripSystem(src), cardId: winnerId, hobbyiqCardId: newHiq,
          reslugedFrom: loserId, reslugedReason: reason, reslugedAt: new Date().toISOString(),
        };
        keep.contentHash = contentHashOf(keep);
        const res = await relocateSoldComp(pool, {
          keep, drop: [{ id: row.id, cardId: loserId }], retry,
          verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY,
        });
        if (res.ok) { stats.salesRelocated++; moved++; } else { stats.salesRelocateFailed++; }
      } else {
        // Same partition: patch in place. Done HERE rather than left to
        // moveCatalogRow so the extending keys are covered too.
        if (APPLY) {
          await retry(() => pool.item(row.id, row.cardId).patch([
            { op: "set", path: "/hobbyiqCardId", value: newHiq },
            { op: "set", path: "/reslugedFrom", value: loserId },
            { op: "set", path: "/reslugedReason", value: reason },
            { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
          ]));
        }
        stats.salesRepointed++; moved++;
      }
    }
  }

  // The row itself, LAST. Sales already point at the winner, so no window
  // exists in which a sale references a row that is gone. `salesContainer` is
  // deliberately omitted: this function has already moved the full width, and
  // passing it would re-scan the exact-match subset a second time.
  const res = await moveCatalogRow(cat, loser, winnerId, { printRun: printRunOf(winner) }, { reason, dryRun: !APPLY, retry });
  stats.gradedRetired += res?.gradedChildrenRetired ?? 0;
  return { moved };
}

/**
 * Build the holdings index ONCE: slug -> [{ docId, userId, holdingId }].
 * portfolio.holdings is a MAP, so this walks Object.values(doc.holdings) and
 * never `JOIN h IN c.holdings` -- a guard that walks nothing vouches for
 * nothing. It prints what it walked and REFUSES on zero docs.
 */
async function buildHoldingsIndex(portfolio, stats) {
  const index = new Map();
  const it = portfolio.items.query({ query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" }, { maxItemCount: 100 });
  let docs = 0;
  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const doc of resources ?? []) {
      docs++;
      const holdings = doc.holdings && typeof doc.holdings === "object" ? doc.holdings : null;
      if (!holdings) continue;
      for (const [hid, h] of Object.entries(holdings)) {
        stats.holdingsWalked++;
        if (!h || typeof h !== "object") continue;
        for (const slug of new Set([String(h.hobbyiqCardId ?? ""), String(h.cardId ?? "")])) {
          if (!slug) continue;
          const list = index.get(slug) ?? [];
          list.push({ docId: doc.id, userId: doc.userId, holdingId: hid });
          index.set(slug, list);
        }
      }
    }
  }
  stats.holdingDocsWalked = docs;
  if (docs === 0) throw new Error("walked ZERO portfolio docs -- refusing to claim holdings are clean");
  console.log(`  holdings index: walked ${f(stats.holdingsWalked)} holdings across ${f(docs)} portfolio docs; ${f(index.size)} distinct slugs held`);
  return index;
}

/** Re-point every holding that points at a folded loser. */
async function repointHoldings(portfolio, holdingsIndex, loserId, winnerId, stats) {
  const hits = holdingsIndex.get(loserId);
  if (!hits || !hits.length) return;
  const byDoc = new Map();
  for (const h of hits) {
    const k = `${h.docId}|${h.userId}`;
    const e = byDoc.get(k) ?? { docId: h.docId, userId: h.userId, ids: new Set() };
    e.ids.add(h.holdingId);
    byDoc.set(k, e);
  }
  for (const { docId, userId, ids } of byDoc.values()) {
    const ops = [];
    for (const hid of ids) {
      ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: winnerId });
      ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: winnerId });
    }
    if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
    stats.holdingsRepointed += ids.size;
  }
  holdingsIndex.delete(loserId);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
