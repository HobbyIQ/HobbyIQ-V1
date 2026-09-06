#!/usr/bin/env node
/**
 * reslug-ruled-alias.cjs -- a ruled ALIAS resolves its pool to the ruled key.
 *
 * CF-AN-ALIAS-IS-NOT-A-SECOND-POOL (2026-09-04), the write half of #1783.
 *
 * WHY THIS EXISTS, AND WHY #1783 DID NOT FINISH THE JOB.
 *
 * #1783 declared `bellingham`, `1987-bellingham-baseball` and
 * `bellingham-mariners-team-issue` aliases of the ruled key
 * `bellingham-mariners`. That fixed the DERIVER: every future derivation of
 * those spellings now lands on the ruled key. It did not move one stored row,
 * and the Great Rematch census cannot move them either -- for a reason worth
 * stating precisely, because it is the whole reason this lane exists:
 *
 *   The census classifies a row by comparing its STORED identity against
 *   `normalizeSetKey(setName)`. Post-alias, a row storing setName
 *   '1987 Bellingham Baseball' derives `bellingham-mariners`... and its stored
 *   slug ALSO reduces to `bellingham-mariners` once the alias is applied. The
 *   two agree. The census calls that AGREE, and AGREE IS NEVER WRITTEN.
 *
 * So the alias declaration makes the census go quiet about exactly the rows the
 * alias was declared to fix. Measured on the 1987 Bellingham Mariners Griffey
 * #15 pool (228 rows): 203 store setName '1987 Bellingham Baseball', 2 store
 * '1987-bellingham-baseball', 24 store 'Unknown'. The 24 classify IMPROVE and
 * the fleet moves them. The other 205 classify AGREE and sit still, on slugs
 * whose setKey segment is the OLD spelling -- while the holding, re-derived,
 * moves to `hiq:baseball:1987:bellingham-mariners:15:base:no-auto`.
 *
 * That is a SPLIT POOL, and a split pool is a wrong FMV
 * (CF-ONE-CARD-ONE-ROW-ONE-POOL). The alias fixed the vocabulary and orphaned
 * the sales. This lane walks the pool by the ALIAS SEGMENT and resolves it.
 *
 * WHAT IT DOES, EXACTLY. For each declared alias of the ruled key named by
 * SCOPE, every sold_comps row whose `cardId` OR `hobbyiqCardId` carries that
 * alias in segment 3 has THAT SEGMENT rewritten to the ruled key. Segment
 * surgery, never a recompute (D28): the card number, parallel, auto flag,
 * subset and print run are carried across byte for byte. A row cannot lose a
 * parallel the current resolver would spell differently, which is the defect
 * the Bowman Draft re-slug caught in dry run when a full re-derive turned
 * `gold-refractor` into `refractor`.
 *
 * BOTH IDENTITY FIELDS, BECAUSE THE READER ORs THEM
 * (CF-A-MOVED-ROW-CARRIES-ONE-IDENTITY). The exact-pool reader matches on
 * `cardId` OR `hobbyiqCardId`, so a move that rewrites one and leaves the other
 * has not moved the sale -- it is still pulled into the old pool. The 44-row
 * Gonzalez half-move is the precedent. Both fields are rewritten, both are in
 * `verifyFields`, and a row whose two fields disagree about the alias is
 * reported as a THIRD SLUG rather than silently normalised.
 *
 * THE TABLE IS READ, NEVER RETYPED. The alias list comes from
 * `ruledAliases()` in setKeyReconciliation -- the same declaration the deriver
 * consults. A hardcoded copy here would be a second source of truth that could
 * drift from the ruling, and this lane's whole premise is that the ruling is
 * already correct. A key that is not a declared alias of SCOPE is untouched,
 * whatever it looks like.
 *
 * SCOPE IS THE DESTINATION KEY, AND IT IS REQUIRED
 * (CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE). SCOPE names the
 * DESTINATION -- `bellingham-mariners`, `donruss-optic` -- and the lane sweeps
 * every ADMITTED alias that resolves to it. There is no default: an empty
 * SCOPE, or the runner's inherited `refractor`, is FATAL before a Cosmos client
 * is built, and a scope that admits no alias at all is FATAL too, so a typo
 * cannot quietly sweep nothing and report success.
 *
 * TWO RULES ADMIT AN ALIAS (widened 2026-09-05 by Drew's ruling; #1792 measured
 * the gap). See the long note above the admission rule below:
 *
 *   RULED    a RULED_ALIASES entry whose canonical is SCOPE. A human decision,
 *            with its evidence -- what #1786 built this lane for.
 *   DERIVER  a spelling the LIVE deriver already folds onto SCOPE
 *            (normalizeSetKey(alias) === SCOPE) and that the pool ACTUALLY
 *            STORES, discovered by a bounded read rather than typed. 306,807
 *            rows sit here -- `panini-optic` -> `donruss-optic` alone is
 *            220,362 -- in the blind spot between the census (which calls them
 *            AGREE and never writes) and this lane's old ruled-only gate.
 *
 * SANITY, NOT TRUST. A declared alias is a ruling and this lane does not
 * relitigate it. But four mechanical gates hold, because each is cheap and each
 * catches a table or a derivation that would move rows that are NOT the same
 * cards:
 *
 *   - the DESTINATION must be a normalizeSetKey FIXED POINT. If it normalises
 *     onward, moving rows onto it just queues the next move. This is what
 *     refuses `donruss` (-> `panini-donruss`, an era split).
 *   - an alias must not be its own destination. A self-alias is a no-op that
 *     would otherwise count as a move.
 *   - a candidate alias must NOT be a fixed point of its own: a key the deriver
 *     leaves alone is a key the vocabulary calls a PRODUCT. This mechanically
 *     refuses #1792's whole 58-pair SPLIT bucket.
 *   - a candidate alias must hold ZERO STRICT checklist-backed catalog rows,
 *     counted BY SOURCE at run start, read-only
 *     (CF-COUNT-BY-SOURCE-NOT-ROW-COUNT). Row count never decides.
 *
 * Every refusal exits 2 and names the alias and the rule that refused it.
 *
 * WHAT THIS LANE DOES NOT FIX, OBSERVED IN THE FIRST REPORT RUN. One of the
 * 205 Bellingham rows carries card number `1` rather than `15`:
 *
 *   hiq:baseball:1987:bellingham:1:base:no-auto   $6,151  PSA 10  (cardhedge)
 *   "1987 Ken Griffey Jr *AUTGRAPHED**87 #1 Pick** Bellingham Team #15 XRC PSA 10/10"
 *
 * The title says `#15`; `#1 Pick` is the DRAFT POSITION and the number parser
 * took it for the card number. So the highest-priced sale in this pool is a
 * genuine sale of the same card, filed one segment away from it.
 *
 * It is reported and NOT repaired here, deliberately. This lane rewrites
 * segment 3 and only segment 3; a lane that also "fixed" the card number when
 * it looked wrong is a recompute wearing a re-key's clothes, and D28 exists
 * because that is how a product move drags a wrong parallel along with it.
 * After this lane the row sits at `bellingham-mariners:1:` -- still its own
 * pool, still not #15 -- and the cardNumber repair is its own scoped PR
 * (repair-card-number-from-title is the existing lane for that shape).
 *
 * THE CATALOG SIDE IS REPORTED, NEVER WRITTEN. Catalog rows keyed on an alias
 * slug are counted and grouped by `source`, and the lane says what it found.
 * It deletes nothing and it writes nothing there -- see the CATALOG note in the
 * banner and the PR body for why `supersededBy` is not the answer.
 *
 * REPORT FIRST. Without BACKFILL_APPLY=true nothing is written: relocateSoldComp
 * is called with dryRun, which touches no container at all. The report prints
 * the same banner an apply does, the per-alias row counts, the destination
 * slug, the pool count BEFORE and AFTER, and the reconciliation
 * `intended = written + skipped + failed`.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     required, the DESTINATION KEY      (runner: scope)
 *   DISCOVERY_PAGES=12        pages per cell for the alias discovery read
 *   YEARS / SPORTS            optional filters       (runner: years / sports)
 *   BACKFILL_APPLY=true       actually write (the runner exports BACKFILL_APPLY,
 *                             not APPLY). Default: REPORT ONLY.
 *   SLOT / SLOTS / SHARD      opt-in sharding   CONCURRENCY=16
 *   RUN_MINUTES=140           budget marker     LIMIT=0
 * Requires dist/ (setKeyReconciliation, hobbyIqCardId, writeReconciliation).
 */
"use strict";
const path = require("path");

const backend = path.resolve(__dirname, "..");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE. `scope` is shared with
// every other lane on this runner and carries THEIR vocabulary; its
// workflow-wide default is the literal string "refractor". Treating that as
// "no scope given" and sweeping everything is how a dispatcher who left a
// previous lane's value in the box gets a live APPLY against a population
// nobody named. Here it is a refusal.
const RAW_SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);

const csv = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = csv(process.env.YEARS || process.env.YEAR).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = csv(process.env.SPORTS || process.env.SPORT);

const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "reslug-ruled-alias" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
// How many pages the alias DISCOVERY read may take per (sport, year) cell. It
// decides the SET of spellings, not the sweep, so a bound is honest rather than
// lossy -- and a truncated cell says so in the banner.
const DISCOVERY_PAGES = Math.max(1, Number(process.env.DISCOVERY_PAGES || 12));
// Gate 3's floor: how much of the DESTINATION's checklist an alias holding
// strict rows of its own must also name before it counts as the same product.
// 0.6 sits far above every measured SPLIT pair (0.0%) and far below every
// measured same-product pair (82.2%, 97.6%) -- the gap is two orders of
// magnitude wide, so the exact value is not load-bearing.
const OVERLAP_MIN = Math.min(1, Math.max(0, Number(process.env.OVERLAP_MIN || 0.6)));
const STARTED = Date.now();

const REASON = "a-ruled-alias-resolves-to-its-ruled-key";
const REASON_LONG =
  "CF-AN-ALIAS-IS-NOT-A-SECOND-POOL: a declared RULED_ALIAS names the same cards as its ruled key, "
  + "so its pool rows belong in the ruled key's pool (#1783 declared the alias; the census calls these rows AGREE and never writes them)";

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();


// ── the admission rule: which aliases may this scope sweep? ─────────────────
//
// CF-A-DERIVER-RESOLVED-ALIAS-IS-STILL-AN-ALIAS (Drew, 2026-09-05).
//
// #1786 built this lane for a RULED alias -- a row in RULED_ALIASES, where a
// human named the destination and the evidence travels with the declaration.
// #1792 then measured what that scope gate can and cannot reach, and found
// 306,807 sold_comps rows in the gap between the two halves of the machinery:
//
//   normalizeSetKey("panini-optic")   === "donruss-optic"      (already)
//   normalizeSetKey("finest")         === "topps-finest"       (already)
//   normalizeSetKey("stadium-club")   === "topps-stadium-club" (already)
//
// The DERIVER already folds these spellings onto one key, so there is no
// vocabulary edit left to make and nothing to declare -- yet the stored slugs
// still carry the alias segment. The Great Rematch census classifies such a row
// AGREE (stored identity and re-derived identity both reduce to the same key
// once the fold applies) and AGREE is never written; this lane refused the
// scope because no *ruled* alias resolves to it. Split pools, unreachable by
// both tools. Drew's ruling: DERIVER-RESOLVED aliases qualify as scope.
//
// So the alias set for a scope key K is the UNION of two rules, and the banner
// says which rule admitted each alias, because they carry different authority:
//
//   RULED    K is the `canonical` of a RULED_ALIASES entry. A human decision.
//   DERIVER  normalizeSetKey(alias) === K, for an alias spelling ACTUALLY
//            PRESENT in the pool for this scope's sport/years -- discovered by
//            a bounded read, never a typed list. A derivation the vocabulary
//            already performs on every future write.
//
// DISCOVERED, NOT TYPED, and that is the load-bearing choice. A hand-written
// list of alias spellings is a second copy of the vocabulary that drifts the
// moment normalizeSetKey changes, and it can name a spelling that does not
// exist (sweeping nothing, reporting success) or miss one that does. Reading
// the segments the pool actually stores and asking the LIVE deriver about each
// one cannot drift: the admitted set is a function of the vocabulary and the
// data, computed at run time.
//
// THE REFUSALS ARE THE POINT. normalizeSetKey(alias) === K is necessary and
// nowhere near sufficient -- #1792's own census over-counted by exactly this
// mistake in reverse. Four gates, each refusing a shape that would move rows
// that are not the same cards:
//
//   1. K MUST BE A FIXED POINT. If the destination itself normalises onward,
//      moving rows onto it only queues the next move. (Already enforced for
//      RULED; it now covers DERIVER too, and it is why `donruss` can never be a
//      scope here -- normalizeSetKey("donruss") === "panini-donruss".)
//   2. AN ALIAS MUST NOT BE A FIXED POINT OF ITS OWN. A key the deriver leaves
//      alone is a key the deriver considers a product. `select`, `score`,
//      `studio` and `diamond-kings` are all fixed points, so the census's
//      proposed folds onto them cannot be admitted here however they were
//      spelled -- and that is #1792's 58-pair SPLIT bucket, refused by
//      mechanism rather than by a list anyone has to maintain.
//   3. AN ALIAS WITH STRICT CHECKLIST ROWS OF ITS OWN MUST PROVE IT NAMES THE
//      SAME CARDS. Measured against card_catalog at run start, read-only.
//
//      The first draft of this gate refused any alias holding a strict
//      checklist-backed row, on the standing rule that a key a strict source
//      writes checklists for is a product that source believes in. Run in
//      REPORT mode against prod it refused `panini-optic` -- the 220,362-row
//      headline case of the very ruling that asked for this lane -- on 15,995
//      strict `checklistinsider` rows in football/2024 alone. That refusal was
//      measured, not guessed, and it was WRONG, for a reason worth stating
//      because it is the whole shape of this gate:
//
//        MEASURED READ-ONLY 2026-09-05, basketball/2023
//          panini-optic   20,651 rows  (20,221 distinct cardNumber|parallel)
//          donruss-optic  20,132 rows  (19,970 distinct)
//          overlap 19,490 of 19,970 = 97.6%
//          panini-optic setName field: "2023 donruss optic"   <- its own rows
//                                                                say so
//        football/2023: 82.2% overlap, same story.
//
//      Both keys are strict. They are ALSO the same product: checklistinsider
//      was ingested twice under two spellings of one release, and the alias's
//      own `setName` field spells the destination. A gate that stops at
//      "strict rows exist" cannot see that, and refuses a fold that is exactly
//      CF-ONE-CARD-ONE-ROW-ONE-POOL.
//
//      The contrast is what makes the measurement a discriminator rather than
//      an excuse, and it is a genuine SPLIT pair from #1792's own bucket:
//
//        MEASURED READ-ONLY 2026-09-05, baseball
//          panini-diamond-kings vs diamond-kings, in their two SHARED years
//            2020: 54 vs 47 distinct cards, overlap 0 -> 0.0%
//            2022:  2 vs  8 distinct cards, overlap 0 -> 0.0%
//
//      Zero. Two products that share a product word and share nothing else.
//      Row counts and strict-source presence are identical in shape across
//      both pairs; only the CARDS tell them apart.
//
//      So the gate is: an alias holding strict rows of its own is admitted
//      only when its checklist demonstrably names the destination's cards --
//      OVERLAP_MIN (default 60%) of the destination's distinct
//      cardNumber|parallel in the shared sport/year cells. Below that it is a
//      product and it refuses. An alias with NO strict rows needs no overlap
//      evidence: it holds no competing checklist claim to begin with.
//
//      Two honest limits, both printed rather than hidden. A pair with NO
//      shared cell has no evidence either way and REFUSES (silence is not
//      proof); and the overlap is measured on the catalog, which is the store
//      that carries the checklist claim -- not on the pool, which is the store
//      this lane moves.
//   4. A DENY-LIST FOR RULING CONFLICTS, from #1792's runbook. Where a standing
//      ruling or a standing TEST pins a key as its own, a source count must not
//      be allowed to outvote it -- `upper-deck-choice` was declared an alias
//      and then WITHDRAWN for exactly this reason
//      (exquisiteIsItsOwnProduct.test.ts:87 pins it a fixed point). Gate 2
//      already refuses every entry here today; the list is belt-and-braces so
//      that a future vocabulary change cannot quietly make one admissible
//      without a human revisiting the ruling that named it.
//
// Gates 1, 2 and 4 are pure and are pinned by the tests below. Gate 3 needs
// Cosmos and runs at the top of main(), before any row is planned.

/**
 * Sources that mint a CHECKLIST row -- a row asserting "this card exists in
 * this product", as opposed to one derived from a sale we saw.
 *
 * The distinction is the standing rule (CF-COUNT-BY-SOURCE-NOT-ROW-COUNT):
 * self-derived rows (ingest-auto-seed*, sales-attested*, ebay-*, user-*) prove
 * only that somebody once sold something whose title parsed to this key --
 * which is precisely the stale spelling this lane exists to move. A strict row
 * is a different claim, and it refuses the fold.
 */
const STRICT_CATALOG_SOURCES = [
  "checklistinsider", "checklistcenter", "beckett", "baseballcardpedia", "bccp",
  "sportscardchecklist", "tcdb", "hobbymonitor", "cardboardconnection",
];

/** Is this catalog `source` a strict, checklist-minting source? */
function isStrictCatalogSource(source) {
  const s = String(source ?? "").trim().toLowerCase();
  if (!s) return false;
  // Prefix match, deliberately: strict sources carry qualified spellings
  // (beckett-xlsx, bccp-product-structure, checklistinsider-2024). The
  // self-derived families never do -- ingest-auto-seed-graded,
  // sales-attested-unnumbered.
  if (STRICT_CATALOG_SOURCES.some((k) => s === k || s.startsWith(k + "-") || s.startsWith(k + "_"))) return true;
  // A ruling Drew wrote by hand IS a checklist row (drew-ruling-checklist-2026-08-30).
  if (s.startsWith("drew-ruling-checklist")) return true;
  return false;
}

/**
 * Keys #1792 measured into the RULING CONFLICT / CROSS-MANUFACTURER buckets:
 * a standing ruling or a standing test pins them, so no derivation admits them
 * as an alias here. Small and explicit, with the reason, because a deny-list
 * without its reason is a list nobody dares to change.
 */
const RULING_CONFLICT_DENY = Object.freeze({
  "upper-deck-choice": "declared an alias of ud-choice on 2026-09-05 and WITHDRAWN the same day: exquisiteIsItsOwnProduct.test.ts:87 pins normalizeSetKey('upper-deck-choice') as a fixed point under CF-UD-INSERT-LINES. A standing ruling outranks a source count (#1792).",
  "ud-choice": "the other half of the withdrawn pair -- both keys stay their own (#1792).",
  "topps-triple-threads": "both keys are declared fixed points with checklist rows of their own (81,967 and 23,053); folding would contradict the 2026-09-03 distinct rulings (#1792).",
  "triple-threads": "the other half of the same refused pair (#1792).",
  "donruss-elite": "RULING CONFLICT with panini-elite -- both declared (#1792).",
  "panini-elite": "the other half of the same refused pair (#1792).",
  "panini-select": "the census proposed folding the LARGER, better-backed key (367,220 catalog rows, 291k+ strict) into the smaller `select` (45,850). Unruled -- it needs a decision, not a derivation (#1792 open question 2).",
  "panini-score": "hobbymonitor wrote 3,300 STRICT rows under this key while ERA_SPLIT_TABLE calls it invented. An open ingest defect, not an alias (#1792 open question 3).",
  "panini-donruss": "an ERA SPLIT, not an alias -- ERA_SPLIT_TABLE + spellForEra resolve it per year (spellForEra('panini-donruss', 1987) === 'donruss'). A flat alias would break whichever era it did not name (#1792).",
  "donruss": "the other half of the era split (#1792).",
  "panini": "CROSS-MANUFACTURER: a maker word, matched against upper-deck on a shared generic word. Never one product (#1792).",
  "fleer-stickers": "CROSS-MANUFACTURER with topps-stickers -- a shared product word across two makers (#1792).",
  "ud-series-1": "CROSS-MANUFACTURER with topps-series-1 (#1792).",
});

/**
 * SPORT-SCOPED ADMISSIONS (CF-SOCCER-PRIZM-IS-PRIZM-FIFA; Drew, 2026-09-05).
 *
 * A fifth admission rule, and the narrowest one in the file.
 *
 * WHY THE EXISTING FOUR CANNOT REACH THIS. `panini-prizm` is a FIXED POINT of
 * the deriver -- normalizeSetKey("panini-prizm") === "panini-prizm" -- because
 * it is the CORRECT key for football and basketball Prizm, the flagship of
 * both. Gate 2 therefore refuses it, and refuses it RIGHTLY: a key the
 * vocabulary calls a product is not a spelling. And it must not be declared in
 * RULED_ALIASES either, because a flat alias has no sport axis and would move
 * every NFL and NBA Prizm sale into a soccer product. Drew ruled the point
 * directly: "a SPORT-SCOPED (and year-scoped) resolution, not a global alias;
 * adding panini-prizm -> panini-prizm-fifa to RULED_ALIASES would wreck FB/BK."
 *
 * So the admission itself carries the scope. An entry admits its `from` key
 * ONLY when the run is filtered to the declared sport and to years inside the
 * declared set -- and the lane REFUSES rather than widens when the dispatcher
 * left the sport or the year filter off. An unfiltered run of a sport-scoped
 * rule is precisely the accident this table exists to make impossible, so it
 * is a refusal and not a default.
 *
 * THE TITLE DECIDES EACH ROW. Unlike every other rule here, a sport-scoped
 * admission does not license a blanket prefix sweep: `titleParks` is consulted
 * PER ROW and a row whose title names ANOTHER COMPETITION'S PRODUCT is skipped
 * by name rather than moved. Absent beats wrong -- a Topps UEFA card filed as
 * Panini Prizm FIFA is worse than one left where it is.
 *
 * The predicate is the SHIPPED one from productSetKeys, never a copy: the
 * deriver and this lane must agree about what a FIFA title is, or the lane
 * moves rows the deriver would put back.
 */
const SPORT_SCOPED_ADMISSIONS = [
  {
    from: "panini-prizm",
    to: "panini-prizm-fifa",
    sport: "soccer",
    years: [2025],
    why: "Drew 2026-09-05: 2025 soccer Prizm IS Prizm FIFA. Measured read-only the same day -- card_catalog soccer/2025 holds 30,773 STRICT checklistinsider rows keyed `panini-prizm-fifa` (every one of them minted under the id stem `hiq:soccer:2025:panini-prizm:`, which is the defect) against 21 self-derived rows and ZERO strict on `panini-prizm`; the pool holds 2,385 rows on the flagship segment, 98.8% FIFA by title. Sport-scoped on purpose: `panini-prizm` is the correct fixed point for FOOTBALL and BASKETBALL Prizm and must never move.",
  },
];

/**
 * The sport-scoped entry that admits `alias` into `scope` for THIS RUN'S
 * filters, or a refusal explaining which filter was missing.
 *
 * `sports` and `years` are the run's own filters. Both must be present and
 * both must be exactly inside the declaration: a run that names two sports, or
 * a year the ruling does not cover, is not the ruled population.
 */
function sportScopedAdmission({ alias, scope, sports, years }) {
  const a = String(alias ?? "").trim().toLowerCase();
  const k = String(scope ?? "").trim().toLowerCase();
  const entry = SPORT_SCOPED_ADMISSIONS.find((e) => e.from === a && e.to === k);
  if (!entry) return null;
  const sp = (sports ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const yr = (years ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (sp.length !== 1 || sp[0] !== entry.sport) {
    return { admit: false, why: 'SPORT-SCOPED rule for "' + a + '" -> "' + k + '" requires the run to be filtered to EXACTLY sports=' + entry.sport
      + ' (got ' + (sp.length ? sp.join(",") : "(all)") + '). An unfiltered run would move ' + entry.sport
      + "'s siblings -- for this rule, football and basketball Prizm -- so it refuses rather than widens" };
  }
  if (!yr.length || !yr.every((y) => entry.years.includes(y))) {
    return { admit: false, why: 'SPORT-SCOPED rule for "' + a + '" -> "' + k + '" requires the run to be filtered to years within ' + entry.years.join(",")
      + ' (got ' + (yr.length ? yr.join(",") : "(all)") + ")" };
  }
  return { admit: true, rule: "SPORT_SCOPED", entry };
}

/**
 * The pure half of the admission decision for ONE candidate alias.
 *
 * `strictRows` is the count of strict checklist-backed catalog rows measured on
 * the alias key, and `overlap` is the fraction of the DESTINATION's distinct
 * cards its checklist also names (null when no shared cell existed to measure).
 * Both are 0/null on the pure path and the measured numbers at run time.
 * Returns {admit:true, rule} or {admit:false, why}.
 */
function admitAlias({ alias, scope, ruledSet, normalizeSetKey, strictRows = 0, overlap = null, overlapMin = 0.6, sports = [], years = [] }) {
  const a = String(alias ?? "").trim().toLowerCase();
  const k = String(scope ?? "").trim().toLowerCase();
  if (!a) return { admit: false, why: "empty alias" };
  if (a === k) return { admit: false, why: "an alias may not be its own destination -- a no-op that would count as a move" };

  // The deny-list is checked FIRST, ahead of RULED, so a table edited into
  // conflict with a standing test refuses rather than sweeps.
  if (RULING_CONFLICT_DENY[a]) return { admit: false, why: "RULING CONFLICT: " + RULING_CONFLICT_DENY[a] };

  // RULED wins outright: a human named this destination and the evidence
  // travels with the declaration. It is not subject to the derivation gates,
  // because a ruling is allowed to disagree with a derivation -- that is what
  // ruling means.
  if (ruledSet.has(a)) return { admit: true, rule: "RULED" };

  // SPORT-SCOPED. Checked BEFORE the deriver gates, because the whole point of
  // the rule is that its `from` key IS a fixed point (gate 2 would refuse it)
  // and is CORRECT for the sports it is not scoped to. It carries its own,
  // stricter gate instead: the run must be filtered to the ruled sport and
  // year, or it refuses.
  const scoped = sportScopedAdmission({ alias: a, scope: k, sports, years });
  if (scoped) return scoped;

  // DERIVER. Everything below is a mechanical check on the live vocabulary.
  const n = normalizeSetKey(a);
  if (n === a) {
    return { admit: false, why: 'the deriver leaves "' + a + '" alone -- a fixed point is a key the vocabulary considers a PRODUCT, not a spelling (this is #1792\'s SPLIT bucket)' };
  }
  if (n !== k) return { admit: false, why: 'derives to "' + n + '", not to this scope' };
  if (strictRows > 0) {
    // A competing checklist claim. It is admitted only if the two checklists
    // demonstrably name the SAME CARDS -- see gate 3 above, where panini-optic
    // (97.6% overlap, one product ingested twice) and panini-diamond-kings
    // (0.0% overlap, two products) are told apart by nothing else.
    if (overlap === null) {
      return { admit: false, why: "holds " + strictRows + " STRICT checklist row(s) of its own and there is NO SHARED sport/year cell in which to compare its cards against the destination's -- silence is not proof of sameness" };
    }
    if (overlap < overlapMin) {
      return { admit: false, why: "holds " + strictRows + " STRICT checklist row(s) of its own and names DIFFERENT CARDS -- only " + (overlap * 100).toFixed(1) + "% of the destination's distinct cardNumber|parallel appear on it (floor " + (overlapMin * 100).toFixed(0) + "%). A competing checklist that lists other cards is a PRODUCT, not a spelling" };
    }
    return { admit: true, rule: "DERIVER", overlap, strictRows };
  }
  return { admit: true, rule: "DERIVER", overlap };
}

// ── slug vocabulary ─────────────────────────────────────────────────────────

/**
 * hiq:sport:year:setKey[:sub-X]:number:parallel:auto[:num-N] -> parts, else null.
 *
 * Deliberately permissive about LENGTH and strict about SHAPE. The other
 * re-key lanes pin the length at 7 or 8, which silently refuses a
 * subset-bearing slug; this lane locates the auto flag by VALUE rather than by
 * index, so a `sub-` segment and a graded tier segment both survive. What is
 * checked is what this lane actually depends on: the `hiq` prefix, a 4-digit
 * year at 2, a non-empty setKey at 3, and an auto flag somewhere after it.
 */
function slugParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts.length < 7) return null;
  if (parts[0] !== "hiq") return null;
  if (!parts[1]) return null;
  if (!/^\d{4}$/.test(parts[2])) return null;
  if (!parts[3]) return null;
  if (!parts.some((p, i) => i >= 5 && (p === "auto" || p === "no-auto"))) return null;
  return parts;
}

/** The setKey segment of a slug, or null when the slug is not one of ours. */
function setKeyOfSlug(id) {
  const parts = slugParts(id);
  return parts ? parts[3] : null;
}

/**
 * Replace ONLY segment 3 (the setKey). Surgery, never a recompute (D28).
 *
 * THE GUARD THIS FUNCTION IS: every other segment is carried across by
 * reference -- `parts` is mutated at index 3 alone and re-joined. Removing that
 * restriction (rebuilding the slug from re-derived components, or writing to
 * any other index) is exactly the mutation the pins assert goes red, because it
 * is how a product move drags a wrong parallel along with it.
 */
function withSetKeySegment(oldSlug, setKey) {
  const parts = slugParts(oldSlug);
  if (!parts) return null;
  if (!setKey) return null;
  parts[3] = setKey;
  return parts.join(":");
}

/**
 * The ruled key this slug's setKey resolves to under `aliasMap`, or null when
 * the slug carries no declared alias.
 *
 * `aliasMap` is Map<alias, ruledKey>, already narrowed to ONE destination by
 * the caller. A key absent from it -- including the ruled key itself -- returns
 * null and the row is untouched. That is the property the pins hold: a
 * non-alias key is never rewritten, however similar it looks.
 */
function ruledKeyForSlug(id, aliasMap) {
  const key = setKeyOfSlug(id);
  if (!key) return null;
  const ruled = aliasMap.get(key);
  if (!ruled || ruled === key) return null;
  return ruled;
}

/**
 * The whole per-row decision, as a pure function, so the pins can drive it
 * without a container. Returns the plan or a reason it is not a move.
 *
 * BOTH FIELDS ARE CONSIDERED. A row is in scope when EITHER identity field
 * carries a declared alias, because the exact-pool reader ORs them and a row
 * matching on either one is in the old pool. Both are rewritten to the target;
 * a field that was already correct stays correct.
 */
function planAliasReslug({ cardId, hobbyiqCardId, aliasMap, title = "", titleParks = null }) {
  const pk = str(cardId);
  const hiq = str(hobbyiqCardId);
  // The identity field leads. Where hobbyiqCardId is absent the partition key
  // is the only identity the row has.
  const identity = hiq || pk;
  if (!identity) return { move: false, why: "no identity field" };

  const viaIdentity = ruledKeyForSlug(identity, aliasMap);
  const viaPartition = pk && pk !== identity ? ruledKeyForSlug(pk, aliasMap) : null;
  const ruled = viaIdentity ?? viaPartition;
  if (!ruled) return { move: false, why: "setKey is not a declared alias of this scope" };

  // THE TITLE DECIDES, PER ROW, for a sport-scoped admission. `titleParks` is
  // supplied only by a scope whose admission carries one (the shipped
  // predicate, never a copy). A row it parks is skipped BY NAME and counted --
  // absent beats wrong. Checked before the target is built so a parked row can
  // never be reported as a move.
  if (typeof titleParks === "function" && titleParks(title)) {
    return { move: false, why: "title names another competition's product", parked: true, aliasWas: setKeyOfSlug(identity) ?? setKeyOfSlug(pk), title: str(title) };
  }

  const target = withSetKeySegment(identity, ruled);
  if (!target) return { move: false, why: "identity slug is malformed" };
  if (target === identity && (!pk || pk === identity)) return { move: false, why: "already at the ruled key" };

  // A partition key that is a DIFFERENT hiq slug from the identity is a third
  // slug: reported, and moved to the same target rather than left behind.
  const thirdSlug = pk && pk !== identity && pk.startsWith("hiq:") && pk !== target ? pk : null;
  // A legacy vendor partition key is not a slug at all; it is preserved.
  const vendorCardIdWas = pk && !pk.startsWith("hiq:") ? pk : null;

  return {
    move: true,
    target,
    ruledKey: ruled,
    aliasWas: setKeyOfSlug(identity) ?? setKeyOfSlug(pk),
    identityWas: identity,
    thirdSlug,
    vendorCardIdWas,
  };
}

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

async function forEachPage(container, spec, onPage, pageSize = 200) {
  let token;
  do {
    const page = await retry(() => container.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}


/**
 * Discover the alias SPELLINGS actually stored in the pool for this scope.
 *
 * Reads segment 3 of `hobbyiqCardId` under `hiq:SPORT:YEAR:` and keeps every
 * distinct value the LIVE deriver folds onto `scope`. Bounded: `maxPages`
 * pages of `pageSize` per (sport, year) cell, projecting one field. This is a
 * DISCOVERY read, not the sweep -- it decides the alias set, and the sweep that
 * follows walks each admitted alias by its own index-served prefix.
 *
 * Why segment 3 and not the `setKey` FIELD: measured read-only 2026-09-05, the
 * field is sparsely populated (8 distinct values across all of baseball), while
 * the slug segment is present on every row and is what this lane rewrites.
 * CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT -- the field drifts, the id is the product.
 *
 * A cell that pages out before exhausting is reported as TRUNCATED. That is
 * honest rather than fatal: a spelling common enough to matter appears in the
 * first pages, and the sweep is per-alias-prefix regardless of how many rows
 * the discovery sampled. It is printed so a reader never mistakes a bounded
 * sample for a census.
 */
async function discoverPoolAliases({ pool, scope, sports, years, normalizeSetKey, retry, maxPages = 12, pageSize = 2000 }) {
  const found = new Map();   // alias -> { sampled, cells:Set }
  const truncated = [];
  const cells = [];
  for (const sp of (sports.length ? sports : [null])) {
    for (const y of (years.length ? years : [null])) {
      if (sp && y) cells.push({ prefix: "hiq:" + sp + ":" + y + ":", label: sp + "/" + y });
      else if (sp) cells.push({ prefix: "hiq:" + sp + ":", label: sp + "/(all years)" });
      else cells.push({ prefix: "hiq:", label: "(all sports)" });
    }
  }
  for (const cell of [...new Map(cells.map((c) => [c.prefix, c])).values()]) {
    let token, pages = 0;
    do {
      const page = await retry(() => pool.items.query({
        query: "SELECT c.hobbyiqCardId FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
        parameters: [{ name: "@p", value: cell.prefix }],
      }, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      for (const row of page.resources ?? []) {
        const parts = String(row.hobbyiqCardId ?? "").split(":");
        if (parts.length < 5) continue;
        const k = parts[3];
        if (!k || k === scope) continue;
        if (normalizeSetKey(k) !== scope) continue;
        if (!found.has(k)) found.set(k, { sampled: 0, cells: new Set() });
        const e = found.get(k);
        e.sampled++;
        e.cells.add(parts[1] + "/" + parts[2]);
      }
      pages++;
    } while (token && pages < maxPages);
    if (token) truncated.push(cell.label);
  }
  return { found, truncated };
}

/**
 * Do two catalog keys name the SAME CARDS? Gate 3's discriminator. Read-only.
 *
 * Returns the fraction of the DESTINATION's distinct `cardNumber|parallel` that
 * also appear under the alias, measured only in cells where BOTH keys hold
 * rows -- and null when there is no such cell, because a pair that never
 * co-occurs offers no evidence either way and must refuse rather than pass.
 *
 * The destination is the denominator on purpose. The question this gate asks is
 * "would folding the alias in bring the destination's own cards home, or import
 * a different product's checklist?", and that is asked of the destination's
 * card list. An alias that is a strict SUPERSET (a bigger ingest of the same
 * release) still scores 1.0, which is correct -- panini-optic is exactly that.
 *
 * Compared on cardNumber|parallel rather than on the full identity slug because
 * the slug's setKey segment is the very thing that differs; number and parallel
 * are what a checklist actually asserts.
 */
async function measureCardOverlap({ cat, alias, scope, sports, years, retry, pageSize = 2000, maxPages = 40 }) {
  // cell -> { alias:Set, dest:Set }
  //
  // Scanned per (cell, KEY) on the narrow prefix `hiq:sport:year:key:`, never on
  // the cell prefix alone. The first draft scanned `hiq:football:2024:` and
  // filtered by segment, which reads EVERY product in the cell: the page bound
  // was exhausted on unrelated keys long before it reached the two being
  // compared, and the gate scored panini-optic at 12.1% off 1,977-of-17,003
  // rows it had actually seen. A bound that silently truncates the evidence
  // turns a discriminator into a coin flip, and it refused the right answer.
  const cells = new Map();
  const cellKeys = [];
  for (const sp of (sports.length ? sports : [])) {
    for (const y of (years.length ? years : [])) cellKeys.push({ cell: sp + "/" + y, sp, y });
  }
  // Both a sport AND a year are needed to name a key's prefix; without them the
  // comparison cannot be index-served and the gate reports no evidence rather
  // than paying for a container scan.
  if (!cellKeys.length) return { overlap: null, destTotal: 0, shared: 0, perCell: [], unscoped: true };

  for (const { cell, sp, y } of cellKeys) {
    for (const [which, key] of [["alias", alias], ["dest", scope]]) {
      let token, pages = 0;
      do {
        const page = await retry(() => cat.items.query({
          query: "SELECT c.id, c.cardNumber, c.parallel FROM c WHERE STARTSWITH(c.id, @p)",
          parameters: [{ name: "@p", value: "hiq:" + sp + ":" + y + ":" + key + ":" }],
        }, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
        token = page.continuationToken;
        for (const d of page.resources ?? []) {
          const parts = String(d.id ?? "").split(":");
          if (parts.length < 5 || parts[3] !== key) continue;
          if (!cells.has(cell)) cells.set(cell, { alias: new Set(), dest: new Set() });
          cells.get(cell)[which].add(
            String(d.cardNumber ?? "").trim().toLowerCase() + "|" + String(d.parallel ?? "").trim().toLowerCase());
        }
        pages++;
      } while (token && pages < maxPages);
      // A key that pages out has an INCOMPLETE set, and an incomplete alias set
      // can only understate the overlap -- which would refuse a real fold. Said
      // out loud rather than absorbed.
      if (token) {
        if (!cells.has(cell)) cells.set(cell, { alias: new Set(), dest: new Set() });
        cells.get(cell).truncated = (cells.get(cell).truncated ?? []).concat(which + ":" + key);
      }
    }
  }
  let destTotal = 0, shared = 0;
  const perCell = [];
  for (const [cell, v] of cells) {
    if (!v.alias.size || !v.dest.size) continue;   // not a SHARED cell
    let i = 0;
    for (const k of v.dest) if (v.alias.has(k)) i++;
    destTotal += v.dest.size;
    shared += i;
    perCell.push({ cell, alias: v.alias.size, dest: v.dest.size, shared: i, pct: i / v.dest.size, truncated: v.truncated ?? null });
  }
  perCell.sort((a, b) => b.dest - a.dest);
  return { overlap: destTotal ? shared / destTotal : null, destTotal, shared, perCell };
}

/**
 * Count STRICT checklist-backed catalog rows on a key, by source. Read-only.
 *
 * Gate 3 of the admission rule. Scoped by the same sport/year cells as the
 * sweep, by id stem, so the count is index-served and names the same population
 * the move would touch.
 */
async function countStrictCatalogRows({ cat, key, sports, years, retry, pageSize = 1000 }) {
  const bySource = new Map();
  let total = 0, strict = 0;
  const prefixes = [];
  for (const sp of (sports.length ? sports : [null])) {
    for (const y of (years.length ? years : [null])) {
      if (sp && y) prefixes.push("hiq:" + sp + ":" + y + ":" + key + ":");
      else if (sp) prefixes.push("hiq:" + sp + ":");
      else prefixes.push("hiq:");
    }
  }
  for (const p of [...new Set(prefixes)]) {
    let token;
    do {
      const page = await retry(() => cat.items.query({
        query: "SELECT c.id, c.source FROM c WHERE STARTSWITH(c.id, @p)",
        parameters: [{ name: "@p", value: p }],
      }, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      for (const r of page.resources ?? []) {
        // When the prefix could not name the key (no sport/year filter), the
        // SEGMENT decides -- the same rule the sweep uses.
        const parts = String(r.id ?? "").split(":");
        if (parts.length < 5 || parts[3] !== key) continue;
        total++;
        const src = String(r.source ?? "").trim() || "(no source)";
        bySource.set(src, (bySource.get(src) ?? 0) + 1);
        if (isStrictCatalogSource(src)) strict++;
      }
    } while (token);
  }
  return { total, strict, bySource };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // The scope refusal comes FIRST, before any dist/ require and before any
  // Cosmos client, so a bad scope can never reach a connected client.
  if (INHERITED_SCOPES.has(RAW_SCOPE)) {
    console.error(
      `FATAL: SCOPE is required and names the RULED KEY (e.g. SCOPE=bellingham-mariners).\n`
      + `  "${RAW_SCOPE}" is the runner's inherited default or another lane's vocabulary, not a ruled key.\n`
      + `  A whole-scope write refuses without its scope.`);
    process.exit(1);
  }

  const { ruledAliases } = require(path.join(backend, "dist/services/catalog/setKeyReconciliation.js"));
  const { normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  // ── GATE 1: the scope key must be a normalizeSetKey FIXED POINT ───────────
  //
  // Checked FIRST and for every scope, RULED or DERIVER alike. If the
  // destination itself normalises onward, moving rows onto it only queues the
  // next move. This is what refuses `donruss` as a scope -- the census's #2 by
  // volume -- because normalizeSetKey("donruss") === "panini-donruss": an ERA
  // SPLIT resolved per-year by spellForEra, never a flat destination.
  const normalised = normalizeSetKey(RAW_SCOPE);
  if (normalised !== RAW_SCOPE) {
    console.error(
      `FATAL: the scope key "${RAW_SCOPE}" is not a normalizeSetKey fixed point -- it normalises to "${normalised}".\n`
      + `  Moving rows onto it would only queue the next move. Rule the destination first.`);
    process.exit(2);
  }
  if (RULING_CONFLICT_DENY[RAW_SCOPE]) {
    console.error(
      `FATAL: "${RAW_SCOPE}" is on the RULING CONFLICT deny-list and may not be a scope.\n`
      + `  ${RULING_CONFLICT_DENY[RAW_SCOPE]}`);
    process.exit(2);
  }

  // THE TABLE IS READ, NEVER RETYPED -- narrowed to the ONE destination named.
  const declared = ruledAliases();
  const ruledForScope = declared.filter((a) => a.canonical === RAW_SCOPE);
  const ruledSet = new Set(ruledForScope.map((a) => a.setKey));

  // SANITY, NOT TRUST. The ruling stands; a table edited wrongly does not.
  const selfAliases = ruledForScope.filter((a) => a.setKey === a.canonical);
  if (selfAliases.length) {
    console.error(`FATAL: ${selfAliases.map((a) => a.setKey).join(", ")} is declared an alias of itself -- a no-op that would count as a move.`);
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const { CosmosClient } = require("@azure/cosmos");
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`reslug-ruled-alias   ${APPLY ? "APPLY" : "REPORT ONLY -- nothing written"}`);
  console.log(`  ruling      ${REASON_LONG}`);
  console.log(`  SCOPE       ${RAW_SCOPE}   <- the destination key; every ADMITTED alias of it is swept`);
  console.log(`  filters     years=${YEARS.length ? YEARS.join(",") : "(all)"}  sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}`);
  console.log("");

  // ── the alias set: RULED union DERIVER-RESOLVED, discovered then gated ────
  console.log(`  discovering alias spellings stored in the pool for this scope (bounded read)...`);
  const discovery = await discoverPoolAliases({
    pool, scope: RAW_SCOPE, sports: SPORTS, years: YEARS, normalizeSetKey, retry,
    maxPages: DISCOVERY_PAGES,
  });
  if (discovery.truncated.length) {
    console.log(`  discovery TRUNCATED at ${DISCOVERY_PAGES} pages in: ${discovery.truncated.join(", ")}`);
    console.log(`    (a bounded sample decides the SET of spellings; the sweep below is per-alias prefix and is not bounded by it)`);
  }

  // Every candidate: the ruled declarations, plus every spelling the pool
  // actually stores that the live deriver folds onto this scope.
  // A SPORT-SCOPED `from` key can never be DISCOVERED: discovery keeps only
  // spellings the sport-blind deriver folds onto the scope, and this rule
  // exists precisely because `panini-prizm` folds onto ITSELF. So the declared
  // `from` keys for this scope are seeded as candidates and then face
  // sportScopedAdmission's own, stricter gate like any other candidate --
  // seeding proposes, the gate disposes.
  const scopedSeeds = SPORT_SCOPED_ADMISSIONS.filter((e) => e.to === RAW_SCOPE).map((e) => e.from);
  const candidates = [...new Set([...ruledSet, ...discovery.found.keys(), ...scopedSeeds])].sort();
  if (!candidates.length) {
    const destinations = [...new Set(declared.map((a) => a.canonical))].sort();
    console.error(
      `FATAL: no alias resolves to "${RAW_SCOPE}" -- neither a RULED declaration nor a spelling stored in the pool.\n`
      + `  A scope that matches nothing must refuse, never sweep nothing and report success.\n`
      + `  Ruled destinations (${destinations.length}): ${destinations.join(", ")}`);
    process.exit(2);
  }

  // GATE 3 needs Cosmos, so the strict-row count is measured HERE, once per
  // candidate, before any row is planned. Read-only.
  const admitted = [];
  const refused = [];
  for (const alias of candidates) {
    // A RULED alias is a human decision and is not made to justify itself with
    // a source count; the count is skipped for it (and for a deny-listed key,
    // which is refused regardless).
    const needsStrictCount = !ruledSet.has(alias) && !RULING_CONFLICT_DENY[alias]
      && normalizeSetKey(alias) !== alias && normalizeSetKey(alias) === RAW_SCOPE;
    let strict = 0;
    let bySource = new Map();
    if (needsStrictCount) {
      const c = await countStrictCatalogRows({ cat, key: alias, sports: SPORTS, years: YEARS, retry });
      strict = c.strict;
      bySource = c.bySource;
    }
    // Gate 3's discriminator, paid for ONLY when there is a competing
    // checklist claim to adjudicate.
    let overlap = null, perCell = [];
    if (strict > 0) {
      const o = await measureCardOverlap({ cat, alias, scope: RAW_SCOPE, sports: SPORTS, years: YEARS, retry });
      overlap = o.overlap; perCell = o.perCell;
    }
    const verdict = admitAlias({ alias, scope: RAW_SCOPE, ruledSet, normalizeSetKey, strictRows: strict, overlap, overlapMin: OVERLAP_MIN, sports: SPORTS, years: YEARS });
    const sampled = discovery.found.get(alias)?.sampled ?? 0;
    if (verdict.admit) admitted.push({ alias, rule: verdict.rule, sampled, strict, bySource, overlap, perCell });
    else refused.push({ alias, why: verdict.why, sampled, strict, bySource, overlap, perCell });
  }

  console.log(`\n  ALIAS SET for ${RAW_SCOPE} -- ${admitted.length} admitted, ${refused.length} refused`);
  const ruledNames = admitted.filter((a) => a.rule === "RULED").map((a) => a.alias);
  const derivNames = admitted.filter((a) => a.rule === "DERIVER").map((a) => a.alias);
  const scopedNames = admitted.filter((a) => a.rule === "SPORT_SCOPED").map((a) => a.alias);
  console.log(`      ruled:            ${ruledNames.length ? ruledNames.join(", ") : "(none)"}`);
  console.log(`      deriver-resolved: ${derivNames.length ? derivNames.join(", ") : "(none)"}`);
  console.log(`      sport-scoped:     ${scopedNames.length ? scopedNames.join(", ") : "(none)"}`);
  for (const a of admitted) {
    console.log(`      ADMIT  ${a.alias}  ->  ${RAW_SCOPE}   [${a.rule}]`
      + (a.rule === "DERIVER"
        ? `  normalizeSetKey("${a.alias}") === "${RAW_SCOPE}"; ${a.strict ? `${f(a.strict)} strict rows, ${(a.overlap * 100).toFixed(1)}% card overlap with the destination` : "0 strict catalog rows"}`
        : a.rule === "SPORT_SCOPED"
          ? `  admitted ONLY for sports=${SPORTS.join(",")} years=${YEARS.join(",")}; this key stays correct in every other sport`
          : "  declared in RULED_ALIASES")
      + (a.sampled ? `  (seen ${f(a.sampled)}x in the discovery sample)` : ""));
    for (const c of (a.perCell ?? []).slice(0, 6)) {
      console.log(`               ${c.cell.padEnd(18)} alias ${String(f(c.alias)).padStart(7)}  dest ${String(f(c.dest)).padStart(7)}  shared ${String(f(c.shared)).padStart(7)}  ${(c.pct * 100).toFixed(1)}%${c.truncated ? `   TRUNCATED (${c.truncated.join(", ")})` : ""}`);
    }
  }
  for (const r of refused) {
    console.log(`      REFUSE ${r.alias}: ${r.why}`);
    if (r.strict > 0) {
      for (const [src, n] of [...r.bySource].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
        console.log(`               ${String(f(n)).padStart(8)}  source=${src}${isStrictCatalogSource(src) ? "   <- STRICT" : ""}`);
      }
      for (const c of (r.perCell ?? []).slice(0, 6)) {
        console.log(`               ${c.cell.padEnd(18)} alias ${String(f(c.alias)).padStart(7)}  dest ${String(f(c.dest)).padStart(7)}  shared ${String(f(c.shared)).padStart(7)}  ${(c.pct * 100).toFixed(1)}%${c.truncated ? `   TRUNCATED (${c.truncated.join(", ")})` : ""}`);
      }
    }
  }
  if (!admitted.length) {
    console.error(`\nFATAL: every candidate alias was refused -- there is nothing in scope to move.`);
    process.exit(2);
  }

  const forScope = admitted.map((a) => ({ setKey: a.alias, canonical: RAW_SCOPE, rule: a.rule }));
  const aliasMap = new Map(forScope.map((a) => [a.setKey, a.canonical]));

  console.log("");
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log("");

  const s = {
    scanned: 0, otherSlot: 0, moved: 0, created: 0, deleted: 0, collapsed: 0,
    notAlias: 0, malformed: 0, outOfScope: 0, alreadyRuled: 0,
    thirdSlug: 0, duplicatesLeft: 0, failed: 0,
    // Rows a SPORT-SCOPED admission's per-row title test refused: another
    // competition's product, left exactly where it is (absent beats wrong).
    parkedOtherCompetition: 0,
  };
  let stopReason = null;
  const byAlias = new Map();
  const destinations = new Map();
  const examples = [];
  const parkedByAlias = new Map();
  const parkedExamples = [];

  // The per-row title predicate, present ONLY when a SPORT-SCOPED admission is
  // in play. It is the SHIPPED predicate from productSetKeys, required through
  // dist/ like every other vocabulary read in this lane -- never a copy, or the
  // lane and the deriver could disagree about what a FIFA title is and the
  // lane would move rows the deriver puts straight back.
  const TITLE_PARKS = admitted.some((a) => a.rule === "SPORT_SCOPED")
    ? require(path.join(backend, "dist", "services", "catalog", "productSetKeys.js")).titleNamesOtherCompetition
    : null;
  if (TITLE_PARKS) {
    console.log("  TITLE TEST  a SPORT-SCOPED admission is active: every row's title is checked and one naming");
    console.log("              ANOTHER COMPETITION'S PRODUCT is PARKED, not moved (absent beats wrong).");
    console.log("");
  }

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  // ── BEFORE: the pool as it stands, per alias and at the destination ───────
  //
  // Counted per ALIAS PREFIX, never as one cross-partition COUNT over the whole
  // container: a prefix count is index-served (CF-THE-ID-CARRIES-THE-PRODUCT),
  // a predicate over 16M rows is a query that runs for minutes.
  const before = { aliases: new Map(), destination: 0 };
  const prefixesFor = (key) => {
    const sports = SPORTS.length ? SPORTS : [null];
    const years = YEARS.length ? YEARS : [null];
    const out = [];
    for (const sp of sports) {
      for (const y of years) {
        if (sp && y) out.push(`hiq:${sp}:${y}:${key}:`);
        else if (sp) out.push(`hiq:${sp}:`);
        else out.push("hiq:");
      }
    }
    // Without a sport filter the prefix cannot name the setKey (it sits after
    // the year), so the scan is by the widest prefix and the SEGMENT decides.
    return [...new Set(out)];
  };

  async function countPrefix(container, field, prefix) {
    return (await retry(() => container.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.${field}, @p)`,
      parameters: [{ name: "@p", value: prefix }],
    }).fetchAll())).resources[0] ?? 0;
  }

  // A per-(sport, year, alias) count is only index-served when the sport and
  // year are known. When they are not, the count is reported as "-- (unscoped)"
  // rather than paid for with a container scan.
  const canCountExactly = SPORTS.length > 0 && YEARS.length > 0;
  if (canCountExactly) {
    for (const a of forScope) {
      let n = 0;
      for (const sp of SPORTS) for (const y of YEARS) {
        n += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${a.setKey}:`);
      }
      before.aliases.set(a.setKey, n);
    }
    for (const sp of SPORTS) for (const y of YEARS) {
      before.destination += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${RAW_SCOPE}:`);
    }
    console.log("  BEFORE (by hobbyiqCardId prefix, index-served):");
    for (const a of forScope) console.log(`      ${String(f(before.aliases.get(a.setKey) ?? 0)).padStart(8)}  ${a.setKey}`);
    console.log(`      ${String(f(before.destination)).padStart(8)}  ${RAW_SCOPE}   <- the destination`);
    console.log("");
  }

  // ── the sweep ────────────────────────────────────────────────────────────

  async function handle(row) {
    const plan = planAliasReslug({
      cardId: row.cardId, hobbyiqCardId: row.hobbyiqCardId, aliasMap,
      title: row.title, titleParks: TITLE_PARKS,
    });
    if (!plan.move) {
      if (plan.parked) {
        s.parkedOtherCompetition++;
        bump(parkedByAlias, plan.aliasWas);
        if (parkedExamples.length < 10) parkedExamples.push(`  PARK   ${String(plan.aliasWas)}  ${str(plan.title).slice(0, 100)}`);
      }
      else if (plan.why === "identity slug is malformed") s.malformed++;
      else if (plan.why === "already at the ruled key") s.alreadyRuled++;
      else s.notAlias++;
      return;
    }
    const parts = slugParts(plan.identityWas);
    if (YEARS.length && !YEARS.includes(Number(parts[2]))) { s.outOfScope++; return; }
    if (SPORTS.length && !SPORTS.includes(parts[1])) { s.outOfScope++; return; }

    bump(byAlias, plan.aliasWas);
    bump(destinations, plan.target);
    if (plan.thirdSlug) s.thirdSlug++;

    const keep = stripSystem(row);
    if (plan.vendorCardIdWas) keep.vendorCardIdWas = plan.vendorCardIdWas;
    // BOTH identity fields land at the target -- the reader ORs them.
    keep.cardId = plan.target;
    keep.hobbyiqCardId = plan.target;
    keep.setKey = plan.ruledKey;
    keep.normalizedSetKey = plan.ruledKey;
    keep.rekeyedSetKeyWas = plan.aliasWas;
    keep.rekeyedFrom = plan.identityWas;
    keep.rekeyedAt = new Date().toISOString();
    keep.rekeyedReason = REASON;
    // THE HASH FOLLOWS THE ADDRESS: cardId is contentHash's first component, so
    // a moved row keeping the old hash is invisible to the store's
    // partition-scoped pre-write dedup and every re-emit duplicates it.
    // Computed AFTER both identity fields are final.
    keep.contentHash = contentHashOf(keep);

    if (examples.length < 10) {
      examples.push(
        `  RESLUG ${plan.identityWas.slice(0, 72)}\n`
        + `      -> ${plan.target.slice(0, 72)}\n`
        + `         ${str(row.title).slice(0, 92)}`
        + (plan.thirdSlug ? `\n         THIRD SLUG cardId was ${plan.thirdSlug.slice(0, 66)}` : ""));
    }

    const drop = [{ id: row.id, cardId: row.cardId }];
    const res = await relocateSoldComp(pool, {
      keep,
      drop,
      retry,
      verifyFields: ["cardId", "hobbyiqCardId", "setKey", "contentHash", "rekeyedFrom"],
      dryRun: !APPLY,
    });
    if (!res.ok && res.stage !== "done") {
      s.failed++;
      console.log(`  FAILED at ${res.stage}: ${row.id} @ ${row.cardId} -> ${plan.target}: ${String(res.error).slice(0, 120)}`);
      return;
    }
    if (res.duplicatesLeft.length) {
      s.failed++; s.duplicatesLeft += res.duplicatesLeft.length;
      for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 90)}`);
      return;
    }
    if (!APPLY) { s.created += 1; s.deleted += 1; }
    else {
      s.created += res.existedBefore ? 0 : 1;
      s.deleted += res.deleted.length;
      if (res.existedBefore) s.collapsed++;
    }
    s.moved++;
  }

  // The scan is by SLUG PREFIX on hobbyiqCardId, plus the same prefix on
  // cardId: a row whose partition key carries the alias while its identity
  // field does not is in the old pool too, and only a cardId scan reaches it.
  // Ids already seen are not handled twice.
  const seen = new Set();
  const scans = [];
  for (const a of forScope) {
    for (const p of prefixesFor(a.setKey)) {
      scans.push({ field: "hobbyiqCardId", prefix: p, alias: a.setKey });
      scans.push({ field: "cardId", prefix: p, alias: a.setKey });
    }
  }

  for (const scan of scans) {
    if (stopReason) break;
    console.log(`-- scanning ${scan.field} ${scan.prefix}  (alias ${scan.alias})`);
    await forEachPage(pool, {
      // SELECT * and not a projection: the row read here is the document
      // UPSERT-ed at the new address, so a projection would silently drop every
      // field it left out. A re-key must carry the whole row.
      query: `SELECT * FROM c WHERE STARTSWITH(c.${scan.field}, @p)`,
      parameters: [{ name: "@p", value: scan.prefix }],
    }, async (rows) => {
      const fresh = rows.filter((r) => {
        const k = `${r.id} ${r.cardId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // Shard on the row's own id: the partition key is a legacy vendor id for
      // much of this population and thousands of rows can share one, so
      // sharding on it would pile them into a single slot.
      const mine = fresh.filter((r) => { if (SHARD_SCOPE.mine(shardIndex(r.id))) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        s.scanned += batch.length;
        await Promise.all(batch.map((r) => handle(r).catch((e) => {
          s.failed++;
          if (s.failed <= 5) console.log(`  FAILED ${String(r.id).slice(0, 64)}: ${String(e?.message ?? e).slice(0, 110)}`);
        })));
        // Rows past the break were never added to s.scanned, so counting them
        // as skipped would overshoot: `intended` is what this slot classified.
        if (LIMIT && s.moved >= LIMIT) { stopReason = "limit"; break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
      }
      return !stopReason;
    }, 400);
  }

  for (const l of examples) console.log(l);

  // ── the catalog side: REPORTED, NEVER WRITTEN ────────────────────────────
  //
  // Catalog rows keyed on an alias slug are counted and grouped by `source`.
  // Nothing here is deleted and nothing is patched. See the banner note.
  const catalogByAlias = new Map();
  if (canCountExactly) {
    for (const a of forScope) {
      const bySource = new Map();
      let total = 0;
      for (const sp of SPORTS) for (const y of YEARS) {
        await forEachPage(cat, {
          query: "SELECT c.id, c.source FROM c WHERE STARTSWITH(c.id, @p)",
          parameters: [{ name: "@p", value: `hiq:${sp}:${y}:${a.setKey}:` }],
        }, async (rows) => {
          for (const r of rows) { total++; bump(bySource, str(r.source) || "(no source)"); }
        }, 400);
      }
      if (total) catalogByAlias.set(a.setKey, { total, bySource });
    }
  }

  // ── the banner ───────────────────────────────────────────────────────────
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget -- the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} -- a bounded run`);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned (this slot)      ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
  console.log(`  RESLUGGED onto the ruled key  ${f(s.moved)}   <- cardId AND hobbyiqCardId, verified by read`);
  console.log(`  new rows created              ${f(s.created)}`);
  console.log(`  old rows deleted              ${f(s.deleted)}`);
  console.log(`  collapsed onto an existing    ${f(s.collapsed)}`);
  console.log(`  third-slug cardId carried     ${f(s.thirdSlug)}   <- partition key named a different slug; moved, not left`);
  console.log(`  not a declared alias (left)   ${f(s.notAlias)}`);
  console.log(`  already at the ruled key      ${f(s.alreadyRuled)}`);
  console.log(`  out of dispatched scope       ${f(s.outOfScope)}`);
  console.log(`  malformed slug (left)         ${f(s.malformed)}`);
  console.log(`  duplicates LEFT in the pool   ${f(s.duplicatesLeft)}`);
  console.log(`  failed                        ${f(s.failed)}`);

  if (byAlias.size) {
    console.log("\n  BY ALIAS (rows this run classified as a move):");
    for (const [k, n] of [...byAlias].sort((a, b) => b[1] - a[1])) console.log(`      ${String(f(n)).padStart(8)}  ${k}  ->  ${RAW_SCOPE}`);
  }
  if (destinations.size) {
    console.log("\n  DESTINATION SLUGS:");
    for (const [k, n] of [...destinations].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`      ${String(f(n)).padStart(8)}  ${k}`);
  }

  // ── AFTER, and the reconciliation ────────────────────────────────────────
  if (canCountExactly) {
    let afterAliases = 0, afterDest = 0;
    for (const a of forScope) for (const sp of SPORTS) for (const y of YEARS) {
      afterAliases += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${a.setKey}:`);
    }
    for (const sp of SPORTS) for (const y of YEARS) {
      afterDest += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${RAW_SCOPE}:`);
    }
    const beforeAliases = [...before.aliases.values()].reduce((x, y) => x + y, 0);
    console.log("");
    console.log(`  POOL BEFORE   aliases ${f(beforeAliases)}   destination ${f(before.destination)}   total ${f(beforeAliases + before.destination)}`);
    console.log(`  POOL AFTER    aliases ${f(afterAliases)}   destination ${f(afterDest)}   total ${f(afterAliases + afterDest)}`);
    if (!APPLY) {
      console.log(`    report-only: unchanged expected. A difference here means another writer moved rows during the run.`);
    } else {
      console.log(`    expected: aliases ${f(beforeAliases - s.deleted)}   destination ${f(before.destination + s.created)}`);
    }
  }

  if (catalogByAlias.size) {
    console.log("\n  CATALOG ROWS ON AN ALIAS SLUG -- REPORTED, NEVER WRITTEN:");
    for (const [k, v] of catalogByAlias) {
      console.log(`      ${String(f(v.total)).padStart(6)}  ${k}`);
      for (const [src, n] of [...v.bySource].sort((a, b) => b[1] - a[1])) console.log(`              ${String(f(n)).padStart(6)}  source=${src}`);
    }
    console.log(`    This lane DELETES NOTHING here. `);
    console.log(`    supersededBy is NOT the answer: dedupe-catalog-rows.cjs writes it and NOTHING in backend/src reads it,`);
    console.log(`    so marking a row changes no read path. The honoured surface is catalogVisibility.ts (source +`);
    console.log(`    verificationStatus), and it gates SEARCH only -- a direct lookup by slug returns any row regardless.`);
    console.log(`    The catalog step is therefore a MOVE onto the ruled slug via catalogRowOps.moveCatalogRow`);
    console.log(`    (rekey-product-setkey MODE=catalog already does exactly this), decided by authority, in its own PR.`);
  } else if (canCountExactly) {
    console.log("\n  CATALOG: no rows on an alias slug in this scope.");
  }

  // PARKED ROWS ARE NAMED, NOT BURIED. A sport-scoped admission's title test
  // is the half of the ruling that says "absent beats wrong", so what it
  // refused is reported with its own count and its own examples -- never
  // folded silently into `skipped`.
  if (s.parkedOtherCompetition) {
    console.log(`
  PARKED -- title names ANOTHER COMPETITION'S PRODUCT, left where it is: ${f(s.parkedOtherCompetition)}`);
    for (const [k, v] of [...parkedByAlias].sort((a, b) => b[1] - a[1])) console.log(`      ${String(f(v)).padStart(6)}  ${k}`);
    for (const line of parkedExamples) console.log(line);
  } else if (TITLE_PARKS) {
    console.log("\n  PARKED: none -- every scanned row's title is this product or says nothing contradicting it.");
  }

  const intended = s.scanned;
  const skipped = s.notAlias + s.alreadyRuled + s.outOfScope + s.malformed + s.parkedOtherCompetition;
  console.log(`\n  reconciled: intended ${f(intended)} = written ${f(s.moved)} + skipped ${f(skipped)}${s.failed ? ` + failed ${f(s.failed)}` : ""}`);
  if (APPLY) reportWrites({ job: "reslug-ruled-alias", intended, written: s.moved, skipped, failed: s.failed });
}

// sha1 shard of a row id, used only when sharding is opted into.
function shardIndex(id) {
  const crypto = require("crypto");
  return parseInt(crypto.createHash("sha1").update(String(id ?? "")).digest("hex").slice(0, 8), 16) % Math.max(1, SLOTS);
}

module.exports = {
  slugParts, setKeyOfSlug, withSetKeySegment, ruledKeyForSlug, planAliasReslug,
  REASON, INHERITED_SCOPES,
  // the admission rule (#1793): RULED union DERIVER-RESOLVED, and its refusals
  admitAlias, isStrictCatalogSource, STRICT_CATALOG_SOURCES, RULING_CONFLICT_DENY,
  discoverPoolAliases, countStrictCatalogRows, measureCardOverlap,
  // the SPORT-SCOPED admission (CF-SOCCER-PRIZM-IS-PRIZM-FIFA)
  sportScopedAdmission, SPORT_SCOPED_ADMISSIONS,
};

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
