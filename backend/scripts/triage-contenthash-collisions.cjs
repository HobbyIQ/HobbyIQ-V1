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
 * So this script re-derives EXACTLY the population D30 refuses over -- the same
 * groupKeyOf grouping, the same shardOfIdentity axis, the same salesUnder()
 * width, the same contentHashOf against the WINNER's partition -- and emits one
 * classified line per collision group. It is the report that unblocks the folds.
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

const MODES = ["report", "apply-true-dupes"];
const MODE = String(process.env.MODE || "report").trim().toLowerCase();
if (!MODES.includes(MODE)) {
  console.error(`FATAL: MODE="${MODE}" is not one of: ${MODES.join(", ")}`);
  console.error("       report            classify every collision, write nothing (default)");
  console.error("       apply-true-dupes  additionally flag the TRUE-DUPE rows this run proved");
  process.exit(1);
}

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const D = (...p) => require(path.join(backend, "dist", ...p));
const { shardOfIdentity, DEFAULT_FORCE_AUTO_PREFIXES } = D("services", "catalog", "foldTwinRuleChecklistNumbered.js");
const { groupKeyOf } = D("services", "catalog", "duplicateWinnerRule.js");
const { reportWrites } = D("services", "ops", "writeReconciliation.js");
const { contentHashOf, legacyContentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
const { classifyCollision } = require(path.join(backend, "scripts", "lib", "collision-triage.cjs"));

// BACKFILL_APPLY alone is NOT enough: the write mode must ALSO be named. A
// runner dispatch that carries apply=true for some other lane cannot turn a
// report into a write by accident.
const APPLY = (process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true") && MODE === "apply-true-dupes";
const SLOT = Number(process.env.SLOT || 0), SLOTS = Number(process.env.SLOTS || 1);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
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
  console.log(`  shard        slot ${SLOT}/${SLOTS}  on hash(groupKey) -- the SAME axis D30 shards on, so slot N here reads slot N's groups there`);
  console.log(`  budget       ${RUN_MINUTES}m`);
  console.log(`  classes      TRUE-DUPE (shared sourceExternalId) | DISTINCT-CARDS (ids differ + identity differs) | AMBIGUOUS (neither -> Drew)`);
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
  // The winner is not decided here -- deciding it is duplicateWinnerRule's job
  // and D30's. For the purpose of a HASH collision the winner only supplies the
  // partition the rows are hashed against, and every row in the group lands in
  // the same one, so the LONGEST id (the most specific address) is a stable
  // stand-in that never changes which rows collide.
  const stats = { groups: 0, multiRow: 0, groupsWithCollisions: 0, collisions: 0, salesProbed: 0, notReached: 0,
    trueDupe: 0, distinctCards: 0, ambiguous: 0, rowsToFlag: 0, rowsToRelocate: 0, legacyOnly: 0,
    flagged: 0, alreadyFlagged: 0, flagFailed: 0 };
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

    const winnerId = [...rows].map((r) => String(r.id)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];

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
    for (const r of rows) {
      for (const sale of await salesUnder(pool, String(r.id))) {
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
      } else if (verdict.class === "DISTINCT-CARDS") {
        stats.distinctCards++;
        stats.rowsToRelocate += verdict.relocate.length;
        finding.axes = verdict.axes;
        finding.relocate = verdict.relocate.map((r) => ({ id: r.id, from: r.hobbyiqCardId ?? null, trueSlug: trueSlugOf(r, winnerId) }));
        for (const a of verdict.axes) {
          console.log(`    COLLAPSED AXIS  ${a.field}: ${a.values.map((v) => JSON.stringify(v)).join("  vs  ")}`);
        }
        for (const r of verdict.relocate) {
          console.log(`    RELOCATE  ${r.id}  [${r.source}]  ext=${r.sourceExternalId}`);
          console.log(`              parallel=${JSON.stringify(r.parallel)}  #${r.cardNumber ?? "-"}  $${r.price}  ${r.soldAt}`);
          console.log(`              from ${r.hobbyiqCardId ?? "(none)"}`);
          console.log(`              ->   ${trueSlugOf(r, winnerId)}   (D31 lane: move, never delete)`);
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
  console.log(`  groups WITH collisions     ${f(stats.groupsWithCollisions)}`);
  console.log(`  COLLISIONS                 ${f(stats.collisions)}   <- the number D30's pre-flight refuses on`);
  console.log(`    of which legacy-only     ${f(stats.legacyOnly)}   <- collide only on the PRE-D31 hash; D31 already parts every future write`);
  console.log(`  not reached                ${f(stats.notReached)}`);
  console.log(`\n  BY CLASS (clusters):`);
  console.log(`    TRUE-DUPE                ${f(stats.trueDupe)}   rows to flag     ${f(stats.rowsToFlag)}`);
  console.log(`    DISTINCT-CARDS           ${f(stats.distinctCards)}   rows to relocate ${f(stats.rowsToRelocate)}   <- D31 lane, NEVER flagged`);
  console.log(`    AMBIGUOUS                ${f(stats.ambiguous)}   -> Drew`);
  const clusters = stats.trueDupe + stats.distinctCards + stats.ambiguous;
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
      scope: { sports: SPORTS, years: YEARS, scope: SCOPE || null, slot: SLOT, slots: SLOTS, mode: MODE, applied: APPLY },
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
 * The slug a DISTINCT-CARDS row should live at: its current partition-mate's
 * address with the row's OWN raw parallel restored. This NAMES a target for the
 * D31 relocation lane; it does not perform one, and it never mints a catalog
 * row (a sale never mints a row). Where the row already carries a slug that
 * differs from the group's winner, that slug is the answer and is left alone.
 */
function trueSlugOf(row, winnerId) {
  const own = String(row?.hobbyiqCardId ?? "");
  if (own && own !== winnerId && !own.startsWith(`${winnerId}:`)) return `${own}   (already distinct -- verify against the checklist)`;
  const parallel = String(row?.parallel ?? "").trim();
  if (!parallel) return `${winnerId}   (no raw parallel to distinguish it -- needs a checklist ruling)`;
  const slug = parallel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const segs = String(winnerId).split(":");
  // hiq:<sport>:<year>:<setKey>:<cardNumber>:<parallel>:<auto> -- replace the
  // parallel segment, which is what the retracted strip collapsed.
  if (segs.length >= 6) { segs[5] = slug; return segs.join(":"); }
  return `${winnerId}#parallel=${slug}`;
}

main().catch((e) => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
