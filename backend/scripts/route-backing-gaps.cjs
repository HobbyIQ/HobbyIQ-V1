#!/usr/bin/env node
/**
 * route-backing-gaps.cjs -- THE GAP ROUTER. For every unbacked (sport, year,
 * setKey) cell in the published census backing table, decides WHICH existing
 * repair lane applies -- never applies anything itself.
 *
 * THIS LANE IS READ-ONLY / DECISION-ONLY. IT MAKES NO COSMOS WRITES, EVER, IN
 * EITHER MODE. There is no apply branch in this file at all -- the runner's
 * apply switch is never read, because there is nothing behind one: the only
 * container call below is `items.query`. No point operation, no items-level
 * write, no sale mover (tests/routeBackingGapsLane.test.ts pins all three,
 * and tests/everyWriteJobReconciles.test.ts's own writer net must keep
 * reading this file as a NON-writer). It dispatches nothing itself either; its output is a
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
 * (publish-census-backing.cjs's own output) -- every sports cell with >= 50
 * unbacked sales, columns+rows, each stamped with its share of its sport's
 * whole gap. (A file stamped `placeholder: true` was cut from the merge
 * tool's top-300 worklist and holds no long tail; the banner says so.) This
 * lane does NOT re-derive the census: it reads that table as its candidate
 * list, narrows it by SCOPE/TITLES/LIMIT/SLOT-SHARD, and spends its own
 * Cosmos reads only on the per-cell classification and per-sale sampling.
 *
 * CELL CLASS, in order, first match wins (classifyCellClass, pure). The
 * names are the evidence's own (gap-classes-top120.json):
 *   ALIAS-KEY         the key is a ruled alias (setKeyReconciliation.ts's
 *                     ruledAliases()) AND the canonical twin holds strict
 *                     rows in this sport+year. The WHOLE CELL re-keys
 *                     (rekey-product-setkey MODE=pool), so no sampling. First
 *                     because an alias's own string is usually unregistered
 *                     too, and the generic class would swallow it.
 *   UNKNOWN-KEY       neither isRegisteredProduct nor productAncestry knows
 *                     the string. subCase says whether strict rows already
 *                     sit under that literal string
 *                     ("strict-rows-exist-under-unregistered-string" -- the
 *                     evidence's practical alias signal) or not. SAMPLED:
 *                     its numbers may live verbatim under a registered key.
 *   MISSING           fewer than 5 strict rows at the cell's id prefix: there
 *                     is nothing to match a sale against, so no sampling --
 *                     this is an acquisition.
 *   PRESENT-MISMATCH  everything else: the checklist EXISTS and the sales do
 *                     not match it. THIS IS THE BULK OF THE GAP (96 of the
 *                     top 120 cells, 85% of their unbacked sales -- baseball
 *                     2025 topps holds 140k strict rows beside 107k unbacked
 *                     sales), and it is what sale-class sampling is FOR. A
 *                     cell is never excused from sampling for having many
 *                     strict rows.
 *
 * SALE CLASS SAMPLING -- every cell except ALIAS-KEY and MISSING.
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
 * SIBLING DISCOVERY (siblingCandidatesFor, pure). A sampled number ABSENT
 * from the cell's own strict rows is probed against candidate products of
 * the SAME sport+year, in this priority order. THE CAP: probing stops after
 * SIBLING_CANDIDATE_CAP (default 12) candidates that actually HOLD strict
 * rows that year, and never exceeds 4 x that many probes in all:
 *   1. known-good pairs (KNOWN_SIBLING_PAIRS -- the pairs the acting lane has
 *      already been ruled on; here ONLY a flag on a suggestion, never a gate)
 *   2. the key's registered ANCESTORS (productAncestry)
 *   3. its registered CHILDREN (productParentOf(child) === key). The registry
 *      files a RELEASE under its flagship exactly as it files an insert
 *      (topps-update-series under topps), so a child hit is
 *      INSERT-UNDER-PARENT only when the sale's TITLE NAMES that child
 *      (insertSetNamedInTitle -- the insert lane's own gate); otherwise it is
 *      NUMBER-IN-SIBLING, the lane that moves on the number alone.
 *   4. SIBLINGS (same immediate parent), then the rest of the FAMILY (same
 *      productAncestry root)
 * Across 3 and 4, a product the published table shows SELLING in this
 * sport+year -- or one this run already holds rows for -- is probed before
 * any that is not (free evidence it exists that year): topps-chrome alone
 * has ~80 registered team-set children, and relation order by itself would
 * spend every probe on empty ones before reaching a sibling.
 * Each candidate's strict NUMBER set is preloaded at most once per run (a
 * projection of cardNumber+source only), held in a row-budgeted LRU cache
 * (NUMBER_CACHE_BUDGET, default 600,000 numbers) shared across cells -- the
 * cells of one sport+year mostly share one family, so later cells pay
 * nothing. Candidates are loaded ONLY when the sample holds an absent number.
 * RU EFFECT: a candidate with no rows costs ~3 RU (at most 48 of them,
 * ~150 RU); one with rows costs about what its own cell preload costs --
 * measured 196 to 21,714 RU across the census's five reference cells --
 * ONCE per run. So the first cell of a family pays for up to 12 sibling
 * checklists (tens of thousands of RU when the family is a flagship's) and
 * every later cell of that sport+year family pays ~0.
 *
 * DISCOVERY IS SAFE BECAUSE THIS LANE NEVER ACTS. A pair it reports is a
 * SUGGESTION with a count and five (number, title) samples; "these two
 * products are confusable" stays an operator ruling
 * (feedback_ratio_similarity_is_not_identity), and the acting lane
 * (repoint-sales-to-sibling-product) still refuses any pair the operator did
 * not name. Candidates cut by the cap are COUNTED in the record
 * (siblingCandidatesDropped), never silently unprobed.
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
 *   PRINTRUN-SHORT-ID        repoint-sales-to-checklist-numbered (the rung is
 *                            on the checklist only WITH :num-N)
 *   NUMBER-ABSENT            acquisition note (on no probed checklist)
 *
 * THERE IS NO "RE-DERIVE" LANE FOR A STORED SALE. The only scripts that carry
 * the word are recheck-holding-identity.ts / rederive-holding-identity
 * (HOLDINGS, not sold_comps). What re-derives a stored sale's identity from
 * its title through today's parser is rematch-sold-comps itself, so
 * JUNK-PARALLEL / PHRASE-LEAK / AUTO-MISMATCH name
 * "rematch-sold-comps (MODE=census scope=improve)" -- a census first, since
 * its apply is gated on a clean sample audit and the canary -- rather than
 * a script that does not exist.
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
 *      default 300,000 per link, both containers -- an RU stop exits 0 and
 *      does NOT print the budget marker, so the runner never relaunches into
 *      the same spend); SOLD_COMPS_RU_PER_SEC=1500 over GOVERNOR_WINDOW_MS=
 *      10000 (the pacing governor); SALES_PAGE_SIZE=100;
 *      SALES_QUERY_PARALLELISM=2; MAX_THROTTLES=20 (then stop `throttled`,
 *      exit 5, no marker) -- see LOAD SAFETY beside the constants;
 *      SAMPLE_CAP=400; SIBLING_CANDIDATE_CAP=12; NUMBER_CACHE_BUDGET=600000;
 *      SCAN_LIMIT (the runner's `scan_limit`) = hop * 1,000,000 + the RESUME
 *      OFFSET a budget relaunch carries, 0 on a first dispatch; a clock stop
 *      that advanced ZERO cells (`no-progress`) or sits at hop 12 (`hop-cap`)
 *      exits 5 and prints no marker;
 *      BACKING_CELLS optional table path (workstation/tests); PLAN_OUT optional NDJSON
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
//
// LOAD SAFETY (2026-09-20). sold_comps runs at 10,000 RU/s SHARED with
// production pricing reads, and the census day's heavy scans already produced
// 429s and pricing timeouts. A triage lane must never be the reason a price
// request times out, so it throttles ITSELF four ways:
//   RU_BUDGET_MAX        300,000 RU per link across both containers (was 2M).
//   SOLD_COMPS_RU_PER_SEC  1,500 -- a pacing governor holds this lane's OWN
//                        sold_comps consumption under that average over a
//                        sliding 10 s window, sleeping before a page when
//                        the window is full. card_catalog is a separate
//                        container, not governed, but metered separately.
//   SALES_PAGE_SIZE 100 / SALES_QUERY_PARALLELISM 2 -- a sample read stops at
//                        ~100 rows per window, so it pages small and does
//                        NOT fan out across every partition at once (-1 is
//                        for a scan that must FINISH; a sample must not).
//   MAX_THROTTLES        20 -- any 429 sleeps retryAfter x2 and is counted;
//                        the 20th ends the run with stop reason `throttled`.
const RU_BUDGET_MAX = Number(process.env.RU_BUDGET_MAX || 300_000);
const SOLD_COMPS_RU_PER_SEC = Math.max(1, Number(process.env.SOLD_COMPS_RU_PER_SEC || 1500));
const GOVERNOR_WINDOW_MS = Math.max(1000, Number(process.env.GOVERNOR_WINDOW_MS || 10_000));
const SALES_PAGE_SIZE = Math.max(1, Number(process.env.SALES_PAGE_SIZE || 100));
const SALES_QUERY_PARALLELISM = Math.max(1, Number(process.env.SALES_QUERY_PARALLELISM || 2));
const MAX_THROTTLES = Math.max(1, Number(process.env.MAX_THROTTLES || 20));
const MAX_RELAUNCH_HOPS = 12;

// THE RESUME VALUE. This lane writes nothing, so it cannot keep a cursor in
// Cosmos, and a relaunch that re-read the table from the top would redo the
// same cells until the end of time. The runner's relaunch step therefore
// advances the EXISTING `scan_limit` input (exported to every script as
// SCAN_LIMIT, inherited default "0"), and the next link skips that many cells
// of the SAME deterministic order (unbacked desc, then cell key). LIMIT bounds
// the whole chain, not each link: the order is cut to LIMIT first and the
// offset applied second.
//
// THE HOP COUNT RIDES IN THE SAME VALUE (no input is free to carry it):
//   scan_limit = hop * 1,000,000 + offset
// The published table cannot reach a million cells, so the two never collide,
// and each relaunch adds 1,000,000 + the cells this link processed.
const HOP_UNIT = 1_000_000;
function decodeResume(raw) {
  const v = Math.max(0, Math.floor(Number(raw || 0)) || 0);
  return { hop: Math.floor(v / HOP_UNIT), offset: v % HOP_UNIT };
}
const encodeResume = ({ hop, offset }) => hop * HOP_UNIT + offset;
const RESUME = decodeResume(process.env.SCAN_LIMIT);
const RESUME_OFFSET = RESUME.offset;

/**
 * HOW A LINK ENDS. PURE. `stoppedBy` is null (every cell done) | "clock" |
 * "ru" | "throttled". The relaunch composite re-dispatches on the budget
 * marker and nothing else, so `printMarker` is the whole decision:
 *   clock + progress + hops left  -> marker, exit 0: the chain continues.
 *   clock + ZERO cells advanced   -> `no-progress`: the next link would start
 *                                    from the same offset with the same clock
 *                                    and advance nothing again, forever.
 *   clock at the hop cap          -> `hop-cap`.
 *   throttled                     -> the container is refusing us; a relaunch
 *                                    would walk straight back into it.
 *   ru                            -> the operator's own budget; exit 0.
 * The three refusals exit 5 with an ABORT/BACKING OFF line, which the
 * composite reports as a FINISHED WITH VERDICT (red, no re-dispatch) rather
 * than as a clean finish with work left over.
 */
function relaunchDecision({ stoppedBy, cellsProcessed, hop, maxHops = MAX_RELAUNCH_HOPS }) {
  if (!stoppedBy) return { stop: "finished", printMarker: false, exitCode: 0 };
  if (stoppedBy === "ru") return { stop: "ru-budget", printMarker: false, exitCode: 0 };
  if (stoppedBy === "throttled") return { stop: "throttled", printMarker: false, exitCode: 5 };
  if (!(cellsProcessed > 0)) return { stop: "no-progress", printMarker: false, exitCode: 5 };
  if (hop >= maxHops) return { stop: "hop-cap", printMarker: false, exitCode: 5 };
  return { stop: "budget", printMarker: true, exitCode: 0 };
}

/**
 * THE PACING GOVERNOR. Holds the RU this lane draws from ONE container under
 * `targetRuPerSec`, averaged over a sliding `windowMs`. `record(ru)` after a
 * page; `await pace()` before the next. When the window already holds its
 * whole allowance, pace() sleeps exactly until enough of the OLDEST charges
 * have aged out -- never a fixed nap, so a cheap run is never slowed and an
 * expensive one is held to the line. `now`/`sleep` are injected so the test
 * drives it with a fake clock.
 */
function makeGovernor({ targetRuPerSec, windowMs = 10_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const allowance = targetRuPerSec * (windowMs / 1000);
  let events = [];
  let sleeps = 0, sleptMs = 0, total = 0;
  const prune = () => { const cut = now() - windowMs; events = events.filter((e) => e.t > cut); };
  const inWindow = () => { prune(); return events.reduce((n, e) => n + e.ru, 0); };
  return {
    record(ru) { if (ru > 0) { events.push({ t: now(), ru }); total += ru; } },
    async pace() {
      let sum = inWindow();
      if (sum < allowance) return 0;
      let until = now();
      for (const e of events) { sum -= e.ru; until = e.t + windowMs; if (sum < allowance) break; }
      const ms = Math.max(1, until - now() + 1);
      sleeps++; sleptMs += ms;
      await sleep(ms);
      return ms;
    },
    ruPerSecNow: () => inWindow() / (windowMs / 1000),
    stats: () => ({ sleeps, sleptMs, total }),
  };
}

/** Thrown by pagedQuery when the run's 429 count reaches MAX_THROTTLES. */
class ThrottleAbort extends Error {
  constructor(count) { super(`THROTTLE_ABORT after ${count} throttled request(s)`); this.name = "ThrottleAbort"; }
}
const is429 = (e) => e?.code === 429 || e?.statusCode === 429 || /\b429\b|request rate is large|TooManyRequests/i.test(String(e?.message ?? ""));
const retryAfterMsOf = (e) => {
  const n = Number(e?.retryAfterInMs ?? e?.retryAfterInMilliseconds ?? e?.headers?.["x-ms-retry-after-ms"]);
  return Number.isFinite(n) && n > 0 ? n : 1000;
};
const SAMPLE_CAP = Math.max(1, Number(process.env.SAMPLE_CAP || 400));
// How many sibling candidates one cell may probe (see SIBLING DISCOVERY in the
// header for the order and the RU effect), and how many card NUMBERS the
// shared candidate cache may hold before its least-recently-used set goes.
const SIBLING_CANDIDATE_CAP = Math.max(0, Number(process.env.SIBLING_CANDIDATE_CAP || 12));
const NUMBER_CACHE_BUDGET = Math.max(1, Number(process.env.NUMBER_CACHE_BUDGET || 600_000));

/**
 * KNOWN-GOOD SIBLING PAIRS, from -> [to]. NOT a gate and NOT the candidate
 * list: discovery finds pairs on its own. A pair listed here has already
 * been ruled for the acting lane (repoint-sales-to-sibling-product's own
 * pilot pairs), so its suggestion is flagged `knownGood` and probed first;
 * every other pair is reported as DISCOVERED and needs an operator ruling.
 */
const KNOWN_SIBLING_PAIRS = Object.freeze({
  topps: Object.freeze(["topps-update-series"]),
  "donruss-optic": Object.freeze(["panini-donruss"]),
});

/** Tokens that are never a finish. A closed list, matched against whole
 *  hyphen-separated tokens of the sale's PARALLEL SLUG (never the title). */
const JUNK_PARALLEL_WORDS = Object.freeze(["lot", "lots", "reprint", "custom", "proxy", "digital", "psa", "bgs", "sgc", "cgc", "graded", "slab", "invest"]);

const { decodeCells } = require(path.join(__dirname, "publish-census-backing.cjs"));

const SHARD_SCOPE = runnerShardScope({ label: "route-backing-gaps" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

const PLAN_OUT = str(process.env.PLAN_OUT);

// BACKING_CELLS is for a workstation or a test pointing at another published
// table; the runner never sets it, so a dispatch always reads the committed one.
const BACKING_CELLS_PATH = str(process.env.BACKING_CELLS) || path.join(backend, "data", "census", "backing-cells.json");

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

/**
 * CELL CLASS. `cellRow` is one decoded row of backing-cells.json. `catalog`
 * is `{ totalRows, strictRows, registered, resolvesViaAncestry, aliasTarget,
 * aliasTargetStrictRows }` -- the LIVE card_catalog facts for this cell,
 * computed once by the caller and passed in pure.
 *
 * `sample` on the verdict says whether the caller goes on to sale-class
 * sampling. Only ALIAS-KEY (the whole cell re-keys) and MISSING (nothing to
 * match a sale against) do not. A cell with plentiful strict rows is NOT
 * excused: that is PRESENT-MISMATCH, the bulk of the measured gap.
 *
 * MISSING floor: strictRows < 5 -- a small floor rather than a hard zero,
 * because a handful of stray rows under this id prefix (a mis-keyed sibling,
 * an isolated seed row) is not "the product has a checklist".
 */
const MISSING_FLOOR = 5;
function classifyCellClass(cellRow, catalog) {
  const strictRows = Number(catalog.strictRows ?? 0);
  const totalRows = Number(catalog.totalRows ?? 0);

  if (catalog.aliasTarget && Number(catalog.aliasTargetStrictRows ?? 0) > 0) {
    return {
      cellClass: "ALIAS-KEY", sample: false,
      aliasTarget: catalog.aliasTarget,
      detail: `setKey "${cellRow.setKey}" is a RULED ALIAS of "${catalog.aliasTarget}" (setKeyReconciliation.ts ruledAliases()), which holds ${catalog.aliasTargetStrictRows} strict rows`,
      suggestedLane: "rekey-product-setkey",
      suggestedMode: "pool",
    };
  }

  if (!catalog.registered && !catalog.resolvesViaAncestry) {
    const subCase = strictRows > 0 ? "strict-rows-exist-under-unregistered-string" : "no-strict-rows-under-unregistered-string";
    return {
      cellClass: "UNKNOWN-KEY", sample: true, subCase,
      detail: `setKey "${cellRow.setKey}" is not a registered product and does not resolve via productAncestry -- ${strictRows} strict / ${totalRows} total catalog row(s) sit under this exact string`,
    };
  }

  if (strictRows < MISSING_FLOOR) {
    return {
      cellClass: "MISSING", sample: false,
      detail: `${strictRows} strict catalog row(s) at this cell's id prefix (floor ${MISSING_FLOOR}) -- registered product, no checklist here; acquire it`,
    };
  }

  return {
    cellClass: "PRESENT-MISMATCH", sample: true,
    detail: `${strictRows} strict rows exist and ${Number(cellRow.unbacked ?? 0)} sales still do not match them -- sale-class sampling says why`,
  };
}

/**
 * THE SIBLING CANDIDATES for one setKey, in PROBE ORDER. PURE: `deps` =
 * { productAncestry, productParentOf, allKeys, knownPairs, presentKeys }.
 * Returns [{ setKey, relation, knownGood, present }], relation being
 * "ancestor" | "child" | "sibling" | "family". The CALLER applies the cap
 * while it probes (see SIBLING DISCOVERY in the header): it stops after
 * `cap` candidates that actually HOLD strict rows in this sport+year, and
 * never probes more than 4 x cap in all -- an empty candidate costs ~3 RU
 * and tells the operator the product has no checklist that year, so it must
 * not spend a slot a real checklist needs.
 *
 * ORDER: known-good pairs, then ancestors, then children, siblings (same
 * immediate parent) and the rest of the family (same productAncestry root).
 * After the ancestors, every key in `presentKeys` -- a product the census
 * table shows selling in THIS sport+year, or one this run already holds
 * rows for -- goes before every key that is not, whatever its relation: a
 * flagship has dozens of registered children (topps-chrome ~80 team sets)
 * and relation order alone would never reach the first sibling. Relation,
 * then closest spelling, order each of the two groups.
 *
 * An UNREGISTERED key has an ancestry of just itself, so its family is
 * empty by the registry -- for that one case the family is the keys sharing
 * its leading word ("topps-foo" probes the topps family), the segment
 * reading resolveProductByChecklist.ts already uses for a key the registry
 * does not know.
 */
function siblingCandidatesFor(setKey, deps) {
  const key = String(setKey ?? "").trim().toLowerCase();
  if (!key) return [];
  const all = deps.allKeys ?? [];
  const present = deps.presentKeys ?? new Set();
  const ancestry = deps.productAncestry(key);
  const known = new Set(deps.knownPairs?.[key] ?? []);
  const parent = deps.productParentOf(key);
  const isRoot = ancestry.length === 1 && all.includes(key);
  const root = ancestry.length > 1 ? ancestry[ancestry.length - 1] : (isRoot ? key : null);
  const leadingWord = key.split("-")[0];
  const rootOf = (k) => { const a = deps.productAncestry(k); return a[a.length - 1]; };
  const sharedPrefix = (k) => { let i = 0; while (i < k.length && i < key.length && k[i] === key[i]) i++; return i; };
  const ranked = (keys) => [...keys].sort((a, b) => (present.has(b) ? 1 : 0) - (present.has(a) ? 1 : 0) || sharedPrefix(b) - sharedPrefix(a) || a.localeCompare(b));
  const relationOf = (k) => {
    if (ancestry.includes(k)) return "ancestor";
    if (deps.productParentOf(k) === key) return "child";
    if (parent && deps.productParentOf(k) === parent) return "sibling";
    return "family";
  };

  const seen = new Set([key]);
  const out = [];
  const push = (k) => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ setKey: k, relation: relationOf(k), knownGood: known.has(k), present: present.has(k) });
  };
  for (const k of known) push(k);
  for (const k of ancestry.slice(1)) push(k);
  const head = out.length;
  for (const k of ranked(all.filter((c) => deps.productParentOf(c) === key))) push(k);
  if (parent) for (const k of ranked(all.filter((c) => deps.productParentOf(c) === parent))) push(k);
  for (const k of ranked(all.filter((c) => (root ? rootOf(c) === root : (c === leadingWord || c.startsWith(`${leadingWord}-`)))))) push(k);
  // PRESENCE OUTRANKS RELATION. topps-chrome alone has ~80 registered
  // children (team sets), nearly all empty in any one sport+year; probed in
  // relation order they would exhaust the probe limit before the first
  // sibling. A stable partition keeps child < sibling < family WITHIN the
  // present group and within the rest.
  const tail = out.slice(head);
  return [...out.slice(0, head), ...tail.filter((c) => c.present), ...tail.filter((c) => !c.present)];
}

/**
 * SALE CLASS for one sampled unbacked sale. `parsed` is
 * parseHobbyIqCardId(sale.hobbyiqCardId) or null. EVERY comparison is on
 * SLUG SEGMENTS -- the sale's id against the catalog rows' ids -- never the
 * human-form parallel/cardNumber/isAuto fields or the title. `ctx`, all
 * precomputed per cell:
 *   sport, year, setKey
 *   ownNumbers            Set<number slug> on this cell's strict rows
 *   ownRungsByNumber      Map<number, [{parallel, isAuto, printRun}]> parsed
 *                         off this cell's strict rows' OWN ids
 *   nonStrictSourcesById  Map<catalog id, Set<source>> for non-strict rows
 *   candidateHits         [{setKey, relation, knownGood, numbers:Set}] in
 *                         siblingCandidatesFor's priority order
 *   suffixWords           the product family's own suffix word(s)
 *   junkWords             tokens that are never a finish
 *
 * Order, first match wins:
 *   UNPARSEABLE -> ROW-EXISTS-NON-STRICT (exact id)
 *   number NOT on own checklist: INSERT-UNDER-PARENT / NUMBER-IN-SIBLING by
 *     candidate relation -> NUMBER-ABSENT
 *   number on own checklist, parallel on it: AUTO-MISMATCH ->
 *     PRINTRUN-SHORT-ID -> PRINTRUN-VARIANT-ABSENT -> UNRESOLVED
 *   number on own checklist, parallel NOT on it: PARALLEL-SUFFIX ->
 *     JUNK-PARALLEL -> PHRASE-LEAK -> RUNG-ABSENT
 */
const REDERIVE_LANE = "rematch-sold-comps (MODE=census scope=improve)";
function classifySaleShape(sale, parsed, ctx) {
  if (!sale?.hobbyiqCardId || !parsed) {
    return { saleClass: "UNPARSEABLE", detail: "no hobbyiqCardId, or the slug does not parse into segments" };
  }
  const num = String(parsed.cardNumber ?? "").trim().toLowerCase();
  if (!num) return { saleClass: "UNPARSEABLE", detail: "parsed slug carries no card number segment" };

  // ROW-EXISTS-NON-STRICT, by EXACT ID: a card_catalog row sits at this very
  // address and no checklist-authority source backs it. This is the census's
  // own rowExistsNonStrict bucket, so it is answered first and exactly.
  const nonStrictSources = ctx.nonStrictSourcesById?.get(String(sale.hobbyiqCardId));
  if (nonStrictSources && nonStrictSources.size > 0) {
    return {
      saleClass: "ROW-EXISTS-NON-STRICT",
      sources: [...nonStrictSources],
      detail: `a card_catalog row exists at this exact id but its source(s) (${[...nonStrictSources].join(", ")}) are not checklist-authority`,
    };
  }

  // THE NUMBER IS NOT ON THIS CELL'S OWN CHECKLIST. Probe the discovered
  // candidates in priority order (siblingCandidatesFor): a CHILD of this key
  // is INSERT-UNDER-PARENT, any other relation is NUMBER-IN-SIBLING. The
  // first candidate listing the number wins; `alsoOn` names the rest, so an
  // ambiguous number is visible as ambiguous.
  if (!ctx.ownNumbers.has(num)) {
    const hits = (ctx.candidateHits ?? []).filter((c) => c.numbers.has(num));
    if (hits.length) {
      // A CHILD of this key is not automatically an insert: the registry
      // files a RELEASE under its flagship the same way (topps-update-series
      // under topps), and that pair belongs to the sibling lane. The two
      // acting lanes split on exactly one fact -- repoint-stored-insert-sales
      // moves a sale only when its TITLE NAMES the insert
      // (insertSetNamedInTitle), the sibling lane moves on the number alone
      // -- so the router asks the same question: a child the title names is
      // INSERT-UNDER-PARENT, any other hit is NUMBER-IN-SIBLING.
      const named = new Set(ctx.insertKeysNamedInTitle ? ctx.insertKeysNamedInTitle(sale) : []);
      const namedChild = hits.find((c) => c.relation === "child" && named.has(c.setKey));
      const hit = namedChild ?? hits[0];
      const alsoOn = hits.filter((c) => c !== hit).map((c) => c.setKey);
      if (namedChild) {
        return {
          saleClass: "INSERT-UNDER-PARENT", insertSetKey: hit.setKey, knownGood: hit.knownGood === true, alsoOn,
          suggestedLane: "repoint-stored-insert-sales",
          detail: `#${num} is on "${hit.setKey}"'s own checklist, a registered child of this cell's product, and the title names it`,
        };
      }
      return {
        saleClass: "NUMBER-IN-SIBLING", siblingSetKey: hit.setKey, relation: hit.relation, knownGood: hit.knownGood === true, alsoOn,
        suggestedLane: "repoint-sales-to-sibling-product",
        detail: `#${num} absent from this cell's own checklist, present verbatim on ${hit.relation} "${hit.setKey}"`,
      };
    }
    return {
      saleClass: "NUMBER-ABSENT",
      detail: `#${num} is on neither this cell's checklist nor any of the ${(ctx.candidateHits ?? []).length} probed candidate(s) -- a missing insert/subset checklist, or a misread number`,
      acquisitionNote: `acquire the checklist carrying #${num} for ${ctx.sport}/${ctx.year}/${ctx.setKey}`,
    };
  }

  // THE NUMBER IS ON THIS CELL'S OWN CHECKLIST. Everything below compares the
  // sale's SLUG rung (parallel, auto, printRun -- read off its id) against the
  // checklist's OWN slug rungs at that number (read off the catalog rows'
  // ids by the same parser), so both sides are in one vocabulary.
  const rungs = ctx.ownRungsByNumber?.get(num) ?? [];
  const saleParallel = String(parsed.parallel ?? "").trim().toLowerCase() || "base";
  const saleAuto = parsed.isAuto === true;
  const salePrintRun = parsed.printRun ?? null;
  const atParallel = rungs.filter((r) => r.parallel === saleParallel);

  if (atParallel.length) {
    const sameAuto = atParallel.filter((r) => r.isAuto === saleAuto);
    if (!sameAuto.length) {
      return {
        saleClass: "AUTO-MISMATCH", suggestedLane: REDERIVE_LANE,
        detail: `#${num} "${saleParallel}" exists on the checklist only as ${saleAuto ? "no-auto" : "auto"}; the sale's id says ${saleAuto ? "auto" : "no-auto"}`,
      };
    }
    if (!sameAuto.some((r) => (r.printRun ?? null) === salePrintRun)) {
      if (salePrintRun === null) {
        return {
          saleClass: "PRINTRUN-SHORT-ID", suggestedLane: "repoint-sales-to-checklist-numbered",
          detail: `#${num} "${saleParallel}" is on the checklist only WITH a print run (num-${sameAuto.map((r) => r.printRun).filter(Boolean).join("/num-")}); the sale's id carries none`,
        };
      }
      return {
        saleClass: "PRINTRUN-VARIANT-ABSENT",
        detail: `#${num} "${saleParallel}" is on the checklist, but not at num-${salePrintRun} (checklist: ${sameAuto.map((r) => (r.printRun ? `num-${r.printRun}` : "unnumbered")).join(", ")})`,
      };
    }
    // Exact rung present (the ids differ elsewhere, e.g. a subset segment).
    return { saleClass: "UNRESOLVED", detail: `#${num}/${saleParallel} -- the exact rung is on the checklist; the id differs on another segment` };
  }

  // The checklist has the number but NOT this parallel slug.
  const parallelsHere = new Set(rungs.map((r) => r.parallel));
  for (const suffixWord of ctx.suffixWords ?? []) {
    const longer = `${saleParallel}-${suffixWord}`;
    const shorter = saleParallel.endsWith(`-${suffixWord}`) ? saleParallel.slice(0, -(suffixWord.length + 1)) : null;
    const twin = parallelsHere.has(longer) ? longer : (shorter && parallelsHere.has(shorter) ? shorter : null);
    if (twin) {
      return {
        saleClass: "PARALLEL-SUFFIX", suggestedLane: "repoint-sales-parallel-suffix", checklistSpelling: twin,
        detail: `"${saleParallel}" vs the checklist's "${twin}" -- they differ only by the product's own suffix word "${suffixWord}"`,
      };
    }
  }
  const tokens = saleParallel.split("-").filter(Boolean);
  const junk = tokens.find((t) => (ctx.junkWords ?? []).includes(t));
  if (junk) {
    return { saleClass: "JUNK-PARALLEL", suggestedLane: REDERIVE_LANE, detail: `parallel slug "${saleParallel}" carries "${junk}", which is never a finish` };
  }
  const productWords = new Set([...String(ctx.setKey ?? "").split("-"), String(ctx.year ?? "")].filter((w) => w.length > 2));
  for (const w of ctx.suffixWords ?? []) productWords.delete(w); // a suffix word is a legitimate part of a finish
  const leaked = tokens.find((t) => productWords.has(t));
  if (leaked) {
    return { saleClass: "PHRASE-LEAK", suggestedLane: REDERIVE_LANE, detail: `parallel slug "${saleParallel}" carries the product's own word "${leaked}" -- the product phrase leaked into the finish` };
  }
  return {
    saleClass: "RUNG-ABSENT", missingSlug: saleParallel,
    detail: `#${num} is on the checklist, "${saleParallel}" is not among its ${parallelsHere.size} rung(s) -- a catalog hole, not a routing problem`,
    acquisitionNote: `acquire ladder coverage for "${saleParallel}" on ${ctx.sport}/${ctx.year}/${ctx.setKey}`,
  };
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
      return `gh workflow run backfill-runner.yml -f script=repoint-sales-to-sibling-product -f apply=false -f scope=${scopeArg} -f "titles=${cell.setKey}>${suggestion.siblingSetKey ?? "SIBLING-SETKEY"}"`; // quoted: a bare '>' is a shell redirect
    case "repoint-stored-insert-sales":
      return `gh workflow run backfill-runner.yml -f script=repoint-stored-insert-sales -f apply=false -f scope=${scopeArg} -f titles=${suggestion.insertSetKey ?? "<insert-setkey>"}`;
    case "repoint-sales-parallel-suffix":
      return `gh workflow run backfill-runner.yml -f script=repoint-sales-parallel-suffix -f apply=false -f scope=${scopeArg} -f titles=${cell.setKey}`;
    case "repoint-sales-to-checklist-numbered":
      return `gh workflow run backfill-runner.yml -f script=repoint-sales-to-checklist-numbered -f apply=false -f scope=${scopeArg} -f titles=${cell.setKey}`;
    case "rekey-product-setkey":
      return `gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false -f mode=pool -f scope=${cell.sport} -f setkey_like=${cell.setKey} -f titles=${suggestion.aliasTarget ?? "<canonical-setkey>"} -f years=${cell.year}`;
    case "rematch-sold-comps (MODE=census scope=improve)":
      // The rematch ALWAYS shards 32 ways on its measured table, so one
      // dispatch is one slot; setkey_like + sports are its in-slot row filter.
      return `gh workflow run backfill-runner.yml -f script=rematch-sold-comps -f mode=census -f scope=improve -f sports=${cell.sport} -f setkey_like=${cell.setKey} -f slots=32 -f slot=0   # repeat for slot 1..31`;
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
/**
 * `opts.governor` paces BEFORE every page and is charged AFTER it.
 * `opts.throttle` is the run-wide 429 ledger `{ count, max, sleptMs, sleep }`:
 * a 429 that reaches us has already outlived the SDK's own retries, so it is
 * counted, slept off at retryAfter x2, and the SAME page is asked for again
 * -- until the run's count reaches `max`, which throws ThrottleAbort.
 */
async function pagedQuery(container, spec, onPage, opts = {}) {
  const pageSize = opts.pageSize ?? 500;
  const SPIN_GUARD_PAGES = Number(process.env.SPIN_GUARD_PAGES || 50);
  const iter = container.items.query(spec, { maxItemCount: pageSize, maxDegreeOfParallelism: opts.parallelism ?? -1 });
  const throttle = opts.throttle;
  let consecutiveEmptyPages = 0;
  let ru = 0;
  while (iter.hasMoreResults()) {
    if (opts.governor) await opts.governor.pace();
    let page;
    for (;;) {
      try { page = await iter.fetchNext(); break; }
      catch (e) {
        if (!is429(e) || !throttle) throw e;
        throttle.count++;
        if (throttle.count >= throttle.max) throw new ThrottleAbort(throttle.count);
        const ms = retryAfterMsOf(e) * 2;
        throttle.sleptMs += ms;
        await throttle.sleep(ms);
      }
    }
    if (opts.governor) opts.governor.record(page.requestCharge || 0);
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
    if (opts.onCharge) opts.onCharge(pageRU); // metered per PAGE, so an aborted read still counts what it spent
    if ((await onPage(rows, pageRU)) === false) break;
  }
  return ru;
}

/** hiq:<sport>:<year>:<setKey>: -- the same STARTSWITH prefix every sibling
 *  lane's own checklist preload uses. */
const idPrefix = (sport, year, setKey) => `hiq:${sport}:${year}:${setKey}:`;

function checklistSpec(sport, year, setKey) {
  return {
    // id + source + cardNumber ONLY: every rung this lane compares is parsed
    // off the id, so the human-form parallel/isAuto fields are never fetched.
    query: `SELECT c.id, c.source, c.cardNumber
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

/** A sibling CANDIDATE's rows -- the same bounded prefix read; only its strict
 *  NUMBER set is kept, in the row-budgeted cache. */
const numbersSpec = checklistSpec;

function salesSpecWindow(sport, year, setKey, fromIso, toIso) {
  return {
    // title/playerName ride along ONLY for the plan's samples and the insert
    // lane's own title gate -- never for number/parallel/auto classification.
    query: `SELECT c.id, c.hobbyiqCardId, c.cardId, c.title, c.playerName, c.soldAt,
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
  const { productParentOf, productAncestry, productSetKeys } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { isRegisteredProduct } = require(path.join(backend, "dist/services/catalog/resolveProductByChecklist.js"));
  const { ruledAliases } = require(path.join(backend, "dist/services/catalog/setKeyReconciliation.js"));
  const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  // The ACTING lane's own table decides where PARALLEL-SUFFIX can be
  // suggested at all: a product it has no suffix word for is a product it
  // would refuse, so the router never sends an operator there.
  const { suffixWordFor } = require(path.join(__dirname, "repoint-sales-parallel-suffix.cjs"));
  const { insertSetNamedInTitle } = require(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";
  const ALIASES = ruledAliases(); // [{setKey, canonical, why}]
  const aliasTargetOf = (setKey) => ALIASES.find((a) => a.setKey === setKey)?.canonical ?? null;
  const ALL_KEYS = productSetKeys();
  const candidateDeps = { productAncestry, productParentOf, allKeys: ALL_KEYS, knownPairs: KNOWN_SIBLING_PAIRS };
  const numberOfId = (row) => {
    const p = parseHobbyIqCardId(String(row.id ?? ""));
    return lower(p?.cardNumber ?? row.cardNumber);
  };

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const catalog = db.container("card_catalog");
  const sales = db.container("sold_comps");

  let totalRU = 0;

  // ── LOAD SAFETY wiring (see the constants' own block). Two meters, because
  // the two containers are two different budgets: sold_comps is the one
  // production pricing reads share, and the only one the governor paces.
  const meter = { catalog: 0, sales: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const governor = makeGovernor({ targetRuPerSec: SOLD_COMPS_RU_PER_SEC, windowMs: GOVERNOR_WINDOW_MS });
  const throttle = { count: 0, max: MAX_THROTTLES, sleptMs: 0, sleep };
  const readCatalog = (spec, onPage) => pagedQuery(catalog, spec, onPage, { throttle, onCharge: (n) => { meter.catalog += n; } });
  const readSales = (spec, onPage) => pagedQuery(sales, spec, onPage, {
    throttle, governor, pageSize: SALES_PAGE_SIZE, parallelism: SALES_QUERY_PARALLELISM, onCharge: (n) => { meter.sales += n; },
  });
  let cellsDoneForBeat = 0;
  // The lane's OWN heartbeat, beside the budget's keepalive: what a reader
  // tailing the log needs to see is load, not just liveness. Unref'd -- the
  // keepalive is what holds the loop; this only narrates.
  CLOCK.keepalive("route-backing-gaps");
  const beat = setInterval(() => {
    const g = governor.stats();
    console.log(`narrate: route-backing-gaps load -- cells ${cellsDoneForBeat}, sold_comps ${f(Math.round(meter.sales))} RU (now ${f(Math.round(governor.ruPerSecNow()))} RU/s of a ${f(SOLD_COMPS_RU_PER_SEC)} target, paced ${g.sleeps}x / ${f(g.sleptMs)} ms), card_catalog ${f(Math.round(meter.catalog))} RU, throttles ${throttle.count}/${MAX_THROTTLES}`);
  }, Number(process.env.LOAD_HEARTBEAT_MS || 60_000));
  if (beat.unref) beat.unref();

  // ── THE NUMBER CACHE: one strict NUMBER set per (sport, year, setKey),
  // loaded at most once per run and shared by every cell that probes it --
  // including each cell's OWN set, since the cells of one family are each
  // other's candidates. LRU, bounded by TOTAL NUMBERS held (a flagship is
  // 5k numbers, an insert 20 -- a count-of-sets cap could not see that).
  const numberCache = new Map(); // key -> Set<number>
  let numberCacheSize = 0, numberCacheEvictions = 0, numberCacheHits = 0, numberCacheLoads = 0;
  const cachePut = (key, set) => {
    if (numberCache.has(key)) { numberCacheSize -= numberCache.get(key).size; numberCache.delete(key); }
    numberCache.set(key, set);
    numberCacheSize += set.size;
    while (numberCacheSize > NUMBER_CACHE_BUDGET && numberCache.size > 1) {
      const [oldest, oldSet] = numberCache.entries().next().value;
      if (oldest === key) break;
      numberCache.delete(oldest); numberCacheSize -= oldSet.size; numberCacheEvictions++;
    }
  };
  /** Returns { numbers, ru } -- ru is 0 on a cache hit. */
  async function strictNumbersOf(sport, year, setKey) {
    const key = `${sport}|${year}|${setKey}`;
    const hit = numberCache.get(key);
    if (hit) { numberCache.delete(key); numberCache.set(key, hit); numberCacheHits++; return { numbers: hit, ru: 0 }; }
    const numbers = new Set();
    const ru = await readCatalog(numbersSpec(sport, year, setKey), (rows) => {
      for (const r of rows) { if (isChecklist(r.source)) { const n = numberOfId(r); if (n) numbers.add(n); } }
    });
    numberCacheLoads++;
    cachePut(key, numbers);
    return { numbers, ru };
  }

  // ── CANDIDATE CELLS: the published table, filtered by SCOPE/TITLES/LIMIT/SHARD ──
  const allCells = decodeCells(published);
  const sportGap = published.sportGap ?? {};
  // Which products the census saw SELLING in each sport+year -- free evidence
  // (no RU) that a sibling candidate exists that year; ranks the probe order.
  const presentKeysBySportYear = new Map();
  for (const c of allCells) {
    const k = `${c.sport}|${Number(c.year)}`;
    if (!presentKeysBySportYear.has(k)) presentKeysBySportYear.set(k, new Set());
    presentKeysBySportYear.get(k).add(lower(c.setKey));
  }
  let candidates = allCells.filter((c) => rowInScope(c, SCOPE_PARSE));
  if (SET_KEY_FILTER.size) candidates = candidates.filter((c) => SET_KEY_FILTER.has(lower(c.setKey)));
  const inScopeBeforeShard = candidates.length;
  candidates = candidates.filter((c) => SHARD_SCOPE.mine(shardOf(c.cell)));
  candidates.sort((a, b) => b.unbacked - a.unbacked || String(a.cell).localeCompare(String(b.cell)));
  const inScopeBeforeLimit = candidates.length;
  if (LIMIT > 0) candidates = candidates.slice(0, LIMIT);
  const chainTotal = candidates.length;
  if (RESUME_OFFSET > 0) candidates = candidates.slice(RESUME_OFFSET);

  console.log("");
  console.log(`  published cells         ${f(allCells.length)}  (floor ${published.minUnbackedUsed ?? "?"} unbacked; from ${BACKING_CELLS_PATH})`);
  if (published.placeholder === true) {
    console.log("  !! INPUT IS A PLACEHOLDER: cut from the merge tool's TOP-300 worklist, it holds NO long tail.");
    console.log("     Regenerate it (merge-census-backing.cjs -> publish-census-backing.cjs) to route the tail.");
  }
  console.log(`  in scope                ${f(inScopeBeforeShard)}  -> this shard ${f(inScopeBeforeLimit)}  -> after LIMIT ${f(chainTotal)}`);
  if (RESUME_OFFSET > 0) console.log(`  RESUMED                 skipping the first ${f(RESUME_OFFSET)} cell(s) an earlier link already routed (scan_limit carries the offset) -> ${f(candidates.length)} left; rollups below cover THIS link only`);
  console.log(`  RU_BUDGET_MAX           ${f(RU_BUDGET_MAX)}    sibling candidate cap ${SIBLING_CANDIDATE_CAP}    number cache budget ${f(NUMBER_CACHE_BUDGET)}`);

  if (!candidates.length) {
    console.log("\n  nothing in scope -- nothing to route.");
    return;
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

  const estByClass = new Map();        // saleClass -> estimated unbacked sales
  const estByClassBySport = new Map(); // sport -> Map(saleClass -> est)
  const actions = [];                  // {lane, dispatch, cell, estSales, note}
  const cellsByClass = new Map();      // cellClass -> {cells, unbacked}
  const reachedBySport = new Map();    // sport -> {cells, unbacked, smallest}
  let cellsProcessed = 0, cellsFailed = 0;
  let stoppedBy = null;
  const bump = (map, k, n) => map.set(k, (map.get(k) ?? 0) + n);

  console.log("\n  per cell:  class / sampled / RU");
  for (const cellRow of candidates) {
    // The budget's PRE-CHECK, before the unit -- never after (runner-budget.cjs).
    if (CLOCK.outOfClock()) { stoppedBy = "clock"; break; }
    if (totalRU >= RU_BUDGET_MAX) { stoppedBy = "ru"; break; }

    const { sport, setKey, cell } = cellRow;
    const year = Number(cellRow.year);
    let cellRU = 0;
    const meterAtStart = { ...meter };
    const record = {
      cell, sport, year, setKey, unbacked: cellRow.unbacked,
      unbackedShareOfSportGap: cellRow.unbackedShareOfSportGap ?? null,
      class: null, classDetail: null, subCase: null,
      sampled: 0, saleClassShares: {}, saleClassEstSales: {},
      suggestedLane: null, suggestedDispatch: null, suggestions: [],
      topMissingSlugs: [], topMissingPrefixes: [], siblingPairs: [],
      siblingCandidatesProbed: [], siblingCandidatesDropped: 0,
      blockers: [], ru: 0,
    };

    try {
      // ── PRELOAD this cell's catalog rows ONCE. Every structure below is
      // LOCAL to this iteration and released with it; only the number set
      // outlives the cell, inside the row-budgeted cache above.
      const strictIds = new Set();
      const ownNumbers = new Set();
      const ownRungsByNumber = new Map();
      const nonStrictSourcesById = new Map();
      let totalCatalogRows = 0;
      cellRU += await readCatalog(checklistSpec(sport, year, setKey), (rows) => {
        totalCatalogRows += rows.length;
        for (const r of rows) {
          if (!isChecklist(r.source)) {
            if (!nonStrictSourcesById.has(r.id)) nonStrictSourcesById.set(r.id, new Set());
            nonStrictSourcesById.get(r.id).add(String(r.source ?? "unknown"));
            continue;
          }
          strictIds.add(r.id);
          const p = parseHobbyIqCardId(String(r.id ?? ""));
          const num = lower(p?.cardNumber ?? r.cardNumber);
          if (!num) continue;
          ownNumbers.add(num);
          if (!p) continue;
          if (!ownRungsByNumber.has(num)) ownRungsByNumber.set(num, []);
          ownRungsByNumber.get(num).push({ parallel: lower(p.parallel) || "base", isAuto: p.isAuto === true, printRun: p.printRun ?? null });
        }
      });
      // A strict twin at the same id outranks a non-strict row there.
      for (const id of strictIds) nonStrictSourcesById.delete(id);
      cachePut(`${sport}|${year}|${setKey}`, ownNumbers);

      const aliasTarget = aliasTargetOf(setKey);
      let aliasTargetStrictRows = 0;
      if (aliasTarget) {
        const got = await strictNumbersOf(sport, year, aliasTarget);
        cellRU += got.ru;
        aliasTargetStrictRows = got.numbers.size; // distinct strict NUMBERS -- >0 is all the class asks
      }

      const verdict = classifyCellClass(cellRow, {
        totalRows: totalCatalogRows, strictRows: strictIds.size,
        registered: isRegisteredProduct(setKey), resolvesViaAncestry: productAncestry(setKey).length > 1,
        aliasTarget, aliasTargetStrictRows,
      });
      record.class = verdict.cellClass;
      record.classDetail = verdict.detail;
      record.subCase = verdict.subCase ?? null;

      if (verdict.cellClass === "ALIAS-KEY") {
        const s = { suggestedLane: "rekey-product-setkey", aliasTarget: verdict.aliasTarget };
        record.suggestedLane = s.suggestedLane;
        record.suggestedDispatch = suggestedDispatchFor(s, { sport, year, setKey });
        record.suggestions.push({ lane: s.suggestedLane, estSales: cellRow.unbacked, dispatch: record.suggestedDispatch, note: `whole cell re-keys onto ${verdict.aliasTarget}` });
        actions.push({ lane: s.suggestedLane, dispatch: record.suggestedDispatch, cell, estSales: cellRow.unbacked, note: `alias of ${verdict.aliasTarget}` });
      } else if (verdict.cellClass === "MISSING") {
        record.suggestedLane = "ACQUISITION";
        record.blockers.push(`no checklist: acquire ${sport} ${year} ${setKey} (${f(cellRow.unbacked)} unbacked sales wait on it)`);
        actions.push({ lane: "ACQUISITION", dispatch: null, cell, estSales: cellRow.unbacked, note: "acquire the product checklist" });
      }

      if (verdict.sample) {
        // ── SAMPLE UNBACKED SALES ONLY (trap #1), across several windows.
        const sampled = [];
        let skippedNeverPrice = 0, skippedAlreadyBacked = 0;
        for (const { from, to } of sampleWindows()) {
          if (sampled.length >= SAMPLE_CAP || CLOCK.outOfClock()) break;
          const windowCap = Math.min(SAMPLE_CAP, sampled.length + Math.ceil(SAMPLE_CAP / 4));
          cellRU += await readSales(salesSpecWindow(sport, year, setKey, from, to), (rows) => {
            for (const r of rows) {
              if (sampled.length >= windowCap) return false;
              if (neverPricedBucket(r)) { skippedNeverPrice++; continue; }
              if (r.hobbyiqCardId && strictIds.has(r.hobbyiqCardId)) { skippedAlreadyBacked++; continue; }
              sampled.push(r);
            }
            return sampled.length < windowCap;
          });
        }
        const parsedOf = new Map(sampled.map((s) => [s, s.hobbyiqCardId ? parseHobbyIqCardId(s.hobbyiqCardId) : null]));

        // ── DISCOVER: only when the sample actually holds an absent number.
        const absent = new Set();
        for (const p of parsedOf.values()) { const n = lower(p?.cardNumber); if (n && !ownNumbers.has(n)) absent.add(n); }
        const candidateHits = [];
        if (absent.size) {
          // Present = the census saw it selling this sport+year, OR this run
          // already holds a non-empty number set for it (free either way).
          const presentKeys = new Set(presentKeysBySportYear.get(`${sport}|${year}`) ?? []);
          for (const [k, set] of numberCache) { const [s, y, sk] = k.split("|"); if (set.size && s === sport && Number(y) === year) presentKeys.add(sk); }
          const cands = siblingCandidatesFor(setKey, { ...candidateDeps, presentKeys });
          let probed = 0;
          for (const c of cands) {
            if (candidateHits.length >= SIBLING_CANDIDATE_CAP || probed >= 4 * SIBLING_CANDIDATE_CAP) break;
            if (CLOCK.outOfClock() || meter.catalog + meter.sales >= RU_BUDGET_MAX) { record.blockers.push(`sibling probe cut short at "${c.setKey}" (budget) -- pairs below are a lower bound`); break; }
            const got = await strictNumbersOf(sport, year, c.setKey);
            cellRU += got.ru; probed++;
            if (!got.numbers.size) continue; // no checklist that year: costs ~3 RU, holds no slot
            record.siblingCandidatesProbed.push({ setKey: c.setKey, relation: c.relation, knownGood: c.knownGood, strictNumbers: got.numbers.size });
            candidateHits.push({ ...c, numbers: got.numbers });
          }
          record.siblingCandidatesEmpty = probed - candidateHits.length;
          record.siblingCandidatesDropped = cands.length - probed;
          if (record.siblingCandidatesDropped > 0) record.blockers.push(`${record.siblingCandidatesDropped} of ${cands.length} family candidate(s) were NOT probed (cap ${SIBLING_CANDIDATE_CAP} with rows / ${4 * SIBLING_CANDIDATE_CAP} probes) -- NUMBER-ABSENT below may hide a sibling; raise SIBLING_CANDIDATE_CAP to reach them`);
        }

        const suffixWord = suffixWordFor(setKey);
        const ctx = {
          sport, year, setKey, ownNumbers, ownRungsByNumber, nonStrictSourcesById, candidateHits,
          suffixWords: suffixWord ? [suffixWord, `${suffixWord}s`] : [], junkWords: JUNK_PARALLEL_WORDS,
          // The insert lane's OWN gate, asked the way that lane asks it.
          insertKeysNamedInTitle: (s) => {
            try {
              return insertSetNamedInTitle({ title: s.title, sport, year, setKey, playerName: s.playerName })
                .map((m) => m.registeredKey).filter(Boolean);
            } catch { return []; }
          },
        };
        const counts = {};
        const pairs = new Map();        // "to" -> {to, relation, knownGood, saleClass, count, samples}
        const missingSlugs = new Map(); const missingPrefixes = new Map();
        for (const sale of sampled) {
          const parsed = parsedOf.get(sale);
          const v = classifySaleShape(sale, parsed, ctx);
          counts[v.saleClass] = (counts[v.saleClass] ?? 0) + 1;
          const to = v.siblingSetKey ?? v.insertSetKey;
          if (to) {
            if (!pairs.has(to)) pairs.set(to, { from: setKey, to, saleClass: v.saleClass, relation: v.relation ?? "child", knownGood: v.knownGood === true, count: 0, samples: [] });
            const pr = pairs.get(to); pr.count++;
            if (pr.samples.length < 5) pr.samples.push({ number: parsed.cardNumber, title: String(sale.title ?? "").slice(0, 140) });
          }
          if (v.saleClass === "RUNG-ABSENT") bump(missingSlugs, v.missingSlug, 1);
          if (v.saleClass === "NUMBER-ABSENT") bump(missingPrefixes, (/^[a-z]+-?/.exec(lower(parsed.cardNumber)) ?? ["(numeric)"])[0], 1);
        }

        // Each sampled sale stands for unbacked/sampled real ones.
        const scale = sampled.length ? cellRow.unbacked / sampled.length : 0;
        const est = (n) => Math.round(n * scale);
        record.sampled = sampled.length;
        record.skippedAlreadyBacked = skippedAlreadyBacked;
        record.skippedNeverPrice = skippedNeverPrice;
        for (const [k, n] of Object.entries(counts)) {
          record.saleClassShares[k] = Number((n / sampled.length).toFixed(4));
          record.saleClassEstSales[k] = est(n);
          bump(estByClass, k, est(n));
          if (!estByClassBySport.has(sport)) estByClassBySport.set(sport, new Map());
          bump(estByClassBySport.get(sport), k, est(n));
        }
        const top = (m, key) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => ({ [key]: k, count: n, estSales: est(n) }));
        record.topMissingSlugs = top(missingSlugs, "slug");
        record.topMissingPrefixes = top(missingPrefixes, "prefix");
        record.siblingPairs = [...pairs.values()].sort((a, b) => b.count - a.count).map((p) => ({ ...p, estSales: est(p.count) }));
        if (!sampled.length) record.blockers.push("no unbacked sale sampled in any window -- the published count may be stale, or every sale is parked/flagged");

        // catalog-duplicate-rung: the checklist itself lists BOTH spellings
        // as real rungs somewhere in the product, which the acting lane
        // refuses product-wide (both-slugs-are-real-rungs).
        if (suffixWord && counts["PARALLEL-SUFFIX"]) {
          const allParallels = new Set();
          for (const rs of ownRungsByNumber.values()) for (const r of rs) allParallels.add(r.parallel);
          const dup = [...allParallels].filter((p) => !p.endsWith(`-${suffixWord}`) && allParallels.has(`${p}-${suffixWord}`));
          if (dup.length) record.blockers.push(`catalog-duplicate-rung: ${dup.length} finish(es) are on this checklist under BOTH spellings (${dup.slice(0, 5).join(", ")}${dup.length > 5 ? ", ..." : ""}) -- repoint-sales-parallel-suffix refuses those (both-slugs-are-real-rungs)`);
        }

        // ── SUGGESTIONS: one per lane (one per PAIR for the two pair lanes),
        // sized by estimated sales. The operator still names the pair.
        const add = (s, n, note) => {
          const dispatch = suggestedDispatchFor(s, { sport, year, setKey });
          record.suggestions.push({ lane: s.suggestedLane, estSales: est(n), dispatch, note });
          actions.push({ lane: s.suggestedLane, dispatch, cell, estSales: est(n), note });
        };
        for (const p of record.siblingPairs) {
          const flag = p.knownGood ? "known-good pair" : "DISCOVERED -- needs an operator ruling before the acting lane is dispatched";
          if (p.saleClass === "INSERT-UNDER-PARENT") add({ suggestedLane: "repoint-stored-insert-sales", insertSetKey: p.to }, p.count, `${setKey} -> ${p.to} (${flag})`);
          else add({ suggestedLane: "repoint-sales-to-sibling-product", siblingSetKey: p.to }, p.count, `${setKey} > ${p.to}, ${p.relation} (${flag})`);
        }
        if (counts["PARALLEL-SUFFIX"]) add({ suggestedLane: "repoint-sales-parallel-suffix" }, counts["PARALLEL-SUFFIX"], `suffix word "${suffixWord}"`);
        if (counts["PRINTRUN-SHORT-ID"]) add({ suggestedLane: "repoint-sales-to-checklist-numbered" }, counts["PRINTRUN-SHORT-ID"], "short ids onto the checklist's :num-N rows");
        const rederive = (counts["JUNK-PARALLEL"] ?? 0) + (counts["PHRASE-LEAK"] ?? 0) + (counts["AUTO-MISMATCH"] ?? 0);
        if (rederive) add({ suggestedLane: REDERIVE_LANE }, rederive, "junk-parallel + phrase-leak + auto-mismatch");
        const acquire = (counts["RUNG-ABSENT"] ?? 0) + (counts["NUMBER-ABSENT"] ?? 0) + (counts["PRINTRUN-VARIANT-ABSENT"] ?? 0);
        if (acquire) {
          record.suggestions.push({ lane: "ACQUISITION", estSales: est(acquire), dispatch: null, note: "rungs / numbers / print runs the checklist does not carry -- see topMissingSlugs + topMissingPrefixes" });
          actions.push({ lane: "ACQUISITION", dispatch: null, cell, estSales: est(acquire), note: `ladder/insert coverage: ${record.topMissingSlugs.slice(0, 3).map((x) => x.slug).join(", ") || record.topMissingPrefixes.slice(0, 3).map((x) => x.prefix).join(", ")}` });
        }
        record.suggestions.sort((a, b) => b.estSales - a.estSales);
        record.suggestedLane = record.suggestions[0]?.lane ?? null;
        record.suggestedDispatch = record.suggestions[0]?.dispatch ?? null;
      }
    } catch (e) {
      if (e instanceof ThrottleAbort) {
        // NOT counted as processed: the resume offset must not step over a
        // cell whose record is half-built. Nothing is emitted for it.
        stoppedBy = "throttled";
        totalRU = meter.catalog + meter.sales;
        break;
      }
      cellsFailed++;
      record.class = record.class ?? "FAILED";
      record.blockers.push(`cell read failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    record.ru = Math.round(cellRU);
    record.ruCatalog = Math.round(meter.catalog - meterAtStart.catalog);
    record.ruSoldComps = Math.round(meter.sales - meterAtStart.sales);
    totalRU = meter.catalog + meter.sales;
    cellsProcessed++;
    cellsDoneForBeat = cellsProcessed;
    const cc = cellsByClass.get(record.class) ?? { cells: 0, unbacked: 0 };
    cc.cells++; cc.unbacked += cellRow.unbacked; cellsByClass.set(record.class, cc);
    const rs = reachedBySport.get(sport) ?? { cells: 0, unbacked: 0, smallest: Infinity };
    rs.cells++; rs.unbacked += cellRow.unbacked; rs.smallest = Math.min(rs.smallest, cellRow.unbacked); reachedBySport.set(sport, rs);
    emitPlanRow(record);
    console.log(`    ${cell.padEnd(44)} ${String(record.class).padEnd(17)} sampled ${String(record.sampled).padStart(3)}  RU sold_comps ${f(record.ruSoldComps).padStart(6)} + card_catalog ${f(record.ruCatalog).padStart(7)}  (running ${f(Math.round(totalRU))}; throttles ${throttle.count})`);
  }
  clearInterval(beat);

  // ── BANNER ────────────────────────────────────────────────────────────────
  const left = candidates.length - cellsProcessed;
  console.log("");
  console.log(`  cells processed         ${f(cellsProcessed)}${cellsFailed ? `   (${f(cellsFailed)} FAILED to read -- see their plan records)` : ""}`);
  if (stoppedBy === "ru") console.log(`  RU_BUDGET_MAX (${f(RU_BUDGET_MAX)}) reached -- stopped cleanly, ${f(left)} cell(s) NOT processed; re-dispatch with a higher budget or a narrower scope.`);
  const gov = governor.stats();
  console.log(`  total RU spent          ${f(Math.round(totalRU))}    avg/cell ${cellsProcessed ? f(Math.round(totalRU / cellsProcessed)) : 0}`);
  console.log(`    sold_comps            ${f(Math.round(meter.sales))} RU  -- governed to ${f(SOLD_COMPS_RU_PER_SEC)} RU/s over ${GOVERNOR_WINDOW_MS / 1000}s: paced ${f(gov.sleeps)} time(s), ${f(gov.sleptMs)} ms asleep; run average ${f(Math.round(meter.sales / Math.max(1, (Date.now() - STARTED) / 1000)))} RU/s`);
  console.log(`    card_catalog          ${f(Math.round(meter.catalog))} RU  (its own container; metered, not governed)`);
  console.log(`  throttles (429)         ${throttle.count} of ${MAX_THROTTLES} allowed, ${f(throttle.sleptMs)} ms backed off`);
  console.log(`  number cache            ${f(numberCacheLoads)} loads, ${f(numberCacheHits)} hits, ${f(numberCacheEvictions)} evictions, ${f(numberCacheSize)} numbers held`);

  console.log("\n  COVERAGE -- how far down each sport's tail this run reached:");
  for (const [sport, r] of reachedBySport) {
    const gap = Number(sportGap[sport] ?? 0);
    const inTable = allCells.filter((c) => c.sport === sport);
    const tableUnbacked = inTable.reduce((n, c) => n + c.unbacked, 0);
    console.log(`    ${sport.padEnd(11)} ${f(r.cells)} of ${f(inTable.length)} published cells, down to a ${f(r.smallest)}-sale cell;`
      + ` ${f(r.unbacked)} unbacked = ${gap ? `${((100 * r.unbacked) / gap).toFixed(1)}% of the sport's ${f(gap)}-sale gap` : "sport gap unknown"}`
      + ` (the published table itself covers ${gap ? `${((100 * tableUnbacked) / gap).toFixed(1)}%` : "?"})`);
  }

  console.log("\n  CELL CLASS ROLLUP:");
  for (const [cls, v] of [...cellsByClass.entries()].sort((a, b) => b[1].unbacked - a[1].unbacked)) {
    console.log(`    ${String(cls).padEnd(18)} ${f(v.cells).padStart(6)} cells  ${f(v.unbacked).padStart(11)} unbacked sales`);
  }

  const printClasses = (m, indent) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    for (const [cls, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${indent}${cls.padEnd(24)} ${f(n).padStart(11)}  (${((100 * n) / total).toFixed(1)}%)`);
    }
  };
  console.log("\n  SALE CLASS ROLLUP -- ESTIMATED unbacked sales (sample share x the cell's unbacked count), overall:");
  printClasses(estByClass, "    ");
  console.log("\n  SALE CLASS ROLLUP, per sport:");
  for (const [sport, m] of estByClassBySport) { console.log(`    ${sport}:`); printClasses(m, "      "); }

  console.log("\n  TOP 50 ACTIONS BY ESTIMATED SALES UNLOCKED:");
  for (const a of [...actions].sort((x, y) => y.estSales - x.estSales).slice(0, 50)) {
    console.log(`    ${f(a.estSales).padStart(9)}  ${a.cell.padEnd(40)} ${a.lane}  -- ${a.note ?? ""}`);
    if (a.dispatch) console.log(`               ${a.dispatch}`);
  }

  if (planFd) {
    console.log(`\n  plan file rows written  ${f(planRowsWritten)}  (one NDJSON record per processed cell; this run only -- truncated at open)`);
    try { fs.closeSync(planFd); } catch { /* best effort */ }
  } else if (PLAN_OUT) {
    console.log(`\n  ::warning::PLAN_OUT was set but no plan file was opened.`);
  }

  console.log("\n  This lane made NO Cosmos writes and dispatched nothing. Every dispatch line above is a");
  console.log("  REPORT-mode (apply=false) suggestion; a DISCOVERED sibling pair needs an operator ruling first.");

  // Printed LAST and only when the clock -- not the RU cap -- stopped the run:
  // the relaunch composite re-dispatches on this phrase, and re-dispatching a
  // run that stopped on its RU cap would just spend the same RU again.
  // Spelled as a literal (not CLOCK.stoppedAtBudget()) because
  // tests/everyWriteJobReconciles.test.ts reads the SOURCE for the phrase.
  //
  // THE ONE PLACE THE MARKER IS PRINTED, and relaunchDecision is the only
  // thing that can authorise it. Every refusal below is worded so it can
  // never match the composite's `stopped at the .*budget` grep.
  const end = relaunchDecision({ stoppedBy, cellsProcessed, hop: RESUME.hop });
  console.log(`\n  STOP REASON: ${end.stop}   (hop ${RESUME.hop} of ${MAX_RELAUNCH_HOPS}, ${f(left)} cell(s) left)`);
  if (end.printMarker) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- ${f(left)} cell(s) left; the relaunch resumes at offset ${f(RESUME_OFFSET + cellsProcessed)}, hop ${RESUME.hop + 1} (both ride scan_limit)`);
  } else if (end.stop === "throttled") {
    console.log(`  BACKING OFF: sold_comps/card_catalog answered 429 ${throttle.count} time(s) (cap ${MAX_THROTTLES}) -- production reads need that throughput more than a triage does. NOT relaunching. Re-dispatch later with -f scan_limit=${encodeResume({ hop: 0, offset: RESUME_OFFSET + cellsProcessed })} to resume, and consider a lower SOLD_COMPS_RU_PER_SEC.`);
  } else if (end.stop === "no-progress") {
    console.log(`  ABORT no-progress: the clock ran out with ZERO cells advanced, so a relaunch would start at the same offset and advance nothing again. NOT relaunching. The next cell alone outlasts this link's clock -- narrow it with titles=, or raise RUN_MINUTES.`);
  } else if (end.stop === "hop-cap") {
    console.log(`  ABORT hop-cap: this chain has already relaunched ${RESUME.hop} time(s) (cap ${MAX_RELAUNCH_HOPS}). NOT relaunching. Re-dispatch with -f scan_limit=${encodeResume({ hop: 0, offset: RESUME_OFFSET + cellsProcessed })} to continue deliberately, or fan out with slot/slots.`);
  }
  return end.exitCode;
}

if (require.main === module) {
  main()
    .then((code) => finishLane(code || 0, { budget: CLOCK }))
    .catch((e) => {
      console.error(`\nFATAL: ${String(e?.stack ?? e)}`);
      finishLane(1, { budget: CLOCK });
    });
}

module.exports = {
  parseScopeTokens, rowInScope,
  classifyCellClass, classifySaleShape, suggestedDispatchFor,
  siblingCandidatesFor, neverPricedBucket, sampleWindows,
  KNOWN_SIBLING_PAIRS, JUNK_PARALLEL_WORDS, REDERIVE_LANE, MISSING_FLOOR,
  // load safety + the relaunch chain
  makeGovernor, pagedQuery, ThrottleAbort, relaunchDecision, decodeResume, encodeResume,
  MAX_RELAUNCH_HOPS, HOP_UNIT,
};
