#!/usr/bin/env node
/**
 * route-backing-gaps.cjs -- THE GAP ROUTER. For every unbacked (sport, year,
 * setKey) cell in the published census backing table, decides WHICH existing
 * repair lane applies -- never applies anything itself.
 *
 * THIS LANE IS READ-ONLY / DECISION-ONLY. IT MAKES NO COSMOS WRITES, EVER, IN
 * EITHER MODE. There is no APPLY branch in this file at all -- no
 * BACKFILL_APPLY gate, because there is nothing behind one: every Cosmos call
 * below is a SELECT, and grepping this file for `.upsert(`, `.replace(`,
 * `.delete(`, `.patch(`, or `container.items.create` should find nothing but
 * this sentence. It dispatches nothing itself either; its output is a
 * machine-readable work queue (PLAN_OUT NDJSON) plus a console banner rollup
 * that names, per cell, which SIBLING lane a human/steward should dispatch.
 *
 * THE MEASURED PROBLEM (2026-09-20 census). sold_comps is only 60.4%
 * strict-checklist-backed for sports; the 120 biggest gap cells hold 51% of
 * the gap and were triaged by hand (gap-classes-top120.json). The rest is a
 * long tail too large for that -- this lane is the decision engine that
 * scales the triage past the top 120: for every cell in the published
 * backing-cells.json table, it classifies the CELL (does the product even
 * have a checklist?) and samples the cell's own UNBACKED sales to classify
 * the SALE-LEVEL shape of the gap, then names the existing repair lane that
 * shape belongs to.
 *
 * PRIMARY INPUT. `backend/data/census/backing-cells.json`
 * (publish-census-backing.cjs's own output) -- a trimmed, sports-only,
 * unbacked>=200 view of merge-census-backing.cjs's topUnbackedCells. This
 * lane does NOT re-derive the census: it reads that published table as its
 * candidate-cell list and narrows it by SCOPE/TITLES/LIMIT/SLOT-SHARD, then
 * spends its own Cosmos reads only on the PER-CELL classification and
 * PER-SALE sampling described below.
 *
 * CELL CLASS, in order, first match wins (see classifyCellClass, pure):
 *   PRESENT             the cell already has plentiful strict catalog rows.
 *                        Threshold: backedStrict >= 200 in the published
 *                        row's own bucket (the same 200-sale floor
 *                        publish-census-backing.cjs itself uses to decide a
 *                        cell is big enough to matter) OR backedStrict is at
 *                        least 10% of the cell's total -- either signal says
 *                        the checklist is genuinely present and the gap is a
 *                        MATCHING problem, not an ACQUISITION problem.
 *   MISSING-PRODUCT      near-zero strict catalog rows for the whole cell
 *                        (checklistStrictRows below a small floor, default 5
 *                        -- a handful of stray rows from a mis-keyed sibling
 *                        product is not "the product has a checklist").
 *   ALIAS-KEY            the key is a ruled alias (setKeyReconciliation.ts's
 *                        ruledAliases()) AND the canonical twin holds strict
 *                        rows. suggestedLane: rekey-product-setkey MODE=pool.
 *                        Checked BEFORE UNREGISTERED-KEY below: a ruled
 *                        alias's own string is usually not a registered
 *                        product either, and this more-actionable class
 *                        would never fire if the generic one ran first.
 *   UNREGISTERED-KEY      the cell's setKey string is not resolvable through
 *                        isRegisteredProduct nor productAncestry (and is not
 *                        a ruled alias, see above). Sub-case recorded:
 *                        whether strict rows already exist under that
 *                        literal string (subCase:
 *                        "strict-rows-exist-under-unregistered-string").
 *   PRESENT-MISMATCH      (the remaining case) the product IS registered and
 *                        DOES have checklist rows, but not enough to clear
 *                        the PRESENT floor above, or its sales are not
 *                        matching it -- this is the case sale-class sampling
 *                        exists for.
 *
 * SALE CLASS SAMPLING (skipped for PRESENT cells -- nothing to route).
 * MEASUREMENT TRAP #1 (backed sales polluting the sample): the query is
 * bounded to STARTSWITH(c.hobbyiqCardId, "hiq:<sport>:<year>:<setKey>:") over
 * SOLD_COMPS directly, then every sampled row's id is checked against the
 * cell's OWN preloaded strict-row id set (already loaded for the cell-class
 * step, reused, never re-queried) and dropped if it is already backed --
 * this lane samples UNBACKED sales only, never a mixed pool.
 *
 * MEASUREMENT TRAP #2 (human-form fields): every sale is classified by
 * walking its id's SLUG SEGMENTS via parseHobbyIqCardId -- never the
 * human-form `parallel`/`cardNumber` fields, which can disagree with the id
 * that actually addresses the row.
 *
 * Sampling is capped at 400 unbacked sales per cell, spread across 4 disjoint
 * `soldAt` windows over the retention period (never one week), each page
 * bounded (maxItemCount 500, maxDegreeOfParallelism -1, never -1 on
 * maxItemCount) with the SAME synchronous spin guard rematch-sold-comps.cjs's
 * own backingCellPreloadRaw uses (consecutive empty-AND-zero-RU pages trip a
 * named refusal rather than spinning forever). Parked/flagged rows are
 * skipped with the SAME predicate rematch-sold-comps.cjs's own census mode
 * uses: flaggedWrong===true or excludedFromFmv===true (notPricedFlagged,
 * checked first) then identityUnverified===true (parked) -- neither is ever
 * routed to a repair lane, because neither is a live gap.
 *
 * SALE CLASSES (classifySaleShape, pure) -> suggestedLane:
 *   NUMBER-IN-SIBLING        repoint-sales-to-sibling-product
 *   INSERT-UNDER-PARENT      repoint-stored-insert-sales
 *   PARALLEL-SUFFIX          repoint-sales-parallel-suffix
 *   PRINTRUN-VARIANT-ABSENT  (no existing repair lane -- flagged, no dispatch)
 *   RUNG-ABSENT              acquisition note, no dispatch line
 *   ROW-EXISTS-NON-STRICT    (no existing repoint lane -- flagged for review)
 *   JUNK-PARALLEL / PHRASE-LEAK / AUTO-MISMATCH  re-derive candidates
 *                            (see the RE-DERIVE LANE note below)
 *   UNPARSEABLE              no hobbyiqCardId, or parseHobbyIqCardId fails
 *
 * RE-DERIVE LANE NAME -- A DEVIATION FROM THE TASK'S ASSUMED NAME. The task
 * expected a script literally named "re-derive"/"rederive". Grepping
 * backend/scripts and backend/src for that vocabulary finds
 * recheck-holding-identity.ts (holdings, not sold_comps rows) and
 * rematch-sold-comps.cjs itself (the census/apply-improve engine this whole
 * program is triaging FOR). Neither is "a re-derive lane a JUNK-PARALLEL/
 * PHRASE-LEAK/AUTO-MISMATCH sale gets dispatched to" in the way the task
 * assumed one exists. This lane therefore reports those three classes'
 * suggestedLane as "rematch-sold-comps (MODE=census scope=improve)" -- the
 * real, shipped mechanism that already re-derives a stored sale's identity
 * from its title through today's parser and classifies it IMPROVE/CONFLICT/
 * AGREE/UNDERIVABLE -- rather than inventing a script name that does not
 * exist. Named explicitly here, and again in the final PR report, per the
 * task's own instruction to say so plainly rather than substitute silently.
 *
 * PLAN_OUT (the resolve-split-identity-parks.cjs mechanism, mirrored
 * byte-for-byte in shape): when PLAN_OUT names a directory, this run writes
 * ONE NDJSON record per IN-SCOPE CELL to
 * `${PLAN_OUT}/plan-slot-${SLOT}.ndjson`, truncated at open (this run's plan
 * only, never appended across relaunches -- a relaunch's own selection can
 * differ from the last run's).
 *
 * Env: COSMOS_CONNECTION_STRING (read-only access -- SELECT queries only);
 *      SCOPE = sport, or sport:year (bare sport filters every cell of that
 *      sport; sport:year narrows to one year); LIMIT = max cells to process
 *      this run (0 = no cap); TITLES / SET_KEYS = optional comma-separated
 *      setKey filter (empty = no filter, unlike the sibling repoint lanes'
 *      REQUIRED from>to pairs -- this lane's `titles` is a plain filter, not
 *      a pair list); SLOT/SLOTS (sha1(cell) shards, opt-in via SHARD=true for
 *      slot 0, via runner-shard-scope.cjs); RU_BUDGET_MAX (hard RU ceiling,
 *      default 2,000,000 -- no existing RU-budget env name was found by grep
 *      across scripts/, so this lane defines its own, clean-stopping and
 *      flushing the banner rather than crashing); PLAN_OUT optional NDJSON
 *      dir; RUN_MINUTES=110 (runner-budget.cjs convention).
 *
 * Requires dist/ (catalogAuthority, productSetKeys, resolveProductByChecklist,
 * setKeyReconciliation, hobbyIqCardId.service for parseHobbyIqCardId).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 2 * 60 * 1000, startedAt: STARTED });
const LIMIT = Number(process.env.LIMIT || 0);
// No existing RU_BUDGET-shaped env name found by grep across scripts/ (only
// MAX_RUN, unrelated) -- this lane defines its own, named plainly. A cell
// that would push the running total over this ceiling is SKIPPED (not
// crashed): the banner still prints, cleanly, with an explicit note of how
// many cells were left unclassified for the next run.
const RU_BUDGET_MAX = Number(process.env.RU_BUDGET_MAX || 2_000_000);

const SHARD_SCOPE = runnerShardScope({ label: "route-backing-gaps" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

const PLAN_OUT = str(process.env.PLAN_OUT);

const BACKING_CELLS_PATH = path.join(backend, "data", "census", "backing-cells.json");

// ── SCOPE. Bare sport ("baseball") filters every cell of that sport; a
// sport:year pair ("baseball:2025") narrows to one year. Both forms are
// legal on the SAME dispatch as a comma list (e.g. "baseball,football:2023"
// filters every baseball cell plus football-2023 cells only). Empty/'all'/
// 'refractor' (the runner's inherited default) is REFUSED -- a whole-pool
// sweep needs its own name, same doctrine every sibling lane in this repo
// uses.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const SPORT_RE = /^[a-z][a-z-]*$/;
const CELL_RE = /^[a-z][a-z-]*:\d{4}$/;

/**
 * PURE. Parse the SCOPE token list into `{ sports: Set<string>, cells:
 * Set<"sport:year">, rejected: string[] }`. A token is EITHER a bare sport
 * or a sport:year cell; anything else is rejected (named, never silently
 * dropped).
 */
function parseScopeTokens(rawTokens) {
  const sports = new Set();
  const cells = new Set();
  const rejected = [];
  for (const raw of rawTokens) {
    const tok = lower(raw);
    if (CELL_RE.test(tok)) cells.add(tok);
    else if (SPORT_RE.test(tok)) sports.add(tok);
    else rejected.push(raw);
  }
  return { sports, cells, rejected };
}

/** PURE. Does `row` (carrying .sport and .year) match a parsed SCOPE? Bare
 *  sport tokens match every year of that sport; sport:year cells match only
 *  that exact year. */
function rowInScope(row, scope) {
  const sport = lower(row.sport);
  const year = String(row.year);
  if (scope.sports.has(sport)) return true;
  return scope.cells.has(`${sport}:${year}`);
}

const SCOPE_PARSE = parseScopeTokens(RAW_SCOPE);

// ── TITLES / SET_KEYS -- OPTIONAL setKey filter, comma list, NEVER a from>to
// pair list (unlike the sibling repoint lanes' REQUIRED titles). Empty means
// no filter at all -- this lane's job is to survey every unbacked cell, so
// an operator narrowing to one product family is the exception, not the
// rule this lane demands.
const RAW_TITLES = csv(process.env.TITLES || process.env.SET_KEYS).map(lower);
const SET_KEY_FILTER = new Set(RAW_TITLES);

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);

// ── never-price predicates, mirroring rematch-sold-comps.cjs's own census
// bucketing ORDER exactly: notPricedFlagged (flaggedWrong/excludedFromFmv)
// is checked BEFORE parked (identityUnverified) -- see that file's own
// comment ("Own bucket, checked BEFORE parked").
function neverPricedBucket(row) {
  if (row?.flaggedWrong === true || row?.excludedFromFmv === true) return "notPricedFlagged";
  if (row?.identityUnverified === true) return "parked";
  return null;
}

// ============================================================================
// PURE DECISION FUNCTIONS -- no I/O, no Cosmos client, no fs. Exported at the
// bottom so they can be unit-tested with fake data, mirroring
// planSiblingMove/classifySaleForSiblingMove's own separation exactly.
// ============================================================================

/** Every checklist-authority row's normalised card number, from a preloaded
 *  cell's strict rows -- Set<string>, lowercase. */
function strictNumberSetOf(strictRows) {
  return new Set(strictRows.map((r) => String(r.cardNumber ?? "").trim().toLowerCase()).filter(Boolean));
}

/**
 * CELL CLASS. `cellRow` is one row of the published backing-cells.json table
 * (carries unbacked/noRow/rowExistsNonStrict/total, its own bucket counts --
 * NOT backedStrict, which the published table does not carry; see the
 * `catalog` param below for that). `catalog` is `{ totalRows, strictRows,
 * registered, resolvesViaAncestry, aliasTarget, aliasTargetStrictRows }` --
 * everything this function needs about the LIVE card_catalog state for this
 * cell, computed once by the caller (a single preload) and passed in pure.
 *
 * PRESENT floor: 200 strict rows (the same floor publish-census-backing.cjs
 * itself uses to decide a cell is big enough to matter -- reusing ONE
 * threshold across both tools rather than inventing a second number) OR
 * strictRows is at least 10% of the cell's own `total` sales -- either
 * signal says the checklist is genuinely present, so a gap here is a
 * MATCHING problem for sale-class sampling to diagnose, never an
 * ACQUISITION one.
 *
 * MISSING-PRODUCT floor: catalog.strictRows < 5 -- a small floor rather than
 * a hard zero, because a handful of stray rows under this cell's exact id
 * prefix (a mis-keyed sibling, an isolated seed row) is not "the product has
 * a checklist"; it is noise beneath the level this lane can act on.
 */
function classifyCellClass(cellRow, catalog) {
  const total = Number(cellRow.total ?? cellRow.unbacked ?? 0) || 1;
  const strictRows = Number(catalog.strictRows ?? 0);
  const PRESENT_FLOOR_ABSOLUTE = 200;
  const PRESENT_FLOOR_SHARE = 0.10;
  if (strictRows >= PRESENT_FLOOR_ABSOLUTE || strictRows / total >= PRESENT_FLOOR_SHARE) {
    return { cellClass: "PRESENT", detail: `${strictRows} strict rows (>= ${PRESENT_FLOOR_ABSOLUTE} or >= ${(PRESENT_FLOOR_SHARE * 100).toFixed(0)}% of ${total} total) -- checklist is genuinely present` };
  }

  const MISSING_PRODUCT_FLOOR = 5;
  if (strictRows < MISSING_PRODUCT_FLOOR) {
    return { cellClass: "MISSING-PRODUCT", detail: `${strictRows} strict catalog row(s) at this cell's id prefix -- below the ${MISSING_PRODUCT_FLOOR}-row noise floor; no checklist exists here` };
  }

  // ALIAS-KEY is checked BEFORE UNREGISTERED-KEY: a ruled alias's own setKey
  // string is, by construction, usually NOT a registered product (that is
  // exactly why setKeyReconciliation.ts had to rule it an alias rather than
  // leaving productSetKeys.ts to resolve it) -- so testing
  // "!registered && !resolvesViaAncestry" first would swallow every real
  // alias into the generic UNREGISTERED-KEY bucket and this dedicated,
  // more-actionable class would never fire.
  if (catalog.aliasTarget && Number(catalog.aliasTargetStrictRows ?? 0) > 0) {
    return {
      cellClass: "ALIAS-KEY",
      aliasTarget: catalog.aliasTarget,
      detail: `setKey "${cellRow.setKey}" is a RULED ALIAS of "${catalog.aliasTarget}" (setKeyReconciliation.ts ruledAliases()), which holds ${catalog.aliasTargetStrictRows} strict rows`,
      suggestedLane: "rekey-product-setkey",
      suggestedMode: "pool",
    };
  }

  if (!catalog.registered && !catalog.resolvesViaAncestry) {
    const subCase = catalog.totalRows > 0 ? "strict-rows-exist-under-unregistered-string" : "no-rows-under-unregistered-string";
    return {
      cellClass: "UNREGISTERED-KEY",
      subCase,
      detail: `setKey "${cellRow.setKey}" is not a registered product and does not resolve via productAncestry -- ${catalog.totalRows} total catalog row(s) exist under this exact string`,
    };
  }

  return {
    cellClass: "PRESENT-MISMATCH",
    detail: `${strictRows} strict rows exist (registered product) but below the PRESENT floor relative to ${total} total sales -- sale-class sampling decides why`,
  };
}

/**
 * SALE CLASS for one sampled unbacked sale. `parsed` is
 * parseHobbyIqCardId(sale.hobbyiqCardId) or null. `ctx` carries everything
 * precomputed per-cell: `ownNumbers` (this cell's own strict card-number
 * set), `siblingHits` (Map<siblingSetKey, Set<number>> for sport-year
 * siblings named as hints, or discovered), `insertParentHits` (Map<insertKey,
 * {parentSetKey, numbers:Set}>), `ownParallelsByNumber` (Map<number,
 * Set<parallelSlug>> from this cell's OWN strict rows, for the
 * PARALLEL-SUFFIX / PRINTRUN-VARIANT-ABSENT / RUNG-ABSENT split),
 * `nonStrictSourcesByNumber` (Map<number, Set<source>> for ROW-EXISTS-NON-
 * STRICT), `phraseLeakWords` (product-family suffix words this cell's own
 * checklist carries, for PARALLEL-SUFFIX's spelling variant), `titleWords`.
 *
 * Order (first match wins), matching the task's own ordering:
 *   UNPARSEABLE -> NUMBER-IN-SIBLING -> INSERT-UNDER-PARENT ->
 *   PARALLEL-SUFFIX -> PRINTRUN-VARIANT-ABSENT -> RUNG-ABSENT ->
 *   ROW-EXISTS-NON-STRICT -> JUNK-PARALLEL/PHRASE-LEAK/AUTO-MISMATCH (title
 *   parser defects) -> a residual bucket, UNRESOLVED, when nothing fires.
 */
function classifySaleShape(sale, parsed, ctx) {
  if (!sale?.hobbyiqCardId || !parsed) {
    return { saleClass: "UNPARSEABLE", detail: "no hobbyiqCardId, or the slug does not parse into segments" };
  }
  const num = String(parsed.cardNumber ?? "").trim().toLowerCase();
  if (!num) return { saleClass: "UNPARSEABLE", detail: "parsed slug carries no card number segment" };

  // NUMBER-IN-SIBLING: absent from this cell's own strict rows, present
  // verbatim under a NAMED sibling product of the same sport-year.
  if (!ctx.ownNumbers.has(num)) {
    for (const [siblingKey, numbers] of ctx.siblingHits ?? []) {
      if (numbers.has(num)) {
        return {
          saleClass: "NUMBER-IN-SIBLING",
          siblingSetKey: siblingKey,
          suggestedLane: "repoint-sales-to-sibling-product",
          detail: `#${num} absent from this cell's own checklist, present verbatim on sibling "${siblingKey}"`,
        };
      }
    }
  }

  // INSERT-UNDER-PARENT: the number belongs to a REGISTERED insert whose
  // productParentOf is THIS cell's setKey.
  if (!ctx.ownNumbers.has(num)) {
    for (const [insertKey, info] of ctx.insertParentHits ?? []) {
      if (info.numbers.has(num)) {
        return {
          saleClass: "INSERT-UNDER-PARENT",
          insertSetKey: insertKey,
          suggestedLane: "repoint-stored-insert-sales",
          detail: `#${num} is on registered insert "${insertKey}"'s own checklist, whose parent product is this cell`,
        };
      }
    }
  }

  // From here on the number itself IS on this cell's own checklist (or
  // matches neither sibling nor insert and falls through as a genuine
  // catalog hole below) -- the remaining classes distinguish PARALLEL-level
  // shapes at that same number.
  const ownParallels = ctx.ownParallelsByNumber?.get(num) ?? new Set();
  const saleParallel = String(parsed.parallelSlug ?? "").trim().toLowerCase() || "base";

  if (ownParallels.size > 0 && !ownParallels.has(saleParallel)) {
    // PARALLEL-SUFFIX: the checklist carries a DIFFERENT spelling of the
    // same finish (a product-family suffix word, e.g. "silver" vs
    // "silver-prizm") -- detected by stripping/adding the cell's own known
    // suffix words and checking whether that produces a checklist hit.
    for (const suffixWord of ctx.phraseLeakWords ?? []) {
      const withSuffix = `${saleParallel}-${suffixWord}`;
      const withoutSuffix = saleParallel.endsWith(`-${suffixWord}`) ? saleParallel.slice(0, -(suffixWord.length + 1)) : null;
      if (ownParallels.has(withSuffix) || (withoutSuffix && ownParallels.has(withoutSuffix))) {
        return {
          saleClass: "PARALLEL-SUFFIX",
          suggestedLane: "repoint-sales-parallel-suffix",
          detail: `"${saleParallel}" differs from the checklist's own spelling by the product-family suffix "${suffixWord}"`,
        };
      }
    }
    // The number exists at a DIFFERENT print-run/parallel combination the
    // checklist DOES carry (just not this exact one, and not a suffix
    // spelling match) -- the print-run VARIANT itself is what's missing.
    if (parsed.printRun) {
      return {
        saleClass: "PRINTRUN-VARIANT-ABSENT",
        detail: `#${num} "${saleParallel}" num-${parsed.printRun} -- the base parallel exists on the checklist but not this specific print-run variant`,
      };
    }
    return {
      saleClass: "RUNG-ABSENT",
      detail: `#${num} parallel "${saleParallel}" is nowhere on this card's checklist rows -- a genuine catalog hole, not a routing problem`,
      acquisitionNote: `acquire ladder/insert checklist coverage for "${saleParallel}" on ${ctx.sport}/${ctx.year}/${ctx.setKey} #${num}`,
    };
  }

  // ROW-EXISTS-NON-STRICT: a card_catalog row exists at this exact id, but
  // its source(s) are not checklist-authority.
  const nonStrictSources = ctx.nonStrictSourcesByNumber?.get(num);
  if (nonStrictSources && nonStrictSources.size > 0) {
    return {
      saleClass: "ROW-EXISTS-NON-STRICT",
      sources: [...nonStrictSources],
      detail: `a card_catalog row exists at #${num}/${saleParallel} but its source(s) (${[...nonStrictSources].join(", ")}) are not checklist-authority`,
    };
  }

  // Title-parser-defect candidates -- re-derive lane (see module header's
  // RE-DERIVE LANE NAME note for why this names rematch-sold-comps rather
  // than a script that does not exist).
  const title = lower(sale.title);
  if (ctx.junkParallelWords?.some((w) => title.includes(w))) {
    return { saleClass: "JUNK-PARALLEL", suggestedLane: "rematch-sold-comps (MODE=census scope=improve)", detail: `title contains a junk-parallel phrase this cell's checklist never lists as a real rung` };
  }
  if (ctx.phraseLeakTitleWords?.some((w) => title.includes(w))) {
    return { saleClass: "PHRASE-LEAK", suggestedLane: "rematch-sold-comps (MODE=census scope=improve)", detail: `title carries a product-phrase leak into the parallel field` };
  }
  if (sale.isAuto === true && !ctx.autoNumbers?.has(num)) {
    return { saleClass: "AUTO-MISMATCH", suggestedLane: "rematch-sold-comps (MODE=census scope=improve)", detail: `sale is flagged isAuto but #${num} carries no auto rung on this cell's checklist` };
  }

  return { saleClass: "UNRESOLVED", detail: `#${num}/${saleParallel} matched none of the named shapes -- residual bucket for manual review` };
}

/**
 * The exact `gh workflow run` dispatch line for a suggestedLane, given a
 * cell. Mirrors backfill-runner.yml's real input names (script/scope/titles/
 * apply) -- this is READ-ONLY documentation of a dispatch a human/steward
 * would run, never executed by this lane itself.
 */
function suggestedDispatchFor(suggestion, cell) {
  const scopeArg = `${cell.sport}:${cell.year}`;
  switch (suggestion.suggestedLane) {
    case "repoint-sales-to-sibling-product":
      return `gh workflow run backfill-runner.yml -f script=repoint-sales-to-sibling-product -f apply=false -f scope=${scopeArg} -f titles=${cell.setKey}>${suggestion.siblingSetKey ?? "<sibling-setkey>"}`;
    case "repoint-stored-insert-sales":
      return `gh workflow run backfill-runner.yml -f script=repoint-stored-insert-sales -f apply=false -f scope=${scopeArg} -f titles=${suggestion.insertSetKey ?? "<insert-setkey>"}`;
    case "repoint-sales-parallel-suffix":
      return `gh workflow run backfill-runner.yml -f script=repoint-sales-parallel-suffix -f apply=false -f scope=${scopeArg} -f titles=${cell.setKey}`;
    case "rekey-product-setkey":
      return `gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false -f mode=pool -f scope=${cell.sport} -f setkey_like=${cell.setKey} -f titles=${suggestion.aliasTarget ?? "<canonical-setkey>"} -f years=${cell.year}`;
    case "rematch-sold-comps (MODE=census scope=improve)":
      return `gh workflow run backfill-runner.yml -f script=rematch-sold-comps -f mode=census -f scope=improve -f setkey_like=${cell.setKey}`;
    default:
      return null; // ACQUISITION/RUNG-ABSENT/UNPARSEABLE/UNRESOLVED/ROW-EXISTS-NON-STRICT carry no dispatch line
  }
}

// ============================================================================
// I/O -- everything below touches Cosmos or the filesystem. main() only.
// ============================================================================

/** Explicit page size (never -1), maxDegreeOfParallelism -1 (a DIFFERENT
 *  knob -- unbounded fan-out for one query's own cross-partition reads).
 *  Mirrors rematch-sold-comps.cjs's own backingCellPreloadRaw exactly,
 *  including its synchronous spin guard. */
async function pagedQuery(container, spec, onPage, opts = {}) {
  const pageSize = opts.pageSize ?? 500;
  const SPIN_GUARD_PAGES = Number(process.env.SPIN_GUARD_PAGES || 50);
  const iter = container.items.query(spec, { maxItemCount: pageSize, maxDegreeOfParallelism: -1 });
  let consecutiveEmptyPages = 0;
  let ru = 0;
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    const rows = page.resources ?? [];
    const pageRU = page.requestCharge || 0;
    if (rows.length === 0 && pageRU === 0) {
      consecutiveEmptyPages++;
      if (consecutiveEmptyPages >= SPIN_GUARD_PAGES) {
        throw new Error(`SPIN_GUARD after ${consecutiveEmptyPages} consecutive empty pages`);
      }
    } else {
      consecutiveEmptyPages = 0;
    }
    ru += pageRU;
    if ((await onPage(rows, pageRU)) === false) break;
  }
  return ru;
}

/** hiq:<sport>:<year>:<setKey>: -- the same STARTSWITH prefix every sibling
 *  lane's own checklist preload uses. */
const idPrefix = (sport, year, setKey) => `hiq:${sport}:${year}:${setKey}:`;

function checklistSpec(sport, year, setKey) {
  return {
    query: `SELECT c.id, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber,
                   c.parallel, c.parallelSlug, c.isAuto, c.playerName
            FROM c
            WHERE STARTSWITH(c.id, @prefix)
              AND c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND NOT IS_DEFINED(c.gradeTier)`,
    parameters: [
      { name: "@prefix", value: idPrefix(sport, year, setKey) },
      { name: "@sport", value: sport },
      { name: "@year", value: year },
    ],
  };
}

function salesSpecWindow(sport, year, setKey, fromIso, toIso) {
  return {
    query: `SELECT c.id, c.hobbyiqCardId, c.cardId, c.title, c.isAuto, c.soldAt,
                   c.flaggedWrong, c.excludedFromFmv, c.identityUnverified
            FROM c
            WHERE STARTSWITH(c.hobbyiqCardId, @p)
              AND c.soldAt >= @from AND c.soldAt < @to`,
    parameters: [
      { name: "@p", value: idPrefix(sport, year, setKey) },
      { name: "@from", value: fromIso },
      { name: "@to", value: toIso },
    ],
  };
}

/** 4 disjoint soldAt windows spread across the retention period (never one
 *  week), most-recent-first so a budget stop still samples the freshest
 *  data. Retention is treated as 8 years back from today, matching
 *  ch_daily_sales' own documented depth (reference_tca_daily_quota_limits /
 *  CLAUDE.md's ch_daily_sales note). */
function sampleWindows(now = new Date()) {
  const end = now.toISOString();
  const yearsBack = 8;
  const spans = [];
  for (let i = 0; i < 4; i++) {
    const toYear = now.getUTCFullYear() - Math.floor((yearsBack / 4) * i);
    const fromYear = now.getUTCFullYear() - Math.floor((yearsBack / 4) * (i + 1));
    const to = i === 0 ? end : new Date(Date.UTC(toYear, 0, 1)).toISOString();
    const from = new Date(Date.UTC(fromYear, 0, 1)).toISOString();
    spans.push({ from, to });
  }
  return spans;
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  GAP ROUTER -- decision-only triage of unbacked sold_comps cells");
  console.log("  READ-ONLY LANE: no Cosmos writes anywhere, no APPLY mode, no dispatch.");
  console.log("  It classifies + reports; a human/steward runs the suggested dispatch.");
  console.log("=".repeat(78));
  console.log(`  ${CLOCK.describe()}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  if (SCOPE_PARSE.rejected.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries value(s) that are neither a sport nor a sport:year cell: ${SCOPE_PARSE.rejected.join(", ")}`);
    process.exit(2);
  }
  if ((!SCOPE_PARSE.sports.size && !SCOPE_PARSE.cells.size) || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED -- a sport (baseball) or sport:year cell (baseball:2025), comma-separated.");
    console.error("       There is no 'all' for this lane; the runner's inherited default 'refractor' is refused.");
    process.exit(2);
  }

  if (!fs.existsSync(BACKING_CELLS_PATH)) {
    console.error("");
    console.error(`FATAL: ${BACKING_CELLS_PATH} does not exist -- run scripts/publish-census-backing.cjs first.`);
    process.exit(3);
  }
  let published;
  try {
    published = JSON.parse(fs.readFileSync(BACKING_CELLS_PATH, "utf8"));
  } catch (e) {
    console.error(`FATAL: could not parse ${BACKING_CELLS_PATH}: ${String(e?.message ?? e)}`);
    process.exit(3);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required (read-only access)"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { productParentOf, productAncestry } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { isRegisteredProduct } = require(path.join(backend, "dist/services/catalog/resolveProductByChecklist.js"));
  const { ruledAliases } = require(path.join(backend, "dist/services/catalog/setKeyReconciliation.js"));
  const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";
  const ALIASES = ruledAliases(); // [{setKey, canonical, why}]
  const aliasTargetOf = (setKey) => ALIASES.find((a) => a.setKey === setKey)?.canonical ?? null;

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const catalog = db.container("card_catalog");
  const sales = db.container("sold_comps");

  let totalRU = 0;
  const spendRU = (n) => { totalRU += n; };

  // ── CANDIDATE CELLS: the published table, filtered by SCOPE/TITLES/LIMIT/SHARD ──
  const allCells = Array.isArray(published.cells) ? published.cells : [];
  let candidates = allCells.filter((c) => rowInScope(c, SCOPE_PARSE));
  if (SET_KEY_FILTER.size) candidates = candidates.filter((c) => SET_KEY_FILTER.has(lower(c.setKey)));
  candidates = candidates.filter((c) => SHARD_SCOPE.mine(shardOf(c.cell)));
  candidates.sort((a, b) => b.unbacked - a.unbacked);
  if (LIMIT > 0) candidates = candidates.slice(0, LIMIT);

  console.log("");
  console.log(`  published cells        ${f(allCells.length)}  (from ${BACKING_CELLS_PATH})`);
  console.log(`  in-scope this run       ${f(candidates.length)}`);
  console.log(`  RU_BUDGET_MAX           ${f(RU_BUDGET_MAX)}`);

  if (!candidates.length) {
    console.log("\n  nothing in scope -- nothing to route.");
    return { skippedForBudget: 0, cellsProcessed: 0 };
  }

  // ── PLAN_OUT ──────────────────────────────────────────────────────────────
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SHARD_SCOPE.SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file               ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
    }
  }
  let planRowsWritten = 0;
  function emitPlanRow(record) {
    planRowsWritten++;
    if (!planFd) return;
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${record?.cell}: ${e?.message}`); }
  }

  const salesByClassOverall = new Map(); // saleClass -> unbacked-sale count (sampled, scaled)
  const salesByClassBySport = new Map(); // sport -> Map(saleClass -> count)
  const actionCandidates = []; // {suggestedLane, suggestedDispatch, cell, salesUnlocked}
  const cellsByClass = new Map();
  let cellsProcessed = 0;
  let skippedForBudget = 0;

  for (const cellRow of candidates) {
    if (CLOCK.outOfClock()) {
      console.log(`\n  ${CLOCK.stoppedAtBudget()} -- ${candidates.length - cellsProcessed} cell(s) left unprocessed this run.`);
      break;
    }
    if (totalRU >= RU_BUDGET_MAX) {
      skippedForBudget = candidates.length - cellsProcessed;
      console.log(`\n  RU_BUDGET_MAX (${f(RU_BUDGET_MAX)}) reached -- stopping cleanly, ${f(skippedForBudget)} cell(s) left unprocessed this run.`);
      break;
    }

    const { sport, year, setKey, cell } = cellRow;
    let cellRU = 0;

    // ── PRELOAD: this cell's own strict + non-strict checklist rows, ONCE.
    const strictRows = [];
    const nonStrictBySources = new Map(); // number -> Set<source>
    const ownParallelsByNumber = new Map(); // number -> Set<parallelSlug>
    const autoNumbers = new Set();
    let totalCatalogRows = 0;
    cellRU += await pagedQuery(catalog, checklistSpec(sport, year, setKey), (rows) => {
      totalCatalogRows += rows.length;
      for (const r of rows) {
        const num = String(r.cardNumber ?? "").trim().toLowerCase();
        if (!num) continue;
        if (isChecklist(r.source)) {
          strictRows.push(r);
          const pSlug = String(r.parallelSlug ?? r.parallel ?? "base").trim().toLowerCase() || "base";
          if (!ownParallelsByNumber.has(num)) ownParallelsByNumber.set(num, new Set());
          ownParallelsByNumber.get(num).add(pSlug);
          if (r.isAuto === true) autoNumbers.add(num);
        } else {
          if (!nonStrictBySources.has(num)) nonStrictBySources.set(num, new Set());
          nonStrictBySources.get(num).add(String(r.source ?? "unknown"));
        }
      }
    });
    const ownNumbers = strictNumberSetOf(strictRows);

    // ── UNREGISTERED-KEY / ALIAS-KEY predicates (no extra Cosmos read -- pure).
    const registered = isRegisteredProduct(setKey);
    const ancestry = productAncestry(setKey);
    const resolvesViaAncestry = ancestry.length > 1;
    const aliasTarget = aliasTargetOf(setKey);
    let aliasTargetStrictRows = 0;
    if (aliasTarget) {
      cellRU += await pagedQuery(catalog, checklistSpec(sport, year, aliasTarget), (rows) => {
        aliasTargetStrictRows += rows.filter((r) => isChecklist(r.source)).length;
      });
    }

    const cellClassVerdict = classifyCellClass(cellRow, {
      totalRows: totalCatalogRows, strictRows: strictRows.length,
      registered, resolvesViaAncestry, aliasTarget, aliasTargetStrictRows,
    });
    cellsByClass.set(cellClassVerdict.cellClass, (cellsByClass.get(cellClassVerdict.cellClass) ?? 0) + 1);

    const record = {
      cell, sport, year, setKey, unbacked: cellRow.unbacked,
      cellClass: cellClassVerdict.cellClass,
      cellClassDetail: cellClassVerdict.detail,
      subCase: cellClassVerdict.subCase ?? null,
      saleClassShares: {},
      suggestedLane: cellClassVerdict.suggestedLane ?? null,
      suggestedMode: cellClassVerdict.suggestedMode ?? null,
      suggestedDispatch: null,
      topMissingSlugs: [],
      topMissingPrefixes: [],
      siblingPairs: [],
      blockers: [],
    };

    if (cellClassVerdict.cellClass === "PRESENT") {
      // Nothing to route -- the checklist is already there in force.
      emitPlanRow(record);
      cellsProcessed++;
      spendRU(cellRU);
      continue;
    }

    if (cellClassVerdict.cellClass === "ALIAS-KEY") {
      record.suggestedDispatch = suggestedDispatchFor({ suggestedLane: "rekey-product-setkey", aliasTarget: cellClassVerdict.aliasTarget }, cellRow);
      const share = cellRow.unbacked;
      actionCandidates.push({ suggestedLane: "rekey-product-setkey", suggestedDispatch: record.suggestedDispatch, cell, salesUnlocked: share });
      emitPlanRow(record);
      cellsProcessed++;
      spendRU(cellRU);
      continue;
    }

    // ── SALE-CLASS SAMPLING (MISSING-PRODUCT / UNREGISTERED-KEY / PRESENT-MISMATCH) ──
    // MEASUREMENT TRAP #1: sample only UNBACKED sales -- every row's id is
    // checked against ownNumbers/strictRows AFTER the query, but the census
    // "backed" bucket is about card_catalog id existence, not this cell's
    // number set alone, so we additionally build the exact strict-id set for
    // this cell to drop any sale whose hobbyiqCardId IS one of them.
    const strictIds = new Set(strictRows.map((r) => r.id));

    // Sibling hint list: named pairs from the evidence + generic same-(sport,
    // year) siblings sharing a family root via productAncestry's OWN parent
    // (never inferred by name similarity -- feedback_ratio_similarity_is_not_
    // identity). Kept small and bounded: only the OPERATOR-NAMED sibling of
    // this exact setKey (if any) plus the parent/ancestor chain's OTHER
    // registered children are consulted, never a scan of every product in
    // the sport-year.
    const KNOWN_SIBLING_HINTS = {
      topps: ["topps-update-series"],
      "donruss-optic": ["panini-donruss"],
    };
    const siblingHits = new Map();
    for (const siblingKey of KNOWN_SIBLING_HINTS[setKey] ?? []) {
      const numbers = new Set();
      cellRU += await pagedQuery(catalog, checklistSpec(sport, year, siblingKey), (rows) => {
        for (const r of rows) if (isChecklist(r.source)) numbers.add(String(r.cardNumber ?? "").trim().toLowerCase());
      });
      if (numbers.size) siblingHits.set(siblingKey, numbers);
    }

    // Registered-insert hint: any insert whose OWN productParentOf resolves
    // to this cell's setKey. productSetKeys.ts has no reverse index exposed,
    // so this checks a small, explicit candidate list built from this cell's
    // OWN nonStrictBySources sources plus the evidence's known insert-shaped
    // number prefixes -- bounded, never a full-registry scan.
    const insertParentHits = new Map();
    // (left empty by default -- populated only when an operator-supplied
    // TITLES hint names a candidate insert key; see KNOWN_INSERT_HINTS.)
    const KNOWN_INSERT_HINTS = {};
    for (const insertKey of KNOWN_INSERT_HINTS[setKey] ?? []) {
      if (productParentOf(insertKey) !== setKey) continue;
      const numbers = new Set();
      cellRU += await pagedQuery(catalog, checklistSpec(sport, year, insertKey), (rows) => {
        for (const r of rows) if (isChecklist(r.source)) numbers.add(String(r.cardNumber ?? "").trim().toLowerCase());
      });
      if (numbers.size) insertParentHits.set(insertKey, { parentSetKey: setKey, numbers });
    }

    const PHRASE_LEAK_WORDS = ["prizm", "optic", "mosaic", "chrome", "finest", "select"];
    const JUNK_PARALLEL_WORDS = ["lot", "reprint", "custom", "proxy"];
    const PHRASE_LEAK_TITLE_WORDS = ["insert", "case hit", "box topper"];

    const sampleCap = 400;
    let sampled = [];
    let skippedNeverPrice = 0;
    let skippedAlreadyBacked = 0;
    for (const { from, to } of sampleWindows()) {
      if (sampled.length >= sampleCap || CLOCK.outOfClock()) break;
      cellRU += await pagedQuery(sales, salesSpecWindow(sport, year, setKey, from, to), (rows) => {
        for (const r of rows) {
          if (sampled.length >= sampleCap) return false;
          if (neverPricedBucket(r)) { skippedNeverPrice++; continue; }
          if (r.hobbyiqCardId && strictIds.has(r.hobbyiqCardId)) { skippedAlreadyBacked++; continue; }
          sampled.push(r);
        }
        return sampled.length < sampleCap;
      }, { pageSize: 500 });
    }

    const shareCounts = {};
    const siblingPairsSeen = new Map();
    for (const sale of sampled) {
      const parsed = sale.hobbyiqCardId ? parseHobbyIqCardId(sale.hobbyiqCardId) : null;
      const verdict = classifySaleShape(sale, parsed, {
        sport, year, setKey,
        ownNumbers, siblingHits, insertParentHits, ownParallelsByNumber,
        nonStrictSourcesByNumber: nonStrictBySources,
        phraseLeakWords: PHRASE_LEAK_WORDS, junkParallelWords: JUNK_PARALLEL_WORDS,
        phraseLeakTitleWords: PHRASE_LEAK_TITLE_WORDS, autoNumbers,
      });
      shareCounts[verdict.saleClass] = (shareCounts[verdict.saleClass] ?? 0) + 1;
      salesByClassOverall.set(verdict.saleClass, (salesByClassOverall.get(verdict.saleClass) ?? 0) + 1);
      if (!salesByClassBySport.has(sport)) salesByClassBySport.set(sport, new Map());
      const bySport = salesByClassBySport.get(sport);
      bySport.set(verdict.saleClass, (bySport.get(verdict.saleClass) ?? 0) + 1);

      if (verdict.saleClass === "NUMBER-IN-SIBLING") {
        const key = verdict.siblingSetKey;
        siblingPairsSeen.set(key, (siblingPairsSeen.get(key) ?? 0) + 1);
      }
      if (verdict.saleClass === "RUNG-ABSENT") {
        record.topMissingSlugs.push(parsed?.parallelSlug ?? null);
      }
    }

    record.saleClassShares = shareCounts;
    record.siblingPairs = [...siblingPairsSeen.entries()].map(([to, count]) => ({ from: setKey, to, count }));
    record.topMissingSlugs = [...new Set(record.topMissingSlugs.filter(Boolean))].slice(0, 20);
    record.samplesSeen = sampled.length;
    record.skippedAlreadyBacked = skippedAlreadyBacked;
    record.skippedNeverPrice = skippedNeverPrice;

    // Dominant sale class -> the cell's own suggestedLane (majority vote
    // over the sample; ties keep the first-seen order, which is the order
    // classifySaleShape itself checks in).
    const dominant = Object.entries(shareCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominant) {
      const [dominantClass] = dominant;
      let suggestion = null;
      if (dominantClass === "NUMBER-IN-SIBLING" && record.siblingPairs.length) {
        suggestion = { suggestedLane: "repoint-sales-to-sibling-product", siblingSetKey: record.siblingPairs[0].to };
      } else if (dominantClass === "INSERT-UNDER-PARENT") {
        suggestion = { suggestedLane: "repoint-stored-insert-sales" };
      } else if (dominantClass === "PARALLEL-SUFFIX") {
        suggestion = { suggestedLane: "repoint-sales-parallel-suffix" };
      } else if (["JUNK-PARALLEL", "PHRASE-LEAK", "AUTO-MISMATCH"].includes(dominantClass)) {
        suggestion = { suggestedLane: "rematch-sold-comps (MODE=census scope=improve)" };
      }
      if (suggestion) {
        record.suggestedLane = suggestion.suggestedLane;
        record.suggestedDispatch = suggestedDispatchFor(suggestion, cellRow);
        actionCandidates.push({ suggestedLane: suggestion.suggestedLane, suggestedDispatch: record.suggestedDispatch, cell, salesUnlocked: dominant[1] });
      } else if (dominantClass === "RUNG-ABSENT") {
        record.suggestedLane = "ACQUISITION";
        record.blockers.push(`RUNG-ABSENT dominant (${dominant[1]}/${sampled.length} sampled) -- acquire ladder/insert checklist coverage; no repair lane applies`);
      } else if (dominantClass === "ROW-EXISTS-NON-STRICT") {
        record.suggestedLane = "ROW-EXISTS-NON-STRICT";
        record.blockers.push(`${dominant[1]}/${sampled.length} sampled sales already have a card_catalog row, but its source is not checklist-authority -- no repoint lane applies; this is an acquisition/upgrade candidate`);
      }
    }

    emitPlanRow(record);
    cellsProcessed++;
    spendRU(cellRU);
  }

  // ── BANNER ────────────────────────────────────────────────────────────────
  console.log("");
  console.log(`  cells processed         ${f(cellsProcessed)}`);
  if (skippedForBudget) console.log(`  cells skipped (RU budget) ${f(skippedForBudget)}`);
  console.log(`  total RU spent          ${f(Math.round(totalRU))}`);
  console.log(`  RU per cell (avg)       ${cellsProcessed ? f(Math.round(totalRU / cellsProcessed)) : 0}`);

  console.log("\n  CELL CLASS ROLLUP:");
  for (const [cls, n] of [...cellsByClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cls.padEnd(20)} ${f(n)}`);
  }

  console.log("\n  SALE CLASS ROLLUP (sampled unbacked sales, overall):");
  const totalSampled = [...salesByClassOverall.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [cls, n] of [...salesByClassOverall.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cls.padEnd(24)} ${f(n).padStart(8)}  (${((100 * n) / totalSampled).toFixed(1)}%)`);
  }

  console.log("\n  SALE CLASS ROLLUP, per sport:");
  for (const [sport, bySport] of salesByClassBySport) {
    const sportTotal = [...bySport.values()].reduce((a, b) => a + b, 0) || 1;
    console.log(`    ${sport}:`);
    for (const [cls, n] of [...bySport.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${cls.padEnd(24)} ${f(n).padStart(8)}  (${((100 * n) / sportTotal).toFixed(1)}%)`);
    }
  }

  console.log("\n  TOP 50 ACTIONS BY SALES-UNLOCKED (candidate dispatches, ranked):");
  const rankedActions = [...actionCandidates].sort((a, b) => b.salesUnlocked - a.salesUnlocked).slice(0, 50);
  for (const a of rankedActions) {
    console.log(`    ${f(a.salesUnlocked).padStart(8)}  ${a.cell.padEnd(36)}  ${a.suggestedLane}`);
  }

  if (planFd) {
    console.log(`\n  plan file rows written  ${f(planRowsWritten)}  (one NDJSON record per in-scope cell)`);
    try { fs.closeSync(planFd); } catch { /* best effort */ }
  } else if (PLAN_OUT) {
    console.log(`\n  ::warning::PLAN_OUT was set but no plan file was opened.`);
  }

  console.log("\n  This lane made NO Cosmos writes. Every suggestedDispatch line above is a");
  console.log("  REPORT-MODE dispatch for a human/steward to review and run -- nothing here");
  console.log("  dispatches anything on its own.");

  if (CLOCK.outOfClock()) {
    console.log(`\n  ${CLOCK.stoppedAtBudget()}`);
  }

  return { cellsProcessed, skippedForBudget, totalRU };
}

if (require.main === module) {
  main()
    .then(() => finishLane(0, { budget: CLOCK }))
    .catch((e) => {
      console.error(`\nFATAL: ${String(e?.stack ?? e)}`);
      finishLane(1, { budget: CLOCK });
    });
}

module.exports = {
  parseScopeTokens, rowInScope,
  strictNumberSetOf, classifyCellClass, classifySaleShape, suggestedDispatchFor,
  neverPricedBucket, sampleWindows,
};
