#!/usr/bin/env node
/**
 * fold-checklist-numbered-twins.cjs -- R1: when the checklist numbers a
 * parallel, EVERY sale-minted twin folds onto the checklist's numbered row and
 * its sales re-point there. One card, one pool.
 *
 * CF-A-CHECKLIST-NUMBERED-ROW-IS-THE-IDENTITY (Drew, 2026-08-30 09:40Z).
 * The case he named: 2020 Bowman Chrome CPA-MH Michael Harris carries
 *   hiq:...:cpa-mh:refractor:auto                 [ingest-auto-seed]  57 sales
 *   hiq:...:cpa-mh:refractor:auto:num-499         [ingest-auto-seed]   1 sale
 *   hiq:...:cpa-mh:base-refractor:auto:num-499    [checklistcenter]    0 sales
 * -- 58 sales split across two rows while the checklist row, the intended
 * identity, holds none of them. All three are ONE card.
 *
 * WHY THIS IS A NEW SCRIPT AND NOT A MODE OF fold-unnumbered-twins.cjs.
 * That script's pass 1 buckets numbered rows under the LITERAL un-numbered id
 * prefix (`id.match(/^(.*):num-(\d+)$/)[1]`) and its pass 2 POINT-READS that
 * base id. Two consequences, and Harris hits both:
 *
 *   1. The checklist row is spelled `base-refractor` and the twin `refractor`,
 *      so the strings never meet -- the twin is not skipped, it is never a
 *      candidate. (`base-*` is not a wait-for-D28 problem: 57,720 baseball
 *      rows still carried one when this was measured.)
 *   2. A NUMBERED twin is not an un-numbered base id, so a point read of the
 *      base id cannot reach it in ANY mode -- a large share of the width is
 *      structurally invisible there.
 *
 * WHAT FOLDS, AND WHAT ONLY GETS REPORTED. Drew's R1 text says a twin
 * "numbered differently" folds, but every case he gave is a RESPELLING at the
 * SAME print run (`refractor:auto:num-499` vs `base-refractor:auto:num-499`).
 * Read literally, "different /N" folds a real /1 onto a /36,960 -- the first
 * dry run surfaced exactly that. Two real print runs are two rungs of the
 * parallel ladder, so a RIVAL /N is reported for a human to rule on and never
 * folded. What folds: an un-numbered twin, a same-/N respelling, and the
 * no-auto ghost on an auto-by-definition card number.
 *
 * So this pass GROUPS BY a cleaned identity key rather than indexing on an id
 * string, which is also what makes the shard axis real (see SHARDING below).
 *
 * WHAT A FOLD DOES, in order (moveCatalogRow, #1417):
 *   copy onto the target -> re-point sales -> retire the twin's graded
 *   children -> delete the twin last. The target is checklist and the twin is
 *   not, so chooseSurvivor returns "incumbent" and the checklist row's fields
 *   survive. That is the intended outcome and it is ASSERTED here, not assumed.
 *
 * SALES. moveCatalogRow re-points sales with an in-place patch of
 * /hobbyiqCardId, which is correct ONLY while the sale's partition key
 * (`cardId`) is not the twin's own slug -- sold_comps is partitioned on
 * /cardId and a partition key cannot be patched. Rows whose cardId IS the twin
 * slug go through relocate-sold-comp (upsert -> verify read-back -> delete),
 * and they are counted on their OWN line: `salesRelocated` is different work
 * from `salesRepointed` and the two are never summed.
 *
 * HOLDINGS. portfolio.holdings is a MAP. This walks Object.values(doc.holdings)
 * -- never `JOIN h IN c.holdings` -- prints what it walked, and refuses on
 * zero docs walked.
 *
 * SHARDING. The fold is decided per GROUP, so a group's rows must land on ONE
 * worker: sharding on the twin id would let two workers race to move the same
 * target. The axis is hash(identityKey) % SLOTS. Probe it with
 * PROBE_SHARDS=true before dispatching a fleet (the setKey-range lesson: 89%
 * of a retire on one worker, 66,711 rows unreachable).
 *
 * THE CATALOG IS MOVING. The D23 rename and D28 base-cards fleets are in
 * flight, so every count here is a snapshot re-derived at run time. A relaunch
 * re-queries by identity key and resumes correctly; nothing is double-folded,
 * because a twin that already folded no longer exists to be found.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (report only by
 *      default); SLOT/SLOTS; RUN_MINUTES=140; SPORTS/SPORT (comma list);
 *      YEARS (comma list); SCOPE=all to run whole-scope; LIMIT=0;
 *      FORCE_AUTO_PREFIXES (default CPA,BCPA,CDA,BDCA,PA); PROBE_SHARDS=true.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");

// ── THE SCOPE REFUSAL RUNS FIRST, BEFORE ANY require() THAT CAN THROW ────────
// A whole-scope write must be asked for by name (the MODE=source lesson: it
// defaulted to baseballcardpedia and reported 13.14M rows). This gate sits
// ABOVE the @azure/cosmos and dist/ requires on purpose: a stale or absent
// `dist` made the refusal unreachable, and the job exited on a MODULE_NOT_FOUND
// that merely LOOKED like a refusal. The scope check needs no compiled code,
// so nothing about the build can decide whether it fires.
const SPORTS = String(process.env.SPORTS || process.env.SPORT || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
if (!SPORTS.length && !YEARS.length && SCOPE !== "all") {
  console.error("FATAL: no SPORTS and no YEARS. This would fold the ENTIRE catalog.");
  console.error("       Pass SPORTS=baseball and/or YEARS=2020,2021,... , or SCOPE=all to mean it.");
  process.exit(1);
}

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { moveCatalogRow } = require(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist", "services", "catalog", "catalogAuthority.service.js"));
const { productFamilyOf } = require(path.join(backend, "dist", "services", "catalog", "productSetKeys.js"));
const {
  cleanParallelSlug,
  identityKeyOf,
  printRunOf,
  decideChecklistNumberedFold,
  pickChecklistNumberedTarget,
  shardOfIdentity,
  DEFAULT_FORCE_AUTO_PREFIXES,
} = require(path.join(backend, "dist", "services", "catalog", "foldTwinRuleChecklistNumbered.js"));
const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));
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
const SHARD_SCOPE = runnerShardScope({ label: "fold-checklist-numbered-twins" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const RUN_MS = RUN_MINUTES * 60000;
// SPORTS / YEARS / SCOPE are parsed and enforced at the top of this file, above
// the requires. The runner exports SPORTS from its `sports` input as a COMMA
// LIST; taking only the first element (as fold-unnumbered-twins does) silently
// scopes a multi-sport dispatch to one sport.
const LIMIT = Number(process.env.LIMIT || 0);
const PROBE_SHARDS = process.env.PROBE_SHARDS === "true";
const FORCE_AUTO_PREFIXES = String(process.env.FORCE_AUTO_PREFIXES || DEFAULT_FORCE_AUTO_PREFIXES.join(","))
  .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
const SAMPLE_PINS = String(process.env.SAMPLE_PINS || "cpa-mh").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const f = (n) => Number(n).toLocaleString();
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const isChecklist = (source) => catalogAuthorityOf(String(source ?? "")) === "checklist";

/** Drew's two per-holding rulings, for the R2 contradiction report (report only). */
const R2_RULINGS = [
  { cardNumber: "cpa-ba", year: 2026, ruledSetKey: "bowman", who: "Antunez" },
  { cardNumber: "cpa-fa", year: 2025, ruledSetKey: "bowman", who: "Arias" },
];

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps"), portfolio = db.container("portfolio");

  // ── banner: name the scope out loud ───────────────────────────────────────
  console.log(`fold-checklist-numbered-twins  MODE=checklist-numbered  ${APPLY ? "APPLY" : "REPORT ONLY -- nothing is written"}`);
  console.log(`  scope        sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}  years=${YEARS.length ? YEARS.join(",") : "(all)"}${SCOPE === "all" ? "  SCOPE=all" : ""}`);
  console.log(`  shard        slot ${SLOT}/${SLOTS}  on hash(identityKey) -- a whole identity group lands on ONE slot`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget       ${RUN_MINUTES}m   force-auto prefixes: ${FORCE_AUTO_PREFIXES.join(",")}`);
  console.log(`  NOTE         the catalog is MOVING under the D23 rename and D28 base-cards fleets;`);
  console.log(`               these counts are re-derived every run and will not reproduce exactly.`);

  // ── pass 1: GROUP BY identity key (not a base-id index) ───────────────────
  const where = ["STARTSWITH(c.id, \"hiq:\")", "NOT IS_DEFINED(c.gradeTier)"];
  const params = [];
  if (SPORTS.length) { where.push(`ARRAY_CONTAINS(@sports, c.sport)`); params.push({ name: "@sports", value: SPORTS }); }
  if (YEARS.length) { where.push(`ARRAY_CONTAINS(@years, c.year)`); params.push({ name: "@years", value: YEARS }); }
  const q = { query: `SELECT c.id, c.cardId, c.source, c.sport, c.year, c.setKey, c.cardNumber, c.parallelSlug, c.isAuto, c.printRun, c.playerName FROM c WHERE ${where.join(" AND ")}`, parameters: params };

  const groups = new Map(); // identityKey -> rows[]
  let rowsRead = 0, rowsOtherShard = 0;
  {
    const it = cat.items.query(q, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        rowsRead++;
        const key = identityKeyOf(r, FORCE_AUTO_PREFIXES);
        // Shard on the GROUP, so every row of one identity is on one worker.
        if (SLOTS > 1 && shardOfIdentity(key, SLOTS, sha1) !== SLOT) { rowsOtherShard++; continue; }
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
    }
  }
  console.log(`\n  pass 1: ${f(rowsRead)} non-graded rows read; ${f(rowsOtherShard)} belong to other slots; ${f(groups.size)} identity groups on this slot`);

  if (PROBE_SHARDS) {
    // Read-only shard-balance probe: PROVE the axis is balanced and reaches
    // every slot BEFORE a fleet is dispatched (the setKey-range lesson -- 89%
    // of a retire on one worker and 66,711 rows unreachable).
    //
    // Run this at SLOTS=1 so the group set is UNSHARDED, and set PROBE_SLOTS
    // to the fleet width you intend to dispatch. Probing at the same SLOTS the
    // run is sharded by would only ever show one non-empty slot.
    const probeSlots = Number(process.env.PROBE_SLOTS || 8);
    const counts = new Array(probeSlots).fill(0);
    for (const key of groups.keys()) counts[shardOfIdentity(key, probeSlots, sha1)]++;
    const total = groups.size || 1;
    console.log(`\n  SHARD PROBE over ${f(groups.size)} identity groups, modelling a ${probeSlots}-slot fleet:`);
    if (SLOTS > 1) console.log(`    WARNING: this run is itself sharded at SLOTS=${SLOTS}; probe at SLOTS=1 for a true picture.`);
    counts.forEach((c, i) => console.log(`    slot ${i}  ${String(f(c)).padStart(10)}  ${(100 * c / total).toFixed(2)}%`));
    console.log(`    max slot share ${(100 * Math.max(...counts) / total).toFixed(2)}%  (ideal ${(100 / probeSlots).toFixed(2)}%; empty slots: ${counts.filter((c) => c === 0).length})`);
  }

  // ── pass 2: per group, pick the checklist /N and fold every non-checklist twin
  const stats = {
    groups: 0, groupsWithFold: 0, noChecklistNumbered: 0, ambiguous: 0,
    twinsFolded: 0, unnumberedTwin: 0, respelledSamePrintRun: 0, noAutoGhost: 0, rivalPrintRun: 0,
    twinIsChecklist: 0, twinIsTarget: 0, differentIdentity: 0,
    salesRepointed: 0, salesRelocated: 0, salesRelocateFailed: 0,
    gradedRetired: 0, holdingsRepointed: 0, holdingDocsWalked: 0, holdingsWalked: 0,
    survivorNotIncumbent: 0, failed: 0, notReached: 0,
  };
  const byFamily = new Map();  // family -> { groups, twins, unnumbered, differentN, ghost }
  const byKind = { "unnumbered-twin": 0, "respelled-same-print-run": 0, "no-auto-ghost": 0 };
  const samples = [], pinnedSamples = [], rivalSamples = [];
  const r2Contradictions = [];
  let stopReason = null;

  const bump = (family, field) => {
    const e = byFamily.get(family) ?? { groups: 0, twins: 0, "unnumbered-twin": 0, "respelled-same-print-run": 0, "no-auto-ghost": 0 };
    e[field] = (e[field] ?? 0) + 1;
    byFamily.set(family, e);
  };

  // Walk the holdings map ONCE, before any fold.
  const holdingsIndex = await buildHoldingsIndex(portfolio, stats);

  // PINNED GROUPS GO FIRST. The pinned case is the one a human reads the report
  // to check, so it must not be a hostage to where the budget happens to stop:
  // with 700k+ groups on a slot, an insertion-ordered walk left cpa-mh in
  // `notReached` and printed "hashes to another slot" -- which was not true at
  // SLOTS=1 and told the reader the opposite of what had happened. Ordering is
  // all this changes; every group is still examined exactly once.
  const isPinnedGroup = (rows) => rows.some((r) => SAMPLE_PINS.some((pin) => String(r.id).toLowerCase().includes(pin)));
  const ordered = [...groups].sort((a, b) => Number(isPinnedGroup(b[1])) - Number(isPinnedGroup(a[1])));

  let gi = 0;
  for (const [key, rows] of ordered) {
    if (LIMIT && gi >= LIMIT) { stats.notReached += groups.size - gi; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`; stats.notReached += groups.size - gi; break; }
    gi++;
    stats.groups++;

    const picked = pickChecklistNumberedTarget(rows, isChecklist);
    if ("skip" in picked) {
      if (picked.skip === "ambiguous") stats.ambiguous++; else stats.noChecklistNumbered++;
      continue;
    }
    const target = picked.target;
    const family = productFamilyOf(target.setKey) || String(target.setKey ?? "");

    // R2 contradiction report (read-only): a CPA row whose product-named
    // checklist disagrees with one of Drew's two per-holding rulings.
    for (const r of R2_RULINGS) {
      if (String(target.cardNumber ?? "").toLowerCase() === r.cardNumber && Number(target.year) === r.year
        && String(target.setKey ?? "").toLowerCase() !== r.ruledSetKey) {
        r2Contradictions.push(`  ${r.who} ${r.cardNumber} ${r.year}: ruling says setKey=${r.ruledSetKey}, the product-named checklist row is ${target.id} [${target.source}] setKey=${target.setKey}`);
      }
    }

    let foldedHere = 0;
    for (const twin of rows) {
      const d = decideChecklistNumberedFold({
        target, twin,
        targetIsChecklist: isChecklist(target.source),
        twinIsChecklist: isChecklist(twin.source),
        forceAutoPrefixes: FORCE_AUTO_PREFIXES,
      });
      if (!d.fold) {
        if (d.skip === "twin-is-checklist") stats.twinIsChecklist++;
        else if (d.skip === "twin-is-target") stats.twinIsTarget++;
        else if (d.skip === "different-identity") stats.differentIdentity++;
        else if (d.skip === "rival-print-run") {
          stats.rivalPrintRun++;
          if (rivalSamples.length < 20) rivalSamples.push(`  ${twin.id}  [${twin.source}] /${printRunOf(twin)}  vs checklist ${target.id} /${printRunOf(target)}`);
        }
        continue;
      }

      const line = `  ${twin.id}  [${twin.source}] -> ${target.id}  [${target.source}]  (${d.kind})`;
      if (SAMPLE_PINS.some((p) => String(twin.id).toLowerCase().includes(p))) { if (pinnedSamples.length < 20) pinnedSamples.push(line); }
      else if (samples.length < 20) samples.push(line);

      try {
        // Sales whose PARTITION KEY is the twin slug cannot be patched in
        // place; they are relocated. Everything else the move re-points.
        const relocated = await relocatePartitionKeyedSales(pool, twin.id, target.id, stats);

        const res = await moveCatalogRow(
          cat, twin, target.id, { printRun: printRunOf(target) },
          { reason: d.reason, dryRun: !APPLY, salesContainer: pool, retry },
        );
        // The target is checklist and the twin is not, so the checklist row's
        // fields MUST survive. Assert rather than assume.
        if (res?.survivor && res.survivor !== "incumbent") {
          stats.survivorNotIncumbent++;
          console.log(`  WARN survivor=${res.survivor} folding ${twin.id} -> ${target.id} (expected incumbent)`);
        }
        stats.twinsFolded++; foldedHere++;
        byKind[d.kind]++;
        bump(family, "twins"); bump(family, d.kind);
        if (d.kind === "unnumbered-twin") stats.unnumberedTwin++;
        else if (d.kind === "respelled-same-print-run") stats.respelledSamePrintRun++;
        else stats.noAutoGhost++;
        stats.salesRepointed += res?.salesRepointed ?? 0;
        stats.gradedRetired += res?.gradedChildrenRetired ?? 0;
        void relocated;

        await repointHoldings(portfolio, holdingsIndex, twin.id, target.id, stats);
      } catch (e) {
        stats.failed++;
        if (stats.failed <= 5) console.log(`  failed ${twin.id}: ${String(e.message).slice(0, 140)}`);
      }
    }
    if (foldedHere) { stats.groupsWithFold++; bump(family, "groups"); }
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  identity groups examined   ${f(stats.groups)}`);
  console.log(`  groups with a fold         ${f(stats.groupsWithFold)}`);
  console.log(`  no checklist /N            ${f(stats.noChecklistNumbered)}   <- nothing authoritative to fold onto`);
  console.log(`  ambiguous /N               ${f(stats.ambiguous)}   <- two checklist print runs; guessing is worse than the split`);
  console.log(`  ${APPLY ? "FOLDED" : "WOULD FOLD"}                 ${f(stats.twinsFolded)}`);
  console.log(`    un-numbered twin         ${f(stats.unnumberedTwin)}`);
  console.log(`    respelled, same /N       ${f(stats.respelledSamePrintRun)}   <- the half the old script cannot reach at all`);
  console.log(`    no-auto ghost            ${f(stats.noAutoGhost)}   <- CPA is auto by definition`);
  console.log(`  left alone: twin is checklist ${f(stats.twinIsChecklist)}  |  is the target ${f(stats.twinIsTarget)}  |  different identity ${f(stats.differentIdentity)}`);
  console.log(`  RIVAL /N (reported, NOT folded) ${f(stats.rivalPrintRun)}   <- a real second print run is a second card; a human rules on these`);
  console.log(`  sales re-pointed (patch)   ${f(stats.salesRepointed)}`);
  console.log(`  sales relocated (re-key)   ${f(stats.salesRelocated)}   <- partition key was the twin slug; upsert-verify-delete`);
  console.log(`  sales relocate failed      ${f(stats.salesRelocateFailed)}`);
  console.log(`  graded children retired    ${f(stats.gradedRetired)}`);
  console.log(`  holdings re-pointed        ${f(stats.holdingsRepointed)}   (walked ${f(stats.holdingsWalked)} holdings across ${f(stats.holdingDocsWalked)} portfolio docs)`);
  console.log(`  survivor != incumbent      ${f(stats.survivorNotIncumbent)}   <- must be 0: the checklist row's fields survive`);
  console.log(`  failed                     ${f(stats.failed)}`);
  console.log(`  not reached                ${f(stats.notReached)}`);

  console.log(`\n  by KIND:`);
  for (const [k, v] of Object.entries(byKind)) console.log(`    ${k.padEnd(26)} ${String(f(v)).padStart(10)}`);

  console.log(`\n  by PRODUCT FAMILY (groups / twins / un-numbered / respelled-same-N / ghost):`);
  const fams = [...byFamily.entries()].sort((a, b) => b[1].twins - a[1].twins);
  for (const [fam, e] of fams.slice(0, 40)) {
    console.log(`    ${String(fam || "(none)").padEnd(28)} ${String(f(e.groups)).padStart(8)} ${String(f(e.twins)).padStart(9)} ${String(f(e["unnumbered-twin"])).padStart(11)} ${String(f(e["respelled-same-print-run"])).padStart(16)} ${String(f(e["no-auto-ghost"])).padStart(7)}`);
  }
  if (fams.length > 40) console.log(`    ... and ${f(fams.length - 40)} more families`);

  if (pinnedSamples.length) {
    console.log(`\n  PINNED SAMPLE (${SAMPLE_PINS.join(",")}) -- the case Drew named:`);
    for (const s of pinnedSamples) console.log(s);
  } else {
    console.log(`\n  PINNED SAMPLE (${SAMPLE_PINS.join(",")}): no fold${SLOTS > 1 ? " on this slot (the group may hash to another slot)" : ""} -- the group is already folded, or holds no foldable twin.`);
  }
  if (samples.length) { console.log(`\n  other samples:`); for (const s of samples) console.log(s); }

  if (rivalSamples.length) {
    console.log(`
  RIVAL /N SAMPLES (reported only -- these are NOT folded; two real print runs are two cards):`);
    for (const r of rivalSamples) console.log(r);
  }

  if (r2Contradictions.length) {
    console.log(`\n  R2 CONTRADICTION REPORT (read-only -- nothing applied, ${f(r2Contradictions.length)} case(s)):`);
    for (const c of [...new Set(r2Contradictions)]) console.log(c);
  } else {
    console.log(`\n  R2 CONTRADICTION REPORT: no case on this slot contradicts Drew's two per-holding rulings.`);
  }

  if (APPLY) {
    // DISJOINT counters. Sub-totals of `written` go on their own line and are
    // never folded into `skipped` -- a slice is not a sibling counter.
    reportWrites({
      job: "fold-checklist-numbered-twins",
      intended: stats.twinsFolded + stats.noChecklistNumbered + stats.ambiguous + stats.twinIsChecklist + stats.twinIsTarget + stats.differentIdentity + stats.rivalPrintRun + stats.failed,
      written: stats.twinsFolded,
      skipped: stats.noChecklistNumbered + stats.ambiguous + stats.twinIsChecklist + stats.twinIsTarget + stats.differentIdentity + stats.rivalPrintRun,
      failed: stats.failed,
    });
    console.log(`  written sub-totals (not skipped): un-numbered ${f(stats.unnumberedTwin)} | respelled-same-/N ${f(stats.respelledSamePrintRun)} | ghost ${f(stats.noAutoGhost)}`);
    console.log(`  collateral (not rows written): sales patched ${f(stats.salesRepointed)} | sales relocated ${f(stats.salesRelocated)} | graded retired ${f(stats.gradedRetired)} | holdings ${f(stats.holdingsRepointed)}`);
  }
  if (stopReason) console.log(`\n${stopReason}`);
}

/**
 * Sales whose PARTITION KEY is the twin's slug. moveCatalogRow patches
 * /hobbyiqCardId in place on (id, cardId), which cannot move a row across
 * partitions -- so these are re-keyed through relocate-sold-comp
 * (upsert -> verify read-back -> delete) BEFORE the move runs, and counted on
 * their own line.
 */
async function relocatePartitionKeyedSales(pool, twinId, targetId, stats) {
  let n = 0;
  const it = pool.items.query(
    { query: "SELECT * FROM c WHERE c.cardId = @t", parameters: [{ name: "@t", value: twinId }] },
    { partitionKey: twinId, maxItemCount: 200 },
  );
  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources ?? []) {
      const keep = { ...stripSystem(row), cardId: targetId, hobbyiqCardId: targetId, reslugedFrom: twinId, reslugedReason: "R1 fold onto the checklist numbered row", reslugedAt: new Date().toISOString() };
      keep.contentHash = contentHashOf(keep);
      const res = await relocateSoldComp(pool, { keep, drop: [{ id: row.id, cardId: twinId }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY });
      if (res.ok) { stats.salesRelocated++; n++; } else { stats.salesRelocateFailed++; }
    }
  }
  return n;
}

/**
 * Build the holdings index ONCE: twin id -> [{ docId, userId, holdingId }].
 *
 * portfolio.holdings is a MAP, so this walks Object.values(doc.holdings) and
 * never `JOIN h IN c.holdings`. Indexing once rather than re-scanning every
 * portfolio doc per fold is the difference between one pass and tens of
 * thousands. It prints what it walked and refuses on zero docs.
 */
async function buildHoldingsIndex(portfolio, stats) {
  const index = new Map();
  const it = portfolio.items.query(
    { query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" },
    { maxItemCount: 100 },
  );
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

/** Re-point every holding that points at the folded twin. */
async function repointHoldings(portfolio, holdingsIndex, twinId, targetId, stats) {
  const hits = holdingsIndex.get(twinId);
  if (!hits || !hits.length) return;
  const byDoc = new Map();
  for (const h of hits) {
    const k = `${h.docId}|${h.userId}`;
    const list = byDoc.get(k) ?? { docId: h.docId, userId: h.userId, ids: new Set() };
    list.ids.add(h.holdingId);
    byDoc.set(k, list);
  }
  for (const { docId, userId, ids } of byDoc.values()) {
    const ops = [];
    for (const hid of ids) {
      ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: targetId });
      ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: targetId });
    }
    if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
    stats.holdingsRepointed += ids.size;
  }
  // The twin is gone; anything still indexed under it now lives at the target.
  holdingsIndex.delete(twinId);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
