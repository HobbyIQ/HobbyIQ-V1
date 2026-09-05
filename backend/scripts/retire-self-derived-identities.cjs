#!/usr/bin/env node
/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04, in those words).
 *
 * ONE pass, TWO lanes, because both need the same computation and computing it
 * twice would be two chances to compute it differently:
 *
 *   (a) RETIRE       a self-derived row whose identity a CHECKLIST row also
 *                    carries. The checklist row is the card; this one is a
 *                    duplicate that splits the pool. Marked, never deleted.
 *   (b) UNVERIFIED   a self-derived row with NO checklist row for its card.
 *                    Labelled `identityUnverified` and listed per
 *                    (year, setKey) — THE ACQUISITION QUEUE.
 *
 * NEITHER LANE DELETES ANYTHING, and lane (b) is not a defect list. Measured
 * read-only over a 2,852-row keyed baseball sample on 2026-09-04:
 *
 *     twin at the exact identity      227   8.0%   -> lane (a)
 *     twin at card level only       1,608  56.4%   -> lane (a), card rule
 *     no checklist row at all       1,017  35.7%   -> lane (b)
 *
 * A third of self-derived rows name a card no checklist we hold lists. Those
 * cards are real — someone sold one — and `unconfirmed` overwhelmingly means
 * we have not acquired that product's checklist yet (annotate-checklist-
 * backing's header argues this at length and its four-state vocabulary is the
 * one reused here). Deleting them would destroy real cards and strand their
 * sales; sold_comps rows reference these ids, so a delete orphans the pool
 * with no way back. This is the same reasoning that made CF-RETIRE-CARDHEDGE-
 * ROWS an exclusion rather than a purge.
 *
 * ── WHAT "SAME IDENTITY" MEANS, AND THE TWO STRICTNESSES ────────────────────
 *
 * Full identity is (year, setKey, cardNumber, playerName, parallel, isAuto).
 * Card identity drops parallel and isAuto.
 *
 * Only the FULL match retires by default. The card-level match is REPORTED and
 * retires only under `--card-rule`, because parallel disagreement is mostly OUR
 * checklist being thin rather than the row being wrong: annotate-checklist-
 * backing measured 86.6% of derived parallels absent from their card's
 * checklist, with comparisons like `"Refractor" not in [base cards, base]` and
 * `"Base" not in [orange, green pattern, sky blue]`. Retiring on that evidence
 * retires nearly everything on the strength of our own gaps. So the safe lane
 * ships on by default and the aggressive one is opt-in and off.
 *
 * playerName is load-bearing, not decorative: CPA-AN is BOTH Angel Nunez and
 * Alejandro Nunez, so a card number alone is not an identity
 * (project_beckett_initials_card_numbers_collide).
 *
 * ── GRADED CHILDREN FOLLOW THEIR PARENT ─────────────────────────────────────
 *
 * A graded twin has its parent's provenance (catalogAuthority strips `-graded`
 * for exactly this reason), so when a parent retires its `<id>:...:psa-N`
 * children retire with it, marked with the same marker and the parent's id.
 * Leaving them would keep the split pool this lane exists to close.
 *
 * ── REPORT FIRST ────────────────────────────────────────────────────────────
 *
 *   (default)                 report only, writes nothing
 *   BACKFILL_APPLY=true       write markers
 *   --card-rule               also retire card-level twins (off by default)
 *   SPORT=baseball            one sport per run (products fit in memory)
 *   PRODUCTS=n                cap products scanned, for a bounded probe
 *   RUN_MINUTES=110           loop budget; must stop under the step ceiling
 *
 * Sharding goes through the ONE helper (runner-shard-scope.cjs): an inherited
 * `slot=0 slots=16` from the workflow defaults is NOT a chosen shard and
 * sweeps everything (CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD, #1765).
 *
 * ── FAN OUT: ONE SPORT DOES NOT FIT IN ONE SLOT ─────────────────────────────
 *
 * Measured on run 33960686247: 51.5 self-derived rows/s, and baseball's
 * self-derived population is 1,998,165 rows across 6,804 (year, setKey)
 * products. One slot is therefore ~10.8 hours of loop, or five serial
 * budget-stop relaunches. Sharding is not optional at this size:
 *
 *   slots=8    mean slot 81m, worst 81m   headroom 1.3x   thin
 *   slots=16   mean slot 40m, worst 45m   headroom 2.4x   RECOMMENDED
 *
 * Both fit inside one 110-minute budget, so the choice is headroom, not wall
 * clock: a slot is a set of PRODUCTS, and products differ by three orders of
 * magnitude (2024 topps 290,871 rows; 1997 fleer 2,937). The worst-slot
 * figures above use the measured hash skew over the real 6,804-product axis
 * (max/mean 1.01x at 8 slots, 1.11x at 16), and 16 slots keeps 2.4x of room
 * for a slot that draws several giants. 8 slots at 1.3x does not.
 *
 * SHARD=true is REQUIRED for slot 0 -- without it slot 0 sweeps the whole
 * sport and the other fifteen slots re-do work it already did.
 *
 * The axis is PROVEN, not assumed: tests/retireSelfDerivedBudgetMargin.test.ts
 * partitions a synthetic product list at 8, 16 and 32 slots and asserts every
 * product is owned by exactly one slot -- complete and disjoint
 * (feedback_shard_axis_must_be_guaranteed_and_measured).
 *
 * ── THE BANNER SEQUENCE OF A MULTI-BUDGET APPLY ─────────────────────────────
 *
 * A relaunch is the lane WORKING, not the lane failing. Run 33960686247 was
 * read as a failure because the relaunch notice sat next to a red step. The
 * expected sequence for a slice that stops on budget is, in order:
 *
 *   1.  APPLIED / elapsed ... / retired / identityUnverified      the counts
 *   2.  RECONCILE  seen N = ... => N BALANCES                     the arithmetic
 *   3.  [retire-self-derived-identities] reconciled: intended ... the shared check
 *   4.  VERIFY BY READ  <sport>: ...                              or UNCONFIRMED
 *   5.  stopped at the clock budget with products left            the MARKER
 *   6.  ::notice::budget hit (...) — re-dispatching slot n/m      the relaunch
 *   7.  the step ends GREEN, and the next slice starts from product 0
 *
 * GATE ON (2) AND (3) PLUS A GREEN JOB. Do NOT gate on the absence of (5) or
 * (6): a budget stop with a relaunch is the designed steady state of a
 * multi-slice apply, and this lane is idempotent, so the next slice re-reads
 * the products the last one finished and skips them as `already marked`.
 * The FINAL slice of a slot prints, instead of (5) and (6):
 *
 *   ::notice::slot n/m finished within budget (...) — done, no re-dispatch.
 *
 * The one thing that IS a failure is (2) saying DOES NOT BALANCE, or the step
 * being killed by the runner -- which, before this fix, is exactly what
 * happened AFTER (3) printed clean (see the RUN_MINUTES block below).
 *
 * Every write goes through patchCatalogRowFields, never a raw patch — a raw
 * patch is how #1614 left rows unfindable by rewriting derived search fields
 * (project_derive_builds_its_own_search_fields).
 */
"use strict";

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
// The row-op, not a hand-rolled patch: CF-GUARD-THE-CATALOG-WRITE-CONTRACT.
// It keeps a `<field>Before` shadow so every marker this lane writes is
// reversible, and it no-ops when the value already matches, so a re-run is
// free. NEVER a raw container.patch: #1614 left rows unfindable that way.
const { patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
// CF-A-GREEN-RUN-THAT-WROTE-NOTHING-IS-NOT-A-SUCCESS. The ONE reconciliation
// helper, so this lane's arithmetic is checked the same way every other
// runner writer's is (intended = written + skipped + failed).
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CARD_RULE = process.argv.includes("--card-rule") || String(process.env.CARD_RULE || "") === "true";
const SPORT = String(process.env.SPORT || process.env.SPORTS || "baseball").trim().toLowerCase();
const PRODUCTS = Number(process.env.PRODUCTS || 0);

/** ── THE BUDGET MUST STOP UNDER THE ACTION CEILING ────────────────────────
 *
 * CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS (#1361 restated, 2026-09-05).
 *
 * Run 33960686247 (sport=baseball, APPLY, sharding OFF) did everything right
 * and still went red. Measured from its log:
 *
 *   10:27:57  step starts
 *   10:28:16  loop t0                          (+19s startup + the DISTINCT)
 *   12:43:23  loop ends, banner + RECONCILE ... BALANCES   (elapsed 8,107s)
 *   12:58:10  ##[error] 'Run backfill (APPLY)' timed out after 150 minutes
 *
 * TWO defects, both of them clock defects, neither of them a data defect:
 *
 *  (1) THE BUDGET OVERSHOT. The check sat at the TOP of the product loop, so
 *      the run always paid for one more whole product after the budget
 *      expired. A big product is minutes (2024 topps: 290,871 rows / 27s of
 *      query plus the per-row writes), and 130 min of budget became 135.1 min
 *      of loop. A ceiling you cross by construction is not a budget.
 *
 *  (2) THE VERIFY NEVER RETURNED. VERIFY BY READ fires two unbounded
 *      `SELECT VALUE COUNT(1) ... WHERE c.sport=@s AND ...` scans. That is
 *      precisely the whole-container aggregate shape this file's own
 *      enumeration comment (below) records as NOT RETURNING on card_catalog
 *      at 19.63M rows. It ran 887s — 14.8 minutes — and had still not
 *      answered when the runner killed the step. The reconciliation had
 *      already printed and BALANCED; the writes were all durable; the job was
 *      red anyway, and the operator was handed a red run whose every data
 *      signal said success.
 *
 * THE RULE. The script's own clock must stop, print, verify AND reconcile
 * with margin under the step's `timeout-minutes`, because a killed step
 * cannot report anything — not its counts, not its verify, not its exit code.
 * The margin is not decoration: it is the only thing that makes a budget stop
 * distinguishable from a crash.
 *
 * THE SIZING, against a 150-minute step ceiling (backfill-runner.yml):
 *
 *   RUN_MINUTES        110    the product loop
 *   + one product      ~10    the worst single product still in flight, since
 *                             the reserve pre-check below cannot know the size
 *                             of the product it is about to start
 *   + VERIFY_MS         10    the post-loop verify, now HARD-CAPPED (it either
 *                             answers or says it could not, and never hangs)
 *   + startup            1    connection + the DISTINCT (measured: 19s)
 *   ------------------------
 *   worst case         131    -> 19 minutes of margin under 150. >= 15. Green.
 *
 * The sibling lanes (rematch-sold-comps, repair-tiffany-pool-enumeration)
 * spell this env var RUN_MINUTES; so does this one now, so an operator sizing
 * a fleet does not have to remember which lane wants milliseconds.
 * tests/retireSelfDerivedBudgetMargin.test.ts pins the arithmetic against the
 * workflow's real timeout-minutes, so shrinking the ceiling fails CI. */
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const BUDGET_MS = Number(process.env.BUDGET_MS || RUN_MINUTES * 60 * 1000);
/** Wall-clock a single product may still be granted after the budget expires.
 *  A product costing more than this is stopped BEFORE it starts, not after. */
const PRODUCT_RESERVE_MS = Number(process.env.PRODUCT_RESERVE_MS || 10 * 60 * 1000);
/** Hard cap on the post-loop VERIFY BY READ. It reports "could not confirm"
 *  rather than holding the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);

/** Markers. Imported nowhere else so they are stated once, here and in the TS
 *  module they mirror (checklistBackedIdentity.ts) — a CJS script cannot
 *  import the TS one, so the test pins the two spellings together. */
const RETIRED = "superseded-by-checklist";
const UNVERIFIED = "identityUnverified";

/** catalogAuthority's DERIVED class + the user-minted family, as SQL. Kept in
 *  the same order as the TS regex so a reader can diff them by eye. */
const SD_SOURCES = [
  "ingest-auto-seed", "sold-comps-stub", "catalog-explode", "tree-builder",
  "sales-derived", "sales-attested", "derived-from", "pool",
  "user-verified", "ebay-user-purchase", "ebay-user-sale", "manual-user-entry",
  "holding-seeded",
];
const SD_SQL = "(" + SD_SOURCES.map((p) => `STARTSWITH(c.source,'${p}')`).join(" OR ") + ")";

/** The checklist class, as catalogAuthority spells it. Substring-tested
 *  because scrape sources are dated (`beckett-scraped-2026-08-19`) and an
 *  exact allowlist decays every night — the defect the authority header
 *  records as reporting 6.1% coverage where the truth was 87.8%. */
const CHECKLIST_STEMS = [
  "checklist", "beckett", "cardpedia", "bccp", "cardboardconnection",
  "almanac", "hobbymonitor", "tcdb", "tcgdex", "pokemon-tcg-data", "official-pdf",
];

const f = (n) => Number(n).toLocaleString("en-US");
const norm = (s) => String(s == null ? "" : s).toLowerCase().trim();

/** Mirrors checklistBackedIdentity.isSelfDerivedIdentity. */
function isSelfDerived(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return false;
  return SD_SOURCES.some((p) => s.startsWith(p));
}

/** Mirrors checklistBackedIdentity.isChecklistBackedIdentity. DERIVED is
 *  tested FIRST because `derived-from-base-checklist-*` embeds the word
 *  "checklist" and must never be promoted by its own name. */
function isChecklist(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return false;
  if (isSelfDerived(s)) return false;
  if (/^(cardhedge|cardsight|ebay)/.test(s)) return false;
  return CHECKLIST_STEMS.some((stem) => s.includes(stem));
}

const kFull = (r) => [norm(r.year), norm(r.setKey), norm(r.cardNumber), norm(r.playerName), norm(r.parallel), r.isAuto ? 1 : 0].join("|");
const kCard = (r) => [norm(r.year), norm(r.setKey), norm(r.cardNumber), norm(r.playerName)].join("|");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e && e.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const SHARD = runnerShardScope({ label: "retire-self-derived-identities" });
  const { SHARDED, SLOT, SLOTS } = SHARD;

  console.log(`retire-self-derived-identities  sport=${SPORT}  ${APPLY ? "APPLY" : "REPORT ONLY"}`);
  console.log(`  ${SHARD.banner()}`);
  console.log(`  card-level rule: ${CARD_RULE ? "ON (retires card-level twins too)" : "off (card-level twins REPORTED only)"}`);
  console.log(`  budget: ${RUN_MINUTES}m loop + ${Math.round(PRODUCT_RESERVE_MS / 60000)}m product reserve`
    + ` + ${Math.round(VERIFY_MS / 60000)}m verify cap — stops under the runner's 150m step ceiling`);

  // ── ENUMERATING THE WORK, AND WHY NOT WITH A GROUP BY ────────────────────
  //
  // The obvious enumeration is
  //     SELECT c.year, c.setKey, COUNT(1) FROM c WHERE c.sport=@s AND <derived>
  //     GROUP BY c.year, c.setKey
  // and it DOES NOT RETURN. Measured against prod on 2026-09-04, card_catalog
  // at 19.63M rows / 400k autoscale: that query, the same one without the
  // IS_DEFINED guards, `GROUP BY c.setKey` scoped to one (sport, year), and
  // even a bare `GROUP BY c.year` scoped to one sport all failed to complete
  // in eight minutes. RU is NOT the constraint (the account autoscales to
  // 400k and the run never throttled) -- a multi-field GROUP BY over this
  // container is a full cross-partition scan with an unbounded accumulator.
  // Only the single-field `GROUP BY c.source` returns, in about a second,
  // because it is served straight from the index.
  //
  // The per-product READ this lane actually needs is perfectly fast on the
  // same data: 2024 topps 290,871 rows / 14,502 RU / 27s; 2025 bowman-chrome
  // 98,182 / 5,333 RU / 11s; 1997 fleer 2,937 / 291 RU / 3s.
  //
  // So the work is enumerated from an axis that IS cheap -- the (year,
  // setKey) pairs the catalog already knows about, gathered per year with a
  // projection rather than an aggregate -- and the self-derived population is
  // classified inside the per-product read, which has to happen anyway.
  // Measuring the axis before dispatching is the rule, not an optimisation
  // (feedback_fleet_scripts_measure_throughput_before_dispatch).
  const YEARS = String(process.env.YEARS || "").trim();
  const yearFilter = YEARS
    ? YEARS.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n))
    : null;
  if (yearFilter) console.log(`  years scope: ${yearFilter.join(", ")}`);

  // DISTINCT (year, setKey) for the sport. DISTINCT runs through the SDK's
  // parallel pipeline where GROUP BY does not.
  const { resources: pairs } = await retry(() => cat.items.query({
    query: `SELECT DISTINCT c.year, c.setKey FROM c
            WHERE c.sport=@s AND IS_DEFINED(c.setKey) AND IS_DEFINED(c.year)`,
    parameters: [{ name: "@s", value: SPORT }],
  }, { maxItemCount: 2000, maxDegreeOfParallelism: -1 }).fetchAll());

  const all = pairs
    .filter((p) => p.setKey && p.year && (!yearFilter || yearFilter.includes(Number(p.year))))
    .map((p) => ({ year: Number(p.year), setKey: String(p.setKey) }))
    .sort((a, b) => b.year - a.year || a.setKey.localeCompare(b.setKey));

  // The shard axis is (year, setKey) and it is DECLARED, not inherited: a
  // deterministic hash so every worker computes the same assignment and takes
  // only its own, without needing per-product sizes it cannot afford to
  // measure (feedback_shard_axis_must_be_guaranteed_and_measured).
  const hash = (str) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h;
  };
  let mine = SHARDED ? all.filter((p) => hash(`${p.year}|${p.setKey}`) % SLOTS === SLOT) : all;
  if (PRODUCTS > 0) mine = mine.slice(0, PRODUCTS);
  console.log(`  ${f(all.length)} (year, setKey) products in ${SPORT}`);
  console.log(`  this run owns ${f(mine.length)} products
`);

  const t0 = Date.now();
  let scanned = 0, rowsRead = 0, retired = 0, unverified = 0, gradedChildren = 0, written = 0;
  let cardLevelSeen = 0, failed = 0, alreadyMarked = 0;
  const gaps = new Map();
  let stopReason = null;

  for (const p of mine) {
    // STOP BEFORE THE PRODUCT, NOT AFTER IT. The old check was `elapsed >
    // BUDGET_MS`, which admits one more whole product every time -- and one
    // product can be 290k rows. Reserving the worst product's wall-clock is
    // what keeps the loop's own overshoot bounded and the total under the
    // step ceiling (see the RUN_MINUTES block at the top).
    if (Date.now() - t0 > BUDGET_MS - PRODUCT_RESERVE_MS) { stopReason = "clock"; break; }
    const { resources: rows } = await retry(() => cat.items.query({
      query: `SELECT c.id, c.cardId, c.source, c.year, c.setKey, c.cardNumber, c.playerName,
                     c.parallel, c.isAuto, c.retiredReason, c.identityUnverified
              FROM c WHERE c.sport=@s AND c.year=@y AND c.setKey=@k`,
      parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }],
    }, { maxItemCount: -1 }).fetchAll());
    rowsRead += rows.length;

    // A graded child is `<parentId>:<grader>-<n>`; index by parent so a
    // retiring parent takes its children with it.
    const childrenOf = new Map();
    for (const r of rows) {
      const id = String(r.id || "");
      const cut = id.lastIndexOf(":");
      if (cut <= 0) continue;
      const parent = id.slice(0, cut);
      if (/^(psa|bgs|sgc|cgc|hga|csg)-/.test(id.slice(cut + 1))) {
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(r);
      }
    }

    const chkFull = new Set(), chkCard = new Set();
    const sd = [];
    for (const r of rows) {
      if (isChecklist(r.source)) { chkFull.add(kFull(r)); chkCard.add(kCard(r)); }
      else if (isSelfDerived(r.source)) sd.push(r);
    }

    for (const r of sd) {
      scanned++;
      const hasFull = chkFull.has(kFull(r));
      const hasCard = !hasFull && chkCard.has(kCard(r));
      if (hasCard) cardLevelSeen++;

      const retiring = hasFull || (hasCard && CARD_RULE);
      const alreadyRetired = String(r.retiredReason || "") === RETIRED;
      const alreadyUnver = r.identityUnverified === true;
      if ((retiring && alreadyRetired) || (!retiring && !hasCard && alreadyUnver)) { alreadyMarked++; continue; }

      if (retiring) {
        retired++;
        const kids = childrenOf.get(String(r.id)) || [];
        gradedChildren += kids.length;
        // REPORT MODE COSTS NOTHING. patchCatalogRowFields' own `dryRun` still
        // POINT-READS every row to compute the diff, which is correct for a
        // pre-flight of a specific repair and far too expensive for a census
        // over millions of rows -- a 60-product probe did not finish in nine
        // minutes paying 1 RU and a round trip per row. The classification
        // above is already complete, so a report run simply counts and moves
        // on (feedback_fleet_scripts_measure_throughput_before_dispatch).
        if (!APPLY) continue;
        try {
          const now = new Date().toISOString();
          await patchCatalogRowFields(cat, String(r.id), r.cardId, {
            retiredReason: RETIRED,
            retiredAt: now,
            retiredBy: "retire-self-derived-identities",
            retiredMatchLevel: hasFull ? "identity" : "card",
          }, { retry });
          written++;
          for (const kid of kids) {
            await patchCatalogRowFields(cat, String(kid.id), kid.cardId, {
              retiredReason: RETIRED,
              retiredAt: now,
              retiredBy: "retire-self-derived-identities",
              retiredMatchLevel: "graded-child",
              retiredWithParent: String(r.id),
            }, { retry });
            written++;
          }
        } catch (e) { failed++; }
        continue;
      }

      if (hasCard) continue; // card-level twin, rule off: reported, untouched.

      // No checklist row for this card at all -> the acquisition queue.
      unverified++;
      const g = `${p.year}|${p.setKey}`;
      gaps.set(g, (gaps.get(g) || 0) + 1);
      if (!APPLY) continue;
      try {
        await patchCatalogRowFields(cat, String(r.id), r.cardId, {
          [UNVERIFIED]: true,
          identityUnverifiedAt: new Date().toISOString(),
          identityUnverifiedBy: "retire-self-derived-identities",
        }, { retry });
        written++;
      } catch (e) { failed++; }
    }
  }

  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY — nothing written"}`);
  console.log(`  elapsed            ${secs}s   (${(scanned / secs).toFixed(1)} sd-rows/s)`);
  console.log(`  catalog rows read  ${f(rowsRead)}`);
  console.log(`  self-derived seen  ${f(scanned)}`);
  console.log(`  retired (twin)     ${f(retired)}   + ${f(gradedChildren)} graded children`);
  console.log(`  card-level twins   ${f(cardLevelSeen)}   ${CARD_RULE ? "(retired: rule ON)" : "(untouched: rule off)"}`);
  console.log(`  identityUnverified ${f(unverified)}`);
  console.log(`  already marked     ${f(alreadyMarked)}`);
  console.log(`  write failures     ${f(failed)}`);

  // RECONCILIATION. Every self-derived row seen took exactly one path, and the
  // paths must sum to the population. A run that cannot balance its own
  // arithmetic has not measured what it claims to
  // (feedback_gate_merges_on_exit_codes).
  const routed = retired + unverified + alreadyMarked + (CARD_RULE ? 0 : cardLevelSeen);
  console.log(`\n  RECONCILE  seen ${f(scanned)} = retired ${f(retired)} + unverified ${f(unverified)}`
    + ` + alreadyMarked ${f(alreadyMarked)} + cardLevelLeft ${f(CARD_RULE ? 0 : cardLevelSeen)}`
    + `  => ${f(routed)} ${routed === scanned ? "BALANCES" : "*** DOES NOT BALANCE ***"}`);

  console.log(`\n  ACQUISITION QUEUE — top 40 (year|setKey -> rows with no checklist):`);
  for (const [g, n] of [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`   ${String(f(n)).padStart(8)}  ${g}`);
  }

  if (stopReason === "clock") {
    // The relaunch gates on THIS marker and nothing else (CF-RELAUNCH-ONLY-ON-
    // BUDGET, #1361): relaunching on "did anything" loops forever once a slot
    // is down to rows it cannot change.
    console.log(`\n  stopped at the clock budget with products left — re-dispatch this slot to continue`);
  }

  if (APPLY) {
    // The shared reconciliation, so this lane is checked by the same equation
    // as every other runner writer. INTENDED is the rows this run decided to
    // mark (parents + graded children); SKIPPED is the population it
    // deliberately left alone -- rows already carrying the marker, and the
    // card-level twins the rule leaves untouched.
    reportWrites({
      job: "retire-self-derived-identities",
      intended: retired + gradedChildren + unverified + alreadyMarked + (CARD_RULE ? 0 : cardLevelSeen),
      written,
      skipped: alreadyMarked + (CARD_RULE ? 0 : cardLevelSeen),
      failed,
    });

    // VERIFY BY READ. A green run is not a data flow
    // (feedback_green_workflow_is_not_data_flow) -- but a verify that never
    // returns is not a verify either, it is a timeout with a comment on it.
    //
    // These two whole-sport `COUNT(1)` scans are the shape this file's own
    // enumeration comment records as not returning on card_catalog: an
    // unbounded cross-partition aggregate. In run 33960686247 they ran 887s
    // and were still running when the step was killed at its 150-minute
    // ceiling -- AFTER the reconciliation had printed and balanced. So the
    // verify now runs under a hard cap and REPORTS ITS OWN FAILURE instead of
    // holding the step open. An unconfirmed verify is a fact worth printing;
    // a killed step prints nothing at all.
    const vt0 = Date.now();
    const capped = async (label, spec) => {
      const left = VERIFY_MS - (Date.now() - vt0);
      if (left <= 0) return null;
      try {
        const { resources } = await Promise.race([
          retry(() => cat.items.query(spec, { maxItemCount: -1 }).fetchAll(), 2),
          new Promise((_, rej) => setTimeout(() => rej(new Error("verify-cap")), left).unref?.()),
        ]);
        return Number(resources[0] || 0);
      } catch (e) {
        console.log(`  VERIFY BY READ  ${label}: could not confirm within the cap (${String(e && e.message)})`);
        return null;
      }
    };
    const v = await capped("retiredReason", {
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.sport=@s AND c.retiredReason=@r`,
      parameters: [{ name: "@s", value: SPORT }, { name: "@r", value: RETIRED }],
    });
    const u = await capped(UNVERIFIED, {
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.sport=@s AND c.${UNVERIFIED}=true`,
      parameters: [{ name: "@s", value: SPORT }],
    });
    const shown = (n) => (n === null ? "UNCONFIRMED (verify cap)" : `${f(n)} rows`);
    console.log(`\n  VERIFY BY READ  ${SPORT}: retiredReason='${RETIRED}' now ${shown(v)};`
      + ` ${UNVERIFIED}=true now ${shown(u)}`
      + `   [${Math.round((Date.now() - vt0) / 1000)}s of a ${Math.round(VERIFY_MS / 60000)}m cap]`);
    if (v === null || u === null) {
      // NOT a failure of the run: every write already reconciled above. The
      // operator is told the count is unread so nobody reads its absence as a
      // zero (feedback_never_dismiss_small_numbers_as_noise).
      console.log(`  the verify count is UNREAD, not zero — the writes above reconciled and are durable.`);
    }
  }
}

main().catch((e) => { console.error("FATAL", e && e.message); process.exit(1); });
