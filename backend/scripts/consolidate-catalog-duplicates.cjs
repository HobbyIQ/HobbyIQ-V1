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
 * (3b) THE contentHash HAZARD, reported before any APPLY. `computeContentHash`
 *     (portfolioiq/soldCompsStore.service.ts:566) and its mirror in
 *     relocate-sold-comp.cjs:44 still strip a trailing " Refractor" -- the
 *     comment says "Colour = Colour Refractor is one card". D31 RETRACTED that.
 *     contentHash is scoped to cardId, so the collision only bites when a fold
 *     lands a `Gold` sale and a `Gold Refractor` sale in the SAME partition at
 *     the same price/date/grade -- which is exactly what MODE=colour creates.
 *     The dry run COUNTS would-be collisions and APPLY REFUSES while any are
 *     outstanding, so the dedup cannot eat a real sale.
 *
 * -- WHAT THIS SCRIPT DOES NOT DO -------------------------------------------
 *
 * It never re-implements D29. MODE=numbered calls `decideChecklistNumberedFold`
 * for R1's population; MODE=cpa calls `decideCpaProduct`. Print-run conflicts
 * and player-differs are NOT duplicates and are never folded. A sale never
 * mints a row. FMV is never a median.
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
const SLOT = Number(process.env.SLOT || 0), SLOTS = Number(process.env.SLOTS || 1);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
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
    let collisions = 0, groupsWithCollisions = 0, salesProbed = 0;
    const examples = [];
    for (const { key, winner, losers } of plan) {
      const winnerId = String(winner.id);
      const seen = new Set();
      // SEED: the sales already sitting on the winner. A loser's sale that
      // hashes to one of these collides the moment it lands.
      for (const row of await salesUnder(pool, winnerId)) {
        salesProbed++;
        seen.add(contentHashOf({ ...row, cardId: winnerId }));
      }
      let hit = 0;
      for (const loser of losers) {
        for (const row of await salesUnder(pool, String(loser.id))) {
          salesProbed++;
          const h = contentHashOf({ ...row, cardId: winnerId });
          if (seen.has(h)) { hit++; collisions++; } else seen.add(h);
        }
      }
      if (hit > 0) {
        groupsWithCollisions++;
        if (examples.length < 10) examples.push(`    ${key}  ->  ${winnerId}  (${hit} colliding sale(s))`);
      }
    }
    return { collisions, groupsWithCollisions, salesProbed, examples };
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
  console.log(`    COLLISIONS                 ${f(preflight.collisions)} in ${f(preflight.groupsWithCollisions)} group(s)`);
  if (preflight.examples.length) { console.log(`    colliding groups:`); for (const ex of preflight.examples) console.log(ex); }

  if (APPLY && preflight.collisions > 0) {
    console.error(`
FATAL: ${f(preflight.collisions)} contentHash collisions across ${f(preflight.groupsWithCollisions)} group(s).`);
    console.error(`       These folds would put two sales that hash IDENTICALLY into one cardId partition, and`);
    console.error(`       the store's pre-write dedup reads that as "the same sale" -- a genuine future sale`);
    console.error(`       would be swallowed at ingest.`);
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
  console.log(`    contentHash COLLISIONS     ${f(stats.hashCollisionRisk)}   <- measured PRE-FLIGHT; APPLY refuses up front while any are outstanding`);

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
 * Every pool row under a slug -- the exact-match key AND the keys that extend
 * it (`:num-N`, a grade segment). READ ONLY: this is the pre-flight probe's
 * reader and never writes. Attribution to the longest matching row is the
 * CALLER's job (see `ownsKey`); here the full width is what the collision
 * probe needs to see.
 */
async function salesUnder(pool, slug) {
  const out = [];
  const it = pool.items.query(
    {
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.isAuto FROM c WHERE c.hobbyiqCardId = @s OR STARTSWITH(c.hobbyiqCardId, @p)",
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

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
