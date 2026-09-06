#!/usr/bin/env node
/**
 * repair-cpa-draft-refile.cjs -- the 2023-2025 Bowman DRAFT CPA rows return to
 * `bowman-draft`.
 *
 * CF-CPA-IS-AMBIGUOUS-FROM-2023 (#1824, Drew 2026-09-05).
 *
 * ── WHAT #1824 FIXED, AND WHAT THIS MOVES ──────────────────────────────────
 *
 * #1824 stopped the MINT: `CHROME_PREFIX_OVERRIDES`' CPA- rule now carries
 * `maxYear: 2022`, because Bowman DRAFT began numbering its chrome prospect
 * autos CPA- in 2023. Nothing new lands in the wrong product.
 *
 * It moved NOTHING already stored. Measured read-only 2026-09-05, over
 * baseball 2023-2025, CPA- numbers on `bowman-chrome` / `bowman-draft` stems:
 *
 *   CATALOG    43,273 rows in scope, and only TEN are wrong -- 1 in 2024 and
 *              9 in 2025, every one of them `ingest-auto-seed`, each carrying
 *              a setName that says "Bowman Draft Chrome" over a chrome stem.
 *              The checklist ingests pass `authoritativeSetKey` and never
 *              consulted the override, so they were never damaged by it.
 *
 *   SALES      175,315 CPA sales sit on a `bowman-chrome` stem, and 20,083 of
 *              them name a player that a bowman-draft checklist claims and no
 *              bowman-chrome checklist does:
 *
 *                  year   scanned   MOVE     PARK    REFUSED   orphan
 *                  2023    24,493      0        0      2,075   15,676
 *                  2024    58,040  8,638      626      5,691   24,458
 *                  2025    92,782 11,445    2,412      9,002   42,962
 *
 * That asymmetry is the whole design. Every vendor title saying only "Bowman"
 * went through the broken override; the checklists never did. So this lane is
 * SALES-FIRST -- the reverse of `repair-bowman-product-refile`, whose catalog
 * lane had to run first to stop a drifted catalog answering the sale-side
 * question wrongly. Here the catalog is already telling the truth, which is
 * precisely why the sale side can be adjudicated against it today.
 *
 * 2023 measures ZERO moves and is still IN SCOPE: it is the year the override
 * became wrong, and a run that reports zero over it is the evidence that the
 * boundary #1824 chose is the right one. Its 2,075 refusals are ordinary
 * initials collisions inside Chrome itself, not this defect.
 *
 * ── THE PRINT-RUN SEGMENT IS WHY THE AXIS GUARD EARNS ITS KEEP ─────────────
 *
 * 3,238 of the 2025 sales plan a destination the axis guard REFUSES, and the
 * shape is always the same (measured: 11,905 rows are `8->7`, 4 are `7->8`):
 *
 *     OLD  hiq:baseball:2025:bowman-chrome:cpa-mm:refractor:auto:num-499
 *     NEW  hiq:baseball:2025:bowman-draft:cpa-mm:refractor:auto
 *
 * The stored slug carries `:num-499`, but the SALE ROW's `printRun` field is
 * undefined -- the print run lives in the id and nowhere else -- so the
 * re-mint cannot reproduce it and drops the segment. Moving that row would
 * pour a /499 card into the UNNUMBERED pool, which is D31's "different print
 * runs are different cards" defect wearing this lane's clothes.
 *
 * `onlyProductSegmentMoves` refuses every one of them by name. That is the
 * guard working, not a gap: those rows need the print run recovered from
 * their own slug before they can move, and that is a separate pass with its
 * own evidence. Left alone, they stay exactly where they are.
 *
 * ── THE ORPHANS ARE NOT THIS LANE'S POPULATION ─────────────────────────────
 *
 * 83,096 of the sales point at a catalog address that does not exist. That is
 * a real defect and it is NOT repaired here: an orphan whose player no
 * checklist names cannot be re-filed onto anything without minting an identity
 * from a sale. They are COUNTED and reported so the number is on the record,
 * and they leave with a named skip.
 *
 * ── THE ABSOLUTE GUARD ─────────────────────────────────────────────────────
 *
 * 45 CPA numbers (23 in 2024, 22 in 2025) name two DIFFERENT players across
 * the two products -- 2024 cpa-dj is Dawel Joseph in Chrome and Dakota Jordan
 * in Draft. Drew, 2026-09-05: "a sale on a collision number with no readable
 * player PARKS"; "never move a row onto a different player's address".
 *
 * `planCrossProductSale` refuses BY NAME and the report carries both names.
 * The collision set is DERIVED from the checklist claim maps, never typed --
 * a hardcoded list goes stale the moment a checklist lands.
 *
 * ── THE SCOPE AXIS: A TRIPLE, NEVER `all` ──────────────────────────────────
 *
 * CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME. `sport:year:fromKey>toKey`, comma
 * separated. The old pair grammar names no destination and is REFUSED, as are
 * the runner's inherited `refractor`, `all`, and an empty scope.
 *
 *   SCOPE=baseball:2025:bowman-chrome>bowman-draft
 *
 * This does NOT overlap `repair-bowman-product-refile`, which is running over
 * `baseball:2026:bowman-chrome`: different years, different axis (that lane
 * repairs a field/stem drift; these rows' field and stem AGREE and are both
 * wrong).
 *
 * ── THE WRITE ──────────────────────────────────────────────────────────────
 *
 * REPORT ONLY unless BACKFILL_APPLY=true (the runner exports BACKFILL_APPLY,
 * not APPLY -- read the banner). Sales go through `relocateSoldComp` -- upsert,
 * read back, THEN delete (CF-A-SALE-IS-NEVER-LOST, D19). Catalog rows go
 * through `moveCatalogRow`. Canary anchors are counted on BOTH keys before and
 * after, and a REPORT-mode run that moved a pool exits 3.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     REQUIRED -- comma-separated sport:year:from>to
 *   MODE                      sales | catalog | both (default both)
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   LIMIT / SLOT / SLOTS / CONCURRENCY / RUN_MINUTES
 * Requires dist/ (hobbyIqCardId, catalogRowOps).
 */
"use strict";

const path = require("path");
const backend = path.resolve(__dirname, "..");

const X = require(path.join(__dirname, "lib", "cross-product-refile.cjs"));
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
const MODE = lower(process.env.MODE || "both");

// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS (#1803). A UNIT here is one sale: a
// pure plan over already-loaded claim maps, then one relocateSoldComp (upsert,
// read-back, delete). 90s of reserve is generous for that unit and is checked
// BEFORE it, so a unit costing more than the reserve is never STARTED past
// expiry. The post-loop work is the canary re-read -- a handful of COUNT(1)
// aggregates -- which sits under its own cap and prints UNCONFIRMED rather
// than holding the step open to the runner's ceiling.
//
// 110m loop + 90s reserve + 5m verify + 1m startup = ~117.5m against the
// runner's 150m ceiling: 32m of margin.
// The budget stated so the margin is COMPUTABLE from the source. #1803's pin
// reads a literal default; burying it in `budget({ minutes: Number(...) })`
// made this lane's worst case unreadable and the margin unprovable. Same value,
// same override, a spelling the pin can parse.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });

const SHARD_SCOPE = runnerShardScope({ label: "repair-cpa-draft-refile" });

// THE SCOPE. `sport:year:fromKey>toKey`; the runner's inherited defaults are
// REFUSED, and so is the old pair grammar -- it names no destination.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const SCOPE_TRIPLES = RAW_SCOPE.map((s) => X.parseScopeTriple(s)).filter(Boolean);
const SCOPE_REJECTED = RAW_SCOPE.filter((s) => !X.parseScopeTriple(s));

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

async function forEachPage(container, spec, onPage, pageSize = 500) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, maxDegreeOfParallelism: 1, bufferItems: false, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

// CF-A-MOVE-LANE-SHARDS-BY-CARD-NOT-BY-ROW (2026-09-05). The unit is the CARD,
// not the row: a graded child `${parent}:${tier}` starts with the same id stem
// this lane scans, so hashing the ROW scattered one card's parent, its children
// and its destination across up to five slots while moveCatalogRow was
// re-pointing that card's sales and retiring those same children.
const shardIndex = (id) => cardShardIndex(id, SHARD_SCOPE.SLOTS);

/** User-verified and ruled rows are report-only forever. */
const isProtectedRow = (r) =>
  r?.userVerified === true || r?.ruled === true || lower(r?.source) === "user-verified"
  || lower(r?.source).startsWith("holding-");

function banner() {
  return [
    "repair-cpa-draft-refile — CF-CPA-IS-AMBIGUOUS-FROM-2023 (#1824)",
    `  MODE            ${MODE}`,
    `  SCOPE           ${SCOPE_TRIPLES.map((t) => t.raw).join(", ") || "(none)"}`,
    `  WRITE           ${APPLY ? "APPLY — moves sold_comps rows and catalog rows" : "REPORT ONLY — nothing is written"}`,
    `  SHARD           slot ${SHARD_SCOPE.SLOT} of ${SHARD_SCOPE.SLOTS}${SHARD_SCOPE.SHARDED ? "" : " (not sharded)"}`,
    `  CLOCK           ${CLOCK.describe()}`,
  ].join("\n");
}

async function main() {
  // ── THE SCOPE REFUSALS RUN FIRST ──────────────────────────────────────────
  if (SCOPE_REJECTED.length) {
    console.error(`::error::scope entries are not sport:year:fromKey>toKey — ${SCOPE_REJECTED.join(", ")}`);
    process.exit(2);
  }
  if (!SCOPE_TRIPLES.length || RAW_SCOPE.some((s) => INHERITED_SCOPES.has(lower(s)))) {
    console.error(
      "::error::repair-cpa-draft-refile requires scope = a comma-separated list of moves as "
      + `sport:year:fromKey>toKey. Got '${process.env.SCOPE ?? ""}' (the runner default 'refractor', 'all', an empty `
      + "scope, and the old sport:year:setKey pair — which names no destination — are all refused).",
    );
    process.exit(2);
  }
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("::error::COSMOS_CONNECTION_STRING not set");
    process.exit(2);
  }
  console.log(banner());
  console.log("");

  const { CosmosClient } = require("@azure/cosmos");
  const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const db = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const report = {
    pool: { scanned: 0, move: 0, moved: 0, orphan: 0, skip: {} },
    catalog: { scanned: 0, move: 0, moved: 0, failed: 0, skip: {} },
    refusals: [],
    parks: [],
    moves: [],
  };
  const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };
  const outOfTime = () => CLOCK.outOfClock();

  // ── CANARY ANCHORS, counted on BOTH keys BEFORE ───────────────────────────
  const canaryCount = async (prefix) => {
    const r = await retry(() => pool.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
      parameters: [{ name: "@p", value: prefix }],
    }, { maxDegreeOfParallelism: 1, bufferItems: false }).fetchAll());
    return (r.resources && r.resources[0]) || 0;
  };
  const canaries = [];
  for (const t of SCOPE_TRIPLES) {
    canaries.push(
      { label: `${t.year} ${t.fromKey}`, prefix: `hiq:${t.sport}:${t.year}:${t.fromKey}:cpa`, before: await canaryCount(`hiq:${t.sport}:${t.year}:${t.fromKey}:cpa`) },
      { label: `${t.year} ${t.toKey}`, prefix: `hiq:${t.sport}:${t.year}:${t.toKey}:cpa`, before: await canaryCount(`hiq:${t.sport}:${t.year}:${t.toKey}:cpa`) },
    );
  }
  console.log("CANARY ANCHORS (before):");
  for (const c of canaries) console.log(`  ${c.label.padEnd(28)} ${f(c.before)}`);
  console.log("");

  for (const t of SCOPE_TRIPLES) {
    if (outOfTime()) break;
    console.log(`── ${t.raw} ──`);

    // ── THE CLAIM MAPS. Read ONCE per key, checklist-backed rows only
    // (CF-COUNT-BY-SOURCE): a row the broken override itself minted cannot be
    // evidence about where the card belongs.
    const CHECKLIST = /^(beckett|checklistcenter|checklistinsider|sportscardchecklist|tcdb|cardboardchecklist|cardboardconnection|bccp|baseballcardpedia)/i;
    const claims = { from: new Map(), to: new Map() };
    const catalogPlayerAt = new Map(); // slug -> playerName, for the guard
    for (const [side, key] of [["from", t.fromKey], ["to", t.toKey]]) {
      await forEachPage(cat, {
        query: "SELECT c.id, c.cardNumber, c.playerName, c.source FROM c"
          + " WHERE STARTSWITH(c.id, @stem) AND IS_DEFINED(c.playerName) AND c.playerName != null",
        parameters: [{ name: "@stem", value: `hiq:${t.sport}:${t.year}:${key}:` }],
      }, async (rows) => {
        for (const r of rows) {
          if (str(r.id)) catalogPlayerAt.set(str(r.id), str(r.playerName));
          if (!CHECKLIST.test(lower(r.source))) continue;
          const n = X.foldNumber(r.cardNumber);
          const p = X.playerKey(r.playerName);
          if (!n || !p) continue;
          const s = claims[side].get(n) ?? new Set();
          s.add(p);
          claims[side].set(n, s);
        }
        return true;
      }, 1000);
    }
    // CF-THE-COLLISION-SET-IS-DERIVED-NEVER-TYPED.
    const COLLISION = X.deriveCollisionNumbers(claims.from, claims.to);
    console.log(`  claim maps: ${f(claims.from.size)} ${t.fromKey} numbers, ${f(claims.to.size)} ${t.toKey} numbers`);
    console.log(`  collision numbers derived: ${f(COLLISION.size)}${COLLISION.size ? ` (${[...COLLISION].slice(0, 8).join(", ")}${COLLISION.size > 8 ? ", …" : ""})` : ""}`);

    // ── LANE A: sold_comps — the population ───────────────────────────────
    if (MODE === "both" || MODE === "sales") {
      const stemPrefix = `hiq:${t.sport}:${t.year}:${t.fromKey}:cpa`;
      const sales = [];
      await forEachPage(pool, {
        query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,"
          + " c.playerName, c.setName, c.parallel, c.isAuto, c.printRun,"
          + " c.title, c.rawTitle, c.source, c.gradeCompany, c.gradeValue, c.price, c.soldAt,"
          + " c.userVerified, c.ruled FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
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
        const num = X.foldNumber(row.cardNumber) || X.foldNumber(String(row.hobbyiqCardId ?? "").split(":")[4]);
        const oldSlug = str(row.hobbyiqCardId ?? row.cardId);
        if (!catalogPlayerAt.has(oldSlug)) report.pool.orphan++;

        // The destination, through the LIVE deriver with the flag set. Never a
        // string this lane assembles -- a repair that builds its own slug is a
        // second minting path.
        let destSlug = null;
        if ((claims.to.get(num) ?? new Set()).size) {
          destSlug = computeHobbyIqCardId({
            sport: t.sport,
            year: Number(row.cardYear ?? t.year),
            setKey: t.toKey,
            cardNumber: row.cardNumber,
            parallel: row.parallel ?? "Base",
            isAuto: row.isAuto === true,
            printRun: typeof row.printRun === "number" ? row.printRun : null,
            authoritativeSetKey: true,
          }) || null;
        }

        const plan = X.planCrossProductSale({
          row,
          fromKey: t.fromKey,
          toKey: t.toKey,
          destSlug,
          destPlayerName: destSlug ? (catalogPlayerAt.get(destSlug) ?? null) : null,
          fromClaimPlayers: claims.from.get(num) ?? new Set(),
          toClaimPlayers: claims.to.get(num) ?? new Set(),
          isCollisionNumber: COLLISION.has(num),
          isProtected: isProtectedRow(row),
        });

        if (!plan.move) {
          bump(report.pool.skip, plan.reason);
          if (plan.reason === X.SKIP.DEST_DIFFERENT_PLAYER && report.refusals.length < 12) {
            report.refusals.push(`  ${plan.evidence.id}  ${plan.evidence.stem}:${plan.evidence.cardNumber}`
              + `  sale says "${plan.evidence.player}" · destination holds "${plan.evidence.destPlayer}" — REFUSED BY NAME`);
          }
          if (plan.reason === X.SKIP.PARK_COLLISION && report.parks.length < 12) {
            report.parks.push(`  ${plan.evidence.id}  ${plan.evidence.cardNumber}  no readable player on a collision number — PARKED`);
          }
          continue;
        }
        report.pool.move++;
        if (report.moves.length < 12) {
          report.moves.push(`  ${plan.evidence.player.padEnd(24)} ${plan.evidence.stem} -> ${t.toKey}  (${plan.evidence.cardNumber})`);
        }
        if (!APPLY) continue;

        // CF-A-SALE-IS-NEVER-LOST (D19): upsert the keeper, read it back, THEN
        // delete.
        const keeper = stripSystem(row);
        keeper.cardId = plan.dest;
        keeper.hobbyiqCardId = plan.dest;
        keeper.contentHash = contentHashOf(keeper);
        keeper.reslugedFrom = oldSlug;
        keeper.reslugedReason = X.REASON_LONG;
        keeper.reslugedAt = new Date().toISOString();
        keeper.reslugedEvidence = plan.evidence.title ?? null;

        const out = await relocateSoldComp(pool, {
          keep: keeper,
          drop: [{ id: row.id, cardId: row.cardId }],
          retry,
          verifyFields: ["hobbyiqCardId", "cardId", "reslugedFrom"],
        });
        if (out?.ok) report.pool.moved++;
        else bump(report.pool.skip, `relocate-failed:${out?.stage ?? "unknown"}`);
        if (out?.duplicatesLeft?.length) bump(report.pool.skip, `duplicate-left-in-pool:${out.duplicatesLeft.length}`);
      }
    }

    // ── LANE B: card_catalog — the ten ingest-auto-seed rows ──────────────
    if (MODE === "both" || MODE === "catalog") {
      const rows = [];
      await forEachPage(cat, {
        query: "SELECT c.id, c.setKey, c.setName, c.backingSetName, c.source, c.playerName,"
          + " c.cardNumber, c.parallelSlug, c.parallel, c.isAuto, c.printRun, c.year, c.cardYear,"
          + " c.userVerified, c.ruled FROM c WHERE STARTSWITH(c.id, @stem)"
          + " AND STARTSWITH(UPPER(c.cardNumber), 'CPA') AND NOT IS_DEFINED(c.gradeTier)",
        parameters: [{ name: "@stem", value: `hiq:${t.sport}:${t.year}:${t.fromKey}:` }],
      }, async (page) => {
        for (const r of page) {
          if (outOfTime()) return false;
          if (SHARD_SCOPE.SHARDED && shardIndex(r.id) !== SHARD_SCOPE.SLOT) continue;
          report.catalog.scanned++;
          rows.push(r);
        }
        return true;
      }, 1000);

      for (const row of rows) {
        if (outOfTime()) break;
        // The re-mint reads the row's OWN words, through the live deriver.
        let destSlug = null;
        const words = `${str(row.setName)} ${str(row.backingSetName)}`.toLowerCase();
        if (/\bdraft\b/.test(words)) {
          destSlug = computeHobbyIqCardId({
            sport: t.sport,
            year: Number(row.year ?? row.cardYear ?? t.year),
            setKey: t.toKey,
            cardNumber: row.cardNumber,
            parallel: row.parallel ?? row.parallelSlug ?? "Base",
            isAuto: row.isAuto === true,
            printRun: typeof row.printRun === "number" ? row.printRun : null,
            authoritativeSetKey: true,
          }) || null;
        }
        const plan = X.planCrossProductCatalogRow({
          row,
          fromKey: t.fromKey,
          toKey: t.toKey,
          destSlug,
          destPlayerName: destSlug ? (catalogPlayerAt.get(destSlug) ?? null) : null,
          isProtected: isProtectedRow(row),
        });
        if (!plan.move) {
          bump(report.catalog.skip, plan.reason);
          if (plan.reason === X.SKIP.DEST_DIFFERENT_PLAYER && report.refusals.length < 12) {
            report.refusals.push(`  ${plan.evidence.id}  catalog row says "${plan.evidence.player}"`
              + ` · destination holds "${plan.evidence.destPlayer}" — REFUSED BY NAME`);
          }
          continue;
        }
        report.catalog.move++;
        if (!APPLY) continue;
        try {
          await moveCatalogRow(cat, row, plan.dest, { setKey: t.toKey }, {
            reason: X.REASON_LONG,
            dryRun: false,
            salesContainer: pool,
            retry,
          });
          report.catalog.moved++;
        } catch (e) {
          report.catalog.failed++;
          bump(report.catalog.skip, `move-failed:${String(e?.message ?? e).slice(0, 60)}`);
        }
      }
    }
  }

  // ── THE REPORT ────────────────────────────────────────────────────────────
  console.log("");
  console.log("═══ POOL ═══");
  console.log(`  scanned            ${f(report.pool.scanned)}`);
  console.log(`  would move         ${f(report.pool.move)}${APPLY ? `   moved ${f(report.pool.moved)}` : ""}`);
  console.log(`  orphan addresses   ${f(report.pool.orphan)}   <- point at a catalog row that does not exist; NOT this lane's population`);
  for (const [k, v] of Object.entries(report.pool.skip).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(44)} ${f(v).padStart(9)}`);
  }
  console.log("");
  console.log("═══ CATALOG ═══");
  console.log(`  scanned            ${f(report.catalog.scanned)}`);
  console.log(`  would move         ${f(report.catalog.move)}${APPLY ? `   moved ${f(report.catalog.moved)}   failed ${f(report.catalog.failed)}` : ""}`);
  for (const [k, v] of Object.entries(report.catalog.skip).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(44)} ${f(v).padStart(9)}`);
  }

  if (report.moves.length) { console.log("\nmove examples:"); report.moves.forEach((e) => console.log(e)); }
  if (report.refusals.length) { console.log("\nREFUSED — a different player at the destination:"); report.refusals.forEach((e) => console.log(e)); }
  if (report.parks.length) { console.log("\nPARKED — a collision number with no readable player:"); report.parks.forEach((e) => console.log(e)); }

  // ── RECONCILE. CF-EVERY-WRITE-JOB-RECONCILES ──────────────────────────────
  const poolSkipped = Object.values(report.pool.skip).reduce((a, b) => a + b, 0);
  const catSkipped = Object.values(report.catalog.skip).reduce((a, b) => a + b, 0);
  const intended = report.pool.scanned + report.catalog.scanned;
  const written = report.pool.moved + report.catalog.moved;
  const wouldWrite = report.pool.move + report.catalog.move;
  console.log("");
  console.log("═══ RECONCILE ═══");
  console.log(`  intended ${f(intended)} = ${APPLY ? "written" : "would-write"} ${f(APPLY ? written : wouldWrite)}`
    + ` + skipped ${f(poolSkipped + catSkipped)} + failed ${f(report.catalog.failed)}`);

  // ── CANARY ANCHORS, re-read on BOTH keys AFTER ────────────────────────────
  console.log("\nCANARY ANCHORS (after):");
  let canaryMoved = 0;
  for (const c of canaries) {
    const after = await canaryCount(c.prefix);
    const delta = after - c.before;
    if (delta !== 0) canaryMoved++;
    console.log(`  ${c.label.padEnd(28)} ${f(c.before)} -> ${f(after)}   ${delta === 0 ? "unchanged" : (delta > 0 ? `+${f(delta)}` : f(delta))}`);
  }

  // A dry run is proven write-free by MEASUREMENT, not by intent.
  if (!APPLY && canaryMoved) {
    console.error(`::error::REPORT-mode run moved a pool — ${canaryMoved} canary anchor(s) changed. A dry run must be write-free.`);
    process.exit(3);
  }

  // CF-RELAUNCH-GATES-ON-THE-BUDGET-MARKER (#1361). The relaunch step greps
  // for this exact line, and it is printed ONLY when the clock actually
  // stopped the loop. A marker assembled unconditionally would re-dispatch a
  // finished slot forever.
  //
  // The lane is CONVERGENT: a moved sale now sits on `toKey`, so the next
  // run's `STARTSWITH(hobbyiqCardId, fromKey)` no longer returns it and the
  // relaunch resumes rather than repeating.
  console.log(`  REFILED to the product the checklist names   ${f(report.pool.moved + report.catalog.moved)}`);
  // THE MARKER IS A LITERAL, and must be. The runner's relaunch step for this
  // lane is keyed on "stopped at the … budget", and everyWriteJobReconciles
  // checks BOTH directions: a printer with no relaunch (the fleet stops
  // silently, green) and a relaunch whose script never prints the marker (it
  // waits for a line that never comes). Assembling the string at runtime
  // satisfied neither — the relaunch was keyed on a marker this source never
  // contained, so a budget stop would have ended the fleet mid-scope. Same
  // shape as the Bowman lane it was copied from.
  if (outOfTime()) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget — the slot has more to do`);
  }
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY — nothing was written"}`);

  // CF-EVERY-WRITE-JOB-RECONCILES. A lane that writes to Cosmos and reports no
  // ledger can finish green having written nothing, and nobody can tell.
  if (APPLY) {
    // DISJOINT counters: intended = written + skipped + failed, with no
    // sub-total counted twice. Anything planned that neither landed nor was
    // refused is `skipped` — the budget stopped the loop before it ran.
    const intended = report.pool.move + report.catalog.move;
    const written = report.pool.moved + report.catalog.moved;
    const failed = report.catalog.failed;
    reportWrites({
      job: "repair-cpa-draft-refile",
      intended,
      written,
      skipped: Math.max(0, intended - written - failed),
      failed,
    });
  }
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// This lane landed after #1828 rewrote the other 63 tails, so it shipped with
// the old bare `main().catch(...)` and was red in laneExitsWhenWorkIsDone from
// the moment it merged.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message || e);
    await finishLane(3);
  });
