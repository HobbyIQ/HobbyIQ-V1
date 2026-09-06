#!/usr/bin/env node
/**
 * CF-DRIVE-THE-UNIVERSE-ONE-ENTRY-AT-A-TIME (D38, 2026-09-01).
 *
 * The enumeration (D37) proved WHAT exists: 7,755 sets across six lanes, of
 * which 2,451 are missing from the catalog entirely and 2,264 are partial. This
 * script is the thing that closes them, one entry at a time, on a runner.
 *
 * WHY A DRIVER AND NOT ANOTHER SWEEP. ingest-checklists-end-to-end acquires a
 * whole SOURCE per run -- scrape all of Beckett, then all of insider. That is
 * the right shape for a first fill and the wrong shape for closing a gap list:
 * it re-scrapes 718 pages to reach the 3 that are missing, it cannot say which
 * SET a failure belonged to, and a budget stop loses the position. This drives
 * the MANIFEST instead: take the next N pending entries for one lane, acquire
 * exactly those, and record a verdict per entry.
 *
 * IT REIMPLEMENTS NO SCRAPING. Every acquisition shells out to the same script
 * the end-to-end path uses, with the same arguments, and every ingest lands
 * through ingest-checklist-csv-to-catalog.cjs / ingest-scraped-checklist.cjs --
 * so the doctrine guards those carry (the exploded-file gate, the player-as-rung
 * filter, the card-line-as-rung filter) apply here unchanged. What this adds is
 * a PER-ENTRY gate in front of the ingest, because those guards drop a bad
 * category and land the rest, which is right for a sweep and wrong for an entry
 * whose whole verdict we are about to record.
 *
 * WHERE THE STATE LIVES. A runner job cannot push, so the manifest is immutable
 * (the universe: which sets exist and where each is fetched) and the mutable
 * verdict is a control doc per entry in `crawl_state` -- the container
 * tca-firehose-ingest already uses for exactly this, self-partitioned on id.
 *
 * SCOPE IS REQUIRED. `sources` names the lane and there is NO default: a driver
 * that picks its own lane on an empty input runs a lane nobody dispatched.
 *
 * Env (all via the existing backfill-runner inputs -- no new inputs):
 *   SOURCES=hobbymonitor|insider|bcp|beckett|tcdb|clc|tcgdexja|sportscardchecklist   REQUIRED
 *   BACKFILL_APPLY=true    actually acquire + ingest + write verdicts
 *   LIMIT=N                entries this run (0 = budget-sized)
 *   YEARS=1969,1972        optional year scope
 *   SPORTS=football        optional sport scope
 *   SCOPE=recheck          re-attempt entries already verdicted (default: pending only)
 *   MODE=refetch           force a LIVE re-fetch, ignoring any staged CSV (default: staged wins)
 *   RUN_MINUTES=140        budget; prints the marker when entries remain
 *   COSMOS_CONNECTION_STRING   required
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
//
// `LIB_HOME` is the directory the helper actually lives in, not an assumption
// that it sits beside this file. #1828 wrote `path.join(__dirname, "lib",
// "runner-budget.cjs")`, which is right for the committed driver and wrong
// for every COPY of it: this module's own mutation pins
// (tests/ingestUniverseDriver*.test.ts and
// tests/sccPartialIsTerminalAndSiblingLadders.test.ts) write a MUTATED copy
// of this file to a temp directory and require it, which is how they prove
// that emptying a declaration changes BEHAVIOUR rather than merely changing
// source text. Under `__dirname` each copy looked for
// `<tmp>/lib/runner-budget.cjs`, found nothing, and threw at require time --
// seven pins red on a path unrelated to anything they pin.
//
// Order: this file's own directory (the committed driver, and the only case
// that runs in prod), then the repo's scripts/ from the working directory (a
// relocated copy, which is only ever a test). When neither has the helper the
// require throws as loudly as it did before, which is correct for a genuinely
// missing one.
const LIB_HOME = [
  __dirname,
  path.join(process.cwd(), "scripts"),
  path.join(process.cwd(), "backend", "scripts"),
].find((d) => fs.existsSync(path.join(d, "lib", "runner-budget.cjs"))) || __dirname;
const { finishLane } = require(path.join(LIB_HOME, "lib", "runner-budget.cjs"));

const HERE = __dirname;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const RECHECK = String(process.env.SCOPE || "").toLowerCase() === "recheck";
/**
 * CF-RECHECK-IS-NOT-REFETCH (2026-09-04).
 *
 * #1737 gave SCOPE=recheck two jobs at once, and they pull opposite ways:
 *
 *   1. re-attempt an entry that already carries a TERMINAL verdict (the queue
 *      filter below skips ingested/unreachable/empty unless RECHECK), and
 *   2. force a live re-fetch, bypassing a gate-clean staged CSV.
 *
 * The 1991 Topps Traded Tiffany entry is where the collision bites. A pre-#1737
 * run verdicted it `ingested` after re-fetching bcp and minting a 396-row
 * cross-join under `topps-traded`. Re-attempting it now needs meaning (1) --
 * and meaning (1) is only reachable through the switch that also arms meaning
 * (2), so the only way to re-run the entry is to re-run the exact mistake. The
 * staged CSV that a human resolved is thrown away by the very dispatch meant to
 * land it.
 *
 * So the two meanings are SEPARATE SIGNALS:
 *
 *   SCOPE=recheck   re-attempt verdicted entries. The staged file STILL WINS.
 *   MODE=refetch    force the live fetch. This is the ONLY thing that bypasses
 *                   a staged file.
 *
 * They compose: recheck+refetch is "go and look again at an entry we already
 * verdicted", which is what a stale staged file needs and is exactly what the
 * old single switch did. Recheck alone is now the safe half.
 *
 * WHY `MODE` AND NOT A NEW INPUT. backfill-runner.yml already exports
 * `MODE: ${{ inputs.mode }}` unconditionally in the "Run backfill" step's env
 * block, so `mode=refetch` reaches this driver with NO workflow change. The
 * existing values of that input are per-script tokens (census, apply-improve,
 * product, ...) and none of them belong to this script, so `refetch` cannot
 * collide: any OTHER value of MODE here is simply not a refetch.
 */
const REFETCH = String(process.env.MODE || "").toLowerCase() === "refetch";
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(HERE, "..", "data", "ingest-universe.json");
const WORKDIR = process.env.WORKDIR || path.join(os.tmpdir(), "hiq-universe");
const CONTROL_CONTAINER = process.env.CONTROL_CONTAINER || "crawl_state";
/** How many CONSECUTIVE failed/unreachable entries mean the lane is down rather
 *  than the entries being bad. Consecutive, never cumulative -- see the
 *  tripwire in the loop. Tunable so a probe can lower it; never 0 or 1, which
 *  would restore the exact one-entry-kills-the-lane behaviour this replaced. */
const SYSTEMIC_FAILURE_STREAK = Math.max(2, Number(process.env.SYSTEMIC_FAILURE_STREAK || 3));

/**
 * CF-A-CORRECT-REFUSAL-IS-NOT-A-LANE-FAILURE (2026-09-04).
 *
 * The statuses that mean "we asked, and the source answered that it has nothing
 * here". They are TERMINAL verdicts about the entry and they are deliberately
 * NOT evidence about the lane's health, so the systemic tripwire skips them --
 * a lane whose next thirty sets the source genuinely does not card is a WORKING
 * lane, and aborting it strands the entries behind them (run 33845979897: XY2,
 * XY3, XY4 empty at tcgdex, 49 entries never attempted).
 *
 * `failed` still means OUR pipe broke and `unreachable` still means the host
 * would not answer; both still count toward the streak.
 */
const EMPTY_STATUS = "empty";
/** Statuses that advance the systemic-failure streak. `empty` is excluded by
 *  construction: it is the source answering, not the lane refusing. */
const STREAK_STATUSES = new Set(["failed", "unreachable"]);

/**
 * CF-PARTIAL-IS-TERMINAL-BUT-RECHECKABLE (2026-09-04).
 *
 * MEASURED, run 33884656387 (sportscardchecklist, pending only, APPLY): the
 * lane holds 136 `partial` control docs, and because `partial` was not terminal
 * every pending-only pass re-walked all 136 before reaching a single entry that
 * has never been attempted. That slice created 24 rows out of a 140-minute
 * budget. The budget did not run out of work -- it spent itself re-ingesting
 * products the catalog already holds.
 *
 * `partial` is a VERDICT, not a queue position. It says "we fetched this page,
 * parsed it, staged it, ingested it and read the catalog back, and what landed
 * is less than a whole product". That is a finished attempt with a recorded
 * answer, exactly like `ingested` and `empty`, and re-attempting it is only
 * worth a request when something has CHANGED -- a parser fix, a new rule, the
 * source growing the missing rung. Deciding that is the operator's job, and
 * SCOPE=recheck is how the operator says it.
 *
 * So `partial` joins the terminal set and keeps its recheck door, on the same
 * terms `empty` already had: pending-only passes skip it, SCOPE=recheck
 * re-attempts it. Nothing is closed and nothing is forgotten -- the control doc
 * still names the gap, and `remaining in lane` still counts it as open work.
 * What changes is that a pending-only slice now spends its budget on entries
 * with NO verdict at all, which on this lane is 5,644 of 5,857.
 *
 * WHY NOT JUST FIX THE ORDERING. Ordering decides which of the eligible entries
 * run first; it cannot make a re-attempt free. A partial entry costs the same
 * fetch, parse, stage, ingest and read-back as a new one, and on a lane whose
 * partials are mostly CORRECT (see the base-only rule below) that cost buys
 * nothing at all. The queue filter is where the decision belongs.
 */
/**
 * CF-AN-ENTRY-THAT-LANDED-ROWS-IS-NOT-A-FAILURE (2026-09-06, run 33997480307).
 *
 * Twelve entries of that run each landed thousands of rows -- their own lines
 * say so, "under source checklistcenter-2026-09-05: 5,636 rows" -- and every
 * one was counted `failed`, because a shortfall in the staged-identity diff was
 * filed under the same word as a severed pipe. `failed` is the bucket for an
 * entry that tried to land and could not; an entry that landed 5,636 rows and
 * is missing 176 rungs is a DIFFERENT finding and needs its own word, or the
 * banner cannot tell an operator which of the two happened.
 *
 * `short-ingest` is that word. It is TERMINAL -- the rows are in the catalog
 * and re-running the entry re-ingests what is already there -- it reconciles in
 * its own named bucket, and it never advances the systemic streak, which may
 * conclude only that the host is down. Reaching it proves the opposite.
 */
const SHORT_STATUS = "short-ingest";
/**
 * CF-A-TOTAL-REFUSAL-IS-NOT-A-GREEN-INGEST (2026-09-06, run 34038740849).
 *
 * The SCC baseball 1970-1999 walk logged eight consecutive entries as
 *
 *   FAILED — green ingest, 0 rows landed
 *
 * and the child's own banner, printed directly above each one, had already
 * said what happened:
 *
 *   [3] 1998 SP Authentic Sheer Dominance   csv rows read 42, written 0, subset collisions REFUSED 42
 *   [4] 1998 ... Sheer Dominance Titanium   csv rows read 42, written 0, subset collisions REFUSED 42
 *   [6] 1999 ... Home Run Chronicles        csv rows read 70, written 0, subset collisions REFUSED 70
 *
 * Every staged row was REFUSED — deliberately, by the subset-collision guard
 * (#1741): the stored baseballcardpedia rows at those rungs carry subsetName
 * "Inserts", the SCC insert page states no subset, and blank is unknown and is
 * never invented. The refusal is CORRECT. What was wrong is the sentence the
 * driver wrote about it.
 *
 * "green ingest, 0 rows landed" asserts two things that are both false here:
 * that the ingest was GREEN (it refused every row and said so), and that the
 * cause is unknown and needs an investigation (the child named it, with a
 * count). It sent an operator looking for a broken pipe or a mis-derived
 * setKey — the two causes that sentence has always meant (#1738, #1739) —
 * when neither was involved and nothing was lost.
 *
 * So a child that read N rows, wrote 0, and refused N is its OWN verdict:
 * `refused`, carrying the child's count and the reason. It is TERMINAL — the
 * guard will refuse identically on every future pass, so re-attempting it
 * forever burns budget to reproduce a decision already made — and it is
 * streak-NEUTRAL, because reaching it required fetching, parsing, staging and
 * ingesting the page, every one of which proves the lane is UP. That is the
 * #1855 rule applied to the refusal class: a verdict, never a `failed`.
 *
 * It does NOT swallow real failures. The branch fires only when the child's
 * own banner accounts for EVERY row it read as refused; a child that wrote
 * nothing and refused nothing is still the unexplained `failed` it always was.
 */
const REFUSED_STATUS = "refused";
const TERMINAL_STATUSES = new Set(["ingested", "unreachable", EMPTY_STATUS, "partial", SHORT_STATUS, REFUSED_STATUS]);

/**
 * The systemic tripwire's whole arithmetic, in one exported place so a test can
 * reach it. It was inline in the run loop, which meant the only way to pin it
 * was to restate it in the test -- and a restated rule pins nothing, because
 * the copy in the test keeps passing while the real one regresses.
 *
 * The streak may conclude exactly one thing: THE HOST IS DOWN. So:
 *
 *   laneProvenHealthy  resets. A verdict we could only reach by fetching and
 *      parsing the page successfully -- a cleanliness-gate CONTENT refusal. It
 *      stays `failed` because a cartesian staging is a real defect, but it is
 *      positive evidence the lane is UP. Run 33857627732 aborted a healthy
 *      lane because two of these counted as a down host.
 *      NOT every gate refusal: "staged file unreadable" means acquisition
 *      delivered no file at all, which is a broken pipe and must still trip
 *      the tripwire. gateStagedEntry draws that line with contentRefusal.
 *   empty              neither advances nor resets. The source answering "I
 *      have nothing for this set" is no evidence either way, so a genuine
 *      outage interrupted by an empty set still trips on its own run.
 *   failed/unreachable advance.
 *   anything else      resets.
 */
function streakAfter(streak, verdict) {
  if (verdict?.laneProvenHealthy) return 0;
  if (STREAK_STATUSES.has(verdict?.status)) return streak + 1;
  if (verdict?.status !== EMPTY_STATUS) return 0;
  return streak;
}

const f = (n) => Number(n).toLocaleString();
// CF-AN-UNANSWERABLE-COUNT-SAYS-SO. `f(null)` is "0", and a count we could not
// take must never print as a measured zero -- that is the conflation the
// acquire lane's Gate 1 was rewritten for (0 rows created vs 3,810 present).
const fOrUnknown = (n) => (n === null || n === undefined ? "not measured" : f(n));
const left = () => RUN_MS - (Date.now() - STARTED);

/**
 * The lane vocabulary. `sources` is the operator's word; `lane` is the
 * manifest's. They differ in exactly one place -- the runner input has always
 * said `insider` and the manifest says `checklistinsider` -- so the alias is
 * written down rather than left for a dispatch to discover as an empty run.
 *
 * tcdb is accepted and then REFUSED with a reason, deliberately. D37 measured
 * that scrape-tcdb.cjs extracts 0 rows and exits 0 on a block, and that TCDB
 * has no enumerable index at all. Silently omitting it from this map would make
 * `sources=tcdb` an unknown-lane error that reads like a typo; naming it here
 * makes the refusal say why.
 */
const LANE_ALIASES = {
  hobbymonitor: "hobbymonitor",
  insider: "checklistinsider",
  checklistinsider: "checklistinsider",
  bcp: "bcp",
  beckett: "beckett",
  clc: "clc",
  tcgdexja: "tcgdexja",
  // The vintage lane (2026-09-04). Covers the seven football/basketball/hockey
  // cells no other source reaches; `scc` is the short form an operator types.
  sportscardchecklist: "sportscardchecklist",
  scc: "sportscardchecklist",
  tcdb: "tcdb",
};

/**
 * CF-THE-LANE-NAME-IS-NOT-THE-SOURCE-NAME (2026-09-04).
 *
 * The ingest child stamps `source` on every row it writes, and
 * catalogAuthorityOf reads that string to decide whether the row may
 * adjudicate. The driver was building it from its OWN lane key --
 * `${lane}-${date}` -- and two of the six lane keys are not source names the
 * authority vocabulary knows:
 *
 *   hobbymonitor-2026-09-04       checklist   ok
 *   checklistinsider-2026-09-04   checklist   ok
 *   beckett-2026-09-04            checklist   ok
 *   tcgdexja-2026-09-04           checklist   ok
 *   bcp-2026-09-04                UNKNOWN  <- the CHECKLIST regex spells it
 *   clc-2026-09-04                UNKNOWN     `cardpedia`/`bccp`, never `bcp`
 *
 * The child refuses an unknown source ON PURPOSE -- rows written under it rank
 * BELOW the derived rows the ingest exists to correct -- so it printed FATAL
 * and exited 2. Every bcp and clc entry the driver has ever attempted failed
 * at that line, which is what run 33839532087 was actually reporting.
 *
 * The names below are not new: ingest-checklists-end-to-end.cjs, the sibling
 * wrapper over the same staged directories, already ingests bcp as
 * `baseballcardpedia-ladders-<stamp>` and clc as `checklistcenter-<stamp>`.
 * The driver invented a parallel vocabulary for the same rows. Using the
 * wrapper's names also keeps `isBcpFamily` true for the bcp rows, so D29/R2's
 * product-filing rule keeps applying to them -- a row stamped `bcp-` would
 * have escaped that rule as well as the authority one.
 *
 * The lane keys stay what they are; only the stamped provenance is mapped.
 */
const LANE_SOURCE = {
  hobbymonitor: "hobbymonitor",
  checklistinsider: "checklistinsider",
  bcp: "baseballcardpedia-ladders",
  beckett: "beckett-checklist",
  clc: "checklistcenter",
  tcgdexja: "tcgdex-ja",
  // #1710's vintage lane. Its own name already classifies as checklist, so
  // this entry is the declaration rather than a translation -- but it is still
  // REQUIRED, because a lane absent from this map now refuses up front instead
  // of failing one fetch at a time. That is the point: adding a lane is a
  // decision about provenance, and the map is where the decision is recorded.
  sportscardchecklist: "sportscardchecklist",
};

/** Per-entry minutes, measured from D37's own acquisition timings. Used to size
 *  N against the budget so a run stops on its own clock and prints the marker,
 *  rather than being SIGKILLed at the step ceiling having printed nothing. */
const LANE_MINUTES = {
  hobbymonitor: 1.2,
  checklistinsider: 2.0,
  bcp: 1.0,
  beckett: 1.5,
  clc: 1.2,
  tcgdexja: 0.5,
  // 0.5-2 MB per set page plus the >=2s politeness delay this source is
  // crawled under. Measured on the three sampled sets, not assumed.
  sportscardchecklist: 0.6,
};

// ── the canonical CSV ────────────────────────────────────────────────────────
const CANONICAL_HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

/** Split one CSV line on commas outside quotes. The staged files are written by
 *  the lane scripts in the canonical format, but a player name legitimately
 *  carries a comma ("Griffey Jr., Ken"), so a naive split mis-columns the row
 *  and a gate reading those columns would judge the wrong field. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const foldName = (v) => String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The rung vocabulary, copied from ingest-checklist-csv-to-catalog.cjs so the
 *  gate and the ingest agree on what a parallel name looks like. */
const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte"]);

const isPersonName = (v) => {
  const t = foldName(v).split(" ").filter(Boolean);
  return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]);
};

/** The same ceilings the ingest's exploded-file gate uses. No real checklist
 *  CATEGORY carries more than ~150 rungs or ~2,000 card numbers; the 11.49M-row
 *  spine did, because it cross-joined cards against players. */
const EXPLODED_PAR_MAX = Number(process.env.EXPLODED_PAR_MAX || 150);
const EXPLODED_NUM_MAX = Number(process.env.EXPLODED_NUM_MAX || 2000);

/** The floor under the cross-join signature. Below two rungs, or with no more
 *  cards than rungs, "every card carries every rung" says nothing: a one-rung
 *  set is dense by definition (the Tiffany shape), and a handful of cards
 *  against a handful of rungs is arithmetic noise, not the 11.49M-row spine. */
const CARTESIAN_MIN_RUNGS = 2;
const CARTESIAN_MIN_CARDS = 4;

/**
 * Does this CSV's sidecar manifest attest that its parallel column is a real
 * ladder read off a checklist?
 *
 * Every converter that parses a published ladder stamps
 * `parallelColumnAuthoritative: true` beside its CSV -- the same flag
 * ingest-scraped-checklist.cjs reads to take the rung from the column instead
 * of re-deriving one from the category slug. A file carrying it is claiming
 * its ladder is the checklist's own and COMPLETE, which is exactly the shape
 * that is legitimately dense.
 *
 * Absence is the safe answer: a missing, unreadable or unflagged manifest
 * means the file is unattested and gets the strict rule. This never throws --
 * a gate that crashes on a malformed sidecar refuses nothing.
 */
function ladderIsAttested(csvPath) {
  try {
    const m = JSON.parse(fs.readFileSync(String(csvPath).replace(/\.csv$/i, ".manifest.json"), "utf8"));
    return m?.parallelColumnAuthoritative === true;
  } catch { return false; }
}

/**
 * CF-A-PRODUCT-WITH-NO-PRINT-RUNS-IS-NOT-PARTIAL (2026-09-04).
 *
 * Backfill Runner 33847867665 (tcgdexja, 2021-2025, apply) recorded 46 of 48
 * entries `partial`, and 30 of those with the reason "ladder present but zero
 * print runs". Not one of them is incomplete. Japanese Pokemon has NO numbered
 * parallels: the rarity ladder (Art Rare, Special Art Rare, Ultra Rare,
 * Character Rare) IS the parallel axis, and tcgdex serves no print run for any
 * JA set. `scrape-tcgdex-ja-modern.cjs` says so in its own header -- "printRun
 * stays EMPTY ... this lane will not invent one: blank means unknown, never
 * Base" -- and its own summary prints "printRun 0 written" on every run.
 *
 * So `withPrintRun === 0` is the EXPECTED, CORRECT shape for this lane, and a
 * verdict of `partial` on it is a false gap: it tells the next pass to
 * re-acquire a set that is already complete, forever, because no re-scrape can
 * ever produce a print run the source does not have.
 *
 * The rule is a property of the PRODUCT, not of the file, so it is declared per
 * lane BY NAME rather than inferred from a file that happens to be empty in
 * that column -- inferring it would excuse a Topps Chrome scrape that simply
 * lost the column. A lane absent from this set keeps the print-run expectation.
 */
const LANES_WITHOUT_PRINT_RUNS = new Set(["tcgdexja"]);

/**
 * CF-A-PROMO-SET-HAS-NO-BASE-CARDS (2026-09-04).
 *
 * The same run's only two failures were both promo products:
 *
 *   [32/48] SV-P  REFUSED -- zero base cards (288 rows, all carry a parallel)
 *   [47/48] M-P   REFUSED -- zero base cards (132 rows, all carry a parallel)
 *
 * Staged and read back from the source: all 132 M-P rows carry `parallel=Promo`,
 * which is the source's own and entirely correct rarity for every card in the
 * set. A promo product IS its promos -- there is no base print underneath them
 * to attach to, the way a Refractor scope attaches to its page's base set. The
 * zero-base rule was written for a cross-join that joined rungs onto a subset
 * never parsed; this is the opposite shape: a complete checklist of a set that
 * has exactly one rung by design.
 *
 * A lane declared here is one whose products may legitimately be rung-only, and
 * the entry is admitted only when EVERY row carries the SAME SINGLE rung -- a
 * one-rung file being the honest shape of "these are all promos", while a
 * multi-rung file with no base cards is still the cross-join the rule catches.
 */
const LANES_WITH_BASELESS_PRODUCTS = new Set(["tcgdexja", "sportscardchecklist"]);

/**
 * CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT (2026-09-04, run 33875264485).
 *
 * sportscardchecklist joins the baseless-product lanes, but for a DIFFERENT
 * shape than tcgdexja's, and the difference is what the manifest flag carries.
 *
 * A tcgdexja promo product is baseless because the PRODUCT has one rung and no
 * base print underneath it. An SCC "...Refractors" page is baseless because the
 * page is ONE RUNG OF A PARENT that lives at its own URL:
 *
 *   /set-151054/...-aptitude-for-altitude-basketball-...            <- the base
 *   /set-151055/...-aptitude-for-altitude-refractors-basketball-... <- this rung
 *
 * The base cards exist; they are the sibling page's. That is the same claim
 * gateStagedEntry already accepts inside one entry when a page stages several
 * scope files -- "the ladder attaches to base cards in a sibling" -- except the
 * sibling here is a separate ENTRY, so no file of this entry can carry it.
 *
 * ADMISSION IS NOT BY LANE NAME ALONE. `parallelOfParent` is written by the
 * fetcher only when the slug named a rung AND a known parent brand was found in
 * that same slug, and the row that lands carries the parent's setKey. So the
 * flag is the fetcher's attestation "these rows belong to <parent>, as <rung>",
 * and admitting on it admits exactly the pages that have somewhere to land.
 * Without the flag the zero-base refusal stands -- a multi-rung baseless file is
 * still the cross-join the rule was written for, on every lane.
 */
function manifestOf(csvPath) {
  try {
    const p = String(csvPath).replace(/\.csv$/, "") + ".manifest.json";
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch { return null; }
}

/** True when EVERY staged file of the entry attests it is one rung of a parent
 *  product. Read from the manifests the fetcher wrote, never inferred from a
 *  file that merely happens to have no base rows -- inferring it would excuse
 *  the cross-join this gate exists to catch. */
function allFilesAreParallelOfParent(paths) {
  if (!paths.length) return false;
  return paths.every((p) => {
    const m = manifestOf(p);
    return Boolean(m && m.parallelOfParent === true && m.setKey && m.parallelName);
  });
}

/**
 * CF-A-VINTAGE-BASE-SET-IS-NOT-PARTIAL (2026-09-04).
 *
 * The SCC-CANARY2 apply (sportscardchecklist, scope=recheck, three titles)
 * landed three complete vintage products and recorded all three `partial`:
 *
 *   1979-80 O-Pee-Chee Hockey      49 rows created, 1,403 in catalog
 *   1972 Topps Football           351 rows created, 7,309 in catalog
 *   1957 Topps Basketball          80 rows created, 4,770 in catalog
 *
 * every one of them for the reason "base-only, no parallel ladder". Not one of
 * them is incomplete. A 1957, 1972 or 1979 base set HAS no parallel ladder --
 * the parallel as a product axis does not exist before the chrome/refractor era
 * -- so `ladder === 0` is the checklist telling the truth about the product,
 * exactly as `withPrintRun === 0` is on tcgdexja. Recording `partial` tells the
 * next pass to re-acquire a set that is already complete, forever, because no
 * re-scrape can produce a ladder the product never had.
 *
 * WHY AN ERA RULE AND NOT A LANE RULE. LANES_WITHOUT_PRINT_RUNS is declared by
 * lane BY NAME because "Japanese Pokemon has no print runs" is a property of
 * everything that lane serves. Vintage is NOT that shape: sportscardchecklist
 * spans 1933-2009, and its 2000s cells (1990-2009) sit squarely in the era when
 * parallels DO exist. Declaring the whole lane would excuse a 2003 Topps Chrome
 * scrape that lost its refractor ladder -- the same defect
 * LANES_WITHOUT_PRINT_RUNS is careful not to excuse for Topps Chrome.
 *
 * So the axis is the PRODUCT ERA, and the lane opts in to being judged by it.
 * A lane not named here keeps the flat expectation at every year.
 *
 * THE BOUNDARY IS 1990, and it is the boundary the repo already uses: valueRank
 * scores era in the same steps off the 2026-09-03 autograph-yield probe, whose
 * measurement was 0% pre-1990. The parallel era begins with the 1993 Topps
 * Finest refractor; 1990 is the conservative side of that line, so a product
 * from 1990-1992 that genuinely has no ladder is still reported PARTIAL rather
 * than quietly closed.
 *
 * This narrows ONLY the ladder expectation, and only for pre-1990 entries on a
 * declared lane. A vintage entry that lands zero rows, or lands short of what
 * was staged, is still FAILED -- the era says a product has no ladder, never
 * that our pipe may lose rows.
 */
const LANES_WITH_VINTAGE_ERA_PRODUCTS = new Set(["sportscardchecklist"]);

/** The first year a parallel ladder is an expected product axis. Below it, on a
 *  declared lane, `ladder === 0` is the product's shape, not a gap. */
const PARALLEL_ERA_FIRST_YEAR = 1990;

/** Lanes whose SOURCE publishes each parallel rung and each insert as its own
 *  set page. On these, a parent page's ladder arrives on sibling ENTRIES, so
 *  `ladder === 0` on the parent is the page's shape rather than a gap -- but
 *  only when the manifest actually declares those siblings. See
 *  ladderOnSiblingPages. A lane absent here keeps the flat expectation. */
const LANES_WITH_SIBLING_PARALLEL_PAGES = new Set(["sportscardchecklist"]);

/**
 * Is a missing parallel ladder the honest shape of THIS entry's product?
 *
 * True only when the lane opts into era judgement AND the entry's year is
 * genuinely pre-1990. A year the manifest never carried is NOT vintage: an
 * absent year must not silently buy the exemption, so it falls through to the
 * flat expectation and the entry reports PARTIAL as before.
 */
function ladderlessByEra(lane, entry) {
  if (!LANES_WITH_VINTAGE_ERA_PRODUCTS.has(lane)) return false;
  const y = Number(entry && entry.year);
  if (!Number.isFinite(y) || y <= 0) return false;
  return y < PARALLEL_ERA_FIRST_YEAR;
}

/**
 * CF-A-LADDER-ON-SIBLING-PAGES-IS-NOT-A-GAP (2026-09-04).
 *
 * The era rule above closed the VINTAGE half of the false `partial`. This is
 * the modern half, and it is a different claim about a different source shape.
 *
 * MEASURED, control docs for this lane: 56 entries sit at `partial` for
 * "base-only, no parallel ladder", and only 3 of them are vintage. The rest are
 * 1996-2009 basketball parent pages -- 2000-01 Topps Chrome Basketball,
 * 2006-07 Topps Chrome Basketball, and so on. Every one of them landed a clean,
 * complete base set and reported a gap.
 *
 * They are not gaps, because SPORTSCARDCHECKLIST DOES NOT PUT THE LADDER ON THE
 * PARENT PAGE. It gives each rung its own set page at its own URL, and the
 * manifest says so in its own rows -- 2006-07 Topps Chrome Basketball has 24
 * siblings sharing its (sport, year, setKey), among them:
 *
 *   2006-07 Topps Chrome Refractors Basketball
 *   2006-07 Topps Chrome Autographs Refractors Gold Basketball
 *   2006-07 Topps Chrome 1996 97 Variations Superfractors Basketball
 *
 * So a parent page that stages base cards and no ladder is that page scraped
 * CORRECTLY and completely. The ladder is real, it is expected, and it arrives
 * on the sibling ENTRIES -- which is the same claim `allFilesAreParallelOfParent`
 * already makes one level down, where a rung page has no base cards because the
 * base cards are the PARENT's. The two rules are the same fact read from the two
 * ends: neither page is the whole product, and neither page is defective for it.
 *
 * THE SIBLINGS MUST BE DECLARED, NEVER ASSUMED. The exemption is granted only
 * when the manifest actually carries at least one other entry at this
 * (sport, year, setKey) whose `derivedSetKey` names a rung or insert of it. A
 * product whose ladder genuinely lives on its own page keeps the flat
 * expectation and still reports PARTIAL -- which is the defect the base-only
 * rule was written for and must keep catching. This is the same discipline
 * `ladderIsAttested` and `parallelOfParent` use: read the attestation, never
 * infer it from a file that merely happens to be empty in that column.
 *
 * IT NARROWS ONLY THE LADDER EXPECTATION. An entry that lands zero rows is
 * still FAILED, and one that lands short of what it staged is still FAILED. The
 * siblings say a product's ladder is published elsewhere; they never say our
 * pipe may lose rows.
 */
function ladderOnSiblingPages(lane, entry, manifestEntries) {
  if (!LANES_WITH_SIBLING_PARALLEL_PAGES.has(lane)) return false;
  if (!entry || !Array.isArray(manifestEntries)) return false;
  // A page that is ITSELF a rung or insert names one in `derivedSetKey`. Only a
  // PARENT page can claim its ladder is on siblings; a rung page reporting
  // base-only is a different shape and keeps the flat expectation.
  if (entry.derivedSetKey) return false;
  const sport = String(entry.sport || "");
  const year = Number(entry.year);
  const setKey = String(entry.setKey || "");
  if (!sport || !setKey || !Number.isFinite(year)) return false;
  return manifestEntries.some((o) =>
    o && o.id !== entry.id
    && (o.lane || o.source) === lane
    && String(o.sport || "") === sport
    && Number(o.year) === year
    && String(o.setKey || "") === setKey
    // The sibling must NAME a rung or insert of this product. An entry sharing
    // the key with no derived name of its own is another parent page, not a
    // ladder page, and cannot attest that this product's ladder exists.
    && Boolean(o.derivedSetKey)
    && String(o.derivedSetKey) !== setKey);
}

/**
 * THE PER-ENTRY CLEANLINESS GATE.
 *
 * The ingest's own guards are per-category and per-row: they drop the bad part
 * and land the rest, which is correct for a sweep across 400 files. An entry in
 * this driver is ONE set whose status we are about to record, so a file that
 * needs those guards to fire is not a clean acquisition -- it is a scrape that
 * went wrong, and recording it `ingested` would close a gap the catalog still
 * has. This refuses the whole entry and says which rule it broke.
 *
 * Returns { ok, reason, stats }.
 */
/**
 * The identity of a staged row, in the terms the catalog keys on:
 * (cardNumber, parallel, isAuto, printRun). Year and setKey are the PRODUCT's
 * and are the same for every row of an entry, so they are the query, not the
 * tuple.
 *
 * A blank parallel and the literal "Base" are ONE identity here, for the same
 * reason gateStagedCsv counts them as one kind of card: the child writes the
 * blank through `computeHobbyIqCardId({ parallel: r.parallel || "Base" })`, so
 * both spellings collapse to the same slug in the catalog. Comparing them as
 * different identities would report every base card missing.
 */
function stagedIdentity(r) {
  const num = String(r.cardNumber ?? "").trim().toUpperCase();
  const par = (!r.parallel || /^base(?:\s+set)?$/i.test(String(r.parallel).trim()))
    ? "base"
    : String(r.parallel).trim().toLowerCase();
  const auto = String(r.isAuto) === "true" ? "1" : "0";
  const run = r.printRun && Number(r.printRun) > 0 ? String(Number(r.printRun)) : "";
  return `${num}|${par}|${auto}|${run}`;
}

function gateStagedCsv(csvPath) {
  const stats = { rows: 0, base: 0, ladder: 0, withPrintRun: 0, categories: 0, playersAsParallel: 0, cardLineParallel: 0, rungNames: [] };
  let text;
  try { text = fs.readFileSync(csvPath, "utf8"); }
  catch (e) { return { ok: false, reason: `staged file unreadable: ${e.code || e.message}`, stats }; }

  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  if (!lines.length) return { ok: false, reason: "staged file is empty", stats };

  // THE ONE CANONICAL CSV. A file whose header is not the canonical format
  // means the converter wrote a different shape, and every column index the
  // gate and the ingest read would be off by one silently.
  const header = lines[0].replace(/^﻿/, "").trim();
  const headerCols = splitCsv(header).slice(0, 6).join(",");
  if (headerCols !== CANONICAL_HEADER) {
    return { ok: false, reason: `not the canonical CSV header (got "${header.slice(0, 80)}")`, stats };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [category, cardNumber, parallel, isAuto, printRun, player] = splitCsv(lines[i]);
    if (!cardNumber && !player) continue;
    stats.rows++;
    rows.push({ category: category || "base", cardNumber, parallel: parallel || "", isAuto, printRun: printRun || "", player: player || "" });
  }
  if (!stats.rows) return { ok: false, reason: "0 data rows parsed", stats };

  // CF-THE-LITERAL-BASE-IS-A-BASE-CARD (2026-09-04).
  //
  // "base" was read as "the parallel column is EMPTY", but the BCP scraper
  // states the base set explicitly -- its own header says so: "Base rows are
  // emitted with the literal 'Base' -- these ARE the checklist's base set,
  // which is the one place 'Base' is a statement of fact rather than a default
  // for a blank (see #1324)". So every row of a page whose base set is spelled
  // out counted as ladder, stats.base fell to 0, and the zero-base rule
  // refused the file.
  //
  // Measured on 1990_Bowman, run 33845791358 entry [7/20]: 1,058 staged rows,
  // 529 of them `parallel=Base` and 529 `parallel=Tiffany`, REFUSED as "zero
  // base cards (1,058 rows, all carry a parallel)". A complete, correct
  // two-rung checklist thrown away -- and, being the third verdict in a row,
  // it was the entry that tripped the systemic abort and took the lane down.
  //
  // This does NOT weaken #1324. A BLANK parallel still means unknown and still
  // counts as a base card, exactly as before; what changes is that the literal
  // word, which is an ATTESTATION that the row is the base card, is no longer
  // mistaken for a rung. The two spellings now agree, and a page that says
  // "Base" out loud is no longer punished for saying it.
  const isBaseParallel = (p) => !p || /^base(?:\s+set)?$/i.test(String(p).trim());
  // The DISTINCT rung names are kept, not merely a count of ladder rows: a
  // promo product is ONE rung over every card and a cross-join is MANY rungs
  // over every card, and only the distinct list tells those two apart.
  const rungSet = new Set();
  for (const r of rows) {
    if (isBaseParallel(r.parallel)) stats.base++;
    else { stats.ladder++; rungSet.add(String(r.parallel).trim()); if (r.printRun) stats.withPrintRun++; }
  }
  stats.rungNames = Array.from(rungSet);
  // CF-COMPARE-IDENTITIES-NOT-COUNTS: the identity tuple of every staged row,
  // so the post-ingest check can ask "which of these is NOT in the catalog"
  // rather than "are there as many rows as I staged". Two scope files that
  // stage the same card under two spellings of the product are two ROWS and
  // ONE identity, and only the tuple can tell that from a lost row.
  stats.identities = rows.map((r) => stagedIdentity(r));

  // ZERO BASE CARDS. A checklist with a parallel ladder but no base cards is a
  // ladder that has nothing to attach to -- the shape a cross-join leaves when
  // it joins rungs onto a subset that was never parsed. Note this is a floor on
  // BASE rows, not on the blank-parallel reading: a blank parallel means
  // unknown, never "Base", and those rows are still cards.
  //
  // The code is load-bearing: this is the ONE rule of the gate that a single
  // scope file may legitimately break, because a page's base set can live in a
  // sibling scope (see gateStagedEntry). Every other rule below is a defect in
  // the file itself and stays fatal per file.
  if (stats.base === 0) {
    return { ok: false, code: "zero-base", reason: `zero base cards (${f(stats.rows)} rows, all carry a parallel)`, stats };
  }

  // PLAYERS-AS-PARALLELS LEAKAGE. A parallel equal to a player name IN THIS
  // FILE is a roster line the scraper read as a rung. The file knows its own
  // players, so this needs no external vocabulary.
  const players = new Set(rows.map((r) => r.player).filter(isPersonName).map(foldName));
  for (const r of rows) if (r.parallel && players.has(foldName(r.parallel))) stats.playersAsParallel++;
  if (stats.playersAsParallel > 0) {
    return { ok: false, reason: `${f(stats.playersAsParallel)} rows whose parallel is a player name from this same file`, stats };
  }

  // A CARD LINE IS NOT A RUNG. "27 Mike Trout" in the parallel column is a
  // scraper joining a card line to a ladder.
  const CARD_LINE_PARALLEL = /^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+\p{L}/u;
  const NOT_A_NAME_AFTER_NUMBER = /^(?:in|of|to|and|the|for|per|on|at|by)\b/i;
  const FINISH_AFTER_NUMBER = /^(?:colou?r|tone|tool|of|piece|pc|patch|star|swatch|box|case|player|team|logo|letter|strand)\b/i;
  // CF-A-TICKET-IS-A-RUNG-NOT-A-CARD-LINE (2026-09-04).
  //
  // "<number> <word>" is the shape of a card line, but the number is only a
  // CARD number when the words before it are a set prefix. Panini Contenders
  // names its ladder after the game it commemorates -- "Week 18 Ticket",
  // "Round 1 Ticket", "Game 5 Ticket" -- and the leading token there is a
  // PERIOD word, not a prefix: the number counts weeks, not cards.
  //
  // The rule read all three as card lines and refused two whole products:
  // 2024 Panini Contenders Football (152 rows, every one "Week 18 Ticket") and
  // 2025/26 Contenders EuroLeague (300 rows across Round 1 / Round 2 / Game 5).
  // Both are real published rungs and the source prices them -- EuroLeague's
  // carry printRun 199, 149 and 5 in the page's own cardParallels[] -- so the
  // refusal was throwing away a correctly-read ladder, not catching a smear.
  //
  // Anchored on the PERIOD WORD, which is the part that distinguishes them: a
  // card line's number leads ("27 Caleb Williams"), while these are led by the
  // unit the number counts. That keeps the guard's teeth -- "27 Caleb Williams"
  // still has no period word and is still refused.
  const PERIOD_RUNG = /^(?:week|round|game|day|match(?:day)?|quarter|period|session|stage|leg)\s+\d{1,4}[a-z]?\b/i;
  for (const r of rows) {
    if (!r.parallel || !CARD_LINE_PARALLEL.test(r.parallel)) continue;
    if (PERIOD_RUNG.test(String(r.parallel).trim())) continue;
    const tail = r.parallel.replace(/^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+/, "");
    if (NOT_A_NAME_AFTER_NUMBER.test(tail) || FINISH_AFTER_NUMBER.test(tail)) continue;
    stats.cardLineParallel++;
  }
  if (stats.cardLineParallel > 0) {
    return { ok: false, reason: `${f(stats.cardLineParallel)} rows whose parallel is a card line ("<number> <name>")`, stats };
  }

  // CROSS-JOIN ARITHMETIC, per category -- the 11.49M-row graveyard.
  const ladderAttested = ladderIsAttested(csvPath);
  const byCat = new Map();
  for (const r of rows) {
    const c = String(r.category || "base");
    if (!byCat.has(c)) byCat.set(c, { pars: new Set(), nums: new Set(), rows: 0, ladderRows: 0 });
    const g = byCat.get(c);
    // A literal "Base" is a base card, not a rung -- the same reading
    // isBaseParallel applies above. Counting it as a rung turns 1990 Bowman's
    // 529 x {Base, Tiffany} into a 2-rung product and reads a correct
    // two-spelling checklist as a cartesian (CF-THE-LITERAL-BASE-IS-A-BASE-CARD).
    const isBase = isBaseParallel(r.parallel);
    g.pars.add(isBase ? "" : r.parallel); g.nums.add(r.cardNumber); g.rows++;
    if (!isBase) g.ladderRows++;
  }
  stats.categories = byCat.size;
  for (const [c, g] of byCat) {
    if (g.pars.size > EXPLODED_PAR_MAX) return { ok: false, reason: `category "${c}" carries ${f(g.pars.size)} distinct parallels (>${EXPLODED_PAR_MAX}) — cross-join`, stats };
    if (g.nums.size > EXPLODED_NUM_MAX) return { ok: false, reason: `category "${c}" carries ${f(g.nums.size)} distinct card numbers (>${EXPLODED_NUM_MAX}) — cross-join`, stats };
    // THE MULTIPLICATIVE SIGNATURE IS NOT ITSELF A DEFECT
    // (CF-A-PER-SUBSET-LADDER-IS-SUPPOSED-TO-MULTIPLY, 2026-09-03).
    //
    // `rows ≈ cards × rungs` is what a CORRECTLY read ladder looks like. Since
    // CF-HM-LADDER-INTO-ROWS the fetchers emit one row per (card, rung of that
    // card's OWN subset) — 2012/13 Panini Prizm's base is 300 cards × {blank,
    // Prizms, Prizms Green, Prizms Gold} = 1,200 rows, and that is the actual
    // checklist. This rule read that as a smear and refused every modern Panini
    // file the lane produced, which is why 2022 Donruss Optic Basketball has
    // 7,603 pool rows against 0 catalog rows.
    //
    // The 11.49M-row graveyard was cards × PLAYERS, not cards × rungs, and the
    // two are told apart by WHAT is in the parallel column — which the
    // players-as-parallels and card-line-as-rung guards above already decide,
    // per row, on this file's own roster. The ceilings above (EXPLODED_PAR_MAX
    // / EXPLODED_NUM_MAX) catch a ladder too WIDE to be one subset's rung list.
    // What is left for arithmetic is the gapless product itself.
    //
    // So the shape is refused when the rung list is MULTI-RUNG and perfectly
    // dense — every card carrying every rung, no card missing one — and the
    // file has nothing attesting that its parallel column is a real, complete
    // ladder. A real scraped ladder is ragged: short prints, rookie-only rungs
    // and per-card variations leave holes.
    //
    // CF-DENSITY-IS-THE-SIGNAL-NOT-SIZE (2026-09-04). #1694 fixed the right
    // defect the wrong way. Its predecessor refused every modern Panini file
    // because `rows ≈ cards × rungs` is what a correctly read per-subset ladder
    // looks like; the fix bolted `rungCount > 60 && nums > 200` onto the
    // density test, which admits those files — and unpins the guard at the low
    // end, where the 11.49M-row spine's own signature lives. A 60-card × 6-rung
    // cross-join is the same defect as a 3,000 × 60 one; the graveyard is not
    // defined by its size.
    //
    // What actually separates the two is PROVENANCE, not magnitude. A converter
    // that read a ladder off a checklist stamps `parallelColumnAuthoritative:
    // true` in the CSV's sidecar manifest — the same flag ingest-scraped-
    // checklist reads to take the rung from the column instead of re-deriving
    // it from the category slug. That flag is the file saying "this column is
    // the checklist's own ladder", and a complete ladder is EXPECTED to be
    // dense: a 132-card set × Tiffany is 132 rows with no holes, and so is
    // 2022 Panini Prizm's 300 × 56 base. Measured across all 102 staged CSVs in
    // this repo: 343 category groups are perfectly dense, and 342 of them carry
    // the flag — including every wide base ladder the size thresholds were
    // widened to admit (300x56, 314x45, 250x46). The one that does not is a
    // 50-card × 1-rung TCDB file, which the multi-rung floor below keeps safe.
    //
    // So an unattested file gets the size-free rule, and an attested one is
    // trusted for density but still bounded by EXPLODED_PAR_MAX /
    // EXPLODED_NUM_MAX above — the flag buys density, never unlimited width.
    //
    // Density is measured against the NON-BLANK rungs. A blank parallel is a
    // base row, one per card, and counting it as a rung drags a true cartesian
    // just under any threshold — a 300 x 80 product reads as 300 x 81 and
    // slips through at 98.8% of the wrong denominator.
    const rungCount = g.pars.size - (g.pars.has("") ? 1 : 0);
    const cartesian = rungCount > 0 && g.ladderRows >= rungCount * g.nums.size * 0.995;
    // ONE rung against N cards is a set with a single parallel — the Tiffany
    // shape — and is dense by definition; it carries no cross-join information
    // either way. The signature needs at least two rungs, and more cards than
    // rungs, to mean anything.
    const bigEnough = rungCount >= CARTESIAN_MIN_RUNGS && g.nums.size >= CARTESIAN_MIN_CARDS;
    if (cartesian && bigEnough && !ladderAttested) {
      return { ok: false, reason: `category "${c}" pairs every one of ${f(g.nums.size)} cards with every one of ${f(rungCount)} rungs (${f(g.ladderRows)} ladder rows, no gaps) — a cartesian product, not a ladder`, stats };
    }
  }

  return { ok: true, reason: null, stats };
}

/**
 * THE ENTRY-LEVEL GATE. One BCP page stages one CSV PER SCOPE, and the verdict
 * this driver records is about the PAGE, so the judgment has to be made over
 * all of them at once.
 *
 * Every rule of gateStagedCsv stays fatal per file -- a bad header, a
 * players-as-rungs leak or a cartesian category is a defect in that file no
 * sibling can excuse, and admitting the entry would land exactly the dirty
 * rows the per-entry gate exists to keep out.
 *
 * `zero-base` is the one exception, and it is not a weakening. "This ladder
 * has nothing to attach to" was always a claim about the PAGE; it only read as
 * a claim about a file back when a page was a file. 2015 Bowman Chrome's
 * Prospects Light Blue Refractors scope genuinely has no base cards of its
 * own, and it is not supposed to -- the base cards are the page's, in the bare
 * stem file, and the rung attaches to them. So the rule is asked of the entry:
 * refused only when NO staged file of the page carries a base card, which is
 * the cross-join shape the rule was written for and which the 11.49M-row
 * graveyard actually had.
 *
 * Stats are summed across the files, so `ladder`/`withPrintRun` -- which
 * decide `partial` vs `ingested` downstream -- describe the whole page.
 */
function gateStagedEntry(csvPaths, lane) {
  const paths = Array.isArray(csvPaths) ? csvPaths : [csvPaths];
  const total = { rows: 0, base: 0, ladder: 0, withPrintRun: 0, categories: 0, playersAsParallel: 0, cardLineParallel: 0, rungNames: [], identities: new Set() };
  // NOT a content refusal: acquisition delivered no file at all, which is the
  // shape a real lane failure takes. It must keep tripping the tripwire.
  if (!paths.length) return { ok: false, reason: "no staged CSV", stats: total, files: [], contentRefusal: false };

  const files = [];
  let zeroBase = null;
  for (const p of paths) {
    const g = gateStagedCsv(p);
    files.push({ file: path.basename(p), ok: g.ok, code: g.code ?? null, reason: g.reason, stats: g.stats });
    for (const k of Object.keys(total)) { if (k === "rungNames" || k === "identities") continue; total[k] += g.stats?.[k] ?? 0; }
    for (const n of g.stats?.rungNames ?? []) if (!total.rungNames.includes(n)) total.rungNames.push(n);
    // A SET, not a concatenation. The bcp scraper stages some pages twice --
    // `2000-finest-baseball.csv` AND `2000-topps-finest-baseball.csv`, the same
    // product under an un-normalized key and its alias -- so the same card
    // appears in both files. Summing rows double-counts it; unioning identities
    // does not, which is the whole reason the check is on tuples.
    for (const id of g.stats?.identities ?? []) total.identities.add(id);
    // A per-file defect other than zero-base condemns the entry immediately,
    // and it names the FILE -- "the gate refused" with no filename is
    // unactionable when a page stages five of them.
    if (!g.ok && g.code !== "zero-base") {
      // CONTENT REFUSAL vs BROKEN PIPE. Everything the gate judges past the
      // read is a verdict about a file the source actually served, and
      // reaching it proves the lane works. "staged file unreadable" is the one
      // refusal that means the opposite: acquisition delivered nothing, which
      // is exactly the shape a real lane failure takes. Only the former may
      // reset the systemic streak -- see streakAfter.
      const contentRefusal = !/staged file unreadable/.test(String(g.reason || ""));
      return { ok: false, reason: `${path.basename(p)}: ${g.reason}`, stats: total, files, contentRefusal };
    }
    if (!g.ok) zeroBase = zeroBase ?? g;
  }

  if (total.base === 0) {
    // CF-A-PROMO-SET-HAS-NO-BASE-CARDS. On a lane whose products may be
    // rung-only, a page whose every row carries the SAME SINGLE rung is a
    // complete promo checklist, not a ladder with nothing to attach to. Two
    // distinct rungs or more with no base card is still the cross-join shape
    // the rule was written for, and stays refused on every lane.
    const singleRung = total.rungNames.length === 1;
    // CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT. The second admissible shape: not
    // "this product has one rung and no base" (tcgdexja's promos) but "this
    // PAGE is one rung of a parent that has its own page", attested per file by
    // the fetcher's `parallelOfParent` and landed on the parent's setKey.
    // Still single-rung: a baseless file with two rungs is the cross-join.
    const parallelOfParent = singleRung && allFilesAreParallelOfParent(paths);
    if (!(LANES_WITH_BASELESS_PRODUCTS.has(lane) && singleRung && (lane !== "sportscardchecklist" || parallelOfParent))) {
      return {
        ok: false,
        reason: `zero base cards across all ${f(paths.length)} staged file(s) (${f(total.rows)} rows, all carry a parallel)`,
        // CF-A-ZERO-BASE-PAGE-PROVES-THE-LANE-IS-UP (2026-09-04, run
        // 33870669723). #1735 exempted CONTENT refusals from the systemic
        // streak, but it set `contentRefusal` on the per-file early return
        // ONLY. This return -- the zero-base verdict asked of the whole entry
        // -- left it undefined, so `laneProvenHealthy` was false and every
        // refusal advanced the streak exactly as before.
        //
        // The sportscardchecklist lane paid for it: entries 10, 12, 14, 16, 18,
        // 20 and 22 were all `REFUSED -- zero base cards` (the "...Refractors"
        // half of each 2000-01 Topps Chrome subset pair, which genuinely has no
        // base cards of its own), and 20-21-22 made a 3-streak that aborted the
        // lane with 176 of 198 entries unattempted.
        //
        // Reaching this verdict required fetching the page, parsing it and
        // staging a CSV whose every row we read. That is positive evidence the
        // HOST IS UP -- the only thing the streak is allowed to conclude. It
        // stays `failed` (a page whose ladder has nothing to attach to is a
        // real defect someone must look at), it simply no longer votes on the
        // lane's health.
        contentRefusal: true,
        stats: total, files,
      };
    }
  }
  return {
    ok: true, reason: null, stats: total, files,
    // A baseless single-rung product admitted by the lane exception, named so
    // the log can say WHY a zero-base page was allowed through.
    baselessSingleRung: total.base === 0 ? (total.rungNames[0] ?? null) : null,
    // Which of the two baseless shapes admitted it, so the log says WHY.
    parallelOfParent: total.base === 0 ? allFilesAreParallelOfParent(paths) : false,
    // THE SAME ATTESTATION, ASKED WITHOUT THE BASELESS PRECONDITION. Above it
    // answers "may this baseless page be admitted at all"; the print-run rule
    // needs "is this page a rung of a parent", which is true of a rung page
    // whether or not the source also listed a base card on it. Reading the
    // manifests once and exposing both keeps the two questions from drifting.
    everyFileIsParallelOfParent: allFilesAreParallelOfParent(paths),
    zeroBaseFiles: files.filter((x) => x.code === "zero-base").map((x) => x.file),
  };
}

// ── acquisition, per lane, through the EXISTING scripts ──────────────────────

/** How many trailing lines of a failed child's stderr reach the verdict. */
const CHILD_STDERR_LINES = 15;

/**
 * CF-A-DISCARDED-BANNER-IS-A-LOST-DIAGNOSIS (2026-09-06, run 34018058461).
 *
 * `run()` returns the child's stdout and every ingest call site threw it away.
 * The child ingester prints an accounting banner — rows read, rows written, of
 * which KEPT THE EXISTING ROW, rows skipped, subset clashes, failures — and
 * none of it has ever reached a driver log.
 *
 * That cost a whole investigation. Run 34018058461 reported:
 *
 *   SHORT INGEST — compared 2,747 staged identities against
 *   2020/topps-chrome-uefa-champions-league: 1,944 present, 803 missing
 *
 * and the log said nothing else. The child had ALREADY counted the answer:
 * 803 rows landed on ids another product held, so `keptExisting` was 803 and
 * its own banner said so, on a line nobody could see. Reading it would have
 * named the cause in one line instead of a staged-CSV re-derivation.
 *
 * WHY NOT JUST TEE THE CHILD. Two of its lines are load-bearing to a machine
 * elsewhere, and both would do damage repeated verbatim in the driver's log:
 *
 *   "stopped at the N-minute budget" — the workflow greps the WHOLE log for
 *       /stopped at the .*budget/ and re-dispatches the lane when it matches.
 *       A CHILD hitting its per-entry budget is normal and says nothing about
 *       the driver's; teeing it raw invents a budget stop the driver never had
 *       and triggers a spurious re-dispatch.
 *   the reconciliation JSON — `reportWrites` emits an {"event":...} object the
 *       workflow's other steps grep for. A second copy under a different job's
 *       name is a false reading of a job that did not run.
 *
 * So this SELECTS the accounting lines, re-emits them INDENTED under the entry
 * with a `child:` prefix, and passes nothing through verbatim. The prefix is
 * what makes the collision impossible rather than unlikely: no grep in the
 * workflow matches a prefixed line, and a reader can still see every number.
 */
const CHILD_BANNER_LINES = 24;
/** The child's accounting lines — the numbers that explain a verdict. */
const CHILD_BANNER_PATTERNS = [
  /^\s*csv rows read\b/,
  /^\s*catalog rows written\b/,
  /^\s*of which kept the existing row\b/,
  /^\s*rows skipped\b/,
  /^\s*rows not reached\b/,
  /^\s*numbered, parallel blank\b/,
  /^\s*rows with card-line parallel\b/,
  /^\s*rows with player-name parallel\b/,
  /^\s*categories REFUSED, exploded\b/,
  /^\s*files with nothing left\b/,
  /^\s*files with no manifest\b/,
  /^\s*subset clashes RESOLVED\b/,
  /^\s*subset clashes NOT VACATED\b/,
  /^\s*subset collisions REFUSED\b/,
  /^\s*failed\b/,
  /^!! EXPLODED category refused:/,
];

/**
 * The child's accounting lines, selected and trimmed. Never the whole stream:
 * see the two markers named above that must not be repeated verbatim.
 *
 * Returns [] for anything unreadable, so a surface that cannot be produced
 * costs a quieter log and never an exception on the ingest path.
 */
function childBannerLines(stdout) {
  if (!stdout) return [];
  const out = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (!CHILD_BANNER_PATTERNS.some((re) => re.test(line))) continue;
    // The explanatory "   <- ..." tail is for a human reading the child's own
    // output; under an entry it is noise around the number.
    out.push(line.replace(/\s{2,}<-.*$/, "").trim());
    if (out.length >= CHILD_BANNER_LINES) break;
  }
  return out;
}

/**
 * Print the child's accounting under the current entry. Indented to the
 * entry's depth and prefixed, so it reads as the child's testimony rather than
 * the driver's own verdict — and so no workflow grep can ever match it.
 */
function printChildBanner(stdout) {
  const lines = childBannerLines(stdout);
  for (const line of lines) console.log(`        child: ${line}`);
  return lines.length;
}

/**
 * The child's accounting, as NUMBERS rather than text.
 *
 * childBannerLines surfaces the banner for a human; this reads the same lines
 * for the verdict. The counters were already being printed and then discarded,
 * which is how run 34038740849 wrote "green ingest, 0 rows landed" eight times
 * over a child that had already counted every one of those rows as REFUSED.
 *
 * Returns null for anything unreadable and omits any counter the banner did
 * not state, so a verdict can require a number to be PRESENT rather than
 * inferring one from a default. A missing counter must never read as zero: a
 * zero is a measurement and an absence is not, and conflating them here would
 * let a truncated banner masquerade as a clean refusal.
 */
const CHILD_COUNTERS = [
  ["read", /^\s*csv rows read\s+([\d,]+)\b/],
  ["written", /^\s*catalog rows written\s+([\d,]+)\b/],
  ["keptExisting", /^\s*of which kept the existing row\s+([\d,]+)\b/],
  ["skipped", /^\s*rows skipped\s+([\d,]+)\b/],
  ["notReached", /^\s*rows not reached\s+([\d,]+)\b/],
  ["subsetRefused", /^\s*subset collisions REFUSED\s+([\d,]+)\b/],
  ["subsetResolved", /^\s*subset clashes RESOLVED\s+([\d,]+)\b/],
  ["failed", /^\s*failed\s+([\d,]+)\b/],
];

function childCounters(stdout) {
  if (!stdout) return null;
  const out = {};
  for (const raw of String(stdout).split(/\r?\n/)) {
    for (const [key, re] of CHILD_COUNTERS) {
      if (key in out) continue;
      const m = re.exec(raw);
      if (m) out[key] = Number(String(m[1]).replace(/,/g, ""));
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Did the child refuse EVERY row it read, and say so?
 *
 * The question is deliberately narrow, because its answer suppresses a
 * `failed`. All four must hold, from the child's own banner:
 *
 *   it read rows          — a page that staged nothing is `empty`, not refused
 *   it wrote none         — one row landing makes this a partial, not a refusal
 *   it reported no failures — a crashed child is a failure however it counted
 *   its refusals ACCOUNT FOR every row read
 *
 * The last is the load-bearing one: refusals plus the rows the child skipped
 * for its own stated reasons must equal what it read. A child that read 42 and
 * refused 3 has 39 rows unaccounted for, and that gap is exactly the
 * unexplained loss `failed` exists to report.
 */
function childRefusedEverything(counters) {
  if (!counters) return false;
  const { read, written, subsetRefused, failed } = counters;
  if (!Number.isFinite(read) || read <= 0) return false;
  if (!Number.isFinite(written) || written !== 0) return false;
  if (Number.isFinite(failed) && failed > 0) return false;
  if (!Number.isFinite(subsetRefused) || subsetRefused <= 0) return false;
  const accountedFor = subsetRefused
    + (Number.isFinite(counters.skipped) ? counters.skipped : 0)
    + (Number.isFinite(counters.notReached) ? counters.notReached : 0);
  return accountedFor >= read;
}

/**
 * CF-A-COMMAND-FAILED-IS-NOT-A-DIAGNOSIS (2026-09-04).
 *
 * Backfill Runner 33839532087 aborted the bcp lane on a 3-streak and left
 * exactly this in the log, twice:
 *
 *   FAILED — Command failed: /opt/.../node /home/.../ingest-checklist-csv-
 *
 * That is execFileSync's own message -- the ARGV, truncated by the verdict's
 * 140-char slice -- and it names the command rather than the complaint. The
 * child had in fact printed the reason on stderr and exited 2:
 *
 *   FATAL: SOURCE "bcp-2026-09-04" classifies as unknown, not checklist.
 *
 * The driver captured that on the pipe and threw it away, so the run reported
 * a broken lane where the truth was a one-line naming defect. A whole dispatch
 * (20 entries, the canary acceptance among them) was spent to learn nothing.
 *
 * execFileSync hangs stdout/stderr off the error, so the fix is to read them.
 * The TAIL, not the head: a child that fails prints its diagnosis last, and
 * `FATAL:` on the final line is exactly the shape being lost here. The child's
 * words come first in the message so the verdict's own truncation cuts the
 * argv, never the reason.
 */

/**
 * CF-THE-RUNNER-FANOUT-IS-NOT-THE-CHILD'S (2026-09-04).
 *
 * The workflow exports its OWN fan-out and bound as plain environment
 * variables -- LIMIT (entries this DRIVER run takes), SLOT/SLOTS (which shard
 * of a FLEET this dispatch is) -- and `run()` handed the child
 * `{...process.env}`. Those names mean something completely different one
 * level down: in ingest-checklist-csv-to-catalog they are the bound on ROWS
 * WRITTEN and the shard of STAGED FILES.
 *
 * Measured on backfill run 33845791358 (LIMIT=20, SLOT=0, SLOTS=16):
 *
 *   SLOTS=16  ->  the child kept files.filter((_, i) => i % 16 === 0), so
 *                 2015 Bowman Chrome's THREE staged scope files became one --
 *                 and the one kept was `--prospects-light-blue-refractors`,
 *                 a parallel scope with no base cards in it at all.
 *   LIMIT=20  ->  the child stopped after 20 rows written, so a 2,980-row
 *                 2011 Topps Chrome staging (290 of them autographs) landed
 *                 ELEVEN rows across the whole run, every one of them
 *                 isAuto=false, and every one of them card #1, #2 or #3.
 *
 * The driver had already read the catalog before and after, so it reported
 * "INGESTED — 3 rows created" and a green reconciliation. The numbers were
 * internally consistent; they were consistent about 0.4% of the job. This is
 * the same defect the ingest child's own SHARD banner was written for, one
 * wrapper up -- and this driver never got that lesson.
 *
 * A DRIVER'S OWN SCOPE IS NOT ITS CHILD'S SCOPE. The child is handed exactly
 * one product's staged directory and must ingest ALL of it; any narrowing here
 * is silent data loss wearing a green check. So these names are DELETED from
 * the child's environment rather than passed through -- explicitly, by name,
 * so a child that genuinely wants one can still be given it in `env`.
 */
const RUNNER_SCOPE_VARS = ["LIMIT", "SLOT", "SLOTS", "SCAN_LIMIT", "MAX_ROWS"];




function run(script, args, env, timeoutMs) {
  const childEnv = { ...process.env, ...env };
  // Deleted AFTER the merge so an explicit `env` value still wins: the caller
  // stating a bound is a decision, inheriting one is an accident.
  for (const k of RUNNER_SCOPE_VARS) if (!(env && k in env)) delete childEnv[k];
  try {
    return execFileSync(process.execPath, [path.join(HERE, script), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs || 10 * 60000,
    });
  } catch (e) {
    // stdout is read too: a child that dies on a guard sometimes says why on
    // stdout and leaves stderr empty, and "no output at all" is itself worth
    // saying out loud rather than reporting as a bare command failure.
    const tail = (buf) => String(buf ?? "")
      .split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
      .slice(-CHILD_STDERR_LINES).join(" | ");
    const said = tail(e.stderr) || tail(e.stdout) || "(the child printed nothing)";
    const how = e.status != null ? `exit ${e.status}` : e.signal ? `signal ${e.signal}` : "no exit status";
    const err = new Error(`${script} ${how}: ${said}`);
    err.childStatus = e.status;
    err.childStderr = String(e.stderr ?? "");
    throw err;
  }
}

const slugOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

/**
 * CF-A-SCOPE-FILE-IS-NOT-THE-PAGE (2026-09-04).
 *
 * Every multi-file lane took `csvs[0]` off a raw readdirSync -- the FIRST name
 * in lexical order -- and threw the rest away. That was survivable while a
 * page staged one file. It is not survivable now: since CF-ONE-FILE-PER-SCOPE
 * the BCP scraper writes one CSV PER SCOPE of a page, and the bare stem (the
 * scope that holds the base cards, the inserts and the typed sections) sorts
 * LAST, because every qualified sibling carries a `--<scope>` suffix that
 * sorts before the `.csv` extension.
 *
 * Measured on 2015 Bowman Chrome, the entry run 33839532087 refused:
 *
 *   2015-bowman-chrome-baseball--prospects-light-blue-refractors.csv   600 rows, 0 base
 *   2015-bowman-chrome-baseball--prospects-wave-refractors.csv       1,200 rows, 0 base
 *   2015-bowman-chrome-baseball.csv                                  4,430 rows, 227 base
 *
 * csvs[0] is the light-blue PARALLEL scope, so the zero-base-cards gate saw a
 * file that is all parallel -- correctly, for that file -- and refused the
 * whole entry as "600 rows, all carry a parallel". The page's base set was in
 * the third file and was never looked at. A page whose base set lives in
 * another scope must not be refused as all-parallel, and the other two scopes
 * are real rows that were being discarded even on the pages that DID pass.
 *
 * So the acquisition returns every staged file and the caller judges the
 * ENTRY, not an arbitrary member of it. Sorted, so a re-run reads them in the
 * same order a previous run did.
 */
function stagedCsvs(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith(".csv")).sort().map((n) => path.join(dir, n));
}

/** The provenance stamped on this lane's rows. See LANE_SOURCE. */
function sourceLabelFor(lane, stamp) {
  const base = LANE_SOURCE[lane];
  if (!base) throw new Error(`no checklist source name declared for lane ${lane} — declare it in LANE_SOURCE`);
  return `${base}-${stamp || new Date().toISOString().slice(0, 10)}`;
}

/**
 * CF-THE-PLAN-AND-THE-APPLY-ARE-ONE-FUNCTION (2026-09-04).
 *
 * The report mode used to print its plan from a hardcoded object literal that
 * lived 500 lines away from the switch that actually runs. Nothing tied them
 * together, so run 33847474466 printed
 *
 *     would drive: fetchSportsCardChecklist.cjs --url <sourceRef> ...
 *
 * for all three entries and was believed to be a clean rehearsal of the apply
 * -- while the apply path for that same lane was broken and threw on every one
 * of them. A report that cannot be wrong about the apply is worth nothing as a
 * rehearsal, and that is exactly what a second copy of the truth buys.
 *
 * So the plan string is DERIVED, by this function, for both modes: report mode
 * prints it, and every lane branch of acquireEntry opens by declaring it, which
 * is what makes it the same sentence rather than two that happen to agree. The
 * completeness assert below closes the other half: a lane that acquireEntry can
 * dispatch but planFor cannot describe -- the shape a new lane arrives in --
 * fails at load, not on the first dispatch.
 *
 * A wrong PLAN is now a wrong RUN. That is the point: they are the same string.
 */
function planFor(entry) {
  const lane = entry.lane;
  switch (lane) {
    case "hobbymonitor":
      return "fetchHobbyMonitorChecklist.cjs --url <sourceRef> (direct-URL lane) → ingest-checklist-csv-to-catalog.cjs";
    case "sportscardchecklist":
      return "fetchSportsCardChecklist.cjs --url <sourceRef> (direct-URL lane) → ingest-checklist-csv-to-catalog.cjs";
    case "checklistinsider":
      return "scrape-checklistinsider.cjs --slugsFile → convertChecklistInsiderToChecklistCsv.cjs → ingest-checklist-csv-to-catalog.cjs";
    case "bcp":
      return "scrape-bcp-ladders.cjs --titles=<page> --titlesOnly → ingest-checklist-csv-to-catalog.cjs";
    case "beckett":
      return "fetch <sourceRef>.xlsx → convertBeckettChecklistXlsx.cjs → ingest-checklist-csv-to-catalog.cjs";
    case "clc":
      return "scrape-checklistcenter-products.cjs --urls → convertChecklistCenterToChecklistCsv.cjs → ingest-checklist-csv-to-catalog.cjs";
    // The lane is TWO scrapers and the plan must say WHICH, or the sentence it
    // prints is not the sentence the apply runs: a modern code (SV*, S*, CS*,
    // M*) routes to the ladder-carrying scraper, the vintage PMCG/neo titles to
    // the original. tcgdexModern is the ONE predicate both sides read.
    case "tcgdexja":
      return `${tcgdexModern(entry)
        ? "scrape-tcgdex-ja-modern.cjs (rarity ladder → parallel)"
        : "scrape-tcgdex-ja.cjs (base-only; tcgdex serves no ladder for these)"} --sets=<id> → ingest-checklist-csv-to-catalog.cjs`;
    default:
      return null;
  }
}

/** The one predicate that decides which tcgdexja scraper runs. Read by BOTH planFor and acquireEntry. */
function tcgdexModern(entry) {
  const setId = String(entry.sourceRef || "").split("/").pop() || "";
  return /^(SV|S\d|CS|M[0-9]|M-P|SVK|SVLN|SVLS)/i.test(setId);
}

/** Every lane acquireEntry can dispatch. The load-time assert below pins planFor to it. */
const ACQUIRE_LANES = ["hobbymonitor", "sportscardchecklist", "checklistinsider", "bcp", "beckett", "clc", "tcgdexja"];

/**
 * Acquire ONE entry into its own directory. Returns { csvPaths: [...] } or
 * throws -- see acquireStaged, which is the checked way to call this.
 * Each lane is the same script the end-to-end wrapper calls, scoped down to the
 * single set by whichever argument that script already accepts for the purpose.
 */
function acquireEntry(entry, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stem = slugOf(`${entry.year || ""}-${entry.setName || entry.sourceRef}`);
  const csvPath = path.join(dir, `${stem}.csv`);

  switch (entry.lane) {
    case "hobbymonitor": {
      // The direct-URL lane (#1565): fetch this exact release page, bypassing
      // hmSlugFor, which cannot name a release absent from the thin --list index.
      //
      // CF-AN-UNRELEASED-PRODUCT-IS-NOT-A-BROKEN-LANE (2026-09-04, run
      // 33857627732). The fetcher exits 1 for THREE different reasons and this
      // lane read all of them as `failed`. Entry 18 (2026 Panini Prizm WNBA,
      // effective 2026-09-25) is a product hobbymonitor has not published a
      // checklist for yet; it became the third `failed` in a row and aborted
      // the lane with 81 entries unattempted. The bcp lane learned exactly this
      // (CF-A-REFUSAL-PATH-IS-NOT-A-CRASH); hobbymonitor never did. Classified
      // on the fetcher's own words, which now name the cause:
      //
      //   "nothing new to add"        -> EMPTY. The release exists and carries
      //      no checklist at all. A verdict about the product, excluded from
      //      the streak, exactly as the same phrase means on bcp and tcgdex.
      //   "challenge/interstitial"    -> UNREACHABLE. The host is not serving
      //      us; terminal for the entry, and a STREAK of them is the lane
      //      being blocked, which is precisely when the tripwire should fire.
      //   "layout not understood"     -> stays `failed`. That is OUR parser and
      //      it must keep bringing someone back to it.
      try {
        run("fetchHobbyMonitorChecklist.cjs", [
          "--url", entry.sourceRef,
          "--out", csvPath,
          "--year", String(entry.year || ""),
          "--set-key", setKeyFor(entry) || "",
          "--set-name", String(entry.setName || ""),
          "--sport", String(entry.sport || "baseball"),
        ]);
      } catch (err) {
        const said = String(err?.message || err);
        if (/nothing new to add/.test(said)) {
          const e = new Error(`hobbymonitor serves no checklist for this release yet — ${(said.match(/\(status[^)]*\)/) || ["the source carries nothing"])[0]}`);
          e.emptyAtSource = true;
          throw e;
        }
        if (/challenge\/interstitial|not a hobbymonitor release page/.test(said)) {
          // Shaped for the shared isGone test so it lands in `unreachable`.
          throw new Error(`hobbymonitor did not serve the release page (HTTP 403-equivalent: a 200 carrying no release payload) — ${said.slice(0, 200)}`);
        }
        throw err;
      }
      return { csvPaths: [csvPath] };
    }
    case "sportscardchecklist": {
      // The direct-URL lane, same shape as hobbymonitor: the sourceRef IS the
      // address. Discovery happened once, in the sitemap pass that minted these
      // entries -- this never touches /search/, which robots.txt Disallows via
      // `/?*` and which returns the wrong sets anyway (the survey measured
      // "1972 topps football" returning 18 results, none of them set-11959).
      // CF-ZERO-ROWS-MUST-NAME-WHY, the sportscardchecklist side (2026-09-04,
      // run 33902098944). The fetcher exits 9 for THREE different reasons and
      // this lane read all of them the same way. Worse, it read them as
      // `failed`: the shared isGone test matches "exited ... code 9", never the
      // "exit 9" that run() actually produces, so a zero-row refusal was
      // reported as OUR pipe breaking rather than as the host not serving us.
      // Entries set-20411, set-29386 and set-20412 made a 3-streak that aborted
      // the era with 1,246 entries unattempted.
      //
      // Probed directly (2026-09-04): all three serve HTTP 200 with a FULL
      // checklist -- 220, 27 and 220 card headers -- and all three parse
      // cleanly through the current parser, as do 20 more entries sampled
      // across 1990-1999. There is no second layout and no empty page here;
      // those bodies were transient, and the era is healthy. What the lane
      // lacked was any way to say so. Classified on the fetcher's own words:
      //
      //   "nothing new to add"     -> EMPTY. The page is a set page and carries
      //      no cards. A verdict about the set, excluded from the streak,
      //      exactly as the same phrase means on bcp, tcgdex and hobbymonitor.
      //   "challenge/interstitial" / "did not serve a set page"
      //                            -> UNREACHABLE. The host is not serving us;
      //      terminal for the entry, and a STREAK of them is the lane being
      //      blocked, which is precisely when the tripwire should fire. This is
      //      where a degraded/truncated body lands, so a repeat of THIS
      //      incident still trips -- on the honest reason.
      //   "layout not understood"  -> stays `failed`. That is OUR parser and it
      //      must keep bringing someone back to it. It is also positive
      //      evidence the host is UP -- we fetched and read every byte -- so it
      //      carries laneProvenHealthy and does not advance the streak.
      try {
        run("fetchSportsCardChecklist.cjs", [
          "--url", entry.sourceRef,
          "--out", csvPath,
          "--year", String(entry.year || ""),
          "--set-key", setKeyFor(entry) || "",
          "--set-name", String(entry.setName || ""),
          "--sport", String(entry.sport || ""),
        ]);
      } catch (err) {
        const said = String(err?.message || err);
        // CF-A-404-IN-A-200-IS-NOT-AN-EMPTY-SET (2026-09-06). The host answers a
        // set id it does not card with its "Checklist Not Found" page, served
        // 200 at ~56 KB. That is the SOURCE not having the set -- an address
        // that does not resolve -- and not a set page that exists and lists no
        // cards. `unreachable` is the honest verdict: terminal, so the walker
        // stops re-fetching a dead id, and recheckable, so a source that later
        // cards the set is picked up. Ordered BEFORE the `nothing new to add`
        // test so the specific reason wins over the general one.
        if (/Checklist Not Found|not carded at the source/.test(said)) {
          throw new Error(`sportscardchecklist does not card this set id (HTTP 404-equivalent: its "Checklist Not Found" page served with 200) — ${said.slice(0, 200)}`);
        }
        if (/nothing new to add/.test(said)) {
          const e = new Error(`sportscardchecklist lists this set but cards none of it — ${said.slice(0, 200)}`);
          e.emptyAtSource = true;
          throw e;
        }
        if (/challenge\/interstitial|did not serve a set page/.test(said)) {
          // Shaped for the shared isGone test so it lands in `unreachable`.
          throw new Error(`sportscardchecklist did not serve the set page (HTTP 403-equivalent: a 200 carrying no checklist) — ${said.slice(0, 200)}`);
        }
        if (/layout not understood/.test(said)) {
          const e = new Error(`sportscardchecklist served a set page our parser does not read — a parser gap, not an empty page: ${said.slice(0, 200)}`);
          e.laneProvenHealthy = true;
          throw e;
        }
        throw err;
      }
      // csvPathS. The fetcher writes `<stem>.csv` beside `<stem>.manifest.json`
      // and, for a ladder rung, `<stem>.parallels.json`; the ingest child reads
      // the DIRECTORY, so the sidecars need no naming here. Only the CSV is
      // gated, and it is returned in the same one-element array shape
      // hobbymonitor uses -- see acquireStaged, which now refuses any other.
      return { csvPaths: [csvPath] };
    }
    case "checklistinsider": {
      // --slugsFile re-runs a NAMED subset without re-fetching all 599 pages.
      const slug = entry.sourceRef.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
      const slugsFile = path.join(dir, "slugs.txt");
      fs.writeFileSync(slugsFile, slug + "\n");
      const jsonl = path.join(dir, "staged.jsonl");
      run("scrape-checklistinsider.cjs", [`--slugsFile=${slugsFile}`, `--out=${jsonl}`, "--delayMs=1500"]);
      run("convertChecklistInsiderToChecklistCsv.cjs", [`--in=${jsonl}`, `--outDir=${dir}`]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) throw new Error("converter produced no CSV");
      return { csvPaths: stagedCsvs(dir) };
    }
    case "bcp": {
      // --titles names the exact mainspace page; BCP has no index, so the page
      // title IS the address.
      const title = decodeURIComponent(entry.sourceRef.split("/index.php/")[1] || "");
      if (!title) throw new Error("cannot derive a bcp page title from sourceRef");
      const said = run("scrape-bcp-ladders.cjs", [
        `--titles=${title}`, "--titlesOnly=1", `--outDir=${dir}`, "--delayMs=800",
        `--sport=${entry.sport || "baseball"}`,
      ]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) {
        // CF-A-SET-THE-SOURCE-DOES-NOT-CARD-IS-NOT-A-BROKEN-LANE, the bcp side
        // (#1717 ruled this for tcgdex on the same day; the wiki has the same
        // shape, so it gets the same status rather than a parallel one).
        //
        // The scraper stages nothing for two completely different reasons, and
        // it SAYS which on stdout while exiting 0 either way:
        //
        //   "base ok (109) but 0 rungs — nothing new to add"   <- the page is
        //      fine and we already have everything it offers. 1990_Baseball_Wit
        //      and 1990_Bazooka are oddballs with no parallel ladder at all;
        //      certified autos are a 1990s-ONWARD feature and 1990 is the
        //      boundary year. There is nothing here and never was.
        //
        //   "0 base cards — layout not understood, SKIPPED"    <- a real gap in
        //      our parser, worth a verdict that brings someone back to it.
        //
        // Both read as `failed` before, so run 33845791358 spent entries 5 and
        // 6 on pages with nothing to give, called them failures, and they
        // became two thirds of the 3-streak that aborted the lane. A lane is
        // not broken because the wiki has nothing to add for a 1990 oddball.
        // CF-A-REFUSAL-PATH-IS-NOT-A-CRASH (2026-09-04, run 33852199385).
        //
        // #1718 mapped exactly ONE of the scraper's refusal messages to EMPTY.
        // The 1990 boxed/retail sets exit by a DIFFERENT path and were still
        // read as `failed`: entries 6, 11, 12, 15, 16 and 17 of that run, and
        // 15/16/17 were three in a row, so the lane aborted with 2,621 entries
        // left. Every path below is the scraper EXITING 0 having said why it
        // staged nothing, so each is classified on its own message rather than
        // on the absence of a CSV, which is the same for all of them.
        //
        // The probe (2026-09-04, pages fetched directly) settles which of these
        // is a verdict and which is a defect:
        //
        //   "base ok (N) but 0 rungs — nothing new to add"  -> EMPTY. The page
        //      has a Base_Set heading and no parallel ladder. 1990_Baseball_Wit
        //      is exactly this. Nothing here, and never was.
        //
        //   "0 base cards — layout not understood, SKIPPED" -> NOT empty. The
        //      probe found these pages carry a FULL checklist (1990_Bazooka 22
        //      cards, 1990_Fleer_Award_Winners 44, 1990_Donruss_Learning_Series
        //      and 1990_Fleer_Baseball_All-Stars likewise) under a plain
        //      `Checklist` heading, with NO `Base_Set` heading -- which is the
        //      only heading parseCards reads. The rows are there and we cannot
        //      see them. That is OUR parser, so it stays a lane fault worth a
        //      verdict that brings someone back to it, exactly as the scraper's
        //      own wording says. It does NOT become EMPTY: calling a gap in our
        //      parser "the source has nothing" is how a defect goes quiet.
        //
        //   "HTTP 404" / "HTTP 410"                          -> the page is gone;
        //      the shared isGone test downstream already lifts these out of
        //      `failed` and into `unreachable`, so they need nothing here.
        const saidStr = String(said || "");
        if (/nothing new to add/.test(saidStr)) {
          // #1717's flag, and deliberately the SAME one: "the source answered,
          // and its answer is that it has nothing here" is ONE concept, and it
          // earns one status and one exclusion from the streak whether the
          // source is tcgdex or the wiki.
          const e = new Error(`bcp page has a base set but no parallel ladder — the wiki carries no rungs for it`);
          e.emptyAtSource = true;
          throw e;
        }
        if (/HTTP 40[34]/.test(saidStr)) {
          // The wiki answered, and its answer is that the page is not there.
          // get() prints this and returns null on a 4xx, so the scraper exits 0
          // and the 404 never reaches the catch below -- a gone page read as a
          // broken pipe. Rethrown in the shape the shared isGone test already
          // recognises, so it lands in `unreachable` (terminal, not our defect)
          // rather than in `failed`, where it would advance the streak.
          throw new Error(`bcp page is gone at the source (${(saidStr.match(/HTTP 40[34]/) || ["HTTP 404"])[0]})`);
        }
        // CF-A-CHECKLIST-WITHOUT-CARD-NUMBERS-IS-NOT-A-PARSER-GAP (2026-09-04).
        //
        // #1729 ruled "0 base cards — layout not understood" a parser gap, and
        // #1732/#1738/#1762 each closed one. 62 control docs still carried it,
        // and a probe of 14 of those pages says the rest are not that at all:
        // the wiki publishes them with NO CARD NUMBERS, so there is nothing a
        // parser could key even in principle.
        //
        //   UNNUMBERED ROSTER  1999 Team Best Autographs — 70 bare names.
        //   STUB               2010 SP Authentic — full heading tree, 0 <li>.
        //   SINGLE-CARD PROMO  2004-05 Speed Stick A-Rod — "Alex Rodriguez 100".
        //
        // The catalog keys a card by cardNumber and the ingester drops any row
        // without one, so reading these would mean INVENTING numbers the source
        // never published — which `no synthetic parallels — actuals only`
        // forbids, and which the older pin "a body of ordinary names is NOT
        // read as an initials-numbered set" already refuses.
        //
        // So this is the source answering, and its answer is that it has no
        // keyable card here: EMPTY, the same flag #1717/#1718 give every other
        // "the source has nothing" path, and streak-neutral for the same
        // reason. It is deliberately matched on the scraper's three distinct
        // per-shape strings rather than a catch-all, so a shape we have NOT
        // classified still falls through to the parser-gap verdict below.
        if (/checklist is an UNNUMBERED ROSTER|page is a STUB|page is a SINGLE-CARD promo/.test(saidStr)) {
          // The scraper's own words for the shape, carried into the verdict so the
          // control doc says WHICH of the three it was.
          const shapeSaid = (saidStr.match(/checklist is an UNNUMBERED ROSTER|page is a STUB[^\n]*|page is a SINGLE-CARD promo[^\n]*/) || ["no keyable card number"])[0].trim();
          const e = new Error(`bcp page states no card numbers — ${shapeSaid}`);
          e.emptyAtSource = true;
          throw e;
        }
        if (/0 base cards — layout not understood/.test(saidStr)) {
          // Named distinctly so the control doc says WHICH defect, and so a
          // future fix to the Checklist-heading layout can find its own rows.
          //
          // A PARSER GAP IS A PER-ENTRY ANSWER (2026-09-04, run 33869931267).
          // The wiki served the page and we read every byte of it -- what we
          // could not do is understand a heading level. That is positive
          // evidence the host is UP, so it must not advance the systemic
          // streak. It did: 2009 Bowman Chrome and 2004 Bowman's Best both
          // landed here, and with "green ingest, 0 rows landed" between them
          // they were two thirds of the 3-streak that aborted the bcp lane.
          const e = new Error("bcp page carries a checklist our parser does not read (no Base_Set heading) — a parser gap, not an empty page");
          e.laneProvenHealthy = true;
          throw e;
        }
        throw new Error("bcp scrape produced no CSV");
      }
      return { csvPaths: stagedCsvs(dir) };
    }
    case "beckett": {
      // sourceRef is the workbook itself, so the archive walk is skipped
      // entirely and the converter runs against the downloaded xlsx.
      const xlsxPath = path.join(dir, `${stem}.xlsx`);
      const bin = execFileSync(process.execPath, ["-e", `
        const https=require("node:https"),fs=require("node:fs");
        https.get(process.argv[1],{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}},(r)=>{
          if(r.statusCode!==200){console.error("HTTP "+r.statusCode);process.exit(9);}
          const c=[];r.on("data",(d)=>c.push(d));r.on("end",()=>{fs.writeFileSync(process.argv[2],Buffer.concat(c));console.log("ok");});
        }).on("error",(e)=>{console.error(e.message);process.exit(9);});
      `, entry.sourceRef, xlsxPath], { encoding: "utf8", timeout: 5 * 60000 });
      if (!fs.existsSync(xlsxPath) || fs.statSync(xlsxPath).size < 2000) throw new Error("workbook empty or unreachable");
      run("convertBeckettChecklistXlsx.cjs", [
        "--xlsx", xlsxPath, "--year", String(entry.year || ""),
        "--set-key", setKeyFor(entry) || "",
        "--set-name", String(entry.setName || ""),
        "--sport", String(entry.sport || "baseball"),
        "--out", csvPath, "--source-url", entry.sourceRef,
      ]);
      fs.rmSync(xlsxPath, { force: true });
      return { csvPaths: [csvPath] };
    }
    case "clc": {
      // Both CLC scripts are driven by a work-list JSON, not by a URL argument,
      // and the committed list holds 547 of the 2,367 pages the sitemap serves.
      // CLC_LIST hands them a one-product list built from this entry, so the
      // fetch and the parse stay theirs and only the work list is ours.
      const slug = entry.sourceRef.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
      const listPath = path.join(dir, "clc-list.json");
      fs.writeFileSync(listPath, JSON.stringify({
        products: [{
          url: entry.sourceRef, sourceSlug: slug,
          productName: entry.setName || slug, year: entry.year, sport: entry.sport || "baseball",
        }],
      }));
      const pagesDir = path.join(dir, "pages");
      run("scrape-checklistcenter-products.cjs", [`--outDir=${pagesDir}`, "--delayMs=800"], { CLC_LIST: listPath });
      const said = run("convertChecklistCenterToChecklistCsv.cjs", [`--pagesDir=${pagesDir}`, `--outDir=${dir}`], { CLC_LIST: listPath });
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) {
        /**
         * CF-AN-UNNUMBERED-ROSTER-IS-NOT-A-BROKEN-CONVERTER (2026-09-06).
         *
         * "no CSV" had ONE wording for two opposite causes, and it named the
         * wrong one. `failed` says our pipe broke and advances the systemic
         * streak; run 33997480307 gave it to five soccer pages that had all
         * answered HTTP 200 with a complete page, and three of them in a row
         * (Real Sociedad, Barcelona, Merlin Heritage 97) tripped the tripwire
         * and aborted the lane with 252 entries still open -- while the same
         * source's football/basketball walk was creating 156k rows a pass.
         *
         * The converter now says WHICH shape it met. An unnumbered roster is
         * the source answering "I have no keyable card here": the page lists
         * bare player names and the catalog keys a card by cardNumber, so
         * there is nothing to read even in principle and inventing numbers is
         * forbidden outright. That is EMPTY -- a terminal verdict about the
         * ENTRY, streak-neutral, exactly as the bcp lane already rules it.
         *
         * Anything else keeps the old wording and stays `failed`, because a
         * converter that met a numbered page and still produced nothing is a
         * real defect and must keep bringing someone back to it.
         */
        if (/UNNUMBERED ROSTER/.test(String(said || ""))) {
          const e = new Error("clc page lists players with no card numbers — the source states no keyable card for this product");
          e.emptyAtSource = true;
          throw e;
        }
        throw new Error("clc converter produced no CSV (page fetched but refused, or no page served)");
      }
      return { csvPaths: stagedCsvs(dir) };
    }
    case "tcgdexja": {
      const setId = entry.sourceRef.split("/").pop();
      // CF-JA-MODERN-PARALLEL-LADDER (gap doc 2026-09-03, recommendation 5).
      // The vintage scraper stages BASE-ONLY -- every row `parallel=""` -- and a
      // base-only checklist does not unblock the comps behind these cells, which
      // are waiting on the parallel axis. For the modern codes (SV*, S*, M*, CS*)
      // the JA rarity ladder IS that axis, so those sets route to the scraper
      // that carries it. The vintage PMCG/neo titles keep the original lane:
      // tcgdex serves them no rarity ladder, so pointing them at the modern
      // scraper would change nothing but the provenance string.
      const modern = tcgdexModern(entry);
      const script = modern ? "scrape-tcgdex-ja-modern.cjs" : "scrape-tcgdex-ja.cjs";
      const said = run(script, [`--outDir=${dir}`, `--sets=${setId}`, "--delayMs=150"]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) {
        /**
         * CF-A-SET-THE-SOURCE-DOES-NOT-CARD-IS-NOT-A-BROKEN-LANE (2026-09-04).
         *
         * Run 33845979897 took XY2, XY3, XY4 and reported all three "FAILED --
         * tcgdex produced no CSV", tripping the 3-streak and leaving 49 entries
         * -- including all 52 staged modern sets -- unattempted.
         *
         * None of the three is a defect. Probed live: every one answers HTTP 200
         * with its right name and a populated `cardCount.total`, and `cards: []`.
         * tcgdex simply holds no per-card rows for the XY-era Japanese sets. The
         * scraper reads that correctly -- `!d.cards.length` -> skippedSets++,
         * continue -- writes nothing, and exits 0. The DRIVER then read "no CSV"
         * as a failure.
         *
         * Measured over the whole lane: 32 of the 97 vintage entries answer with
         * an empty `cards` array. A refusal the source itself states is a VERDICT
         * about that set, not evidence the lane is down, so it gets its own
         * status and is excluded from the systemic streak (see EMPTY_STATUS).
         */
        const setsSkipped = /sets skipped\s+([1-9])/.test(String(said ?? ""));
        const stagedNone = /sets staged\s+0(?!\d)/.test(String(said ?? ""));
        if (setsSkipped && stagedNone) {
          const err = new Error(`tcgdex serves no cards for this set (${script}, set ${setId}) — the source's own answer, not a lane failure`);
          err.emptyAtSource = true;
          throw err;
        }
        throw new Error(`tcgdex produced no CSV (${script}, set ${setId})`);
      }
      return { csvPaths: stagedCsvs(dir) };
    }
    default:
      throw new Error(`no acquisition machinery for lane ${entry.lane}`);
  }
}

/**
 * CF-A-LANE-THAT-RETURNS-THE-WRONG-SHAPE-IS-A-REFUSAL (2026-09-04).
 *
 * Run 33848115955 (sportscardchecklist, apply=true, limit=3) failed all three
 * entries with
 *
 *     FAILED — The "path" argument must be of type string. Received undefined
 *
 * and then tripped the 3-streak systemic abort. The report run for the very
 * same three, 33847474466, was clean, because report mode never calls this
 * function at all.
 *
 * The cause was one character. #1710 wrote the lane's return as
 *
 *     return { csvPath };          // singular
 *
 * while the caller -- and every one of the other six lanes -- speaks csvPathS:
 *
 *     const { csvPaths } = acquireEntry(entry, dir);
 *
 * So csvPaths was `undefined`, gateStagedEntry's `Array.isArray(x) ? x : [x]`
 * faithfully wrapped it into `[undefined]`, and gateStagedCsv handed `undefined`
 * to fs.readFileSync. The CSV was fetched and staged correctly; nothing was
 * wrong with the acquisition. A one-character key mismatch cost a whole lane.
 *
 * The lesson is not "spell it right" -- it is that the contract between a lane
 * branch and its caller was never stated anywhere, so a wrong shape read as a
 * legitimately-empty one. It is stated here now, and it is CHECKED. A lane that
 * returns anything but `{ csvPaths: [string, ...] }` is a defect in this file,
 * so it says so by name rather than surfacing as an undefined path five frames
 * down in an unrelated gate.
 */
/**
 * CF-A-STAGED-FILE-WINS (2026-09-04).
 *
 * #1719 committed eight Topps Traded Tiffany checklists -- 1984-1990 from
 * sportscardchecklist, 1991 from baseballcardpedia -- as CSVs with manifest
 * sidecars under backend/data/checklists/scraped/. #1717 then taught the queue
 * to put staged entries FIRST. Nothing taught the driver to USE them: the
 * acquisition re-fetched every one, and the re-fetch is not the staged file.
 *
 * Measured in the catalog on 2026-09-04, after run 33854416984:
 *
 *   1984-1990  setKey topps-traded-tiffany  132 rows/yr  source sportscardchecklist-2026-09-04   ok
 *   1991       setKey topps-traded          396 rows     source baseballcardpedia-ladders-2026-09-04
 *
 * The 1991 entry is the whole argument. Its staged CSV is 132 rows, setKey
 * `topps-traded-tiffany`, parallel BLANK. What the re-fetch landed instead:
 *
 *   - scrape-bcp-ladders.cjs derives its key from the PAGE TITLE
 *     ("1991_Topps_Traded" -> normalizeSetKeyLocal -> `topps-traded`), so the
 *     rows are filed under the Traded product, not the Tiffany one;
 *   - it emits the literal "Base" in the parallel column, which the CSV
 *     contract forbids -- blank means plain, and "Base" is a rung name;
 *   - Tiffany itself came back as a PARALLEL of Topps Traded ("Topps Traded
 *     Tiffany", 132 rows) alongside "Grey Backs", so the 132-card Tiffany
 *     product became a rung of another product -- the split-pool shape
 *     (memory: one card, one row, one pool).
 *
 * The staged file has none of those defects, because a human resolved them
 * once and wrote the answer down. Re-deriving it from the source slug throws
 * that ruling away every run.
 *
 * So: when the manifest sidecar for an entry's sourceRef is on disk, the
 * driver INGESTS IT AS-IS -- byte for byte, with its own manifest, which is
 * what the ingest child reads product identity from. No fetch, no network, no
 * re-derivation. The verdict records `acquired: "staged"` so a control doc
 * says which files landed and a later reader can tell a staged ingest from a
 * fetched one.
 *
 * MODE=refetch is the way back, and it is the ONLY way back (CF-RECHECK-IS-
 * NOT-REFETCH, 2026-09-04). It was SCOPE=recheck, which also happens to be the
 * only way to re-attempt an entry that already carries a terminal verdict --
 * so "run 1991 Tiffany again" and "throw away the human's ruling and re-scrape
 * bcp" were the same dispatch, and the entry could not be re-run without
 * re-running the cross-join. The operator saying "go and look again at the
 * SOURCE" now says MODE=refetch; SCOPE=recheck says "look at this entry
 * again", and takes the staged file when there is one.
 *
 * The staged files are COPIED into the run's workdir rather than ingested in
 * place: the child is handed a DIR and the caller deletes that DIR when the
 * entry is done, and pointing it at the repo would delete committed work.
 */
/**
 * CF-A-STALE-STAGED-FILE-MUST-NOT-OUTLIVE-ITS-CONVERTER (2026-09-06).
 *
 * The converter version each lane currently emits. A staged file whose manifest
 * stamps an OLDER version is not re-ingested as-is: the driver falls through to
 * a live fetch, so a converter fix re-opens the entries it affects WITHOUT an
 * operator having to remember MODE=refetch for a population nobody has listed
 * yet.
 *
 * A lane absent here is unversioned and keeps the plain staged-wins rule, so
 * this narrows nothing for lanes that have not opted in. A staged file with NO
 * stamp on a lane that IS listed is treated as version 0 -- written before the
 * stamp existed, therefore older than anything current.
 */
const LANE_CONVERTER_VERSION = { sportscardchecklist: 4 };

/** The converter version a staged manifest claims, or 0 when it claims none. */
function stagedConverterVersion(manifestPath) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const v = Number(m && m.converterVersion);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

/**
 * Is every staged file for this entry current enough to win over a live fetch?
 *
 * Returns { ok, current, stale } -- `stale` names the files and the versions
 * they carry, so the banner can say WHY a staged file was passed over rather
 * than silently fetching and looking like the staged-wins rule broke.
 */
function stagedIsCurrent(lane, staged) {
  const current = LANE_CONVERTER_VERSION[lane];
  if (!current) return { ok: true, current: null, stale: [] };
  const stale = staged
    .map((s) => ({ file: path.basename(s.csv), version: stagedConverterVersion(s.manifest) }))
    .filter((x) => x.version < current);
  return { ok: stale.length === 0, current, stale };
}

function acquireFromStaging(entry, dir) {
  const staged = stagedFilesFor(entry);
  if (!staged.length) return null;
  // A STAGED FILE ONLY WINS WHILE ITS CONVERTER IS CURRENT. Returning null here
  // is exactly what a missing staged file does, so the caller falls through to
  // the live fetch with no other change in behaviour.
  const fresh = stagedIsCurrent(String(entry?.lane || entry?.source || ""), staged);
  if (!fresh.ok) {
    console.log(`      STAGED IGNORED — converter v${fresh.current} is current; staged file(s) carry ` +
      `${fresh.stale.map((x) => `${x.file}=v${x.version || "unstamped"}`).join(", ")} — re-fetching live`);
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const s of staged) {
    const csv = path.join(dir, path.basename(s.csv));
    fs.copyFileSync(s.csv, csv);
    // The manifest travels WITH the CSV. ingest-checklist-csv-to-catalog.cjs
    // reads sport/year/setKey/setName from the sidecar next to the file (and
    // falls back to parsing the FILENAME when there is none), so copying the
    // CSV alone would hand the child a different product identity than the one
    // the staged manifest states -- the very re-derivation this rule exists to
    // stop.
    fs.copyFileSync(s.manifest, path.join(dir, path.basename(s.manifest)));
    out.push(csv);
  }
  return out;
}

function acquireStaged(entry, dir) {
  const got = acquireEntry(entry, dir);
  const paths = got && got.csvPaths;
  if (!Array.isArray(paths)) {
    const keys = got && typeof got === "object" ? Object.keys(got).join(", ") : String(got);
    throw new Error(
      `lane ${entry.lane} returned no csvPaths array (got keys: ${keys || "(none)"}) — ` +
      `every lane must return { csvPaths: [<file>, ...] }`,
    );
  }
  const bad = paths.findIndex((p) => typeof p !== "string" || !p);
  if (bad !== -1) {
    throw new Error(`lane ${entry.lane} returned a non-string staged path at index ${bad} — every lane must return { csvPaths: [<file>, ...] }`);
  }
  return paths;
}

// ── Cosmos: the control docs and the verify-by-read ──────────────────────────

let db = null;
function cosmos() {
  if (db) return db;
  const { CosmosClient } = require("@azure/cosmos");
  db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  return db;
}

/**
 * CF-A-URL-IS-NOT-A-COSMOS-ID (2026-09-04).
 *
 * The manifest's entry.id embeds the whole sourceRef -- "bcp::http://www.
 * baseballcardpedia.com/index.php/1990_Baseball_Wit" -- so the control id it
 * produced carried slashes, and the SDK rejects those CLIENT-SIDE:
 * "Illegal characters ['/', '\', '#'] cannot be used in Resource ID".
 *
 * That throw came from writeControl, which sits AFTER the per-entry try/catch,
 * so it escaped to the outer handler and killed the lane on entry 1 with exit
 * 3. Measured on the manifest: ALL 7,755 entries across ALL SIX lanes produce
 * an illegal id, so no generation of this driver has ever written a verdict in
 * APPLY mode -- run 33837346045 is simply the first that reached the line.
 *
 * The id is an ADDRESS, not the record: the readable fields (entryId, lane,
 * sourceRef) all stay on the doc verbatim. So the illegal characters are
 * ESCAPED rather than stripped -- two entries differing only where a slash sat
 * must not fold onto one doc. `~` is escaped first, so the mapping is
 * injective by construction.
 */
const COSMOS_ID_ESCAPES = [[/~/g, "~t"], [/\//g, "~s"], [/\\/g, "~b"], [/#/g, "~h"], [/\?/g, "~q"]];
function cosmosSafeId(raw) {
  let v = String(raw ?? "");
  for (const [re, to] of COSMOS_ID_ESCAPES) v = v.replace(re, to);
  return v;
}
const controlId = (entryId) => cosmosSafeId(`ingest_universe::${entryId}`);

async function readControl(entryId) {
  const id = controlId(entryId);
  try {
    const { resource } = await cosmos().container(CONTROL_CONTAINER).item(id, id).read();
    return resource || null;
  } catch (e) { if (e.code === 404) return null; throw e; }
}

async function writeControl(entry, verdict) {
  const id = controlId(entry.id);
  const doc = {
    id,
    docType: "ingest_universe_status",
    entryId: entry.id,
    lane: entry.lane,
    sourceRef: entry.sourceRef,
    sport: entry.sport, year: entry.year, setName: entry.setName,
    status: verdict.status,
    // "staged" = the committed CSV+manifest were ingested as-is (no fetch);
    // "fetched" = the lane's own scraper ran. See CF-A-STAGED-FILE-WINS.
    acquired: verdict.acquired || null,
    // Rows the catalog holds for this product UNDER THIS RUN'S SOURCE -- the
    // number that answers "did my rows land", as opposed to rowsInCatalog,
    // which counts synthetic rows too.
    rowsUnderSource: verdict.rowsUnderSource ?? null,
    reason: verdict.reason || null,
    rowsCreated: verdict.rowsCreated ?? null,
    rowsInCatalog: verdict.rowsInCatalog ?? null,
    // Staged-row count, so "did every row land?" is answerable from the
    // control doc alone -- the question run 33847867665 needed a log to answer.
    rowsStaged: verdict.rowsStaged ?? null,
    stagedStats: verdict.stats || null,
    lastAttempt: new Date().toISOString(),
    attempts: (verdict.priorAttempts || 0) + 1,
    // THE VERDICT RECORDS WHICH CONVERTER REACHED IT. Without this the queue
    // filter cannot tell a fresh verdict from one recorded before the last
    // bump, so a re-opened entry would be re-opened again on every subsequent
    // run -- a bump that never stops costing. Null for a lane with no declared
    // version, which reads as "unversioned" and changes nothing for it.
    converterVersion: LANE_CONVERTER_VERSION[entry.lane] ?? null,
  };
  await cosmos().container(CONTROL_CONTAINER).items.upsert(doc);
  return doc;
}

/**
 * The catalog's setKey for an entry's set name.
 *
 * A set name is "1952 Topps Baseball" and the catalog key is `topps`: the YEAR
 * is its own column and the SPORT is its own column, so carrying either in the
 * key mints a second product beside the real one. Measured on the dry run --
 * `topps-baseball` counted 0 rows against the 6,115 the catalog actually holds
 * under `topps`, which would have marked a healthy ingest `failed`.
 *
 * Season spans ("2023-24 Upper Deck") lose the span the same way, for the same
 * reason. Anything left empty returns null and the caller REFUSES to verify
 * rather than guessing -- an unverifiable entry is a failed entry, never an
 * assumed-good one.
 */
const SPORT_SUFFIX = /-(baseball|football|basketball|hockey|soccer|pokemon|wrestling|racing|golf|tcg)$/;
function setKeyFor(entry) {
  // POKEMON MATCHES ON THE SET ID, and year is not part of that identity. A
  // ja-exclusive set's name is Japanese ("PMCG1 拡張パック"), which slugifies to
  // nothing at all -- so deriving a key from the name would leave every tcgdexja
  // entry unverifiable and a clean ingest would be recorded `failed`. The set id
  // IS the vocabulary the catalog keys pokemon on (sv3-obsidian-flames), and it
  // is what the sourceRef carries.
  if (entry.lane === "tcgdexja") {
    const id = String(entry.sourceRef || "").split("/").pop();
    return id ? id.toLowerCase() : null;
  }
  let k = slugOf(entry.setName || "");
  k = k.replace(/^(?:19|20)\d{2}(?:-\d{2})?-/, "");
  // ORDER MATTERS. The CLC page titles end "...Baseball Card Checklist", so the
  // sport is only trailing once the checklist words are gone. Stripping the
  // sport first leaves `bowman-baseball` -- a key the catalog does not use.
  // Both are stripped repeatedly until neither applies.
  for (let i = 0; i < 4; i++) {
    const before = k;
    k = k.replace(/-(?:card-)?checklist$/, "");
    k = k.replace(SPORT_SUFFIX, "");
    if (k === before) break;
  }
  return k || null;
}

/** Count catalog rows for this entry's product. The verification is a READ of
 *  what actually landed, never the ingest's own claim -- a green ingest that
 *  wrote nothing is the exact failure this reconciles against. */
/**
 * CF-THE-COUNT-MUST-READ-THE-KEY-THE-CHILD-WROTE (2026-09-04, run 33869931267).
 *
 * `setKeyFor` slugifies the entry's DISPLAY NAME. The child writes under the
 * staged manifest's setKey, which is `normalizeSetKey`'d -- and the two diverge
 * wherever the alias table has an opinion. `finest` -> `topps-finest` is such an
 * alias (#1699), so on the whole bcp Finest family the driver counted a key the
 * ingest never writes:
 *
 *   2026 finest 0        topps-finest 39,480   -> "FAILED -- green ingest, 0 rows landed"
 *   2023 finest 628      topps-finest 20,367   -> "0 rows created, 628 in catalog of 4,526 staged"
 *   2025 finest 2,467    topps-finest 91,015   -> "0 rows created, 2,467 in catalog of 4,933 staged"
 *
 * Every one of those is a MEASUREMENT error. `baseballcardpedia-ladders-
 * 2026-09-04` in fact landed 18,876 rows on 2026, 968 on 2023 and 1,166 on
 * 2025 -- under `topps-finest`, where the driver never looked. The residue
 * sitting under the un-normalized `finest` key is what the count actually read.
 *
 * Resolve the key through the SAME function the child uses. Falls back to the
 * raw slug when dist is not built, so a driver run never dies on this.
 */
let _normalizeSetKey;
function canonicalSetKey(k) {
  if (!k) return k;
  if (_normalizeSetKey === undefined) {
    try { ({ normalizeSetKey: _normalizeSetKey } = require(path.join(HERE, "..", "dist/services/portfolioiq/hobbyIqCardId.service.js"))); }
    catch { _normalizeSetKey = null; }
  }
  if (!_normalizeSetKey) return k;
  try { return _normalizeSetKey(k) || k; } catch { return k; }
}

/**
 * CF-THE-CHILD-MAY-WRITE-EITHER-KEY (2026-09-04).
 *
 * #1738's rule -- "count the key the child WROTE" -- is right, and normalizing
 * is only half of it. `ingest-checklist-csv-to-catalog.cjs` resolves the
 * product as `setKey: m.setKey || normalizeSetKey(m.setName)`, so a manifest
 * that STATES a setKey is honoured VERBATIM and never normalized. Every
 * hobbymonitor manifest states one. The driver, meanwhile, normalized before
 * querying -- so wherever the alias table has an opinion the two diverged and
 * the verification read a key the rows were never written under.
 *
 * That is the whole of the `short ingest` class, and it is a MEASUREMENT
 * error, not lost data. Verified against prod card_catalog:
 *
 *   Sapphire      raw 2,105 rows   vs  topps-chrome-update-series (131,937)
 *                 -- and 2,105 is EXACTLY the count reported missing
 *   Score-A-Treat raw   900 rows   vs  panini-score           (3,343)
 *                 -- and 900 is EXACTLY the count reported missing
 *   Exquisite     raw   705 rows   vs  upper-deck            (44,840)
 *   Topps Three   raw 3,035 rows   vs  topps                (327,392)
 *
 * The named "missing" identities were then read back under the raw key and are
 * present -- SS-8, SS-11 and SS-18 all sit there carrying Gold / Black /
 * Padparadscha Sapphire. Nothing needs re-fetching.
 *
 * So the product is asked for under BOTH spellings and the answers are unioned.
 * A row can only be written under one of them, so the union is the honest
 * count either way, and it is immune to which side of the alias table the
 * manifest happens to sit on -- including when `dist/` is absent and
 * canonicalSetKey falls back to the raw key.
 */
/**
 * CF-THE-DIFF-MUST-READ-THE-KEY-THE-MANIFEST-STATES (2026-09-04).
 *
 * The two rules above -- normalize the key, then ask under both spellings --
 * both RECONSTRUCT the product key from the entry's DISPLAY NAME. The child
 * does no such thing. `productOf` reads the manifest the fetcher wrote and
 * takes `m.setKey` VERBATIM, and since #1741 that key is frequently NOT the
 * display-name slug: a rung or insert page states its PARENT product.
 *
 * Measured today, re-fetching the three pages the failed control docs name:
 *
 *   2004-05 Topps Chrome Town Heroes Basketball
 *     manifest setKey `topps-chrome`   driver setKeyFor `topps-chrome-town-heroes`
 *   2000-01 Topps Gallery Basketball
 *     manifest setKey `topps`          driver setKeyFor `topps-gallery`
 *   2003 Bowman's Best (bcp)
 *     manifest setKey `bowman`         driver setKeyFor `bowman-s-best`
 *
 * Every one is a MEASUREMENT error of the same shape as #1738's, one level
 * further out: normalizing cannot reach it, because `topps-gallery` and
 * `bowmans-best` are RULED products that normalizeSetKey returns unchanged
 * (CF-A-RULED-KEY-IS-A-FIXED-POINT), so no amount of alias resolution turns
 * them into the parent the manifest actually named. Gallery is the proof: it
 * staged 150 clean base rows, the child wrote all 150 under `topps`, and the
 * driver read `topps-gallery`, found 0 and recorded "ingest reported success
 * but the catalog holds 0 rows for this product".
 *
 * THE MANIFEST IS THE WRITER'S OWN STATEMENT of where the rows went, so it
 * leads. The reconstructed keys stay as fallbacks -- an entry staged before
 * the fetcher wrote manifests, or one whose sidecar is missing, must still be
 * verifiable -- and every candidate is unioned, exactly as #1738 established.
 */
function manifestSetKeys(entry, csvPaths) {
  const out = [];
  // THE FILES THIS RUN ACQUIRED, when the caller has them -- the staging index
  // is a disk scan and can miss a directory this run just created.
  const paths = (Array.isArray(csvPaths) && csvPaths.length) ? csvPaths : (stagedFilesFor(entry) || []);
  for (const p of paths) {
    const m = manifestOf(p);
    const k = m && typeof m.setKey === "string" ? m.setKey.trim() : "";
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * CF-A-COLLAPSED-KEY-IS-A-DIFFERENT-PRODUCT (2026-09-06, run 33997480307).
 *
 * The candidate list grew once per defect -- the manifest key (#1739), the
 * reconstructed slug, and the NORMALIZED form of each (#1738, so `finest` can
 * reach `topps-finest`). #1738's widening was right about the key it added and
 * silent about what else that key can name.
 *
 * `normalizeSetKey` is a PRODUCT-FAMILY resolver. Where the vocabulary has no
 * row for a specialization it answers with the FLAGSHIP, and on this run's
 * entries that is most of them:
 *
 *   topps-juventus-team-set            -> topps
 *   topps-chrome-bundesliga            -> topps-chrome
 *   topps-chrome-uefa-champions-league -> topps-chrome
 *   topps-stadium-club-chrome-uefa     -> topps-stadium-club
 *
 * So verifying a 65-row Juventus team set also read `2021/topps`, which holds
 * 147,149 rows of eighty other products. Counted from Cosmos on 2026-09-06:
 *
 *   2021 topps-juventus-team-set        65 rows, ALL source checklistcenter-2026-09-05
 *   2021 topps                     147,149 rows, ZERO from this run
 *   2021 topps-chrome-bundesliga     2,213 rows, ALL source checklistcenter-2026-09-05
 *   2021 topps-chrome               31,898 rows, ZERO from this run
 *
 * Three readings went wrong on that one union, and all twelve "SHORT INGEST"
 * entries of the run are this shape:
 *
 *   `after`   became 147,214 instead of 65, so `created = after - before` was a
 *             difference of two six-figure numbers that other writers move
 *             between the reads. It came out <= 0, and `Math.max(0, ...)`
 *             recorded ZERO ROWS CREATED for an entry that landed 65;
 *   identity  `catalogIdentities` unioned the flagship's identities in, so 914
 *             of 1,017 staged identities read "present" because a card of the
 *             same number and parallel exists somewhere in the flagship pool --
 *             `1|green refractor|0|99` IS in 2021/topps-chrome (baseballcard-
 *             pedia) and is NOT in 2021/topps-chrome-bundesliga -- while the
 *             ~100 genuinely new rungs read "missing";
 *   `before`  was read without csvPaths, so it resolved a different candidate
 *             list than `after` did (fixed at its call site).
 *
 * THE DISTINCTION THAT MATTERS, and why this is not a revert of #1738. A key
 * that is STATED -- by the manifest, or reconstructed from the entry -- is an
 * address someone asserted rows are at, and #1741's rung pages prove both can
 * hold some (25 rows under `topps-chrome-town-heroes` on 2026-09-04). Those
 * stay. What must not be added is a key NOTHING stated, invented by collapsing
 * a stated one onto its parent product: that is not this product under another
 * spelling, it is a DIFFERENT product, and reading it answers a question
 * nobody asked.
 *
 * So a normalization is admitted only when it RESOLVES A SPELLING -- `finest`
 * -> `topps-finest`, the alias #1738 exists for -- and never when it COLLAPSES
 * a specialization, which is recognised by the answer being a strict prefix of
 * the key it came from. `topps-chrome-bundesliga` -> `topps-chrome` is a
 * collapse and is dropped; `finest` -> `topps-finest` is not and is kept.
 */
function collapsesToParent(key, normalized) {
  if (!key || !normalized || key === normalized) return false;
  // The flagship of a specialization is a leading segment of it. `finest` ->
  // `topps-finest` grows and is an alias; `topps-chrome-bundesliga` ->
  // `topps-chrome` shrinks onto its own prefix and is a family collapse.
  return key.startsWith(normalized + "-");
}

function setKeyCandidates(entry, csvPaths) {
  const out = [];
  const add = (k) => { if (k && !out.includes(k)) out.push(k); };
  // THE MANIFEST IS THE WRITER'S OWN STATEMENT of where the rows went, and the
  // child honours it VERBATIM (`setKey: m.setKey || normalizeSetKey(m.setName)`).
  // So when there IS one, normalizing it can only name a product the child did
  // not write to, and a family collapse is dropped.
  const stated = manifestSetKeys(entry, csvPaths);
  for (const k of stated) {
    add(k);
    const norm = canonicalSetKey(k);
    if (!collapsesToParent(k, norm)) add(norm);
  }
  const raw = setKeyFor(entry);
  if (!raw) return out;
  add(raw);
  const rawNorm = canonicalSetKey(raw);
  // WITHOUT a manifest the collapsed key stays. Nothing has stated where the
  // rows went, the child may itself have resolved the name through
  // normalizeSetKey, and a product whose manifest omitted a setKey must still
  // be counted rather than reported wholly missing (#1739's hobbymonitor
  // cases: `topps-three` -> `topps`, `panini-score-a-treat` -> `panini-score`).
  // A wrong guess here costs a false `failed`; dropping it costs a real ingest
  // reported as zero rows. WITH a manifest the guess is not needed, so the
  // collapse is dropped and the shrunken list is the whole point (#1747).
  if (stated.length ? !collapsesToParent(raw, rawNorm) : true) add(rawNorm);
  return out;
}

/**
 * The identities the catalog holds for this entry's product, as the same tuple
 * `stagedIdentity` builds. One cross-partition read of four fields, bounded by
 * (year, setKey) -- the product, never the container.
 */
async function catalogIdentities(entry, csvPaths) {
  const keys = setKeyCandidates(entry, csvPaths);
  if (!keys.length) return null;
  if (entry.lane !== "tcgdexja" && !entry.year) return null;
  const byKeyOnly = entry.lane === "tcgdexja";
  const out = new Set();
  let answered = false;
  for (const setKey of keys) {
    const q = byKeyOnly
      ? { query: "SELECT c.cardNumber, c.parallel, c.isAuto, c.printRun FROM c WHERE c.setKey = @k", parameters: [{ name: "@k", value: setKey }] }
      : {
          query: "SELECT c.cardNumber, c.parallel, c.isAuto, c.printRun FROM c WHERE c.year = @y AND c.setKey = @k",
          parameters: [{ name: "@y", value: Number(entry.year) }, { name: "@k", value: setKey }],
        };
    const { resources } = await cosmos().container("card_catalog").items.query(q).fetchAll();
    // ONLY A PROJECTION ANSWERS THIS QUESTION. A driver whose Cosmos layer hands
    // back something other than the {cardNumber,...} rows asked for cannot be
    // read as "the catalog holds none of these" -- that would report every staged
    // identity missing and fail a healthy entry. Refuse to answer instead, and
    // the caller falls back to the count checks.
    if (!Array.isArray(resources)) continue;
    if (resources.length && !resources.some((r) => r && typeof r === "object" && "cardNumber" in r)) continue;
    answered = true;
    for (const r of resources) {
      if (!r || typeof r !== "object") continue;
      out.add(stagedIdentity({
        cardNumber: r.cardNumber,
        parallel: r.parallel,
        isAuto: r.isAuto === true ? "true" : "false",
        printRun: r.printRun,
      }));
    }
  }
  // Not one candidate gave a readable projection: the same "cannot answer"
  // the single-key form returned null for.
  return answered ? out : null;
}

async function countCatalogRows(entry, csvPaths) {
  const keys = setKeyCandidates(entry, csvPaths);
  if (!keys.length) return null;
  // Pokemon identity is the setKey alone -- year is NOT part of it, and gating
  // on year here read as a false zero for every tcgdex set. Every other lane
  // needs the year, because `topps` without one spans eighty products.
  const byKeyOnly = entry.lane === "tcgdexja";
  if (!byKeyOnly && !entry.year) return null;
  let total = 0;
  for (const setKey of keys) {
    const q = byKeyOnly
      ? { query: "SELECT VALUE COUNT(1) FROM c WHERE c.setKey = @k", parameters: [{ name: "@k", value: setKey }] }
      : {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.year = @y AND c.setKey = @k",
          parameters: [{ name: "@y", value: Number(entry.year) }, { name: "@k", value: setKey }],
        };
    const { resources } = await cosmos().container("card_catalog").items.query(q, { maxItemCount: 1 }).fetchAll();
    total += Number(resources[0] ?? 0) || 0;
  }
  return total;
}

/**
 * CF-THE-VERIFICATION-MUST-COUNT-THE-ROWS-THIS-RUN-WROTE (2026-09-04).
 *
 * countCatalogRows counts EVERY row of a (year, setKey), whatever wrote it.
 * That is the right number for "did this product end up populated", and the
 * wrong number for "did MY ingest land". Measured for 1984 Topps Traded
 * Tiffany after run 33854416984:
 *
 *   sportscardchecklist-2026-09-04            132   <- the checklist
 *   derived-from-base-checklist-2026-08-23      1   } rows we SYNTHESISED from
 *   derived-from-base-checklist-2026-08-23-...   3   } sales, not a checklist
 *                                             ----
 *                                              136   <- what the driver read
 *
 * So the run reported "136 in catalog, 0 rows created" -- 0 because the 132
 * were already there from the staging pass, and 136 because four synthetic
 * rows were counted as if they were checklist rows. Neither number answers the
 * question the operator asked, which is "are the 132 staged rows in the
 * catalog under the source that staged them".
 *
 * This counts by SOURCE. It is a strictly additional read, used for the
 * verdict's `rowsUnderSource` field and printed in the banner; the existing
 * whole-product count is unchanged, because the truncation and partial rules
 * are written against it.
 */
async function countCatalogRowsBySource(entry, source, csvPaths) {
  // THE THIRD READ SITE, and it had the original defect in its rawest form:
  // the bare slug, with no alias resolution at all. It reads the same product
  // as the two above and must resolve the key the same way, or the banner's
  // by-source number lands on a different product than the verdict it sits
  // beside (CF-THE-CHILD-MAY-WRITE-EITHER-KEY).
  const keys = setKeyCandidates(entry, csvPaths);
  if (!keys.length || !source) return null;
  const byKeyOnly = entry.lane === "tcgdexja";
  if (!byKeyOnly && !entry.year) return null;
  let total = 0;
  for (const setKey of keys) {
    const q = byKeyOnly
      ? {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.setKey = @k AND c.source = @s",
          parameters: [{ name: "@k", value: setKey }, { name: "@s", value: source }],
        }
      : {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.year = @y AND c.setKey = @k AND c.source = @s",
          parameters: [{ name: "@y", value: Number(entry.year) }, { name: "@k", value: setKey }, { name: "@s", value: source }],
        };
    const { resources } = await cosmos().container("card_catalog").items.query(q, { maxItemCount: 1 }).fetchAll();
    total += Number(resources[0] ?? 0) || 0;
  }
  return total;
}

/**
 * CF-A-CANARY-SHOULD-HIT-THE-CARDS-THAT-SELL (2026-09-04).
 *
 * The queue was manifest order, which is year-then-name -- so a LIMIT=20 canary
 * on YEARS=1990..2026 spent all twenty entries in 1990, starting at "Baseball
 * Wit": an oddball with no parallel ladder and, per the 2026-09-03 probe, no
 * autograph section either, because certified autos are a 1990s-ONWARD feature
 * and 1990 is the boundary year itself. Twenty pages of the least valuable end
 * of the lane prove nothing about a re-scrape whose whole purpose is autographs.
 *
 * ORDER BY VALUE. Two mechanisms, in priority order:
 *
 *   1. AN EXPLICIT LIST WINS. `titles` is an EXISTING runner input, exported as
 *      BCP_TITLES, and naming the exact pages is both the cheapest ranking and
 *      the most honest one -- the operator states the order and the banner
 *      prints it back. Entries match on page title, set name, "<year> <name>"
 *      or sourceRef, so the same list works whichever the operator has to hand.
 *      Named entries lead, in the order given; the rest follow beneath, so a
 *      LIMIT larger than the list still runs a full budget.
 *
 *   2. OTHERWISE, AN INTRINSIC PROXY, NOT A COSMOS READ. Ranking by real pool
 *      rows would need a sold_comps aggregate per (year, setKey) across 2,637
 *      entries -- a cross-partition GROUP BY over a 16M-row container, spent on
 *      the driver's own budget before it acquires anything. That cost is the
 *      whole reason mechanism 1 exists. What the manifest ALREADY holds is
 *      enough to sort the HEAD of the list correctly: the flagship chrome and
 *      prospect products carry the auto ladders and the liquid cards, and the
 *      probe measured autograph yield rising by decade. So the proxy is
 *      product family + era, computed from fields already in hand, at zero RU.
 *
 * This is a PROXY and says so. It decides which twenty a canary sees; it is not
 * a claim about any card's price, and nothing downstream reads it. When the
 * ranking matters more than its cost, pass the list.
 */
const VALUE_FAMILIES = [
  [/\btopps chrome\b/i, 98],
  [/\bbowman chrome\b/i, 96],
  [/\bbowman'?s best\b/i, 88],
  [/\bbowman\b/i, 84],
  [/\bprizm\b/i, 80],
  [/\bfinest\b/i, 78],
  [/\boptic\b/i, 74],
  [/\btopps\b/i, 72],
  [/\bselect\b/i, 68],
  [/\bsp authentic\b|\bupper deck\b/i, 60],
  [/\bleaf\b|\bdonruss\b|\bfleer\b|\bscore\b|\bpanini\b/i, 50],
];
function valueRank(entry) {
  const name = String(entry.setName || "");
  let family = 10;
  for (const [re, w] of VALUE_FAMILIES) if (re.test(name)) family = Math.max(family, w);
  // The autograph-yield gradient the 2026-09-03 probe measured: 0% pre-1990,
  // then rising by decade. Bounded so era NUDGES the family order rather than
  // replacing it -- a 2024 oddball must not outrank 2011 Topps Chrome.
  const y = Number(entry.year) || 0;
  const era = y >= 2010 ? 20 : y >= 2000 ? 14 : y >= 1990 ? 6 : 0;
  // A seeded partial is a page we already hold rows for, so a re-scrape gains
  // the delta rather than a first fill -- which is exactly what a recheck is.
  const seeded = entry.seededStatus === "partial" ? 4 : 0;
  // THE FLAGSHIP OUTRANKS ITS SPECIALIZATIONS (memory: product-family ladder).
  // Family alone put "2020 Topps Chrome Ben Baller Edition" and "Bowman Chrome
  // Mini" above 2011 Topps Chrome itself -- they match the same family regex and
  // sit in a later era. But the flagship is the product that carries the pool:
  // the base rookie, the auto ladder, the sales. A specialization is a narrow
  // side product with a fraction of the rows. The test is the page name itself:
  // a name that IS the family, with nothing trailing, is the flagship.
  const bare = name.replace(/^(?:19|20)\d{2}(?:-\d{2})?\s+/, "").trim();
  const flagship = VALUE_FAMILIES.some(([re]) => { const m = bare.match(re); return m && m[0].length >= bare.length - 1; }) ? 30 : 0;
  return family + era + seeded + flagship;
}

/**
 * CF-A-STAGED-CSV-LEADS-ITS-LANE (2026-09-04).
 *
 * Run 33845979897's queue put 2014 XY2/XY3/XY4 first and the 52 modern JA sets
 * that #1702 had ALREADY STAGED -- CSVs and manifests committed to the repo --
 * behind them. The proxy is not wrong about value; it simply cannot see the
 * work already done. Both groups score family 10 + era 20; the vintage XY rows
 * carry `seededStatus: "partial"` for its +4 and the staged modern sets are
 * seeded `missing`, so the entries with a checklist in hand sorted LAST.
 *
 * That cost the whole run: the three vintage sets ahead of them are empty at
 * tcgdex, the lane aborted on the streak, and none of the 52 was attempted.
 *
 * An entry whose checklist is already on disk is the cheapest and surest work
 * in the lane -- no fetch, no source outage, no rate limit between us and the
 * rows. So it leads, ahead of the value proxy, and the ordering says so in the
 * banner. Keyed by the staged manifest's own `sourceUrl`, which is the address
 * the universe entry was built from, so no name normalization can drift.
 */
/** The committed staging root. Overridable so a test can point the staged-file
 *  rule at a fixture instead of the repo's own checklists. */
const CHECKLIST_DIR = process.env.CHECKLIST_DIR || path.join(HERE, "..", "data", "checklists");
let _stagedIndex = null;
/**
 * The staged index: sourceUrl -> the CSV(s) staged under it, WITH their
 * manifest sidecars. One page may stage several scope files, so the value is a
 * list and the entry-level gate judges all of them together, exactly as it
 * does for a freshly-acquired page.
 */
function stagedIndex() {
  if (_stagedIndex) return _stagedIndex;
  const byRef = new Map();
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (!d.name.endsWith(".manifest.json")) continue;
      // A manifest with no CSV beside it is not staged work.
      const csv = full.replace(/\.manifest\.json$/, ".csv");
      if (!fs.existsSync(csv)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(full, "utf8"));
        if (!m || !m.sourceUrl) continue;
        const ref = String(m.sourceUrl);
        if (!byRef.has(ref)) byRef.set(ref, []);
        byRef.get(ref).push({ csv, manifest: full, source: m.source ? String(m.source) : null });
      } catch { /* an unreadable manifest simply stages nothing */ }
    }
  };
  walk(CHECKLIST_DIR);
  // Sorted, so a re-run reads a page's scope files in the same order.
  for (const v of byRef.values()) v.sort((a, b) => a.csv.localeCompare(b.csv));
  _stagedIndex = byRef;
  return byRef;
}

function stagedSourceRefs() {
  return new Set(stagedIndex().keys());
}

/** The staged CSV+manifest pairs for this entry, keyed by the manifest's own sourceUrl. */
function stagedFilesFor(entry) {
  return stagedIndex().get(String(entry?.sourceRef || "")) || [];
}

/** True when this entry's checklist is already staged on disk. */
function isStaged(entry) {
  return stagedFilesFor(entry).length > 0;
}

/**
 * Order the eligible queue. `titlesRaw` is the operator's explicit list (the
 * existing `titles` input / BCP_TITLES env); empty means use the proxy.
 *
 * Returns { queue, mode, named, unmatched }. `unmatched` is REPORTED, never
 * silently dropped: a mistyped title that quietly ranked nothing would leave
 * the canary back on alphabetical order while the banner claimed otherwise,
 * which is the exact failure this ordering exists to prevent.
 */
function orderQueue(queue, titlesRaw) {
  const wanted = String(titlesRaw || "").split(",").map((t) => t.trim()).filter(Boolean);
  // Stable: equal rank keeps manifest order, so a re-dispatch takes the same
  // twenty rather than a fresh shuffle of a tie. STAGED FIRST, then the value
  // proxy within each group -- work already on disk cannot be lost to a source
  // outage, so it never queues behind work that can.
  const byValue = (qs) => {
    const decorated = qs.map((q, i) => ({ q, i, s: isStaged(q.entry) ? 1 : 0, r: valueRank(q.entry) }));
    decorated.sort((a, b) => (b.s - a.s) || (b.r - a.r) || (a.i - b.i));
    return { queue: decorated.map((d) => d.q), staged: decorated.filter((d) => d.s).length };
  };
  if (!wanted.length) {
    const { queue: sorted, staged } = byValue(queue);
    return {
      queue: sorted,
      mode: staged
        ? `staged-first (${staged} with a checklist on disk), then value-proxy (product family + era)`
        : "value-proxy (product family + era)",
      named: 0,
      unmatched: [],
      staged,
    };
  }
  const norm = (v) => String(v || "").toLowerCase().replace(/[_\s]+/g, " ").replace(/[^a-z0-9 ]+/g, "").trim();
  const keysOf = (e) => {
    const title = decodeURIComponent(String(e.sourceRef || "").split("/index.php/")[1] || "");
    return new Set([norm(title), norm(e.setName), norm(`${e.year} ${e.setName}`), norm(e.sourceRef)].filter(Boolean));
  };
  const lead = [], rest = [...queue], unmatched = [];
  for (const w of wanted) {
    const nw = norm(w);
    const at = rest.findIndex((q) => keysOf(q.entry).has(nw));
    if (at < 0) { unmatched.push(w); continue; }
    lead.push(rest.splice(at, 1)[0]);
  }
  // CF-THE-REST-FOLLOW-BENEATH-IN-VALUE-ORDER (2026-09-04, run 33852199385).
  //
  // `rest` used to be the eligible queue in MANIFEST order, which for bcp is
  // alphabetical. So the canary named four Chrome pages, ingested them, and
  // then spent entries 5-20 on 1990 Baseball Wit, Bazooka, Bowman, Classic,
  // Donruss ... -- the alphabetical head of 1990, the least valuable end of the
  // lane, and precisely the order #1708's proxy exists to prevent. The docblock
  // above already promised "the rest follow beneath"; it never said in what
  // order, and the code answered "alphabetically".
  //
  // The two mechanisms are not alternatives. The explicit list ranks what the
  // operator named; the proxy ranks EVERYTHING ELSE. A LIMIT larger than the
  // list is the normal case -- 4 named, 20 taken -- so the remainder is most of
  // what actually runs, and it gets the same staged-first + family + era order
  // it would get with no titles at all.
  const { queue: restSorted, staged } = byValue(rest);
  return {
    queue: [...lead, ...restSorted],
    mode: `explicit list (titles / BCP_TITLES), then ${staged ? `staged-first (${staged} on disk), then ` : ""}value-proxy (product family + era) for the rest`,
    named: lead.length,
    unmatched,
    staged,
  };
}


// ── main ────────────────────────────────────────────────────────────────────

// The gate is exported so its rules can be asserted directly against fixture
// CSVs, rather than only through a full acquisition. `require`d as a module the
// script does nothing; run as a CLI it drives.

// EVERY LANE acquireEntry CAN DISPATCH MUST HAVE A PLAN, checked at load rather
// than on the first dispatch of a new lane. This is the half that a shared
// function alone does not buy: planFor and acquireEntry could still drift apart
// by one of them gaining a lane the other never heard of, and the report would
// print "would drive: undefined" -- which is precisely the silent shape that
// let the sportscardchecklist apply path ship untested.
for (const lane of ACQUIRE_LANES) {
  if (!planFor({ lane, sourceRef: "" })) {
    throw new Error(`lane ${lane} is dispatchable by acquireEntry but planFor cannot describe it — report mode would print "would drive: undefined"`);
  }
}

module.exports = { collapsesToParent, streakAfter, RUNNER_SCOPE_VARS, gateStagedCsv, gateStagedEntry, ladderIsAttested, setKeyCandidates, canonicalSetKey, TERMINAL_STATUSES, LANES_WITH_SIBLING_PARALLEL_PAGES, ladderOnSiblingPages, allFilesAreParallelOfParent, CARTESIAN_MIN_RUNGS, CARTESIAN_MIN_CARDS, stagedCsvs, LANES_WITHOUT_PRINT_RUNS, LANES_WITH_BASELESS_PRODUCTS, LANES_WITH_VINTAGE_ERA_PRODUCTS, PARALLEL_ERA_FIRST_YEAR, ladderlessByEra, sourceLabelFor, splitCsv, isPersonName, setKeyFor, planFor, tcgdexModern, acquireStaged, ACQUIRE_LANES, LANE_ALIASES, LANE_SOURCE, LANE_MINUTES, CANONICAL_HEADER, CHILD_STDERR_LINES, childBannerLines, CHILD_BANNER_PATTERNS, CHILD_BANNER_LINES, childCounters, childRefusedEverything, CHILD_COUNTERS, REFUSED_STATUS, cosmosSafeId, controlId, orderQueue, SYSTEMIC_FAILURE_STREAK, EMPTY_STATUS, SHORT_STATUS, STREAK_STATUSES, isStaged, stagedSourceRefs, stagedIndex, stagedFilesFor, acquireFromStaging, LANE_CONVERTER_VERSION, stagedConverterVersion, stagedIsCurrent };
if (require.main !== module) return;

(async () => {
  // REFUSALS BEFORE REQUIRES.
  const rawSource = String(process.env.SOURCES || "").trim().toLowerCase();
  if (!rawSource) {
    console.error("REFUSE: SOURCES is required and has no default — name exactly one lane:");
    console.error("        hobbymonitor | insider | bcp | beckett | clc | tcgdexja | sportscardchecklist  (tcdb is refused, see below)");
    process.exit(2);
  }
  if (rawSource.includes(",")) {
    console.error(`REFUSE: SOURCES names one lane per dispatch (got "${rawSource}") — dispatch once per lane so each has its own budget and its own reconciliation`);
    process.exit(2);
  }
  const lane = LANE_ALIASES[rawSource];
  if (!lane) {
    console.error(`REFUSE: unknown lane "${rawSource}" — known: ${Object.keys(LANE_ALIASES).join(", ")}`);
    process.exit(2);
  }
  if (lane === "tcdb") {
    console.error("REFUSE: tcdb has no enumerable universe and no manifest entries.");
    console.error("        D37 measured scrape-tcdb.cjs extracting 0 rows and exiting 0 on a 403 block, writing");
    console.error("        an empty CSV and a manifest naming the set \"Trading Card Database\" (the block page's");
    console.error("        title). It stays a per-URL backup, and it needs a refusal-on-zero-rows guard of its");
    console.error("        own before any driver trusts it. Driving it here would record fabricated successes.");
    process.exit(2);
  }
  // REFUSE THE UNSTAMPABLE LANE UP FRONT. The ingest child checks the source
  // name it is handed and exits 2, which is correct -- but it does so per
  // ENTRY, after a fetch, so a lane whose name the authority vocabulary does
  // not know burns a fetch and a verdict per entry until the systemic tripwire
  // stops it. That is exactly what run 33839532087 spent its budget on. The
  // name is knowable before the first fetch, so it is checked before the first
  // fetch, and the refusal names the file the declaration lives in.
  {
    let label;
    try { label = sourceLabelFor(lane); }
    catch { console.error(`REFUSE: no checklist source name declared for lane "${lane}" — add it to LANE_SOURCE`); process.exit(2); }
    let authorityOf = null;
    try { ({ catalogAuthorityOf: authorityOf } = require(path.join(HERE, "..", "dist/services/catalog/catalogAuthority.service.js"))); }
    catch { /* dist not built (a unit-test run); the child re-checks anyway */ }
    if (authorityOf && authorityOf(label) !== "checklist") {
      console.error(`REFUSE: lane "${lane}" would stamp source="${label}", which catalogAuthority classifies as ${authorityOf(label)}, not checklist.`);
      console.error(`        Rows written under it rank BELOW the derived rows this ingest exists to correct, so`);
      console.error(`        ingest-checklist-csv-to-catalog.cjs refuses them one entry at a time, after the fetch.`);
      console.error(`        Fix LANE_SOURCE here, or declare the name in catalogAuthority.service.ts.`);
      process.exit(2);
    }
    // CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew,
    // 2026-09-05). A demoted lane still INGESTS -- the gate above is about
    // whether the stamped name is a checklist at all, and hobbymonitor's is.
    // The demotion is a question about a ROW ("does a second strict source
    // agree on this cell?"), and at this point in the run no row exists yet:
    // the fetch has not happened, the CSV is not written, and the cell the
    // corroboration read needs is not knowable. Asking it here would be asking
    // it of nothing.
    //
    // So the driver SAYS SO instead of guessing, and the demotion is applied
    // where the rows are: identityBackingOf at pricing time, and
    // K.isStrictChecklistRow in the rematch. hobbymonitor's 1,192,925 rows are
    // the ONLY transcription most modern Panini releases have (2022
    // panini-select alone is 28,497 rows with no second source), so refusing
    // the lane would take coverage away rather than add accuracy -- absent
    // beats wrong only when the alternative is a better row, and here it is no
    // row (see sourceCorroboration.ts's header).
    //
    // THE NAME IS CHECKED, NOT THE MODULE LOADED. Requiring the corroboration
    // bridge here costs a `dist/` load on EVERY driver spawn -- measured at
    // +43s across this file's own suite (87s -> 130s), which is enough to blow
    // a 30s per-test budget under a parallel run. This banner is cosmetic and
    // the demotion is enforced elsewhere, at pricing and rematch time, where
    // the ONE predicate genuinely runs. So the lane names are compared against
    // the exported list, which is a string comparison and free.
    //
    // The list is duplicated NOWHERE: `sourceCorroboration.ts` is the single
    // definition and this is a banner, not a decision. If the two ever drift
    // the only consequence is a missing NOTE line -- no row is classified here.
    // `ingestUniverseDriverDemotedLaneBanner.test.ts` pins them equal anyway.
    const DEMOTED_LANE_NAMES = ["hobbymonitor"];
    const laneStem = String(label).toLowerCase().replace(/-\d{4}-\d{2}-\d{2}.*$/, "");
    if (DEMOTED_LANE_NAMES.some((n) => laneStem === n || laneStem.startsWith(`${n}-`))) {
      console.log(`NOTE: lane "${lane}" stamps source="${label}", a DEMOTED source (Drew 2026-09-05).`);
      console.log(`      Its rows ingest normally and are re-keyable and outrank derived stubs, but they count`);
      console.log(`      as checklist-BACKED only where a second strict source agrees on (year, setKey,`);
      console.log(`      cardNumber, parallel, isAuto) and on the player. That is judged per row, after the`);
      console.log(`      write, by identityBackingOf and the rematch -- not here, where no row exists yet.`);
    }
  }
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("REFUSE: COSMOS_CONNECTION_STRING not set"); process.exit(2); }
  if (!fs.existsSync(MANIFEST_PATH)) { console.error(`REFUSE: manifest not found at ${MANIFEST_PATH}`); process.exit(2); }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const years = String(process.env.YEARS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sports = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let candidates = manifest.entries.filter((e) => e.lane === lane);
  const laneTotal = candidates.length;
  if (years.length) candidates = candidates.filter((e) => years.includes(String(e.year)));
  if (sports.length) candidates = candidates.filter((e) => sports.includes(String(e.sport || "").toLowerCase()));

  /**
   * CF-A-404-BELONGS-TO-THE-HOST-THAT-SERVED-IT (2026-09-04).
   *
   * The unreachable list travels with the manifest so a run never spends its
   * budget re-probing what a direct 404 already settled. But the mark was keyed
   * `sport|year|setKey` -- the SET, with no lane and no sourceRef in it -- so it
   * settled the set everywhere, on every host, forever.
   *
   * Run 33841276495 is what that costs. `football|1972|topps` is on the list
   * because the lanes that existed when it was probed could not serve it. #1710
   * then added sportscardchecklist, whose sitemap survey fetched that very set
   * (set-11959, 351 cards) without trouble, and the manifest RECORDS this:
   *
   *   nowCoveredBy: "sportscardchecklist"
   *   note: "...the mark records that the ORIGINAL lane could not reach it"
   *
   * The driver read neither field. It matched the set key, printed
   * "UNREACHABLE — direct 404 probe, no lane serves it", and skipped an entry
   * seeded `missing` that a working lane was standing right there to fetch. 7
   * of the 8 marks carry nowCoveredBy, so the new lane was inheriting almost
   * the whole list as permanent refusals.
   *
   * A 404 is a fact about a URL, so the mark is keyed by the lane whose
   * sourceRef earned it. A record naming the lane it belongs to binds only that
   * lane; `nowCoveredBy` releases the lane that has since been proven to serve
   * it; and a legacy record naming neither keeps its old set-wide reach for the
   * lanes that existed when it was written, which is the only reading under
   * which it was ever true.
   */
  const unreachableMarks = (manifest.unreachable || []).map((u) => ({
    key: `${u.sport}|${u.year}|${u.setKey}`,
    lane: u.lane || null,
    sourceRef: u.sourceRef || null,
    nowCoveredBy: u.nowCoveredBy || null,
  }));
  const isUnreachable = (entry) => {
    const key = `${entry.sport}|${entry.year}|${setKeyFor(entry) || ""}`;
    return unreachableMarks.some((m) => {
      if (m.key !== key) return false;
      // Proven reachable HERE since the probe: the mark is history, not a veto.
      if (m.nowCoveredBy && m.nowCoveredBy === entry.lane) return false;
      // A mark that names its own address binds that address only.
      if (m.sourceRef) return m.sourceRef === entry.sourceRef;
      if (m.lane) return m.lane === entry.lane;
      return true;
    });
  };

  const perEntryMin = LANE_MINUTES[lane] || 1.5;
  const budgetSized = Math.max(1, Math.floor((RUN_MS / 60000) * 0.85 / perEntryMin));
  const LIMIT = Number(process.env.LIMIT || 0) || budgetSized;

  console.log(`── ingest-universe-driver ──`);
  console.log(`  lane          ${lane}${rawSource !== lane ? ` (dispatched as "${rawSource}")` : ""}`);
  console.log(`  manifest      ${path.relative(process.cwd(), MANIFEST_PATH)}  (${f(manifest.entries.length)} entries, ${f(laneTotal)} in this lane)`);
  console.log(`  scope         years=${years.join(",") || "(all)"}  sports=${sports.join(",") || "(all)"}  ${RECHECK ? "RECHECK (re-attempt verdicted entries)" : "pending only"}`);
  // The two signals are separate and the banner says which is armed, because
  // "why did it re-scrape" must be answerable from the log alone.
  console.log(`  staged        ${REFETCH ? "REFETCH (MODE=refetch) — live fetch forced, any staged CSV is IGNORED" : `a gate-clean staged CSV WINS (no fetch) while its converter is current${LANE_CONVERTER_VERSION[lane] ? ` (v${LANE_CONVERTER_VERSION[lane]})` : ""}; MODE=refetch forces the live fetch`}`);
  console.log(`  budget        ${RUN_MS / 60000}m  →  N=${f(LIMIT)} entries @ ~${perEntryMin}m each`);
  console.log(`  mode          ${APPLY ? "APPLY" : "REPORT ONLY (no acquisition, no writes)"}\n`);

  // Read the existing verdicts so a relaunch continues rather than re-doing the
  // head of the list forever.
  const priorById = new Map();
  {
    const { resources } = await cosmos().container(CONTROL_CONTAINER).items.query({
      query: "SELECT c.entryId, c.status, c.attempts, c.converterVersion FROM c WHERE c.docType = 'ingest_universe_status' AND c.lane = @l",
      parameters: [{ name: "@l", value: lane }],
    }).fetchAll();
    for (const r of resources) priorById.set(r.entryId, r);
  }
  console.log(`  control docs  ${f(priorById.size)} already carry a verdict for this lane\n`);

  // `empty` is terminal too: re-fetching a set the source does not card burns
  // a request and a verdict per run to learn the same thing. SCOPE=recheck is
  // the way back once tcgdex grows the cards.
  const TERMINAL = TERMINAL_STATUSES;
  /**
   * CF-A-CONVERTER-BUMP-RE-OPENS-ITS-OWN-VERDICTS (2026-09-06).
   *
   * #1875 stamped the converter version and taught `acquireFromStaging` to pass
   * over a stale staged file. That is HALF the mechanism, and the missing half
   * made the whole thing inert: the stamp is read inside acquireFromStaging,
   * which runs only for an entry that already reached the queue -- and the
   * filter below drops every terminal verdict BEFORE that.
   *
   * So a converter fix re-opened nothing. Measured today after #1878, on the
   * baseball 1948-1969 cell: 107 entries, 97 of them terminal (94 `partial`,
   * 2 `short-ingest`, 1 `empty`), which a pending-only walk skips outright --
   * including both 1957 entries the fix was written for. The run reported
   * "nothing intended", exactly as observed.
   *
   * A VERDICT IS A STATEMENT ABOUT AN OUTPUT, and when the code that produces
   * that output changes, the statement is stale -- not wrong, but no longer
   * evidence. So a terminal verdict recorded by an OLDER converter re-enters the
   * queue on its own, which is what the stamp was built to do and could not.
   *
   * NARROW BY CONSTRUCTION:
   *   - only lanes that declare a version (sportscardchecklist alone today);
   *   - only when the verdict records a version OLDER than current -- a verdict
   *     already at the current version stays terminal, so a re-dispatch after
   *     this run does NOT re-walk the same entries again;
   *   - the `failed` attempts ceiling is untouched, so a lane that is broken
   *     for its own reasons still stops after three tries.
   *
   * An UNSTAMPED verdict counts as older, which is every verdict recorded
   * before this shipped -- that is the population a bump has to re-open, and it
   * happens exactly once per bump.
   */
  const staleByConverter = (prior) => {
    const current = LANE_CONVERTER_VERSION[lane];
    if (!current || !prior) return false;
    const at = Number(prior.converterVersion);
    return !(Number.isFinite(at) && at >= current);
  };
  const queue = [];
  let reopened = 0;
  for (const e of candidates) {
    const prior = priorById.get(e.id);
    if (prior && !RECHECK && TERMINAL.has(prior.status)) {
      if (!staleByConverter(prior)) continue;
      reopened++;
    }
    if (prior && !RECHECK && prior.status === "failed" && (prior.attempts || 0) >= 3) continue;
    queue.push({ entry: e, prior });
  }
  if (reopened) {
    console.log(`  converter     v${LANE_CONVERTER_VERSION[lane]} re-opened ${f(reopened)} terminal verdict(s) recorded by an older converter`);
  }

  // ORDER BEFORE TAKING. The slice below is the run; ordering after it would
  // only shuffle the twenty already chosen by alphabet.
  const ordering = orderQueue(queue, process.env.BCP_TITLES || process.env.TITLES || "");
  queue.length = 0; queue.push(...ordering.queue);
  console.log(`  order         ${ordering.mode}${ordering.named ? `  —  ${f(ordering.named)} named entries lead` : ""}`);

  /**
   * CF-AN-UNMATCHED-TITLE-REFUSES (2026-09-04, run 33872976786).
   *
   * The operator dispatched titles="1991 Topps Traded Tiffany" limit=1 apply=true.
   * The title ranked NOTHING -- the entry was already `ingested`, so the TERMINAL
   * filter above had dropped it from `queue` before orderQueue ever saw it -- and
   * the driver printed "the run continues on the rest", took the next entry by
   * value-proxy (1991 Bowman), got EMPTY, and reported RECONCILED yes. A green
   * run, zero rows, and the ONE set the operator named never fetched.
   *
   * An explicit list is not a ranking hint, it is the SCOPE of the run. Naming a
   * title the lane cannot serve is an operator error, and the only safe answer is
   * to refuse: exit non-zero with intended 0, so nothing is acquired and the run
   * goes RED rather than laundering a typo into a green no-op on a set nobody
   * asked for. The banner names each unmatched title and its nearest manifest
   * neighbours, because "check the page title against the manifest sourceRef"
   * without the manifest in front of you is not actionable.
   *
   * The sibling half is CF-LIMIT-MUST-NOT-PAD-AN-EXPLICIT-LIST below: when SOME
   * titles match, only the matched entries may run.
   */
  if (ordering.unmatched.length) {
    const nrm = (v) => String(v || "").toLowerCase().replace(/[_\s]+/g, " ").replace(/[^a-z0-9 ]+/g, "").trim();
    // Nearest neighbours by shared-word count against every title this lane can
    // serve -- INCLUDING entries already verdicted, since "no such page" and
    // "that page is already ingested" are different operator errors and the
    // banner has to let them be told apart.
    const universe = candidates.map((e) => ({ label: `${e.year} ${e.setName}`, key: nrm(`${e.year} ${e.setName}`) }));
    console.error(`\n  REFUSE        ${ordering.unmatched.length} title(s) in the explicit list matched no entry of this lane and ranked NOTHING.`);
    console.error(`                An explicit \`titles\` list is the SCOPE of the run, not a ranking hint —`);
    console.error(`                falling through to unrequested entries is how a typo ships as a green no-op.`);
    for (const u of ordering.unmatched) {
      const nu = new Set(nrm(u).split(" ").filter(Boolean));
      const near = universe
        .map((c) => ({ label: c.label, score: c.key.split(" ").filter((w) => nu.has(w)).length }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      console.error(`                  "${u}"`);
      if (near.length) console.error(`                     nearest in manifest: ${near.map((n) => `"${n.label}"`).join(", ")}`);
      else console.error(`                     nearest in manifest: (no entry of this lane shares a word with it)`);
    }
    console.error(`\n  intended            0   (refused before any acquisition)`);
    console.error(`  RECONCILED          yes  —  intended 0 = written 0 + skipped 0`);
    console.error(`[ingest-universe-driver] reconciled: intended 0 = written 0 + skipped 0`);
    console.error(`  universe_entries_done=0`);
    process.exit(6);
  }

  /**
   * CF-LIMIT-MUST-NOT-PAD-AN-EXPLICIT-LIST (2026-09-04).
   *
   * `limit` sizes a budget when the driver is choosing its own work. It must not
   * choose work when the operator already did: titles=<one page> limit=20 means
   * "that page", not "that page and nineteen others you picked for me". The
   * value proxy still orders the remainder; it just never gets taken here.
   */
  const namedScoped = ordering.named > 0;
  const effectiveLimit = namedScoped ? Math.min(LIMIT, ordering.named) : LIMIT;
  if (namedScoped && effectiveLimit < LIMIT) {
    console.log(`  scoped        explicit list of ${f(ordering.named)} — limit ${f(LIMIT)} will NOT pad with unrequested entries`);
  }
  console.log(`  ${f(queue.length)} entries eligible; taking up to ${f(effectiveLimit)}`);
  for (const q of queue.slice(0, Math.min(effectiveLimit, 5))) console.log(`                  → ${q.entry.year} ${q.entry.setName}`);
  console.log("");

  // RECONCILIATION: intended is fixed BEFORE the loop and every entry lands in
  // exactly one bucket, counted directly. A remainder derived by subtraction
  // balances by construction and can never disagree with itself.
  const take = queue.slice(0, effectiveLimit);
  const intended = take.length;
  const verdicts = { ingested: 0, partial: 0, failed: 0, unreachable: 0, [EMPTY_STATUS]: 0, [SHORT_STATUS]: 0, [REFUSED_STATUS]: 0 };
  let notReached = 0, rowsCreatedTotal = 0;
  // Report mode reconciles against what it INSPECTED. Counting a dry run's
  // deliberate zero writes as a shortfall reports a false imbalance and, worse,
  // exits non-zero -- which would stop the very relaunch that is working.
  let inspected = 0;
  const perEntry = [];
  let stoppedOnBudget = false;
  // The systemic-failure tripwire's state. A refusal is a per-entry verdict; a
  // STREAK of them is the lane. See CF-A-REFUSED-ENTRY-IS-NOT-A-BROKEN-LANE.
  let consecutiveFailures = 0, controlWriteFailures = 0, systemicAbort = null;

  for (let i = 0; i < take.length; i++) {
    const { entry, prior } = take[i];
    if (left() < perEntryMin * 60000 * 1.5) { notReached = take.length - i; stoppedOnBudget = true; break; }

    const label = `${entry.lane}/${entry.setName || entry.sourceRef}`;
    if (isUnreachable(entry)) {
      verdicts.unreachable++;
      perEntry.push({ id: entry.id, label, status: "unreachable", reason: "on the manifest's probed-404 list", rowsCreated: 0 });
      if (APPLY) await writeControl(entry, { status: "unreachable", reason: "on the manifest's probed-404 list", rowsCreated: 0, priorAttempts: prior?.attempts });
      console.log(`  [${i + 1}/${take.length}] ${label}\n      UNREACHABLE — direct 404 probe, no lane serves it`);
      continue;
    }

    console.log(`  [${i + 1}/${take.length}] ${label}`);
    console.log(`      ${entry.sourceRef}`);

    if (!APPLY) {
      // REPORT ONLY: name the exact machinery this entry would drive, and the
      // gates it would face, without a fetch or a write.
      //
      // planFor is the SAME function the apply path is pinned to (see
      // CF-THE-PLAN-AND-THE-APPLY-ARE-ONE-FUNCTION). A report that describes a
      // pipe the apply does not run is worse than no report at all: it was
      // believed as a rehearsal on 2026-09-04 and the apply threw on every
      // entry it had just called clean.
      // A STAGED ENTRY DRIVES A DIFFERENT PIPE, so the report must say so --
      // the plan and the apply are one decision (CF-THE-PLAN-AND-THE-APPLY-
      // ARE-ONE-FUNCTION), and the staged short-circuit is part of it.
      const stagedNow = REFETCH ? [] : stagedFilesFor(entry);
      const plan = stagedNow.length
        ? `STAGED (${stagedNow.length} committed file(s)) → ingest-checklist-csv-to-catalog.cjs — no fetch; ${planFor(entry)} is bypassed`
        : planFor(entry);
      const inCatalog = await countCatalogRows(entry).catch(() => null);
      console.log(`      would drive: ${plan}`);
      if (stagedNow.length) {
        console.log(`      staged files: ${stagedNow.map((s) => path.basename(s.csv)).join(", ")}`);
      }
      console.log(`      gates: canonical header · zero-base-cards (per ENTRY, across every staged scope file) · players-as-parallels · card-line-as-rung · cross-join arithmetic`);
      console.log(`      would stamp source: ${sourceLabelFor(lane)}`);
      console.log(`      catalog now: ${inCatalog === null ? "(setKey/year not derivable — verify would refuse)" : f(inCatalog) + " rows"}   seeded=${entry.seededStatus}   prior=${prior?.status || "(none)"}`);
      perEntry.push({ id: entry.id, label, status: "would-attempt", reason: null, rowsInCatalog: inCatalog, seeded: entry.seededStatus });
      inspected++;
      continue;
    }

    const dir = path.join(WORKDIR, lane, slugOf(entry.id).slice(0, 60));
    let verdict;
    // Declared out here so the catch below, and the control doc after it, both
    // say how the entry was acquired -- a failure while fetching and a failure
    // while ingesting a staged file are different findings.
    let acquired = "fetched";
    // The by-source count, hoisted for the same reason as `acquired`: it
    // belongs on the control doc whichever verdict the entry ends with.
    let rowsUnderSource = null;
    try {
      // A STAGED FILE WINS. See CF-A-STAGED-FILE-WINS: an entry whose checklist
      // is committed with its manifest is ingested as-is, and only an explicit
      // MODE=refetch re-fetches it (CF-RECHECK-IS-NOT-REFETCH: a recheck
      // re-attempts a verdicted entry and still takes the staged file).
      const fromStaging = REFETCH ? null : acquireFromStaging(entry, dir);
      const csvPaths = fromStaging || acquireStaged(entry, dir);
      acquired = fromStaging ? "staged" : "fetched";
      if (fromStaging) {
        console.log(`      STAGED — ingesting ${f(fromStaging.length)} committed file(s) as-is, no fetch: ${fromStaging.map((p) => path.basename(p)).join(", ")}`);
      }

      // GATE BEFORE INGEST. A staged file that violates doctrine is refused as
      // a whole entry -- never a dirty ingest, and never a silent skip.
      /**
       * CF-BOTH-ENDS-OF-A-DELTA-READ-ONE-KEY (2026-09-06, run 33997480307).
       *
       * `before` was read at the top of the try, BEFORE acquisition -- and the
       * key it counts comes from the staged manifest, which does not exist
       * until the files are on disk. So it fell back to the reconstructed slug
       * while `after` read the manifest's key, and their difference was a
       * subtraction of two different products' counts rather than a
       * measurement of this run. It is read here, from the same csvPaths
       * `after` will use, so the two ends of the delta name one product.
       *
       * The SAME argument governs `beforeUnderSource`
       * (CF-ROWS-CREATED-IS-COUNTED-BY-SOURCE, #1856): it is the other end of
       * the by-source delta and resolves its key the same way, so it must be
       * read from the same csvPaths or the delta straddles two products.
       */
      const before = await countCatalogRows(entry, csvPaths);
      const beforeUnderSource = await countCatalogRowsBySource(entry, sourceLabelFor(lane), csvPaths).catch(() => null);
      const gate = gateStagedEntry(csvPaths, lane);
      if (csvPaths.length > 1) {
        console.log(`      ${f(csvPaths.length)} staged scope files: ${csvPaths.map((p) => path.basename(p)).join(", ")}`);
      }
      // WHY A ZERO-BASE PAGE WAS ALLOWED THROUGH. Silence here is how a wrongly
      // admitted cross-join would look exactly like a correctly admitted rung.
      if (gate.ok && gate.baselessSingleRung) {
        console.log(`      BASELESS SINGLE RUNG — every row is "${gate.baselessSingleRung}"` +
          (gate.parallelOfParent ? "; the page is that rung of a parent product, landing on the parent's setKey" : "; the product itself has no base print"));
      }
      if (!gate.ok) {
        // CF-A-GATE-REFUSAL-IS-NOT-EVIDENCE-THE-LANE-IS-DOWN (2026-09-04, run
        // 33857627732). A refusal here is a verdict about the STAGED FILE, and
        // reaching it PROVES the lane works: we fetched the page, parsed it and
        // staged a CSV. Yet it wrote plain `failed`, which advances the
        // systemic streak -- so entries 16 and 17 (2024 and 2025 Panini Prizm
        // Football, both refused as cartesian) plus one unreleased product made
        // a 3-streak that aborted a HEALTHY lane with 81 entries unattempted.
        //
        // It stays `failed`: a cartesian staging is a real defect in the
        // converter and must keep bringing someone back to it. What changes is
        // that it no longer counts as evidence the HOST is down, which is the
        // only thing the streak is allowed to conclude.
        verdict = { status: "failed", reason: `cleanliness gate: ${gate.reason}`, rowsCreated: 0, stats: gate.stats, laneProvenHealthy: gate.contentRefusal === true };
        console.log(`      REFUSED — ${gate.reason}`);
      } else {
        // THE CHILD'S OWN ACCOUNTING, surfaced. See
        // CF-A-DISCARDED-BANNER-IS-A-LOST-DIAGNOSIS: `keptExisting` is the
        // number that explains a short ingest, and it was being thrown away
        // with the rest of this stream.
        const ingestSaid = run("ingest-checklist-csv-to-catalog.cjs", [], {
          DIR: dir,
          SOURCE: sourceLabelFor(lane),
          BACKFILL_APPLY: "true",
          RUN_MINUTES: String(Math.max(2, Math.floor(left() / 60000 / 2))),
          CONCURRENCY: process.env.CONCURRENCY || "16",
        }, 20 * 60000);
        printChildBanner(ingestSaid);
        // THE CHILD'S OWN ACCOUNTING, as numbers. Read here so a verdict can
        // rest on what the child COUNTED rather than on what the catalog read
        // back alone. See CF-A-TOTAL-REFUSAL-IS-NOT-A-GREEN-INGEST.
        const counters = childCounters(ingestSaid);

        // VERIFY BY READ. Not the ingest's claim -- a count from Cosmos.
        const after = await countCatalogRows(entry, csvPaths);

        // VERIFY BY SOURCE. `after` counts every row of the product, whoever
        // wrote it; this counts only what this run's source wrote. See
        // CF-THE-VERIFICATION-MUST-COUNT-THE-ROWS-THIS-RUN-WROTE.
        rowsUnderSource = await countCatalogRowsBySource(entry, sourceLabelFor(lane), csvPaths).catch(() => null);

        // CF-ROWS-CREATED-IS-COUNTED-BY-SOURCE. The delta under THIS run's
        // source tag, never the whole-product delta. When the by-source read
        // is unavailable at either end `created` is null -- "not measured" --
        // rather than a whole-product number wearing the by-source label: an
        // unanswerable count must say so, not fall back to the wrong one.
        const created = (rowsUnderSource === null || beforeUnderSource === null)
          ? null
          : rowsUnderSource - beforeUnderSource;
        rowsCreatedTotal += Math.max(0, created ?? 0);
        if (rowsUnderSource !== null) {
          console.log(`      under source ${sourceLabelFor(lane)}: ${f(rowsUnderSource)} rows (of ${f(after ?? 0)} for the product)`);
        }

        /**
         * CF-EVERY-STAGED-ROW-OR-IT-IS-NOT-INGESTED (2026-09-04).
         *
         * Run 33847867665 landed EXACTLY 64 catalog rows for set after set --
         * S10a, S12, S5I, S8, S9a, S6H, S9, S8b, S11 ... thirty-nine of the
         * forty-eight -- while the staging held 92 rows for SV1V, 108 for SV9
         * and 367 for SV4a. 64 is not a number this lane can produce: it is
         * ceil(LIMIT/CONCURRENCY) * CONCURRENCY = ceil(52/16) * 16, the leaked
         * runner LIMIT rounded up to the child's write-chunk boundary.
         *
         * #1718 deleted the leak. This is the ASSERTION that would have caught
         * it without a human reading a log: the driver already knows how many
         * rows the gate parsed out of the staged files, and a complete ingest
         * of a product the catalog had none of must leave that many rows
         * behind. A count short of staging is a TRUNCATED ingest -- a verdict
         * of its own, never `ingested`, and never `partial` (which claims the
         * SOURCE was thin when in fact our own pipe dropped rows).
         *
         * The comparison is made only when the product started EMPTY. With
         * rows already present the arithmetic cannot separate "created 64 of
         * 92 staged" from "58 of the 92 were already there", and asserting on
         * a difference we cannot attribute would fire on every honest re-run.
         */
        const staged = gate.stats.rows;
        const startedEmpty = (before ?? 0) === 0;
        const truncated = startedEmpty && after !== null && staged > 0 && after < staged;

        /**
         * CF-STAGED-IDENTITIES-MUST-BE-IN-THE-CATALOG (2026-09-04, run
         * 33869931267).
         *
         * `truncated` above compares COUNTS and only when the product started
         * EMPTY, and both halves of that let a real shortfall through. On the
         * bcp Finest family the driver reported, green:
         *
         *   INGESTED -- 0 rows created, 628 in catalog of 4,526 staged
         *   INGESTED -- 0 rows created, 1,113 in catalog of 4,364 staged
         *   INGESTED -- 0 rows created, 2,467 in catalog of 4,933 staged
         *
         * A catalog holding an eighth of what was staged, and the verdict says
         * INGESTED because `before` was non-zero so the count check never ran.
         *
         * Counts cannot answer it in either direction. They over-report a loss
         * when the same card is staged twice under two spellings of the product
         * (the 664/791/1,241 "rows lost" on 2000, 2003 and 2009 Finest are
         * exactly this -- two scope files, one card), and they under-report one
         * when the ingest wrote a different set of rows than it staged.
         *
         * So ASK THE QUESTION DIRECTLY: is every staged identity in the
         * catalog? Set difference, no arithmetic, and no dependence on
         * `before`. A non-empty difference is a `short-ingest` -- named apart
         * from `truncated` because the cause is usually a MERGE REFUSAL rather
         * than a severed pipe, and the operator needs to know which.
         */
        let shortIngest = null;
        if (after !== null && gate.stats.identities && gate.stats.identities.size) {
          const inCatalog = await catalogIdentities(entry, csvPaths).catch(() => null);
          if (inCatalog) {
            const missing = [];
            for (const id of gate.stats.identities) if (!inCatalog.has(id)) missing.push(id);
            if (missing.length) {
              shortIngest = {
                staged: gate.stats.identities.size,
                present: gate.stats.identities.size - missing.length,
                missing: missing.length,
                sample: missing.slice(0, 5),
                countedKeys: setKeyCandidates(entry, csvPaths),
              };
            }
          }
        }

        /**
         * CF-A-PRODUCT-WITH-NO-PRINT-RUNS-IS-NOT-PARTIAL. On a lane whose
         * products carry no numbered parallels, an empty print-run column is
         * the source telling the truth, not a gap for a later pass to close.
         */
        /**
         * CF-A-RUNG-PAGE-CARRIES-NO-PRINT-RUN (2026-09-04). The other half of
         * the false modern `partial`: 80 entries sit at "ladder present but
         * zero print runs", and almost every one is a "...Refractors" page --
         * a page that IS one rung, attested by the fetcher's `parallelOfParent`
         * and landed on the parent's setKey. The rung is the axis such a page
         * publishes; the numbering, where it exists, is the parent's. Demanding
         * a print-run column from it asks the source for a column it never had.
         * The attestation is the fetcher's, never inferred from an empty column.
         */
        const printRunsExpected = !LANES_WITHOUT_PRINT_RUNS.has(lane)
          && !(LANES_WITH_SIBLING_PARALLEL_PAGES.has(lane) && gate.everyFileIsParallelOfParent);
        /**
         * CF-A-VINTAGE-BASE-SET-IS-NOT-PARTIAL. On a declared lane, a pre-1990
         * product has no parallel ladder to lose, so `ladder === 0` is the
         * checklist telling the truth rather than a gap for a later pass.
         *
         * CF-A-LADDER-ON-SIBLING-PAGES-IS-NOT-A-GAP. Its modern counterpart: on
         * a source that gives every rung its own page, a PARENT page's ladder
         * arrives on sibling entries the manifest declares, so base-only is the
         * page's shape rather than the product's gap.
         */
        const ladderExpected = !ladderlessByEra(lane, entry)
          && !ladderOnSiblingPages(lane, entry, manifest.entries);
        const incomplete = (ladderExpected && gate.stats.ladder === 0)
          || (printRunsExpected && gate.stats.withPrintRun === 0);

        if (after === null) {
          // Also per-entry: the ingest ran, and what we cannot do is DERIVE a
          // key to verify it with. Nothing about the host.
          verdict = { status: "failed", reason: "cannot verify by read — setKey/year not derivable for this entry", rowsCreated: 0, stats: gate.stats, laneProvenHealthy: true };
          console.log(`      FAILED — unverifiable`);
        } else if (childRefusedEverything(counters)) {
          // A DELIBERATE REFUSAL IS A DECISION, NOT A LOSS.
          //
          // The child read rows, wrote none, and accounted for every one of
          // them as refused -- the subset-collision guard declining to invent
          // a subset name for a rung the catalog already holds under a
          // different one. Nothing was dropped and nothing is missing: the
          // rows were never eligible to land under this identity.
          //
          // TERMINAL, because the guard is deterministic. Given the same page
          // and the same stored rows it refuses identically on every future
          // pass, so leaving the entry pending re-fetches and re-refuses it
          // forever -- 8 of this run's 170 slots bought nothing but a repeat
          // of a decision already made. It leaves the queue with its reason.
          //
          // STREAK-NEUTRAL via laneProvenHealthy, on the same evidence as a
          // cleanliness-gate content refusal: reaching this line required the
          // page to be fetched, parsed, staged and ingested, which is positive
          // proof the lane is UP. The streak may conclude one thing only, and
          // this is evidence against it.
          const detail = `${f(counters.subsetRefused)} of ${f(counters.read)} rows refused by the subset-collision guard`;
          verdict = {
            status: REFUSED_STATUS,
            reason: `refused at merge — the child read ${f(counters.read)} rows and wrote 0: ${detail}. `
              + `The stored row at each rung claims a subset this page does not state, and blank is unknown and is never invented. `
              + `A decision, not a loss — re-running reproduces it.`,
            rowsCreated: 0, rowsInCatalog: after, rowsStaged: gate.stats.rows,
            childRead: counters.read, childRefused: counters.subsetRefused,
            countedSetKeys: setKeyCandidates(entry, csvPaths),
            stats: gate.stats, laneProvenHealthy: true,
          };
          console.log(`      REFUSED AT MERGE — ${detail}; nothing lost, nothing to retry`);
        } else if (after === 0) {
          // A per-entry answer. We fetched the page, staged it, ran the ingest
          // and read the catalog back -- the host answered every time, so this
          // is our defect, not a down lane. It stays `failed`; it does not vote.
          // NAME THE KEY IT COUNTED. "the catalog holds 0 rows" is unactionable
          // without the address that was read: every one of the 96 entries with
          // this verdict was a key mismatch, and the operator could not see it
          // because the sentence never said which key answered 0. See
          // CF-THE-DIFF-MUST-READ-THE-KEY-THE-MANIFEST-STATES.
          const countedKeys = setKeyCandidates(entry, csvPaths);
          verdict = {
            status: "failed",
            reason: `ingest reported success but the catalog holds 0 rows for this product `
              + `(counted under ${countedKeys.length ? countedKeys.map((k) => `${entry.year}/${k}`).join(" + ") : "no derivable key"})`,
            rowsCreated: 0, rowsInCatalog: 0, countedSetKeys: countedKeys,
            stats: gate.stats, laneProvenHealthy: true,
          };
          console.log(`      FAILED — green ingest, 0 rows landed`);
        } else if (shortIngest) {
          // THE IDENTITY DIFF IS THE TRUTH, and it supersedes the count check:
          // `truncated` fires on row totals and cannot see a page staged twice
          // under two spellings, where "lost" rows are a double count. When
          // identities are all present the ingest is complete however the
          // counts read.
          //
          // A per-entry answer, NOT a lane fault. Reaching it means the page
          // was fetched, parsed, staged and ingested, and the catalog was read
          // back -- every one of which proves the host is up. The cause is
          // ours (a merge refusal, a key mismatch, a severed child), so it
          // stays `failed` and keeps bringing someone back; it just never votes
          // that the LANE is down. See CF-A-CORRECT-REFUSAL-IS-NOT-A-LANE-FAILURE.
          // ITS OWN TERMINAL STATE, never `failed`. See
          // CF-AN-ENTRY-THAT-LANDED-ROWS-IS-NOT-A-FAILURE: this entry's rows
          // ARE in the catalog, and calling that a failure both misreports the
          // run and feeds a systemic streak that may only conclude the host is
          // down -- which reaching this line disproves.
          verdict = {
            status: SHORT_STATUS,
            // NAME WHAT WAS COMPARED. "short ingest" alone does not say which
            // two things disagreed, and the whole defect this replaces was a
            // comparison against the wrong address.
            reason: `short ingest — compared the ${f(shortIngest.staged)} distinct identities staged for this entry `
              + `(cardNumber|parallel|isAuto|printRun) against the catalog under `
              + `${shortIngest.countedKeys.map((k) => `${entry.year}/${k}`).join(" + ")}: `
              + `${f(shortIngest.present)} present, ${f(shortIngest.missing)} missing (e.g. ${shortIngest.sample.join(", ")}); `
              + `${f(rowsUnderSource ?? 0)} rows landed under ${sourceLabelFor(lane)}`,
            rowsCreated: created, rowsInCatalog: after, rowsStaged: staged,
            stagedIdentities: shortIngest.staged, missingIdentities: shortIngest.missing,
            presentIdentities: shortIngest.present,
            countedSetKeys: shortIngest.countedKeys,
            stats: gate.stats, laneProvenHealthy: true,
          };
          console.log(`      SHORT INGEST — compared ${f(shortIngest.staged)} staged identities against ${shortIngest.countedKeys.map((k) => `${entry.year}/${k}`).join(" + ")}: ${f(shortIngest.present)} present, ${f(shortIngest.missing)} missing`);
          console.log(`      missing e.g. ${shortIngest.sample.join(", ")}`);
        } else if (truncated) {
          // Reached only when every staged identity IS in the catalog and the
          // row count is still short -- the same card staged more than once.
          // That is a double count in the staging, not a loss in the pipe.
          verdict = {
            status: "ingested",
            reason: `${f(staged)} rows staged over ${f(gate.stats.identities.size)} distinct identities — all present; the row surplus is the same card staged more than once`,
            rowsCreated: created, rowsInCatalog: after, rowsStaged: staged, stats: gate.stats,
          };
          console.log(`      INGESTED — ${f(gate.stats.identities.size)} distinct identities all present (${f(staged)} staged rows include duplicates across scope files)`);
        } else if (incomplete) {
          // Landed and clean, but incomplete: base-only, or -- on a lane whose
          // products ARE numbered -- a ladder with no print runs. Recording it
          // `ingested` would close a gap still open.
          const why = (ladderExpected && gate.stats.ladder === 0)
            ? "base-only, no parallel ladder"
            : "ladder present but zero print runs";
          verdict = { status: "partial", reason: why, rowsCreated: created, rowsInCatalog: after, rowsStaged: staged, stats: gate.stats };
          console.log(`      PARTIAL — ${why} (${fOrUnknown(created)} rows created under ${sourceLabelFor(lane)}, ${f(after)} in catalog)`);
        } else {
          const note = printRunsExpected
            ? `${f(gate.stats.withPrintRun)} with print runs`
            : LANES_WITH_SIBLING_PARALLEL_PAGES.has(lane) && gate.everyFileIsParallelOfParent
              ? "no print runs — this page IS one rung; the numbering is the parent's"
              : "no print runs — this lane's products carry none";
          // Say the exemption out loud, and say WHICH one. A base set reporting
          // INGESTED with no ladder must not read like a ladder that was
          // scraped and silently dropped, and "the source puts it on another
          // page" is a different claim from "the product never had one".
          const era = !(gate.stats.ladder === 0) ? ""
            : ladderlessByEra(lane, entry)
              ? `; base-only is the shape of a pre-${PARALLEL_ERA_FIRST_YEAR} product, not a gap`
              : ladderOnSiblingPages(lane, entry, manifest.entries)
                ? "; base-only is the shape of a PARENT page — this source publishes each rung as its own set page, and the manifest declares the siblings"
                : "";
          verdict = { status: "ingested", reason: null, rowsCreated: created, rowsInCatalog: after, rowsStaged: staged, stats: gate.stats };
          console.log(`      INGESTED — ${fOrUnknown(created)} rows created under ${sourceLabelFor(lane)}, ${f(after)} in catalog of ${f(staged)} staged, ${note}${era}`);
        }
      }
    } catch (e) {
      // Wide enough for the child's own words. The old 200/140 pair was set
      // when the message was ours; now it carries up to CHILD_STDERR_LINES of
      // the child's stderr, and truncating THAT is the defect this run hit.
      const msg = String(e.message || e).slice(0, 1200);
      // A 404/403 from the source is the source not serving this set -- not a
      // defect in our pipe, and a different verdict from a broken acquisition.
      // `exit 9` is the form run() actually builds ("${script} exit ${status}: ...");
      // the old alternation only matched Node's own "exited ... code 9" wording,
      // so the beckett downloader's 9 was recognised and every OTHER child's was
      // not. The sportscardchecklist zero-row refusal exits 9 and fell through to
      // `failed` -- our pipe broke -- when the host had simply not served us.
      const isGone = /HTTP 40[34]|ENOTFOUND|exit(ed)?\s+(?:with\s+)?(?:code\s+)?9|workbook empty or unreachable/i.test(msg);
      // The acquisition itself says when the SOURCE answered "nothing here".
      // That is a verdict about the set, never a symptom of a broken lane.
      const status = e?.emptyAtSource ? EMPTY_STATUS : isGone ? "unreachable" : "failed";
      // A thrower that KNOWS the host answered says so, and the streak listens.
      // See the parser-gap throw in the bcp acquisition.
      verdict = { status, reason: `acquisition: ${msg}`, rowsCreated: 0, ...(e?.laneProvenHealthy ? { laneProvenHealthy: true } : {}) };
      console.log(`      ${status.toUpperCase()} — ${msg}`);
    }

    // HOW IT WAS ACQUIRED IS PART OF THE VERDICT. A control doc that does not
    // say whether the rows came from a committed checklist or from a fresh
    // fetch cannot answer the question this run exists to settle.
    verdict.acquired = acquired;
    verdict.rowsUnderSource = rowsUnderSource;

    verdicts[verdict.status]++;
    perEntry.push({ id: entry.id, label, status: verdict.status, reason: verdict.reason, rowsCreated: verdict.rowsCreated, acquired });

    // CF-A-REFUSED-ENTRY-IS-NOT-A-BROKEN-LANE (2026-09-04).
    //
    // writeControl sat OUTSIDE the per-entry try, so a throw here -- the
    // illegal-id one above, a 429, a transient socket -- escaped to the outer
    // handler and exited 3, losing the other 19 entries of the run AND the
    // verdicts already earned. Recording a verdict is per-entry work and it
    // fails per-entry: the write is guarded, the failure is COUNTED, and the
    // lane keeps going. A run whose verdicts are not landing is still a real
    // problem, so it trips the systemic tripwire below rather than being
    // swallowed -- it is just no longer allowed to take the lane down at once.
    try {
      await writeControl(entry, { ...verdict, priorAttempts: prior?.attempts });
    } catch (e) {
      controlWriteFailures++;
      const msg = String(e?.message || e).slice(0, 160);
      console.log(`      CONTROL WRITE FAILED — ${msg}`);
      console.log(`      (the entry's own verdict stands in this run's summary; the control doc did not land)`);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

    // THE SYSTEMIC TRIPWIRE. One entry the source does not serve is a VERDICT.
    // N in a row is the lane itself being down -- the site blocking us, the
    // network gone, credentials rejected -- and continuing then burns the
    // budget writing `failed` onto entries that are fine, which a later
    // `pending only` run would skip on their attempt count. Consecutive, never
    // cumulative: a lane where every fourth page is genuinely unreachable is a
    // working lane, not a broken one.
    // `empty` neither advances the streak NOR resets it: the source having no
    // cards for this set is no evidence either way about the lane's health, so
    // a genuine outage interrupted by an empty set still trips on its own run.
    consecutiveFailures = streakAfter(consecutiveFailures, verdict);
    if (consecutiveFailures >= SYSTEMIC_FAILURE_STREAK) {
      systemicAbort = `${consecutiveFailures} consecutive entries failed or were unreachable — the lane, not the entries`;
      notReached = take.length - (i + 1);
      console.log(`
  ABORTING THE LANE — ${systemicAbort}`);
      console.log(`  ${f(notReached)} entries of this run were not attempted; the verdicts already written stand.`);
      break;
    }
    if (controlWriteFailures >= SYSTEMIC_FAILURE_STREAK) {
      systemicAbort = `${controlWriteFailures} control-doc writes failed — the verdicts are not landing, so the run cannot resume from them`;
      notReached = take.length - (i + 1);
      console.log(`
  ABORTING THE LANE — ${systemicAbort}`);
      break;
    }
  }

  // ── reconciliation ────────────────────────────────────────────────────────
  // `empty` is a verdict like any other and lands a control doc, so it counts
  // toward `written` -- leaving it out would put a lane of correctly-refused
  // sets straight into RECONCILED NO.
  const written = verdicts.ingested + verdicts.partial + verdicts.failed + verdicts.unreachable + verdicts[EMPTY_STATUS] + verdicts[SHORT_STATUS] + verdicts[REFUSED_STATUS];
  // CF-AN-UNREACHABLE-ENTRY-IS-ACCOUNTED-FOR (2026-09-04).
  //
  // Run 33841276495 (sportscardchecklist, report mode, limit=20) printed
  //
  //   intended 20 / inspected 19 / unreachable 1 / not reached 0
  //   RECONCILED NO — 19 + 0 != 20
  //
  // and exited 4, so the runner refused to relaunch a lane that had done
  // nothing wrong. The entry WAS accounted for -- it was settled from the
  // manifest and printed on its own line one row above the failing sum -- but
  // report mode counted only `inspected`, and an entry settled without a fetch
  // is never inspected. The banner and the arithmetic were reading different
  // columns.
  //
  // APPLY's `written` already sums all four verdict buckets, unreachable
  // included, which is why only report mode ever went red on this. Report mode
  // now says the same thing: every entry the loop DECIDED, by whichever route.
  const accounted = APPLY ? written : inspected + verdicts.unreachable + verdicts[EMPTY_STATUS];
  const spent = Math.round((Date.now() - STARTED) / 60000);
  console.log(`\n── driver complete in ${spent}m ──`);
  console.log(`  lane                ${lane}`);
  console.log(`  intended            ${f(intended)}   (entries this run took)`);
  if (APPLY) {
    console.log(`    ingested          ${f(verdicts.ingested)}`);
    console.log(`    partial           ${f(verdicts.partial)}`);
    console.log(`    short ingest      ${f(verdicts[SHORT_STATUS])}   (rows landed; some staged identities are not in the catalog)`);
    console.log(`    refused at merge  ${f(verdicts[REFUSED_STATUS])}   (the child refused every row it read; a decision, not a loss)`);
    console.log(`    failed            ${f(verdicts.failed)}`);
    console.log(`    unreachable       ${f(verdicts.unreachable)}`);
    console.log(`    empty at source   ${f(verdicts[EMPTY_STATUS])}   (the source served no cards; a verdict, not a lane fault)`);
  } else {
    console.log(`    inspected         ${f(inspected)}   (report mode: planned, never fetched)`);
    console.log(`    unreachable       ${f(verdicts.unreachable)}   (settled from the manifest, no fetch needed)`);
  }
  console.log(`    not reached       ${f(notReached)}   (budget stop, counted directly)`);
  console.log(`  written             ${f(APPLY ? written : 0)}   (control docs upserted)`);
  console.log(`  rows created        ${f(rowsCreatedTotal)}   (verified by catalog read UNDER THIS RUN'S SOURCE, not claimed)`);
  const balanced = accounted + notReached === intended;
  console.log(`  RECONCILED          ${balanced ? "yes" : `NO — ${f(accounted)} + ${f(notReached)} != ${f(intended)}`}`);
  if (controlWriteFailures) console.log(`  control writes lost  ${f(controlWriteFailures)}   (verdict earned, doc did not land)`);
  if (systemicAbort) console.log(`  SYSTEMIC ABORT      ${systemicAbort}`);
  if (!APPLY) console.log(`  (REPORT ONLY — nothing acquired, nothing written)`);

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. The house reconciliation, which sets
  // process.exitCode itself so a run that dropped its work goes RED rather than
  // green. DISJOINT counters: `written` is the entries that actually landed
  // rows; an entry refused by a gate or unreachable at the source is SKIPPED --
  // deliberately not written, and not loss -- while `failed` is an entry that
  // tried to land and could not. `notReached` is a budget stop, and the
  // relaunch continues from it, so it is skipped rather than unaccounted.
  if (APPLY) {
    const { reportWrites } = require(path.join(HERE, "..", "dist", "services", "ops", "writeReconciliation.js"));
    reportWrites({
      job: "ingest-universe-driver",
      intended,
      // A short ingest LANDED its rows -- see
      // CF-AN-ENTRY-THAT-LANDED-ROWS-IS-NOT-A-FAILURE. It belongs with the
      // written, never with the failed; counting it as loss is what made run
      // 33997480307 report 18 failures over twelve entries that wrote.
      written: verdicts.ingested + verdicts.partial + verdicts[SHORT_STATUS],
      // An entry the source does not card is deliberately not written; it is
      // skipped, exactly like an unreachable one -- never counted as loss.
      // A merge refusal is deliberately not written, exactly like an
      // unreachable entry: the rows were never eligible to land under this
      // identity, so it is skipped and never counted as loss.
      skipped: verdicts.unreachable + verdicts[EMPTY_STATUS] + verdicts[REFUSED_STATUS] + notReached,
      failed: verdicts.failed,
    });
  }

  const remaining = queue.length - accounted;
  console.log(`  remaining in lane   ${f(Math.max(0, remaining))}`);
  // CF-A-REPORT-THAT-WALKED-IS-NOT-A-REPORT-THAT-DID-NOTHING (2026-09-04).
  //
  // This marker is the number the runner greps and echoes, and it read
  // `written` -- which counts control docs and is 0 in report mode BY DESIGN.
  // So a report run that walked its whole queue and planned every entry
  // published `entries=0`, indistinguishable from a run that matched nothing
  // and exactly what run 33837346045 preceding report reported. Report mode
  // reconciles against what it INSPECTED, so the marker says that. APPLY is
  // unchanged: `written` is still the control docs upserted.
  //
  // It counts `accounted`, not `inspected`, for the same reason the
  // reconciliation does: an entry settled from the manifest without a fetch is
  // DONE, and a marker that omits it leaves the lane permanently short of draining.
  console.log(`  universe_entries_done=${APPLY ? written : accounted}`);

  // THE BUDGET MARKER. Printed only when entries remain AND this run stopped on
  // its own clock -- the relaunch gates on this line, never on a count, because
  // a count gate loops forever on a lane whose remainder cannot be changed and
  // stops early on a budget stop that happened to change nothing.
  if (systemicAbort) {
    console.log(`  lane aborted — NOT printing the budget marker; a relaunch would meet the same wall. Fix the cause, then re-dispatch.`);
  } else if (remaining > 0 && stoppedOnBudget && notReached > 0) {
    // CF-A-LIMIT-BOUND-RUN-IS-NOT-A-BUDGET-STOP (2026-09-04, run 33854416984).
    //
    // The condition used to be `stoppedOnBudget || written >= LIMIT`. That
    // second clause made a run that CLEANLY FINISHED its slice look like one
    // the clock cut short: sportscardchecklist with limit=3 took exactly its
    // three entries, reported "intended 3 = written 3" and RECONCILED yes, and
    // still printed the marker because 3 >= 3. The runner's relaunch step gates
    // on this line, so it re-dispatched the SAME inputs, which took the same
    // three entries, and the lane looped (33854423019, 33854625169) until it
    // was cancelled by hand.
    //
    // `written >= LIMIT` cannot distinguish the two cases at all: LIMIT is
    // either the operator's explicit slice or `budgetSized`, so on a full run
    // it is TRUE by construction whether or not the clock was ever consulted.
    //
    // The marker means one thing -- "there is more work and I ran out of time
    // before I could take it" -- so it now asserts exactly that, in the two
    // facts that make it true and that nothing else sets:
    //   stoppedOnBudget  the loop broke on `left() < perEntryMin * 1.5`
    //   notReached > 0   entries of THIS run's slice were never attempted
    // A run that exhausted an explicit LIMIT, or drained the eligible list,
    // has notReached === 0 and never trips the clock, so it falls through to
    // the branches below and the relaunch stops -- which is the whole point.
    console.log(`stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  } else if (remaining > 0 && notReached === 0) {
    // The slice this run was asked for is DONE and the lane still has more.
    // That is a complete run, not an early exit, so it does not read as one --
    // and it deliberately does not print the marker, because the operator (or
    // the sizing) chose the slice and a relaunch is theirs to decide.
    console.log(`  slice complete — ${f(remaining)} entries remain in the lane; re-dispatch to continue`);
  } else if (remaining > 0) {
    console.log(`  ${f(remaining)} entries remain but this run ended early — inspect the failures before re-dispatching`);
  } else {
    console.log(`  lane complete — nothing left pending`);
  }

  // Set, never exit(): reportWrites has already set process.exitCode on a
  // shortfall, and an exit() here would race its verdict and could mask a
  // reconciliation failure behind this one's success.
  if (!balanced) process.exitCode = 4;
  // A LANE ABORT IS RED, A REFUSED ENTRY IS NOT. The whole point of the change
  // above is that "this page has no ladder" is a verdict the run records and
  // walks past. A systemic abort is the opposite: the lane is down, the
  // remaining entries were never attempted, and a relaunch would repeat it --
  // so it goes red and the marker below is deliberately NOT printed.
  if (systemicAbort) process.exitCode = 5;
})()
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
// process.exitCode set by the body above is HONOURED, never overwritten.
  .then(() => finishLane(process.exitCode || 0))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
