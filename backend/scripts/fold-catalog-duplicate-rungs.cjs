#!/usr/bin/env node
/**
 * fold-catalog-duplicate-rungs.cjs -- PR #2377 unblock: the SAME card held
 * twice in card_catalog as two STRICT rows whose parallel slug differs only
 * by RESPELLING -- plural (`white-prizm` vs `white-prizms`) or product-word
 * order (`green-mosaic` vs `mosaic-green`, `prizms-orange` vs
 * `orange-prizm`). Census measured 301,115 such pairs across 60 big modern
 * cells (Prizm/Mosaic 25-48% of rows in those cells), and the split pool is
 * not merely untidy: the suffix repoint lane refused 54,413 sales in ONE
 * cell (basketball 2024 panini-prizm) as `catalog-duplicate-rung` because it
 * could not tell which of the two rows was the card's real address.
 *
 * #2377 (merged) put the CANONICAL FORM in the live deriver:
 * `normalizeParallel` / the private `foldParallelWordOrderToSuffix` inside
 * hobbyIqCardId.service.ts -- a closed, evidence-gated family-word list
 * (prizm, mosaic, optic, select, refractor), singular, SUFFIX, edge-only.
 * This lane NEVER re-implements that vocabulary: every canonical id is
 * computed by calling the REAL compiled `computeHobbyIqCardId`, so a future
 * change to the fold table changes this lane's answer for free and can never
 * drift from it.
 *
 * WHAT THIS SCRIPT DOES, MIRRORING fold-checklist-numbered-twins.cjs (R1):
 *
 *   pass 1  GROUP BY (setKey, cardNumber, isAuto, num- segment, sub segment,
 *           CANONICAL parallel slug) -- never by a literal id string, for the
 *           same reason R1 groups by identity: two respelled twins do not
 *           share an id prefix.
 *   pass 2  per group with >= 2 rows whose STORED ids differ, decide a
 *           SURVIVOR (the row whose stored id already equals the canonical
 *           id, else the highest-authority row is RE-KEYED onto it) and fold
 *           every other row onto it via moveCatalogRow -- copy, re-point
 *           sales, retire graded children, delete the loser LAST.
 *
 * SAFETY GATES, every one of them a REFUSAL that writes nothing when it does
 * not hold (never a best-effort fold):
 *
 *   same player       every row in the group names the same player
 *                     (`playerIdentityKey`; a multi-player row is compared as
 *                     a SET of keys, so "A, B" and "B, A" are one group but
 *                     "A, B" and "A, C" are not) -- else `different-player`.
 *   same print run    IS PART OF THE GROUP KEY (the num- segment), so a rival
 *                     /N is never grouped in the first place -- there is no
 *                     separate gate to bypass.
 *   never cross auto  isAuto is PART OF THE GROUP KEY -- an auto and a
 *                     no-auto row of the same number are never one group.
 *   user-verified     a `verifiedByUser` / user-seed-source row is never
 *                     deleted: if one is in the group it is the SURVIVOR (its
 *                     stored id becomes canonical via a re-key, never a
 *                     fold-away) or, when a DIFFERENT row already sits at the
 *                     canonical id, the group is refused
 *                     (`user-verified-not-survivor`) rather than delete the
 *                     protected row.
 *   holdings          moveCatalogRow itself does not touch portfolio.holdings
 *                     (checked: this file's own holdings index below is the
 *                     one built by fold-checklist-numbered-twins.cjs, walking
 *                     Object.values(doc.holdings), never a JOIN). A loser
 *                     with a live holding reference IS folded -- the holding
 *                     is re-pointed by this script the same way the sibling
 *                     lane does -- and the count of holdings touched is
 *                     reported on its own line so an operator can see the
 *                     blast radius; nothing is refused for carrying one.
 *   vendorIds/fields  moveCatalogRow already unions vendorIds and rebuilds
 *                     search fields on every fold (catalogRowOps.service.ts);
 *                     nothing here re-implements that. Any residual field
 *                     tidy-up on the surviving row goes through
 *                     `patchCatalogRowFields`, never a raw `.patch()`.
 *
 * SALES. Two shapes, both re-pointed BEFORE the loser's catalog row is
 * deleted (moveCatalogRow's own ORDER IS THE INVARIANT):
 *   - sales whose `hobbyiqCardId` names the loser slug but whose Cosmos
 *     PARTITION KEY (`cardId`) is something else entirely (a vendor id) are
 *     re-pointed by moveCatalogRow's own in-place patch (`salesContainer`).
 *   - sales whose PARTITION KEY (`cardId`) IS the loser slug cannot be
 *     patched across partitions; they go through `relocate-sold-comp.cjs`
 *     (upsert -> verify read-back -> delete), the SAME #2339 split-row guard
 *     and `ifMatchEtag` machinery fold-checklist-numbered-twins.cjs uses, and
 *     are counted on their own line (`salesRelocated`), never summed into
 *     `salesRepointed`.
 *
 * SHARDING, BUDGET, RELAUNCH, HEARTBEAT: identical conventions to
 * fold-checklist-numbered-twins.cjs (runner-shard-scope.cjs,
 * runner-budget.cjs's budget()/finishLane(), sha1(identityKey) % SLOTS so a
 * whole group lands on one worker).
 *
 * PLAN_OUT: one NDJSON record per fold-candidate GROUP (not per row), same
 * auditability doctrine as resolve-split-identity-parks.cjs -- see that
 * file's own header for the format this mirrors.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true|APPLY=true to write
 *      (report only by default); SCOPE=REQUIRED comma list of `sport:year`
 *      cells (e.g. basketball:2024) -- there is no whole-catalog sweep and
 *      the inherited defaults ('', 'refractor', 'all') are all REFUSED;
 *      TITLES=REQUIRED comma list of setKeys (e.g. panini-prizm) narrowing a
 *      SCOPE cell -- also refused when empty; SLOT/SLOTS (opt-in via
 *      SHARD=true for slot 0, sha1(identityKey) % SLOTS); CONCURRENCY=6
 *      by default (safe on a 10,000-RU sold_comps day, shared with
 *      production pricing reads; raise it with the dispatch `concurrency`
 *      input) -- bounded parallelism ACROSS groups, one group's own writes
 *      stay strictly ordered; see processGroup's header; auto-throttles to 2
 *      after 20 sale-lookup 429s in one run, see THROTTLE below;
 *      RUN_MINUTES=120; LIMIT=0; SCAN_LIMIT (the resume cursor:
 *      hop*1,000,000 + offset, same convention as route-backing-gaps.cjs's
 *      own RESUME -- rides the existing `scan_limit` dispatch input, no new
 *      one). THE OFFSET IS REPORT-ONLY: APPLY always rescans at offset 0
 *      every hop (a group an earlier hop folded no longer qualifies and
 *      drops out of the fresh scan on its own; slicing a REBUILT, POTENTIALLY
 *      RE-ORDERED corpus by a stale numeric offset would skip arbitrary
 *      never-folded groups, forever -- review finding, 2026-09-21). Only the
 *      hop count carries forward under APPLY, bounded by MAX_RESUME_HOPS.
 *      REPORT's offset is valid because `orderedGroups` is explicitly SORTED
 *      BY GROUP KEY before slicing (never relying on Map insertion order as
 *      an implicit contract); PLAN_OUT (fixed dir, wired by the runner).
 *
 * SPEED (review finding, 2026-09-20). The football/2024 panini-mosaic pilot
 * REPORT measured 3,197 groups in 120 minutes (~2.2s/group) though pass 1
 * cost only 4,850 RU -- the time was moveCatalogRow's own per-loser
 * CROSS-PARTITION queries (the sales `hobbyiqCardId` lookup and the graded-
 * children `STARTSWITH` scan), which the CF-REPORT-MUST-PREDICT-APPLY
 * contract runs under REPORT too (a real count, never a structural zero),
 * awaited ONE GROUP AT A TIME. Groups are independent by construction of
 * `groupKeyOf` (disjoint stored ids), so pass 2 now runs CONCURRENCY groups
 * at once -- no gate weakened, no write-order changed WITHIN a group, only
 * the wait between groups is overlapped.
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("crypto");

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const csv = (v) => str(v).split(",").map((x) => x.trim()).filter(Boolean);
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// ── THE SCOPE REFUSAL RUNS FIRST, BEFORE ANY require() THAT CAN THROW ────────
// Mirrors fold-checklist-numbered-twins.cjs's own top-of-file refusal: a
// whole-catalog write must be asked for by name, and this lane's SCOPE/TITLES
// contract additionally REQUIRES both -- there is no 'all' escape hatch at
// all, because 301,115 pairs across 60 cells is exactly the shape a mistaken
// full sweep would make expensive to undo blind.
const CELL_RE = /^[a-z][a-z-]*:\d{4}$/;
const RAW_SCOPE = csv(process.env.SCOPE);
const REJECTED_SCOPE = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const RAW_TITLES = csv(process.env.TITLES);

if (!RAW_SCOPE.length || REJECTED_SCOPE.length || !RAW_TITLES.length) {
  console.error("FATAL: fold-catalog-duplicate-rungs requires BOTH:");
  console.error("  SCOPE  a comma list of sport:year cells, e.g. SCOPE=basketball:2024");
  console.error("  TITLES a comma list of setKeys, e.g. TITLES=panini-prizm");
  console.error("There is no whole-catalog sweep for this lane -- the inherited runner");
  console.error("defaults ('', 'refractor', 'all') are all refused, and so is a scope");
  console.error("entry that is not a well-formed `sport:year` cell.");
  if (RAW_SCOPE.length) console.error(`  rejected scope entries: ${REJECTED_SCOPE.join(", ") || "(none well-formed)"}`);
  process.exit(1);
}

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
// patchCatalogRowFields is NOT imported: moveCatalogRow already unions
// vendorIds and rebuilds every search field (searchText/searchTokens/
// displayName) on every fold, per catalogRowOps.service.ts's own contract --
// there is no residual field tidy-up left for this lane to do with a raw
// patch, so patchCatalogRowFields has no call site here. If a future change
// needs one, it MUST go through patchCatalogRowFields, never a raw
// container.item().patch() on card_catalog.
const { moveCatalogRow } = require(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));
const { catalogAuthorityOf, authorityRank } = require(path.join(backend, "dist", "services", "catalog", "catalogAuthority.service.js"));
const { playerIdentityKey } = require(path.join(backend, "dist", "services", "catalog", "playerIdentityKey.js"));
const { computeHobbyIqCardId, normalizeParallel } = require(path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));
const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
// CF-THE-SCAN-AND-THE-WRITE-MUST-AGREE-ON-WHERE-A-ROW-LIVES (review finding,
// 2026-09-20). A row with no `cardId` field at all lives at Cosmos's own
// None partition key -- `moveCatalogRow`'s own delete now resolves that
// correctly (see catalogRowOps.service.ts's pkFor/deleteAndVerifyGone), but
// this LANE still refuses to fold or re-key a None-pk row at all: the
// population is exactly the user-verified/self-derived rows a census found
// carrying no cardId, and this fold is not the place to be the first mover
// on that address shape. isNonePkRow is the SAME predicate
// patchCatalogRowFields's own pkFor branches on.
const { isNonePkRow } = require(path.join(__dirname, "lib", "catalog-none-pk.cjs"));
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const SHARD_SCOPE = runnerShardScope({ label: "fold-catalog-duplicate-rungs" });
const { SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 5 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const PLAN_OUT = str(process.env.PLAN_OUT);

const STARTED = Date.now();
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS, startedAt: STARTED });

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const shardOfKey = (key) => (SLOTS > 1 ? parseInt(sha1(key).slice(0, 8), 16) % SLOTS : 0);
// THROTTLE COUNT (review finding, 2026-09-21): sold_comps is SHARED with
// production pricing reads, so a fold lane at CONCURRENCY=16 hammering it
// with per-loser cross-partition sale lookups is exactly the shape that
// starves a live customer-facing read. `throttleStats` is incremented every
// time `retry` (below, the ONE retry wrapper every Cosmos call in this file
// goes through) decides a call needs to be retried -- a 429/503/timeout is
// production-relevant contention this lane caused, whether or not the SDK's
// own retryOptions ALSO backed off underneath it. The banner and the
// heartbeat both report it, and the driving loop (see CONCURRENCY below)
// reads it to decide whether to throttle itself down.
const throttleStats = { count: 0, droppedTo2: false };
const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      throttleStats.count++;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};
const isChecklist = (source) => catalogAuthorityOf(String(source ?? "")) === "checklist";

/** REVIEW #5 parity with resolve-split-identity-parks.cjs / relocate-pool-
 *  rows-by-list.cjs: a human claim or the one user-seed mint path outranks
 *  anything this lane can compute, and a protected row is NEVER deleted. */
const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);
function isUserVerified(row) {
  return row?.verifiedByUser === true || USER_SEED_SOURCES.has(String(row?.source ?? ""));
}

/** The `:num-N` segment of a stored id, or "" (never numbered). PART OF THE
 *  GROUP KEY: a rival print run is a different card and must never share a
 *  group with this one, so there is no separate "same print run" gate to
 *  bypass -- the grouping itself makes a cross-/N fold unreachable. */
function numSegmentOf(id) {
  const m = String(id ?? "").match(/:num-(\d+)(?::|$)/);
  return m ? `num-${m[1]}` : "";
}

/** The `:sub-...` segment of a stored id, or "". Mirrors
 *  foldTwinRuleChecklistNumbered.ts's own `subsetSegmentOf`: a subset
 *  disambiguates cards the checklist itself says collide, and folding across
 *  it would recreate exactly the collision D-something's subset segment
 *  exists to prevent. */
function subSegmentOf(id) {
  const m = String(id ?? "").match(/^hiq:[^:]+:[^:]+:[^:]+:(sub-[^:]+):/);
  return m ? m[1] : "";
}

/** Every row's CANONICAL parallel slug, computed by calling the REAL
 *  compiled derivation -- never re-implemented. `computeHobbyIqCardId` throws
 *  on a genuinely underivable row (unknown sport, unparsed card number, a
 *  subset clash with no subsetName); such rows are reported as their own
 *  refusal class and never grouped, because a group keyed on a fallback
 *  string could silently merge with an unrelated one. */
function canonicalParallelOf(row) {
  const parallelText = row.parallel ?? row.parallelSlug ?? "";
  return normalizeParallel(String(parallelText));
}

function canonicalIdOf(row) {
  return computeHobbyIqCardId({
    sport: row.sport,
    year: Number(row.year ?? row.cardYear),
    setKey: row.setKey,
    cardNumber: row.cardNumber,
    parallel: row.parallel ?? row.parallelSlug ?? "",
    isAuto: row.isAuto === true,
    printRun: typeof row.printRun === "number" ? row.printRun : null,
    playerName: row.playerName ?? null,
    source: row.source ?? "",
    confidence: Number(row.confidence ?? 0),
    authoritativeSetKey: true,
    subsetInId: row.subsetInId === true,
    subsetName: row.subsetName ?? null,
    unnumberedByChecklist: row.unnumberedByChecklist === true,
  });
}

/** The group key: sport|year|setKey|cardNumber|isAuto|num-segment|sub-segment
 *  |CANONICAL-parallel. Every axis that must never be folded across (print
 *  run, auto, subset) is baked into the key itself, exactly as
 *  foldTwinRuleChecklistNumbered.ts's identityKeyOf does for R1 -- the
 *  grouping IS the safety gate for those three axes, not a filter applied
 *  after the fact. */
function groupKeyOf(row) {
  const sport = lower(row.sport);
  const year = str(row.year ?? row.cardYear);
  const setKey = lower(row.setKey);
  const cardNumber = lower(row.cardNumber);
  const auto = row.isAuto === true ? "auto" : "no-auto";
  const num = numSegmentOf(row.id);
  const sub = subSegmentOf(row.id);
  const canonicalParallel = canonicalParallelOf(row);
  return `${sport}|${year}|${setKey}|${cardNumber}|${auto}|${num}|${sub}|${canonicalParallel}`;
}

/** A multi-player row's name, reduced to a SET of playerIdentityKey keys so
 *  "A, B" and "B, A" compare equal (order-independent) while "A, B" and
 *  "A, C" do not. Splits on the same separators a multi-player checklist
 *  cell typically uses; a single-name row is a set of one. */
function playerKeySetOf(playerName) {
  const raw = String(playerName ?? "").trim();
  if (!raw) return new Set();
  const parts = raw.split(/\s*(?:,|&|\/|\+| and )\s*/i).map((p) => p.trim()).filter(Boolean);
  const keys = (parts.length ? parts : [raw]).map((p) => playerIdentityKey(p)).filter(Boolean);
  return new Set(keys);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Every row in a group names the same player (as a SET). One side missing a
 *  name entirely is NOT a disagreement (nothing to contradict), matching
 *  CF-A-FOLD-NEVER-CHANGES-THE-PLAYER's own "both must name someone" rule --
 *  but once two DIFFERENT non-empty sets appear in one group, the whole
 *  group refuses: a fold that changed a player because two of three rows
 *  agreed would still have changed the player on the third. */
function samePlayerAcross(rows) {
  let reference = null;
  for (const r of rows) {
    const keys = playerKeySetOf(r.playerName);
    if (keys.size === 0) continue;
    if (reference === null) { reference = keys; continue; }
    if (!setsEqual(reference, keys)) return false;
  }
  return true;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps"), portfolio = db.container("portfolio");
  const result = await runLane({ cat, pool, portfolio });
  return { client: db.client, ...result };
}

/**
 * The whole lane, parameterized on its three containers -- extracted from
 * `main()` so a test can hand it fakes instead of a real CosmosClient
 * (review finding, 2026-09-20: "measured before/after on your fake"). `main`
 * above is now the thin wrapper that builds the real client and calls this;
 * nothing about the lane's own logic, gates, or write order changed by this
 * extraction -- it is the SAME body, only its container arguments moved from
 * closed-over module state to explicit parameters.
 */
async function runLane({ cat, pool, portfolio }) {
  console.log(`fold-catalog-duplicate-rungs  ${APPLY ? "APPLY" : "REPORT ONLY -- nothing is written"}`);
  console.log(`  scope        cells=${SCOPE_CELLS.join(",")}  titles(setKeys)=${RAW_TITLES.join(",")}`);
  console.log(`  shard        slot ${SLOT}/${SLOTS}  on hash(groupKey) -- a whole group lands on ONE slot`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  if (PLAN_OUT) console.log(`  plan file    ${PLAN_OUT}/plan-slot-${SLOT}.ndjson`);

  // ── pass 1: read the cell's rows (strict + non-strict), GROUP BY identity ──
  const cells = SCOPE_CELLS.map((c) => {
    const [sport, yearStr] = c.split(":");
    return { sport, year: Number(yearStr) };
  });
  const setKeys = RAW_TITLES.map(lower);

  const groups = new Map(); // groupKey -> rows[]
  let rowsRead = 0, rowsOtherShardPre = 0, scanRU = 0;
  for (const { sport, year } of cells) {
    const q = {
      query: `SELECT c.id, c.cardId, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber,
                      c.parallel, c.parallelSlug, c.isAuto, c.printRun, c.playerName, c.confidence,
                      c.subsetInId, c.subsetName, c.unnumberedByChecklist, c.verifiedByUser
               FROM c
               WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
                 AND ARRAY_CONTAINS(@setKeys, LOWER(c.setKey))
                 AND NOT IS_DEFINED(c.gradeTier)`,
      parameters: [
        { name: "@sport", value: sport },
        { name: "@year", value: year },
        { name: "@setKeys", value: setKeys },
      ],
    };
    // FeedOptions per the task spec: maxItemCount 500 (NEVER -1 -- the SDK
    // spins on that value) and maxDegreeOfParallelism -1 (let the SDK choose
    // its own fan-out), matching backingCellPreloadRaw's own convention.
    const it = cat.items.query(q, { maxItemCount: 500, maxDegreeOfParallelism: -1 });
    // SYNCHRONOUS SPIN GUARD + IN-LOOP DEADLINE, mirroring
    // rematch-sold-comps.cjs's own backingCellPreloadRaw exactly: a
    // cross-partition query at maxDegreeOfParallelism:-1 can spin on
    // consecutive empty-AND-zero-RU pages without ever throwing on its own,
    // so this checks BOTH the wall clock and the empty-page streak on every
    // iteration, never inside a timer callback.
    const cellDeadlineAt = Date.now() + 10 * 60 * 1000;
    let consecutiveEmptyPages = 0;
    while (it.hasMoreResults()) {
      if (Date.now() > cellDeadlineAt) {
        throw new Error(`FOLD_CATALOG_DUPLICATE_RUNGS_TIMEOUT (in-loop deadline) reading ${sport}:${year}`);
      }
      const page = await retry(() => it.fetchNext());
      const resources = page.resources ?? [];
      const pageRU = page.requestCharge || 0;
      scanRU += pageRU;
      if (resources.length === 0 && pageRU === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 20) {
          throw new Error(`FOLD_CATALOG_DUPLICATE_RUNGS_SPIN_GUARD after ${consecutiveEmptyPages} consecutive empty pages: ${sport}:${year}`);
        }
      } else {
        consecutiveEmptyPages = 0;
      }
      for (const r of resources) {
        rowsRead++;
        let key;
        try {
          key = groupKeyOf(r);
        } catch (e) {
          // Should not happen -- groupKeyOf does no I/O and throws only via
          // canonicalParallelOf/numSegmentOf, neither of which throws. Kept
          // defensive so a future change to those helpers cannot crash the
          // whole scan; counted under a group of its own so it is visible.
          key = `__malformed__|${String(e?.message ?? e)}`;
        }
        if (SLOTS > 1 && shardOfKey(key) !== SLOT) { rowsOtherShardPre++; continue; }
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
    }
  }
  console.log(`\n  pass 1: ${f(rowsRead)} rows read across ${f(cells.length)} cell(s); ${f(rowsOtherShardPre)} belong to other slots; ${f(groups.size)} identity groups on this slot`);

  // ── pass 2: per group, decide fold or refuse ────────────────────────────────
  const stats = {
    groupsScanned: 0, groupsSingleRow: 0, groupsAlreadyOneId: 0, groupsCandidates: 0,
    groupsFolded: 0, rowsRemoved: 0, survivorsRekeyed: 0, survivorsAlreadyCanonical: 0,
    salesRepointed: 0, salesRelocated: 0, salesRelocateFailed: 0,
    gradedRetired: 0, holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    refusedDifferentPlayer: 0, refusedUserVerifiedNotSurvivor: 0, refusedCanonicalUnderivable: 0,
    refusedNonePartitionKeyRow: 0,
    failed: 0, notReached: 0,
  };
  const pairCounts = new Map(); // "loserSlug -> canonicalSlug" -> count
  const bumpPair = (loser, canon) => {
    const k = `${loser}\u0000${canon}`;
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
  };
  const refusals = { differentPlayer: [], userVerifiedNotSurvivor: [], canonicalUnderivable: [], nonePartitionKeyRow: [] };
  const failures = [];
  let stopReason = null;

  // Holdings index -- same shape as fold-checklist-numbered-twins.cjs: walk
  // Object.values(doc.holdings) once, never a JOIN, refuse on zero docs.
  const holdingsIndex = await buildHoldingsIndex(portfolio, stats);

  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      planFd = fs.openSync(path.join(PLAN_OUT, `plan-slot-${SLOT}.ndjson`), "w");
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

  /**
   * Decide and (under APPLY) write ONE group. Pure per-group logic, unchanged
   * from before this fix except for extraction into its own function -- every
   * gate, every counter, every plan row is byte-identical to what ran inline.
   * REPORT and APPLY run the SAME body; only `dryRun`/`apply` flags inside
   * moveCatalogRow/relocateSoldComp/the holdings patch decide whether a call
   * actually writes. No gate is skipped under REPORT: this is the
   * REPORT-MUST-PREDICT-APPLY contract, unchanged from the original PR.
   *
   * ORDER WITHIN ONE GROUP IS UNCHANGED AND SERIAL: survivor re-key (if any)
   * -> per loser, in order: sales re-point -> moveCatalogRow fold (which
   * itself re-points patchable sales, retires graded children, deletes the
   * loser LAST) -> holdings re-point. Concurrency is applied ACROSS groups
   * (the caller's batches), never WITHIN one -- a group is the unit of
   * atomicity, and two losers of the SAME survivor writing to it concurrently
   * would race moveCatalogRow's own read-incumbent-then-upsert step.
   */
  async function processGroup(key, rows) {
    stats.groupsScanned++;

    if (rows.length < 2) { stats.groupsSingleRow++; return; }

    const storedIds = new Set(rows.map((r) => String(r.id)));
    if (storedIds.size < 2) { stats.groupsAlreadyOneId++; return; } // already one address, nothing to fold

    stats.groupsCandidates++;

    // ── SAFETY GATE: same player on every row ─────────────────────────────
    if (!samePlayerAcross(rows)) {
      stats.refusedDifferentPlayer++;
      const names = [...new Set(rows.map((r) => String(r.playerName ?? "(blank)")))];
      const line = `  REFUSED different-player  group=${key}  players=${names.join(" | ")}  ids=${[...storedIds].join(", ")}`;
      if (refusals.differentPlayer.length < 40) refusals.differentPlayer.push(line);
      for (const r of rows) emitPlanRow({ action: "refused", reason: "different-player", groupKey: key, id: r.id, source: r.source ?? null });
      return;
    }

    // ── canonical id for this group, from the REAL deriver ────────────────
    // Every row in the group shares sport/year/setKey/cardNumber/isAuto/
    // printRun/canonical-parallel by construction (the group key), so any
    // one row's fields (preferring the highest-authority row so a checklist
    // row's own playerName/subset spelling drives the derivation) produce
    // the SAME canonical id.
    const byAuthority = [...rows].sort((a, b) => authorityRank(b.source) - authorityRank(a.source) || String(b.id).length - String(a.id).length);
    const template = byAuthority[0];
    let canonicalId;
    try {
      canonicalId = canonicalIdOf(template);
    } catch (e) {
      stats.refusedCanonicalUnderivable++;
      const line = `  REFUSED canonical-underivable  group=${key}  template=${template.id}  error=${String(e?.message ?? e)}`;
      if (refusals.canonicalUnderivable.length < 40) refusals.canonicalUnderivable.push(line);
      for (const r of rows) emitPlanRow({ action: "refused", reason: "canonical-underivable", groupKey: key, id: r.id, source: r.source ?? null });
      return;
    }

    // ── SURVIVOR RULE ──────────────────────────────────────────────────────
    // 1. a row whose STORED id already equals canonicalId needs no re-mint:
    //    it is the survivor and every other row folds onto it as-is.
    // 2. otherwise the HIGHEST-AUTHORITY row (ties broken by longer/more
    //    specific stored id, matching pickChecklistNumberedTarget's own
    //    tiebreak) is RE-KEYED onto canonicalId via moveCatalogRow, and every
    //    remaining row folds onto that newly-canonical address.
    // 3. a user-verified / user-seed row is NEVER deleted: if one exists and
    //    it is not already the chosen survivor, the WHOLE GROUP refuses --
    //    re-keying a protected row is fine (it keeps its content, just moves
    //    address), but folding it away as a loser is not.
    const verifiedRows = rows.filter(isUserVerified);
    let survivor = rows.find((r) => String(r.id) === canonicalId) ?? null;
    let survivorRule;
    if (survivor) {
      survivorRule = "stored-id-already-canonical";
    } else {
      survivor = byAuthority[0];
      survivorRule = "rekey-highest-authority";
    }

    if (verifiedRows.length && !verifiedRows.some((r) => r.id === survivor.id)) {
      stats.refusedUserVerifiedNotSurvivor++;
      const line = `  REFUSED user-verified-not-survivor  group=${key}  verified=${verifiedRows.map((r) => r.id).join(", ")}  chosen-survivor=${survivor.id}`;
      if (refusals.userVerifiedNotSurvivor.length < 40) refusals.userVerifiedNotSurvivor.push(line);
      for (const r of rows) emitPlanRow({ action: "refused", reason: "user-verified-not-survivor", groupKey: key, id: r.id, source: r.source ?? null });
      return;
    }

    // ── SAFETY GATE: no None-partition-key row in this group is ever deleted
    // or re-keyed by this lane ──────────────────────────────────────────────
    // CF-THE-SCAN-AND-THE-WRITE-MUST-AGREE-ON-WHERE-A-ROW-LIVES (review
    // finding, 2026-09-20). A row with no `cardId` field lives at Cosmos's
    // own None partition key -- catalogRowOps.service.ts's moveCatalogRow now
    // resolves that correctly for its OWN delete (pkFor/deleteAndVerifyGone),
    // but this lane still refuses to be the first mover on that address
    // shape: the population is exactly the user-verified/self-derived rows a
    // census found carrying no cardId, and a fold across product-word
    // respellings is not the operation that should also be the one moving a
    // None-pk row for the first time. The ONLY exception is a None-pk row
    // that is ALREADY the chosen survivor under rule 1 (its stored id already
    // equals the canonical id) -- nothing about it needs to move OR be
    // deleted in that case, so there is nothing this gate needs to protect.
    const nonePkRows = rows.filter(isNonePkRow);
    const nonePkNeedsMoveOrDelete = nonePkRows.some((r) => r.id !== survivor.id || survivorRule !== "stored-id-already-canonical");
    if (nonePkRows.length && nonePkNeedsMoveOrDelete) {
      stats.refusedNonePartitionKeyRow++;
      const line = `  REFUSED none-partition-key-row  group=${key}  none-pk-ids=${nonePkRows.map((r) => r.id).join(", ")}  chosen-survivor=${survivor.id} (${survivorRule})`;
      if (refusals.nonePartitionKeyRow.length < 40) refusals.nonePartitionKeyRow.push(line);
      for (const r of rows) emitPlanRow({ action: "refused", reason: "none-partition-key-row", groupKey: key, id: r.id, source: r.source ?? null });
      return;
    }

    const losers = rows.filter((r) => r.id !== survivor.id);
    if (!losers.length) { stats.groupsAlreadyOneId++; return; }

    try {
      // ── step 0: re-key the survivor onto the canonical id first, if needed
      if (survivorRule === "rekey-highest-authority") {
        const moveRes = await moveCatalogRow(
          cat, survivor, canonicalId, {},
          { reason: "fold-catalog-duplicate-rungs: re-key the highest-authority row onto the canonical respelling (PR #2377)", dryRun: !APPLY, salesContainer: pool, retry },
        );
        if (moveRes.action === "refused") {
          // The canonical address is occupied by something chooseSurvivor
          // itself cannot settle (e.g. a different-player collision this
          // lane's own gate did not already catch because the occupant is
          // OUTSIDE this group's rows). Refuse the whole group rather than
          // guess.
          stats.refusedDifferentPlayer++;
          const line = `  REFUSED at re-key (moveCatalogRow refused)  group=${key}  survivor=${survivor.id} -> ${canonicalId}  ${moveRes.decision}`;
          if (refusals.differentPlayer.length < 40) refusals.differentPlayer.push(line);
          for (const r of rows) emitPlanRow({ action: "refused", reason: "different-player-at-rekey", groupKey: key, id: r.id, source: r.source ?? null });
          return;
        }
        stats.survivorsRekeyed++;
        stats.salesRepointed += moveRes.salesRepointed ?? 0;
        stats.gradedRetired += moveRes.gradedChildrenRetired ?? 0;
        await repointHoldings(portfolio, holdingsIndex, survivor.id, canonicalId, stats, APPLY);
        emitPlanRow({ action: "resolve-survivor-rekey", reason: survivorRule, groupKey: key, id: survivor.id, canonicalId, source: survivor.source ?? null });
      } else {
        stats.survivorsAlreadyCanonical++;
        emitPlanRow({ action: "survivor-already-canonical", reason: survivorRule, groupKey: key, id: survivor.id, canonicalId, source: survivor.source ?? null });
      }

      // ── step 1..N: fold every loser onto the (now-canonical) survivor,
      // STRICTLY SERIAL within this one group -- see the function's own
      // header. Different GROUPS run concurrently (the caller's batches);
      // different LOSERS of one group never do.
      let foldedHere = 0;
      for (const loser of losers) {
        // Sales whose PARTITION KEY is the loser's own slug cannot be
        // patched across partitions -- relocate them BEFORE the row moves,
        // mirroring fold-checklist-numbered-twins.cjs's own ordering.
        await relocatePartitionKeyedSales(pool, loser.id, canonicalId, stats, APPLY);

        const res = await moveCatalogRow(
          cat, loser, canonicalId, {},
          { reason: `fold-catalog-duplicate-rungs: respelling of the same rung folds onto the canonical parallel slug (PR #2377); loser was ${loser.id}`, dryRun: !APPLY, salesContainer: pool, retry },
        );
        if (res.action === "refused") {
          stats.refusedDifferentPlayer++;
          const line = `  REFUSED at fold (moveCatalogRow refused)  group=${key}  ${loser.id} -> ${canonicalId}  ${res.decision}`;
          if (refusals.differentPlayer.length < 40) refusals.differentPlayer.push(line);
          emitPlanRow({ action: "refused", reason: "different-player-at-fold", groupKey: key, id: loser.id, canonicalId, source: loser.source ?? null });
          continue;
        }
        stats.rowsRemoved++;
        foldedHere++;
        stats.salesRepointed += res.salesRepointed ?? 0;
        stats.gradedRetired += res.gradedChildrenRetired ?? 0;
        bumpPair(loser.id, canonicalId);
        await repointHoldings(portfolio, holdingsIndex, loser.id, canonicalId, stats, APPLY);
        emitPlanRow({ action: "resolve-fold", reason: "respelling-of-canonical-rung", groupKey: key, id: loser.id, canonicalId, source: loser.source ?? null, survivorRule });
      }
      if (foldedHere) stats.groupsFolded++;
    } catch (e) {
      stats.failed++;
      const line = `  failed group=${key} survivor=${survivor.id}: ${String(e?.stack ?? e?.message ?? e)}`;
      failures.push(line);
      console.log(line.split("\n")[0]);
      for (const r of rows) emitPlanRow({ action: "failed", reason: "exception", groupKey: key, id: r.id, source: r.source ?? null, error: String(e?.message ?? e) });
    }
  }

  // ── RESUME (review findings, 2026-09-20 and the follow-up review on THIS
  // fix). Two DIFFERENT populations, two different rules:
  //
  //   APPLY  every relaunch is a NEW PROCESS that rebuilds `groups` from a
  //          fresh Cosmos scan, and by the time hop 2 runs, hop 1 has FOLDED
  //          (deleted) some groups away -- a folded group no longer has >= 2
  //          distinct stored ids, so it drops out of the NEXT scan's own
  //          candidate set on its own. That means the fresh scan is already
  //          SHORTER and, because `groups` is a plain Map keyed by string
  //          rather than something re-sorted identically every time,
  //          POTENTIALLY RE-ORDERED. Slicing that fresh list by the SAME
  //          numeric offset the previous hop reported would skip whichever
  //          groups now happen to sit at the front -- not the ones already
  //          folded -- silently and forever: the exact bug the follow-up
  //          review caught. So an APPLY relaunch ALWAYS rescans at offset 0;
  //          the groups a completed hop already folded are simply absent
  //          from the new scan, which is what "the rescan naturally
  //          continues" means. The hop counter still rides the cursor, but
  //          ONLY for the hop cap -- see MAX_RESUME_HOPS below -- never as an
  //          offset into anything.
  //   REPORT writes nothing, so nothing about the corpus changes between
  //          hops and a resume OFFSET is safe -- but only once the order it
  //          is an offset INTO is made deterministic on purpose, rather than
  //          relying on "a Map's insertion order happens to be stable for an
  //          unchanged corpus" as prose. `orderedGroups` is now explicitly
  //          SORTED BY GROUP KEY before any slicing, under both APPLY and
  //          REPORT (harmless when the offset is forced to 0 anyway), so the
  //          REPORT resume is correct by construction and not by convention.
  //
  // Rides the EXISTING `scan_limit` dispatch input (SCAN_LIMIT env, already
  // forwarded to every script unconditionally) rather than a new one --
  // route-backing-gaps.cjs's own RESUME/encodeResume/decodeResume convention,
  // reused byte-for-byte (hop*1,000,000 + offset; the corpus size for any one
  // cell/setKey scope cannot plausibly reach a million groups).
  const RESUME_HOP_UNIT = 1_000_000;
  /** Hops after which this chain ABORTS rather than relaunching again --
   *  APPLY has no offset to rely on for termination (it rescans every hop),
   *  so a corpus that somehow never converges (a defect elsewhere, or a
   *  concurrent writer re-introducing duplicates) must not be allowed to
   *  relaunch forever on the hop counter alone. */
  const MAX_RESUME_HOPS = 30;
  function decodeResume(raw) {
    const v = Math.max(0, Math.floor(Number(raw || 0)) || 0);
    return { hop: Math.floor(v / RESUME_HOP_UNIT), offset: v % RESUME_HOP_UNIT };
  }
  const encodeResume = ({ hop, offset }) => hop * RESUME_HOP_UNIT + offset;
  const RESUME = decodeResume(process.env.SCAN_LIMIT);
  if (RESUME.hop >= MAX_RESUME_HOPS) {
    throw new Error(`FOLD_CATALOG_DUPLICATE_RUNGS_HOP_CAP: this chain has already relaunched ${RESUME.hop} time(s) (cap ${MAX_RESUME_HOPS}) without converging -- ABORTING rather than relaunching again. Re-dispatch deliberately (scan_limit=0) only after checking why the corpus is not shrinking.`);
  }

  // SORT BY GROUP KEY, always -- see the header above. A stable, explicit
  // order is what makes a REPORT's offset meaningful; it costs nothing under
  // APPLY, where the offset is forced to 0 regardless.
  let orderedGroups = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const totalGroupsThisSlot = orderedGroups.length;
  // APPLY NEVER HONOURS AN OFFSET -- see the header above: a folded group is
  // simply absent from this fresh scan, which is the whole reason a rescan
  // at 0 "naturally continues" rather than redoing work. Only the HOP rides
  // forward, for MAX_RESUME_HOPS above; REPORT_RESUME_OFFSET is the one used
  // for slicing, and it is 0 under APPLY by construction.
  const REPORT_RESUME_OFFSET = APPLY ? 0 : RESUME.offset;
  if (APPLY && RESUME.offset > 0) {
    console.log(`  RESUME (APPLY)   scan_limit carried a non-zero offset (${f(RESUME.offset)}) from an earlier hop -- IGNORED under APPLY: every relaunch rescans from the top, because a group an earlier hop folded no longer qualifies (>= 2 distinct stored ids) and simply will not appear in this fresh scan. Only the hop count (${f(RESUME.hop)}) carries forward, for the hop cap.`);
  }
  if (REPORT_RESUME_OFFSET > 0) {
    orderedGroups = orderedGroups.slice(REPORT_RESUME_OFFSET);
    console.log(`  RESUMED (REPORT) skipping the first ${f(REPORT_RESUME_OFFSET)} group(s) of the GROUP-KEY-SORTED order an earlier relaunch of this same slot already decided (hop ${RESUME.hop}) -> ${f(orderedGroups.length)} left. Valid because REPORT writes nothing, so the corpus and this sort are unchanged between hops.`);
  }

  // ── CONCURRENCY: bounded, ACROSS groups only ────────────────────────────
  // A group is the unit of atomicity (its own gates, its own survivor, its
  // own ordered write sequence); different groups touch DISJOINT stored ids
  // by construction of groupKeyOf, so running several concurrently is safe --
  // the slow part measured on the football/2024 panini-mosaic pilot
  // (51,286 rows, 3,197 groups, 120 minutes, ~2.2s/group) was
  // moveCatalogRow's own per-loser CROSS-PARTITION queries (the sales
  // hobbyiqCardId lookup and the graded-children STARTSWITH scan), issued
  // and awaited ONE AT A TIME. Running that same I/O for independent groups
  // concurrently is the fix; nothing about a single group's own internal
  // order changes (see processGroup's header).
  //
  // DEFAULT 6, NOT 16 (review finding, 2026-09-21). sold_comps is SHARED
  // with production pricing reads at a routine 10,000 RU/s day -- this
  // lane's own per-loser cross-partition sale lookups compete with live
  // customer traffic for that budget, and 16 concurrent groups (each several
  // Cosmos calls deep) is not a number to default to against a shared
  // container. 6 is safe headroom; the dispatch `concurrency` input (already
  // forwarded as CONCURRENCY/BACKFILL_CONCURRENCY) raises it explicitly when
  // an operator has checked the account's current RU pressure first.
  const REQUESTED_CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 6));
  /** After this many throttles IN THIS RUN, drop to THROTTLE_CONCURRENCY for
   *  the rest of the run -- a ONE-WAY step down, never restored even if the
   *  throttling later subsides, because "it got better for a while" is not
   *  evidence the pressure this lane caused is gone. */
  const THROTTLE_TRIP_AT = 20;
  const THROTTLE_CONCURRENCY = 2;
  /** The concurrency actually used for the NEXT batch. Read fresh each
   *  iteration of the driving loop (below) rather than fixed once, so the
   *  drop takes effect on the very next batch after the 20th throttle. */
  function effectiveConcurrency() {
    if (throttleStats.count >= THROTTLE_TRIP_AT) {
      if (!throttleStats.droppedTo2) {
        throttleStats.droppedTo2 = true;
        console.log(`\n  THROTTLED: ${f(throttleStats.count)} retries (429/503/timeout) hit in this run -- dropping concurrency from ${f(REQUESTED_CONCURRENCY)} to ${f(THROTTLE_CONCURRENCY)} for the REST of this run. sold_comps is shared with production pricing; this lane backs off rather than compete for it.`);
      }
      return THROTTLE_CONCURRENCY;
    }
    return REQUESTED_CONCURRENCY;
  }
  console.log(`  concurrency   ${REQUESTED_CONCURRENCY} group(s) at once (across groups only -- one group's own writes stay strictly ordered); auto-drops to ${THROTTLE_CONCURRENCY} after ${THROTTLE_TRIP_AT} throttles this run`);

  // ── HEARTBEAT: groups done / total + ETA, once per minute ───────────────
  let groupsDone = 0;
  let lastHeartbeatAt = Date.now();
  const HEARTBEAT_MS = 60 * 1000;
  function maybeHeartbeat() {
    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
    lastHeartbeatAt = now;
    const elapsedS = (now - STARTED) / 1000;
    const rate = groupsDone / Math.max(elapsedS, 1);
    const remaining = orderedGroups.length - groupsDone;
    const etaS = rate > 0 ? Math.round(remaining / rate) : null;
    const eta = etaS === null ? "unknown" : etaS < 60 ? `${etaS}s` : `${Math.round(etaS / 60)}m`;
    console.error(`  narrate: heartbeat groups ${f(groupsDone)}/${f(orderedGroups.length)} this run (${f(totalGroupsThisSlot)} total this slot)  rate ${rate.toFixed(1)}/s  ETA ${eta}  throttles ${f(throttleStats.count)}${throttleStats.droppedTo2 ? ` (DROPPED to concurrency ${THROTTLE_CONCURRENCY})` : ""}`);
  }

  // `stoppedMidScan` is set ONLY by the CLOCK branch below -- a LIMIT stop is
  // an operator-requested slice (a dry-run sizing a probe), not a budget
  // exhaustion, and never printed the relaunch marker in the original
  // single-group loop either (its own `if (LIMIT...) break;` carried no
  // `stopReason`). Conflating the two would make a LIMIT=100 debug dispatch
  // trigger a real re-dispatch of the whole remaining scope.
  let stoppedMidScan = false;
  outer:
  for (let i = 0; i < orderedGroups.length; ) {
    // Read fresh every iteration -- effectiveConcurrency() is what lets the
    // 20-throttle trip take effect on the NEXT batch rather than waiting for
    // the whole run to restart.
    const batchSize = effectiveConcurrency();
    if (LIMIT && groupsDone >= LIMIT) { stats.notReached += orderedGroups.length - i; break outer; }
    // Checked BEFORE each batch starts, never after: a batch admitted past
    // budget still runs to completion (bounded by CONCURRENCY groups' worth
    // of I/O, not one), but no NEW batch is admitted once the clock is out --
    // the same "checked before the unit, never at the loop top alone" rule
    // runner-budget.cjs's own header states, applied to a BATCH of units
    // rather than one.
    if (CLOCK.outOfClock()) {
      stats.notReached += orderedGroups.length - i;
      stoppedMidScan = true;
      break outer;
    }
    const batch = orderedGroups.slice(i, i + batchSize);
    await Promise.all(batch.map(([key, rows]) => processGroup(key, rows)));
    groupsDone += batch.length;
    i += batch.length;
    maybeHeartbeat();
  }

  // A REPORT (or APPLY) THAT FINISHED ITS SCAN NEVER PRINTS THE BUDGET
  // MARKER (review finding, 2026-09-20). The marker -- and ONLY the marker --
  // is what the relaunch composite's `grep -aqE "stopped at the .*budget"`
  // gates on (CF-RELAUNCH-ONLY-ON-BUDGET, #1361): run 35576430500 looped
  // because a report whose per-group cost left it right at the edge of its
  // own RUN_MINUTES printed the marker AFTER having already decided every
  // group, and the relaunch dutifully re-dispatched a run that had nothing
  // left to do. `stoppedMidScan` is set ONLY inside the loop above, so a
  // scan that runs to completion (the `for` exhausts `orderedGroups` without
  // ever hitting a `break outer`) leaves it `false` and `stopReason` stays
  // `null` -- exactly the same guarantee the original single-group loop had,
  // now stated for a batch rather than one group.
  if (stoppedMidScan) {
    // Spelled as a LITERAL here (never CLOCK.stoppedAtBudget()'s return
    // value alone) so a static scan of THIS FILE's own text finds the
    // phrase -- everyWriteJobReconciles.test.ts's markerPrinters() and the
    // relaunch action's own `grep -aqE "stopped at the .*budget"` both read
    // the script's source/log directly, never runner-budget.cjs's.
    //
    // THE NEXT OFFSET IS NEVER CARRIED FORWARD UNDER APPLY -- see the RESUME
    // header above. The hop always advances (for MAX_RESUME_HOPS); the
    // offset advances only under REPORT, where the sorted order and the
    // corpus are both guaranteed unchanged between hops.
    const nextOffset = APPLY ? 0 : REPORT_RESUME_OFFSET + groupsDone;
    const nextResume = encodeResume({ hop: RESUME.hop + 1, offset: nextOffset });
    stopReason = APPLY
      ? `stopped at the ${RUN_MINUTES}-minute budget — the relaunch resumes at scan_limit=${nextResume} (hop ${RESUME.hop + 1}; APPLY always RESCANS from the top -- folded groups already dropped out of the next scan on their own, so offset stays 0)`
      : `stopped at the ${RUN_MINUTES}-minute budget — the relaunch resumes at scan_limit=${nextResume} (hop ${RESUME.hop + 1}, offset ${f(nextOffset)} of ${f(totalGroupsThisSlot)} this slot)`;
  }
  console.log(`\n  groups this run  decided ${f(groupsDone)} of ${f(orderedGroups.length)} in scope this run (resume offset ${f(REPORT_RESUME_OFFSET)}${APPLY ? " -- APPLY always rescans at 0" : ""}, ${f(totalGroupsThisSlot)} total this slot, hop ${f(RESUME.hop)})`);

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  cells                       ${f(cells.length)}`);
  console.log(`  rows scanned                ${f(rowsRead)}`);
  console.log(`  RU (pass-1 scan only)       ${f(Math.round(scanRU))}   <- moveCatalogRow/relocateSoldComp do not surface their own RU back to this caller, so writes are not in this total`);
  console.log(`  throttles (429/503/timeout) ${f(throttleStats.count)}${throttleStats.droppedTo2 ? `   <- concurrency was DROPPED to ${THROTTLE_CONCURRENCY} for the rest of this run after ${THROTTLE_TRIP_AT} throttles` : ""}`);
  console.log(`  groups                      ${f(stats.groupsScanned)}`);
  console.log(`  groups, single row          ${f(stats.groupsSingleRow)}   <- nothing to fold`);
  console.log(`  groups, already one id      ${f(stats.groupsAlreadyOneId)}   <- rows agree on the stored id already`);
  console.log(`  groups, fold candidates     ${f(stats.groupsCandidates)}   <- >= 2 distinct stored ids at one identity`);
  console.log(`  groups ${APPLY ? "folded" : "would fold"}                ${f(stats.groupsFolded)}`);
  console.log(`  ${APPLY ? "rows removed" : "would-fold rows (catalog rows removed)"}  ${f(stats.rowsRemoved)}`);
  console.log(`  survivors re-keyed          ${f(stats.survivorsRekeyed)}   <- highest-authority row moved onto the canonical id`);
  console.log(`  survivors already canonical ${f(stats.survivorsAlreadyCanonical)}   <- stored id already equalled the canonical id`);
  console.log(`  sales to re-point (patch)   ${f(stats.salesRepointed)}`);
  console.log(`  sales relocated (re-key)    ${f(stats.salesRelocated)}   <- partition key was the loser slug; upsert-verify-delete`);
  console.log(`  sales relocate failed       ${f(stats.salesRelocateFailed)}`);
  console.log(`  graded children retired     ${f(stats.gradedRetired)}`);
  console.log(`  holdings re-pointed         ${f(stats.holdingsRepointed)}   (walked ${f(stats.holdingsWalked)} holdings across ${f(stats.holdingDocsWalked)} portfolio docs)`);
  console.log(`\n  REFUSALS BY CLASS (nothing written for any of these):`);
  console.log(`    different-player                ${f(stats.refusedDifferentPlayer)}`);
  console.log(`    user-verified-not-survivor       ${f(stats.refusedUserVerifiedNotSurvivor)}`);
  console.log(`    canonical-underivable            ${f(stats.refusedCanonicalUnderivable)}`);
  console.log(`    none-partition-key-row           ${f(stats.refusedNonePartitionKeyRow)}   <- a row with no cardId lives at Cosmos's own None partition; never deleted or re-keyed by this lane`);
  console.log(`  failed                      ${f(stats.failed)}`);
  console.log(`  not reached                 ${f(stats.notReached)}`);

  const topPairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  if (topPairs.length) {
    console.log(`\n  TOP 40 (loser slug -> canonical slug) PAIRS BY COUNT:`);
    for (const [k, n] of topPairs) {
      const [loser, canon] = k.split("\u0000");
      console.log(`    ${f(n).padStart(8)}  ${loser} -> ${canon}`);
    }
  }

  if (refusals.differentPlayer.length) {
    console.log(`\n  REFUSED: different player (${f(stats.refusedDifferentPlayer)} total, showing up to 40):`);
    for (const l of refusals.differentPlayer) console.log(l);
  }
  if (refusals.userVerifiedNotSurvivor.length) {
    console.log(`\n  REFUSED: user-verified row is not the chosen survivor (${f(stats.refusedUserVerifiedNotSurvivor)} total, showing up to 40):`);
    for (const l of refusals.userVerifiedNotSurvivor) console.log(l);
  }
  if (refusals.canonicalUnderivable.length) {
    console.log(`\n  REFUSED: canonical id could not be derived (${f(stats.refusedCanonicalUnderivable)} total, showing up to 40):`);
    for (const l of refusals.canonicalUnderivable) console.log(l);
  }
  if (refusals.nonePartitionKeyRow.length) {
    console.log(`\n  REFUSED: a None-partition-key row in the group needs a move or delete this lane refuses to do (${f(stats.refusedNonePartitionKeyRow)} total, showing up to 40):`);
    for (const l of refusals.nonePartitionKeyRow) console.log(l);
  }
  if (failures.length) {
    console.log(`\n  FAILED -- every one, in full (${f(failures.length)}):`);
    for (const l of failures) console.log(l);
  }

  const refusedTotal = stats.refusedDifferentPlayer + stats.refusedUserVerifiedNotSurvivor + stats.refusedCanonicalUnderivable + stats.refusedNonePartitionKeyRow;
  if (APPLY) {
    reportWrites({
      job: "fold-catalog-duplicate-rungs",
      intended: stats.rowsRemoved + refusedTotal + stats.failed,
      written: stats.rowsRemoved,
      skipped: refusedTotal,
      failed: stats.failed,
    });
  }

  console.log(`\n  RECONCILE: groups scanned ${f(stats.groupsScanned)} = single-row ${f(stats.groupsSingleRow)} + already-one-id ${f(stats.groupsAlreadyOneId)} + candidates ${f(stats.groupsCandidates)}`);
  console.log(`  RECONCILE: candidates ${f(stats.groupsCandidates)} = folded ${f(stats.groupsFolded)} + refused(different-player/user-verified/canonical/none-partition-key) ${f(refusedTotal)} + failed ${f(stats.failed)} + not-reached-mid-group 0`);

  if (stopReason) console.log(`\n${stopReason}`);
  return { stats, stopReason, groupsDone, totalGroupsThisSlot };
}

/** Sales whose PARTITION KEY is the loser's slug. Mirrors
 *  fold-checklist-numbered-twins.cjs's relocatePartitionKeyedSales exactly:
 *  upsert -> verify read-back -> delete, via relocate-sold-comp.cjs, run
 *  BEFORE moveCatalogRow's own patch-based re-point and BEFORE the loser's
 *  catalog row is deleted. */
async function relocatePartitionKeyedSales(pool, loserId, canonicalId, stats, apply) {
  let n = 0;
  const it = pool.items.query(
    { query: "SELECT * FROM c WHERE c.cardId = @t", parameters: [{ name: "@t", value: loserId }] },
    { partitionKey: loserId, maxItemCount: 200 },
  );
  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources ?? []) {
      const keep = { ...stripSystem(row), cardId: canonicalId, hobbyiqCardId: canonicalId, reslugedFrom: loserId, reslugedReason: "fold-catalog-duplicate-rungs: respelling fold onto the canonical parallel (PR #2377)", reslugedAt: new Date().toISOString() };
      keep.contentHash = contentHashOf(keep);
      const dropSpec = { id: row.id, cardId: loserId };
      if (row._etag) dropSpec.ifMatchEtag = row._etag;
      const res = await relocateSoldComp(pool, { keep, drop: [dropSpec], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !apply });
      if (res.ok) { stats.salesRelocated++; n++; } else { stats.salesRelocateFailed++; }
    }
  }
  return n;
}

/** Byte-for-byte the same shape as fold-checklist-numbered-twins.cjs's own
 *  buildHoldingsIndex: portfolio.holdings is a MAP, walked once via
 *  Object.values (never a JOIN), refusing on zero docs walked. */
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

/** Re-point every holding that points at a folded/re-keyed id. Same shape as
 *  fold-checklist-numbered-twins.cjs's repointHoldings. moveCatalogRow itself
 *  does NOT touch portfolio -- this is the caller's own responsibility, and
 *  this script does it exactly as the sibling fold lane does. */
async function repointHoldings(portfolio, holdingsIndex, oldId, newId, stats, apply) {
  const hits = holdingsIndex.get(oldId);
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
      ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: newId });
      ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: newId });
    }
    if (apply) await retry(() => portfolio.item(docId, userId).patch(ops));
    stats.holdingsRepointed += ids.size;
  }
  holdingsIndex.delete(oldId);
}

module.exports = {
  groupKeyOf, canonicalParallelOf, canonicalIdOf, samePlayerAcross, playerKeySetOf,
  numSegmentOf, subSegmentOf, isUserVerified, runLane,
  // Exported for white-box testing of the throttle-drop mechanism only --
  // `throttleStats` lets a test simulate 429 pressure without paying real
  // retry() backoff delays (500ms-15s per attempt) for 20+ real throttles.
  throttleStats,
};

// Only run the lane when this file is executed directly (`node
// fold-catalog-duplicate-rungs.cjs`, which is how the runner and every
// operator invoke it) -- never when it is `require()`d for its pure helper
// exports, e.g. by this file's own unit tests. Matches the convention
// already used by annotate-checklist-backing.cjs, apply-setkey-rulings.cjs
// and dozens of other scripts in this directory.
if (require.main === module) {
  main()
    .then((ctx) => finishLane(0, { ...(ctx || {}), budget: CLOCK }))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, { budget: CLOCK });
    });
}
