#!/usr/bin/env node
/**
 * rematch-sold-comps.cjs -- the GREAT REMATCH. Every sale in sold_comps sits
 * under the identity today's parser and catalog would give it, or it is
 * reported to Drew and left exactly where it is.
 *
 * CF-A-REMATCH-IS-A-DIFF-BEFORE-IT-IS-A-WRITE (Drew, 2026-09-01). This
 * supersedes the one-defect-one-lane era for POOL IDENTITY: instead of a
 * script per defect shape, one census re-derives every row's identity from its
 * OWN title plus its stored raw fields, through parseTitleIdentity +
 * ingestGradeFromTitle + the catalog-first matcher, and diffs the result
 * against the key the row carries. The classifier is scripts/lib/
 * rematch-classify.cjs and is pure; this file is paging, I/O and the banner.
 *
 * TWO MODES, ONE SELECTOR
 *
 *   MODE=census        READ ONLY. Pages the shard, classifies every row
 *                      AGREE / IMPROVE / CONFLICT / UNDERIVABLE with a
 *                      provenance tier, prints the census banner, and writes a
 *                      machine-readable shard census JSON for the artifact
 *                      step (falls back to a parseable CENSUS_JSON line).
 *                      Touches nothing, ever -- there is no write path in this
 *                      mode at all, not even behind APPLY.
 *
 *                      RESUMABLE ACROSS THE RUNNER'S SELF-RELAUNCH, AT TWO
 *                      GRAINS (2026-09-11, finer-grained 2026-09-12 -- #2058
 *                      follow-up). A census walks its shard UNIT BY UNIT --
 *                      the same (cardYear, sportClass, sha1(id) % parts) units
 *                      SHARD_TABLE packs a slot from -- and checkpoints a
 *                      per-slot cursor to the `rematch_control` container
 *                      after every unit that finishes inside budget. Several
 *                      units (measured: slot 0's 484,940-row first unit
 *                      among them) are themselves bigger than one link's
 *                      throughput at sold_comps' fixed 10,000 RU autoscale
 *                      (~150-200 in-slot rows/s), so a SECOND checkpoint
 *                      saves the Cosmos query iterator's own continuation
 *                      token for the unit currently in flight -- every
 *                      `CENSUS_PAGE_CHECKPOINT_PAGES` pages (default 40) or
 *                      `CENSUS_PAGE_CHECKPOINT_MS` (default 5 minutes),
 *                      whichever comes first. The query behind each unit has
 *                      no ORDER BY (see slotQuery), which is exactly the
 *                      shape whose continuation token the SDK guarantees is
 *                      safe to replay against a brand-new query object on a
 *                      brand-new process. A run that hits `RUN_MINUTES` stops
 *                      at the next of either boundary, saves the units done
 *                      so far, the in-flight unit's resume token (if any) and
 *                      the merged counts produced up to that exact page, and
 *                      prints `stopped at the ... budget` exactly as before
 *                      -- the runner's existing relaunch fires on that line
 *                      with no new dispatch input. The relaunch's own pass
 *                      reads that cursor, MERGES its saved counts into its
 *                      own, skips every unit already marked done, and --
 *                      when a partial unit's key matches the next unit it
 *                      would otherwise start cold -- resumes it from the
 *                      saved token instead of its first row, so a slot's
 *                      `classified` climbs EVERY link toward `expectedRows`,
 *                      including inside a unit too large for one link alone,
 *                      instead of resetting to zero every ~2h10m. A pass that
 *                      finishes its WHOLE shard prints `finished within
 *                      budget` and clears the cursor, so an unrelated later
 *                      dispatch of the same slot (a re-run, an audit
 *                      re-check) starts clean rather than "resuming" a slot
 *                      with nothing left to resume. The cursor is invalidated
 *                      (dropped, not repaired -- page token included) by any
 *                      change to the shard table's `measuredAt`, `scope`,
 *                      `sports`, `setkey_like` or `years` -- see
 *                      censusCursorSignature. MODE=apply-improve is
 *                      untouched: its queue is rebuilt from a census-fresh
 *                      read on every dispatch and every candidate is
 *                      re-checked at write time, so there is nothing for a
 *                      cursor to resume.
 *   MODE=apply-improve  SCOPE=revert-eviction
 *                      THE ONE WAY BACK. Reads the rows this script's own
 *                      base-eviction wave WROTE -- the ones carrying
 *                      `baseEvictionEvidence` and `rekeyedFrom` -- re-reads
 *                      each one's title against G6, and moves the ones G6 now
 *                      refuses back to `rekeyedFrom[0].cardId`. No shard axis,
 *                      no derivation, no catalog: the destination is the slug
 *                      the row itself recorded that it came from. Report-first
 *                      like every other apply, and it rides the SAME runner
 *                      inputs -- there is no revert lane, no revert script and
 *                      no new dispatch input.
 *   MODE=apply-improve Re-reads the shard and applies ONLY IMPROVE-class,
 *                      AUTO-tier rows AND the BASE-EVICTION subclass of
 *                      CONFLICT, through scripts/lib/relocate-sold-comp
 *                      .cjs so contentHash + provenance handling stays in ONE
 *                      place. Only-improve is RE-CHECKED at write time,
 *                      because the pool moves between the census and the
 *                      apply: a row that a concurrent ingest has since made
 *                      more specific is skipped, not overwritten.
 *
 * WHAT NEVER WRITES, EVER
 *
 *   CONFLICT      a different reading, not a more specific one. To Drew --
 *                 EXCEPT the BASE-EVICTION subclass below.
 *   UNDERIVABLE   the title yields nothing that passes the slug guard.
 *   PROTECTED     ebay-user-purchase / ebay-user-sale / ebay-account /
 *                 manual-user-entry, any Drew ruling or hand/D31 relocation
 *                 marker, anything verifiedByUser. Report-only FOREVER, even
 *                 when the row is IMPROVE-shaped OR BASE-EVICTION-shaped.
 *                 Measured 2026-09-01: 160 user-sourced rows, 53 D19
 *                 relocations, 800 verified.
 *
 * THE BASE-EVICTION SUBCLASS (Drew 2026-09-02)
 *
 * One shape inside CONFLICT is not two rival readings of a card: a row filed
 * on a parallel slug (`...:refractor:...`) whose own stored parallel field
 * says Base/blank and whose title names no finish, where a checklist-backed
 * BASE destination exists. Three independent fields agree that the row names
 * no parallel; only the slug disagrees, and a slug is an artifact of whichever
 * writer keyed the row. This script computes the base destination (the derived
 * identity with parallel forced to Base and the print run dropped), verifies
 * it is checklist-backed exactly as IMPROVE's destination is, and hands all
 * three fields to the classifier, which decides. The subclass rides the SAME
 * trust ladder as IMPROVE -- per-shard 500-row audit plus rematch-canary-check
 * before that shard's apply -- and the residual risk (a seller omitting
 * "Refractor" on a genuine parallel) is what the audit is for.
 *
 * THE APPLY IS GATED TWICE, OUTSIDE THIS SCRIPT
 *
 *   1. a 500-row sample audit of THAT shard's IMPROVE bucket comes back clean
 *   2. rematch-canary-check.cjs shows zero regressions on the hand-verified
 *      pools, before and after
 * Neither gate lives in this file -- a script cannot certify itself. The
 * sequence is documented in rematch-canary-check.cjs's header and in the
 * dispatch plan; this script only refuses to write anything but clean classes.
 *
 * THE SHARD AXIS IS MEASURED, NOT ASSUMED
 *
 * GROUP BY cardYear over the live pool, 2026-09-01: 16,336,293 rows in 136
 * year buckets, and FOUR years blow past any even share -- 2024 = 2,711,283,
 * 2025 = 2,629,991, 2023 = 1,457,497, 2026 = 1,268,434, against an even
 * 32-slot share of 510,509. Year alone is not an axis; it is a 6.6x spread.
 *
 * So the axis is composite, in three levels, each used only when the level
 * above is still too big:
 *   1. cardYear           every year that fits inside a share rides whole
 *   2. + sport class      the four heavy years split baseball / football /
 *                         basketball / pokemon / other (2025 baseball alone is
 *                         1,262,342 -- 2.5x a share on its own)
 *   3. + sha1(id) % parts a unit still over a share splits into hash parts,
 *                         which are uniform by construction
 * That yields 158 units packed into 32 slots at min 497,602 / max 532,572 --
 * a 1.07x spread. SHARD_TABLE below IS that packing, encoded, and the banner
 * echoes this slot's units and their measured row counts. A slot's rows are
 * its own; slots never overlap, so 32 dispatches need no coordination.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      MODE=census | apply-improve          (REQUIRED, no default)
 *      SLOT / SLOTS                          which slice (default 0 / 32)
 *      BACKFILL_APPLY=true                   write (apply-improve only)
 *      BACKFILL_CONCURRENCY                  parallel relocates (default 8)
 *      RUN_MINUTES=140                       budget marker under the step's 150
 *      LIMIT                                 cap rows read (0 = the whole slot)
 *      YEARS                                 narrow to these years inside the slot
 *      CENSUS_OUT                            where the shard census JSON lands
 *      SCOPE=revert-eviction                 undo damaged evictions (see above)
 * Requires dist/ (parseTitleIdentity, hobbyIqCardId, slugGuard,
 * persistVendorSalesToPool, writeReconciliation).
 */
"use strict";

// ── THE LANE NARRATES ITS OWN START, BEFORE IT CAN FAIL ──────────────────────
//
// CF-AN-EMPTY-LOG-IS-NOT-A-BUDGET-KILL (#1913 follow-up, 2026-09-07).
//
// 19 of 121 rematch-sold-comps runner runs (15.7%) ended in #1913's KILLED
// branch with an EMPTY /tmp/backfill.log, and the branch's diagnostic --
// `tail -n 20 /tmp/backfill.log` -- printed nothing at all. An operator reading
// that run saw "KILLED before finish" with no evidence, and the natural reading
// of a KILLED-at-the-ceiling banner is a 150-minute budget kill. It was not.
// Those runs died in 55-70 SECONDS, at the very first env check.
//
// The mechanism is one line of the runner:
//
//     node "backend/scripts/${{ inputs.script }}.cjs" | tee /tmp/backfill.log
//
// `tee` sees STDOUT ONLY. Every startup refusal in this file is a
// `console.error` + `process.exit(2)` -- STDERR -- and it fires BEFORE the
// banner, which is the first thing this script writes to stdout. So a refusal
// wrote the log file and left it EMPTY: exactly the state the KILLED branch
// reads as "neither the budget marker nor finishLane", i.e. a kill.
//
// THE PIN. This is a SOURCE LITERAL printed to STDOUT before any require that
// touches Cosmos, the catalog or dist/ -- before, in fact, any require at all.
// It cannot be skipped by a failing import, a missing dist/, an OOM at module
// load, or an env refusal, because nothing above it can throw. An empty
// /tmp/backfill.log is therefore no longer reachable from this lane: if the log
// is empty the process never started, and if this line is present but nothing
// follows it, the run died in startup and the log says so.
//
// The runner's KILLED branch reads this line to say "started but died at
// <phase>" instead of implying a budget kill. Keep the text stable -- the
// runner and the tests both match on `rematch-sold-comps: STARTUP`.
console.log("rematch-sold-comps: STARTUP ok -- module load beginning (pid " + process.pid + ")");

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const { patchSoldCompFields } = require(path.join(__dirname, "lib", "patch-sold-comp-fields.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
// CF-A-DERIVATION-STAMP-MUST-NOT-HASH-PLUMBING (2026-09-11). storedIdentity
// and deriveIdentity are THE DERIVATION -- what a row's own fields say, and
// what today's parser + matcher would say from its title -- and they used to
// live inline here, which meant the I9 derivation stamp hashed this whole
// file: the worker pool, the write ledger, the budget clock, finishLane's
// exit code, none of which decide a verdict. They are pure (no Cosmos, no
// clock) and now live in lib/rematch-derive-identity.cjs, which is what
// derivation-version.cjs hashes instead. Re-exported below unchanged so every
// caller -- this file's own apply/revert loops, and any test doing
// `require(".../rematch-sold-comps.cjs").deriveIdentity` -- sees the same API.
const { storedIdentity, deriveIdentity } = require(path.join(__dirname, "lib", "rematch-derive-identity.cjs"));
// CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew, 2026-09-05).
// The ONE corroboration predicate, reached through the CJS bridge; never a copy.
const CORROBORATION = require(path.join(__dirname, "lib", "source-corroboration.cjs"));
const SUBSET = require(path.join(__dirname, "lib", "subset-identity.cjs"));

const MODE = String(process.env.MODE || "").trim();
const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: this lane's NORMAL mode is a
// fan-out -- it declares its own multi-slot default (32) and is always
// dispatched per slot -- so it shards on the env alone. The helper is shared so
// the banner and the arithmetic are the same everywhere.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ alwaysShard: true, defaultSlots: 32, label: "rematch-sold-comps" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
const CENSUS_OUT = String(process.env.CENSUS_OUT || "/tmp/rematch-census").trim();
// THE WRITE LEDGER (2026-09-04): where the apply records which POOLS it moved
// rows in and out of, so the canary gate that runs after it can ATTRIBUTE a
// verdict instead of blaming this shard for every writer's changes. Written
// even when nothing was written -- an empty ledger is the positive claim
// "this shard touched no pool", which is the claim the 2026-09-04 halt needed.
const WRITE_LEDGER_OUT = String(process.env.WRITE_LEDGER_OUT || "/tmp/rematch-write-ledger.json").trim();
// Ids are capped per pool so a shard that moves 40k rows does not write a
// 40k-id file; the COUNTS are exact regardless, and the counts are what the
// gate's attribution decision reads.
const LEDGER_IDS_PER_POOL = Math.max(1, Number(process.env.LEDGER_IDS_PER_POOL || 50));
// THE SETTLE MARKERS (CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL, Drew
// 2026-09-04). The write ledger above is the right RECORD in the wrong MEDIUM
// for the pricing engine: it is a file on this runner's disk, and the engine
// runs in App Service. So when a slice that touched a pool COMPLETES, the same
// facts are also written to Cosmos as per-identity markers the engine can read
// at pricing time.
//
// Why this matters: a freshly minted identity is repriceable the moment its
// catalog row exists, but its sales arrive here over the following hours. The
// 1987 Topps Traded Tiffany Maddux row was minted 14:37Z; a reprice at 18:56Z
// with 17 of 350 sales migrated found an empty PSA 10 tier and published $240
// for a ~$1,500 card. The engine's gate presumes a recently minted identity is
// still migrating; THIS marker is what releases it early, so a completed slice
// does not leave its pools gated for the rest of the settle window.
//
// Off by default: the gate is safe without markers (it falls back to the age
// window), so this is an optimization that must never become a dependency.
const SETTLE_MARKERS = String(process.env.SETTLE_MARKERS || "").trim() === "true";
const REMATCH_CONTROL_CONTAINER = String(process.env.COSMOS_REMATCH_CONTROL_CONTAINER || "rematch_control").trim();
/** This file's exit codes so far: 3 (uncaught exception, via finishLane's
 *  catch), 4 (reconcile/class drift), 6 (apply class-scope failure). 5 is
 *  free and is what a census pass exits when its cursor save failed -- see
 *  saveCensusCursor's header comment and the checkpoint block in main(). */
const CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE = 5;
/**
 * THE APPLY CLASS SCOPE (audit gate item 8, 2026-09-03).
 *
 * MODE=apply-improve wrote BOTH writable classes -- IMPROVE and the
 * BASE-EVICTION subclass of CONFLICT -- under one verdict. The second audit
 * gate measured them separately and they came back UNEQUAL: BASE-EVICTION is
 * clean corpus-wide (0 bad in 1,236 audited lines across all 16 shards), while
 * IMPROVE is dirty at 4.9% (298/6,106). A class that has earned its apply
 * could not have it without dragging along the class that has not.
 *
 * So the apply is SCOPABLE, and it rides the EXISTING free-form `scope`
 * dispatch input, which backfill-runner.yml already exports as SCOPE. GitHub
 * caps workflow_dispatch at 25 inputs and 24 are used, so a new one is not
 * available -- and this is the input whose own description documents it as the
 * per-script narrowing carrier.
 *
 *   SCOPE=base-eviction   apply evictions only   <- the clean class
 *   SCOPE=improve         apply IMPROVE only
 *   SCOPE=both            apply both (the pre-2026-09-03 behaviour)
 *   SCOPE=revert-eviction UNDO evictions G6 now refuses  <- the way back
 *
 * REVERT IS A SCOPE, NOT A LANE (2026-09-04). The base-eviction wave wrote
 * 1,456 rows before it was halted, and 12 of them are DAMAGED: G6 now says the
 * title states the stored slug's own parallel, so those evictions should never
 * have run. The obvious shape for the undo is a one-off repair script, and the
 * one-off-per-defect era is precisely what the GREAT REMATCH replaced -- a
 * separate script would carry its own copy of the marker read, its own
 * reconciliation and its own idea of what a revert is, and would then drift
 * from the guard whose verdict it exists to honour.
 *
 * So the undo lives HERE, behind the same MODE, the same `scope` input, the
 * same BACKFILL_APPLY, the same reconciliation and the same verify-by-read. It
 * consults G6 through the SAME classifier function the eviction path consults,
 * so the two can never disagree about which rows are damaged. And it never
 * derives a destination: `rekeyedFrom[0].cardId` is the slug the row recorded
 * for itself on the way out, which makes the revert exact rather than a second
 * guess at an identity.
 *
 * THE INHERITED DEFAULT IS NOT A SCOPE. That input's runner-wide default is
 * "refractor" and its description says the value is INHERITED rather than
 * chosen. An inherited default must never arm a write, so `parseApplyScope`
 * refuses anything it does not recognise and the apply exits 2 -- it does not
 * fall back to "both". A write happens because somebody asked for it by name.
 *
 * MODE=census ignores this entirely: a census writes nothing and must count
 * every class regardless of what an apply would later be scoped to.
 */
const APPLY_SCOPE_RAW = String(process.env.SCOPE || "").trim();
/**
 * THE AUDIT SAMPLE IS 500 ROWS, SPREAD ACROSS DISTINCT CARDS (audit finding 7).
 *
 * This was 30, so the "500-row sample audit" the trust ladder is defined
 * around was arithmetically impossible -- and the 30 that were kept were the
 * first 30 in COSMOS PAGE ORDER, which is partition order, which is card
 * order. Slot 27's sample was 23 of 30 lines from one single card. A sample
 * that is one card is not a sample of a shard.
 *
 * 500, and one reservoir PER cardId rather than one for the whole class, so
 * the lines the auditor reads span the shard's cards instead of its first
 * partition. `sampleLine` below implements it.
 */
const SAMPLE_CAP = Number(process.env.SAMPLE_CAP || 500);
/** At most this many lines from any ONE card, so no single pool can crowd the
 *  sample the way slot 27's did. 500 / 4 still leaves room for 125 cards. */
const SAMPLE_PER_CARD_CAP = Math.max(1, Number(process.env.SAMPLE_PER_CARD_CAP || 4));
/**
 * THE IN-SLOT ROW FILTER (2026-09-07).
 *
 * WHY IT IS A ROW FILTER AND NOT A SHARD AXIS. The shard table is a MEASURED
 * packing of 16.3M pool rows into 32 slots, and `feedback_shard_axis_must_be_
 * guaranteed_and_measured` is explicit that the axis is re-measured, never
 * re-typed. A `sports` axis cannot be added to it without re-measuring the
 * whole packing -- and the sports that need narrowing are exactly the ones the
 * table does NOT split on: SPORT_CLASSES names baseball, football, basketball
 * and pokemon, so soccer, hockey and every other vertical live inside the
 * catch-all "other" and inside undifferentiated whole-year units.
 *
 * So this narrows the rows a slot CLASSIFIES, never the rows a slot OWNS. The
 * slot still reads its own query, still walks its own pages, and `rowInSlot`
 * still decides membership first. A filtered run of slot N is a strict subset
 * of an unfiltered run of slot N: the shard axis is untouched and two slots
 * can no more overlap under a filter than without one.
 *
 *   SPORTS       comma list, matched against the row's OWN sport segment
 *   SETKEY_LIKE  prefix/like on the row's STORED setKey segment
 *
 * BOTH READ THE STORED ROW, NOT THE DERIVATION. The filter decides which rows
 * are examined; the classifier decides what they are. A filter that read the
 * derived key would silently change WHICH rows a census counts as it changed
 * what the deriver says, and two runs of the same dispatch would disagree.
 *
 * THE SETKEY SEGMENT IS READ FROM THE SLUG, and falls back to normalizing
 * setName only when the slug cannot answer. `hiq:<sport>:<year>:<setKey>:...`
 * is the address the row actually occupies, which is the thing a restem is
 * scoped against -- `setName` is free text and two rows in one pool can spell
 * it differently.
 *
 * `like` is a PREFIX, deliberately: `panini-prizm` selects `panini-prizm` and
 * every `panini-prizm-*` specialization in one dispatch, which is the shape a
 * family->product restem is scoped by. It is anchored at the start, so it can
 * never select `donruss-panini-prizm`-shaped keys the caller did not name.
 *
 * COUNTED SEPARATELY FROM `otherSlot`. A row another slot owns and a row this
 * slot owns but the filter excluded are two different facts, and the banner
 * prints both: `filtered` is the population this dispatch declined to look at,
 * and it is what tells a reader that a filtered run's small `seen` is the
 * filter working rather than the shard being empty.
 */
const SPORTS_FILTER = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SETKEY_LIKE = String(process.env.SETKEY_LIKE || "").trim().toLowerCase();
const ROW_FILTER_ON = SPORTS_FILTER.length > 0 || SETKEY_LIKE.length > 0;

/** The setKey segment of a `hiq:<sport>:<year>:<setKey>:...` slug, or "" when
 *  the slug is not that shape. Read from the ADDRESS the row occupies. */
function slugSetKeySegment(slug) {
  const parts = String(slug ?? "").split(":");
  // hiq | sport | year | setKey | ... -- fewer segments is not this shape.
  return parts.length >= 4 && parts[0] === "hiq" ? String(parts[3] ?? "").toLowerCase() : "";
}

/**
 * Does this row pass the in-slot filter? A row the filter excludes is counted
 * and skipped before any derivation, catalog read or classification -- the
 * filter is also what makes a narrow dispatch CHEAP.
 */
function rowPassesFilter(row, deps) {
  if (!ROW_FILTER_ON) return true;
  if (SPORTS_FILTER.length) {
    const sport = String(row?.sport ?? "").trim().toLowerCase();
    if (!SPORTS_FILTER.includes(sport)) return false;
  }
  if (SETKEY_LIKE) {
    let seg = slugSetKeySegment(row?.cardId);
    // A row whose slug is not the canonical shape still has a stored set name,
    // and normalizing it is the same reading `storedIdentity` takes.
    if (!seg && row?.setName && deps?.normalizeSetKey) {
      try { seg = String(deps.normalizeSetKey(String(row.setName)) ?? "").toLowerCase(); } catch { seg = ""; }
    }
    if (!seg) return false;                       // cannot answer -> not selected
    if (seg !== SETKEY_LIKE && !seg.startsWith(`${SETKEY_LIKE}-`)) return false;
  }
  return true;
}


const f = (n) => Number(n ?? 0).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const hashPartOf = (id, parts) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % parts;

// ── the measured shard table ───────────────────────────────────────────────
// Built by GROUP BY over the live pool 2026-09-01 and packed longest-first
// into 32 bins. `rows` is the MEASURED count for that unit at capture time --
// it is the banner's expectation, never a gate (ingest legitimately adds rows).
// A unit is { year, sportClass, hashPart, hashParts, rows }: sportClass null
// means the whole year, hashPart null means the whole unit.
const SPORT_CLASSES = ["baseball", "football", "basketball", "pokemon"];
const SHARD_TABLE = require(path.join(__dirname, "..", "data", "rematch-shard-table.json"));
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

/**
 * EVERY APPLY KIND, IN ONE LIST.
 *
 * The banner, the per-class reconcile and the disarmed report all walk this.
 * It used to be `[K.IMPROVE, K.BASE_EVICTION]` written out at four call sites,
 * which is four places a new scope has to be remembered -- and a scope missing
 * from the RECONCILE is a scope that can write without balancing, which is the
 * one thing `everyWriteJobReconciles` exists to prevent. One list, four
 * readers.
 */
const APPLY_KINDS = [
  K.IMPROVE, K.BASE_EVICTION,
  K.GRADE_FROM_TITLE, K.YEAR_FROM_TITLE_VINTAGE, K.SPORT_FROM_PRODUCT,
  K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT, K.POKEMON_SET_CODE, K.FINISH_IS_A_PARALLEL,
];

/** The units this slot owns. */
function unitsForSlot(slot, table = SHARD_TABLE) {
  const row = (table.slots ?? []).find((s) => Number(s.slot) === Number(slot));
  return row ? row.units : [];
}

/** A Cosmos predicate + params for one unit. `sportClass: "other"` is every
 *  sport OUTSIDE the four named classes, which is why it is a NOT IN. */
function unitPredicate(unit, i) {
  const params = [];
  const parts = [];
  // `absent` and `null` are TWO populations, not one: 49 rows carry no
  // cardYear field and 4,017 carry an explicit null (measured 2026-09-01).
  // They need two different predicates, and folding them together made two
  // slots claim the same rows -- a slice that is not a slice.
  if (unit.yearKind === "absent") parts.push("NOT IS_DEFINED(c.cardYear)");
  else if (unit.yearKind === "null") parts.push("IS_NULL(c.cardYear)");
  else { parts.push(`c.cardYear = @y${i}`); params.push({ name: `@y${i}`, value: Number(unit.year) }); }
  if (unit.sportClass) {
    if (unit.sportClass === "other") {
      const names = SPORT_CLASSES.map((s, j) => { params.push({ name: `@sc${i}_${j}`, value: s }); return `@sc${i}_${j}`; });
      parts.push(`(NOT IS_DEFINED(c.sport) OR NOT (c.sport IN (${names.join(", ")})))`);
    } else { parts.push(`c.sport = @s${i}`); params.push({ name: `@s${i}`, value: unit.sportClass }); }
  }
  return { where: `(${parts.join(" AND ")})`, params };
}

/** The whole slot as ONE query, plus the in-code hash filter the third axis
 *  needs (a hash cannot be expressed in SQL, so it is applied on read -- the
 *  unit is already small enough that this costs a fraction of a share). */
function slotQuery(units, years = YEARS) {
  // A YEARS filter names real years, so it never selects the absent/null
  // units -- those are reached only by running the slot unscoped.
  const scoped = years.length ? units.filter((u) => u.yearKind === "value" && years.includes(Number(u.year))) : units;
  if (!scoped.length) return null;
  const wheres = [], params = [];
  scoped.forEach((u, i) => { const p = unitPredicate(u, i); wheres.push(p.where); params.push(...p.params); });
  return { query: `SELECT * FROM c WHERE ${wheres.join(" OR ")}`, parameters: params, units: scoped };
}

/** Does this row belong to this slot's hash part? Units without a hash part
 *  take every row that matched their year/sport predicate. */
function rowInSlot(row, units) {
  for (const u of units) {
    // `Number(null) === 0` and the pool really does hold a `cardYear: 0` unit
    // (2 rows), so a null-year row would silently match it. Null and undefined
    // are rejected BEFORE the numeric compare or the axis stops being disjoint.
    const yearOk = u.yearKind === "absent" ? row.cardYear === undefined
      : u.yearKind === "null" ? row.cardYear === null
      : row.cardYear !== null && row.cardYear !== undefined && Number(row.cardYear) === Number(u.year);
    if (!yearOk) continue;
    if (u.sportClass) {
      const sport = String(row.sport ?? "").toLowerCase();
      const named = SPORT_CLASSES.includes(sport);
      if (u.sportClass === "other" ? named : sport !== u.sportClass) continue;
    }
    if (u.hashParts && u.hashParts > 1 && hashPartOf(row.id, u.hashParts) !== u.hashPart) continue;
    return true;
  }
  return false;
}

// ── derivation: the row's own title + stored fields, through today's parser ──
//
// storedIdentity / deriveIdentity now live in lib/rematch-derive-identity.cjs
// (required above) so the I9 derivation stamp hashes THE DERIVATION alone,
// not this file's worker pool / ledger / budget plumbing. See that file's
// header comment.

// ── main ───────────────────────────────────────────────────────────────────
/**
 * A STOPPED SLOT MUST SAY WHERE ITS TIME WENT (2026-09-07).
 *
 * "stopped at the 120-minute budget" told a reader nothing that would let them
 * act. Slot 12 printed exactly that beside `written=0`, and the fleet's own
 * annotation guessed the wrong cause from it -- it read the pair as a
 * truncated apply and re-dispatched a REPORT, when the slot had in fact walked
 * its shard and found none of the class it was armed for.
 *
 * So the stop line carries the arithmetic that distinguishes those two: how
 * many rows were classified, how fast, and how much of the shard that covered.
 * A slot that is SLOW and a slot that is EMPTY produce visibly different lines.
 */
function stopAccounting({ stopReason, stats, expected, startedAt }) {
  if (!stopReason) return null;
  const secs = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const looked = stats.seen + stats.prefiltered;
  const reach = stats.seen + stats.prefiltered + stats.otherSlot;
  const rps = looked / secs;
  const lines = [stopReason];
  lines.push(`  where the time went: ${f(stats.seen)} row(s) classified` +
    (stats.prefiltered ? ` + ${f(stats.prefiltered)} prefiltered out` : "") +
    (stats.filtered ? ` + ${f(stats.filtered)} filtered out` : "") +
    ` in ${(secs / 60).toFixed(1)}m  = ${rps.toFixed(0)} in-slot rows/s`);
  lines.push(`  shard coverage:      ${f(reach)} row(s) reached of ${f(expected)} measured at capture` +
    (expected ? `  (${((reach / expected) * 100).toFixed(1)}%)` : ""));
  // The line that names the two causes apart. A slot that saw its whole shard
  // did not run out of time -- it ran out of candidates.
  if (expected && reach >= expected) {
    lines.push(`  this slot REACHED ITS WHOLE SHARD; the budget stopped the tail, not the sweep.`);
  } else if (expected) {
    lines.push(`  this slot did NOT reach its whole shard -- ${f(Math.max(0, expected - reach))} row(s) were never read.`);
  }
  return lines.join("\n");
}

// ── A REFUSAL THE RUNNER'S LOG CAN SEE ───────────────────────────────────────
//
// CF-AN-EMPTY-LOG-IS-NOT-A-BUDGET-KILL (2026-09-07). The runner pipes this
// script through `tee /tmp/backfill.log`, and `tee` sees STDOUT ONLY. Every
// refusal below used to be `console.error` alone, so the runner's log kept no
// trace of WHY a run stopped -- and #1913's KILLED branch, whose whole
// diagnostic is `tail -n 20 /tmp/backfill.log`, printed an empty tail and
// implied a 150-minute budget kill for a run that died in 55 seconds.
//
// `refuse()` writes the SAME text to BOTH streams: stderr keeps the Actions
// red-annotation behaviour operators already rely on, and stdout puts it in
// the log the KILLED branch reads. `phase` names where the lane died, so the
// runner can say "started but died at <phase>" rather than guessing.
// `code` keeps the house convention that a missing COSMOS_CONNECTION_STRING
// exits 1 (every other script in backend/scripts does), while a refusal of a
// dispatched INPUT exits 2. Only the stream the text lands on is changing here;
// the exit codes are exactly what they were.
function refuse(phase, lines, code = 2) {
  const head = `FATAL [phase=${phase}]:`;
  for (const l of [`${head} ${lines[0]}`, ...lines.slice(1)]) {
    console.error(l);
    console.log(l);
  }
  // STARTUP REFUSED is the runner's machine-readable hook. Keep the spelling
  // stable -- backfill-runner.yml greps for it and so do this lane's tests.
  const marker = `rematch-sold-comps: STARTUP REFUSED at phase=${phase} -- the lane never began work (this is NOT a budget kill).`;
  console.error(marker);
  console.log(marker);
  process.exit(code);
}

async function main() {
  if (MODE !== "census" && MODE !== "apply-improve") {
    refuse("mode", [`MODE is required and has no default -- 'census' (read only) or 'apply-improve'. Got ${JSON.stringify(MODE)}.`]);
  }
  // THE CLASS SCOPE IS PARSED BEFORE ANYTHING IS READ, and a scope the apply
  // cannot read is a REFUSAL, not a default. See APPLY_SCOPE_RAW above.
  const applyScope = K.parseApplyScope(APPLY_SCOPE_RAW);
  if (MODE === "apply-improve" && !applyScope.ok) {
    refuse("class-scope", [
      `MODE=apply-improve needs a class scope on the 'scope' input, and ${JSON.stringify(APPLY_SCOPE_RAW)} is not one.`,
      `       ${applyScope.reason}`,
      `       Use scope=base-eviction (the class the audit gate cleared), scope=improve, or scope=both.`,
      `       The runner's inherited default 'refractor' is deliberately NOT accepted -- an apply says which class it writes.`,
      `       IF THIS RUN WAS A SELF-RELAUNCH: the relaunch must forward -f scope=<class>. A relaunch that omits it`,
      `       inherits the workflow default 'refractor' and lands here, having done no work at all.`,
    ]);
  }
  const ARMED = applyScope.classes;
  const REVERTING = MODE === "apply-improve" && applyScope.revert === true;
  /**
   * THE SCOPED-APPLY PREFILTER (2026-09-07).
   *
   * A scoped apply writes ONE class and counts the rest, but it used to
   * CLASSIFY every row of its shard to find out which was which -- and
   * classification is the expensive half (a derivation, a catalog point read,
   * and the per-product map reads behind the clash and flagship gates). Slot
   * 12 of the 2026-09-07 fleet burned its whole 120-minute budget classifying
   * 350,267 rows to discover that ZERO were GRADE-FROM-TITLE, then reported
   * "budget hit ... written=0" -- a report that says nothing about why.
   *
   * `K.applyPrefilterFor` returns the NECESSARY CONDITION for the single armed
   * kind, read off the stored row with no derivation and no catalog read, and
   * built from the very predicates the evidence function's own legs call. A
   * row it refuses would have failed that leg anyway.
   *
   * ONLY IN apply-improve, and only for a single-kind scope. MODE=census must
   * count every class -- that is what a census IS -- so it never filters, and
   * a multi-kind scope gets null because the rows are then a union of two
   * populations. IMPROVE and BASE-EVICTION have no cheap necessary condition
   * and no entry, so `scope=improve` and `scope=both` are untouched.
   */
  const APPLY_PREFILTER = MODE === "apply-improve" && !REVERTING
    ? K.applyPrefilterFor(ARMED) : null;

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { refuse("cosmos-env", ["COSMOS_CONNECTION_STRING not set"], 1); }
  if (!Number.isFinite(SLOT) || !Number.isFinite(SLOTS) || SLOT < 0 || SLOT >= SLOTS) {
    refuse("slot-range", [`SLOT must be 0..${SLOTS - 1}; got SLOT=${SLOT} SLOTS=${SLOTS}`]);
  }
  // THE REVERT PASS BRANCHES BEFORE THE SHARD TABLE, and deliberately.
  //
  // That table is a measured packing of 16.3M pool rows into 32 slots by year
  // and sport. The revert's population is the ~1,456 rows carrying the
  // eviction marker, which do not respect it at all -- an eviction moved each
  // one to a BASE slug carrying the row's own year, so slotting them by that
  // table would hand one slot nearly everything and the rest nothing. The
  // revert shards on sha1(id) % SLOTS instead, which is uniform over whatever
  // the marked set turns out to be, and SLOTS=1 (the default for an unsharded
  // dispatch) puts the whole of it in slot 0.
  //
  // So `SLOTS !== 32` is not an error for a revert, and the reachability
  // checks below -- which ask what the SHARD TABLE says slot N owns -- are not
  // questions a revert can answer or needs to.
  if (REVERTING) {
    const backendDir = requireDist();
    const poolDb = cosmos(conn);
    await revertEvictions({
      pool: poolDb.container("sold_comps"),
      retry: retry,
      reportWrites: require(path.join(backendDir, "dist", "services", "ops", "writeReconciliation.js")).reportWrites,
    });
    return;
  }
  if (SLOTS !== SHARD_TABLE.slots.length) {
    refuse("shard-table", [`SLOTS=${SLOTS} but the measured shard table has ${SHARD_TABLE.slots.length} slots. The table IS the axis -- re-measure before changing it.`]);
  }
  const units = unitsForSlot(SLOT);
  if (!units.length) { refuse("shard-units", [`slot ${SLOT} owns no units in the measured table.`]); }
  const q = slotQuery(units);
  if (!q) { console.log(`slot ${SLOT} has no units matching YEARS=${YEARS.join(",")} -- nothing to do.`); return; }

  const backend = path.resolve(__dirname, "..");
  const d = (p) => require(path.join(backend, "dist", "services", ...p));
  const pti = d(["portfolioiq", "parseTitleIdentity.service.js"]);
  const hic = d(["portfolioiq", "hobbyIqCardId.service.js"]);
  const psk = d(["catalog", "productSetKeys.js"]);
  const guard = d(["portfolioiq", "slugGuard.service.js"]);
  const pvs = d(["portfolioiq", "persistVendorSalesToPool.service.js"]);
  const slugRe = d(["portfolioiq", "slugRederivation.service.js"]);
  const { reportWrites } = d(["ops", "writeReconciliation.js"]);
  // R27-POKEMON-SET-CODE's own table (Drew, 2026-09-13). Required directly --
  // not through `psk`, a different module -- because pokemonSetCodes.ts owns
  // this vocabulary and productSetKeys.ts owns a different one; see
  // POKEMON_SET_CODE's doc for why the two must not merge into one lookup.
  const pkc = d(["catalog", "pokemonSetCodes.js"]);
  const POKEMON_CODE_SET = new Set([
    ...Object.keys(pkc.POKEMON_EN_SET_CODES ?? {}),
    ...Object.keys(pkc.POKEMON_PROMO_SET_CODES ?? {}),
    ...Object.keys(pkc.POKEMON_JA_SET_CODES ?? {}),
  ].map((k) => k.toLowerCase()));
  const POKEMON_AMBIGUOUS_CODES = new Set([...(pkc.AMBIGUOUS_MARKET_CODES ?? [])].map((k) => k.toLowerCase()));
  const deps = {
    parseListingIdentity: pti.parseListingIdentity,
    // isAuto's boundary is the CARD NUMBER, never title text
    // (CF-ISAUTO-BOUNDARY-IS-CARDNUMBER). The classifier needs this verdict
    // separately from parseListingIdentity's OR'd `isAuto`, because that OR
    // is exactly what the D7 guard has to be able to see through.
    isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
    inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
    // CF-THE-PARSER-IS-THE-EVIDENCE (this PR). The ruled soccer competition
    // table's own verdict on a title, exported from the ONE seam that holds
    // it. `specInputs` hands it to the classifier as a boolean so the
    // classifier -- which is pure and must stay so -- never carries a second
    // copy of the 66 regexes that would drift from this one.
    titleStatesSoccerCompetition: pti.titleStatesSoccerCompetition,
    inferSportFromTitle: pti.inferSportFromTitle,
    ingestGradeFromTitle: pvs.ingestGradeFromTitle,
    // The parser's own count-anchored multi-card-lot detector. GUARD 5 in the
    // classifier refuses a cardNumber minted off a lot or a range, and it
    // consults BOTH detectors: the range and pick/singles vocabulary live in
    // rematch-finish-vocab.cjs (pure, no dist/), the count-anchored lot idioms
    // ("Lot of 6", "40x Refractors", "(12 Cards)") live here and are passed in.
    isMultiCardLot: pti.isMultiCardLot,
    normalizeSetKey: hic.normalizeSetKey,
    computeHobbyIqCardId: hic.computeHobbyIqCardId,
    applySiblingChecklistOverride: hic.applySiblingChecklistOverride,
    spellForEra: psk.spellForEra,
    guardSlugInputs: guard.guardSlugInputs,
    normalizeSportStrict: guard.normalizeSportStrict,
    extractYearFromTitle: slugRe.extractYearFromTitle,
  };

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps"), cat = db.container("card_catalog");

  const expected = units.reduce((a, u) => a + Number(u.rows ?? 0), 0);
  console.log(`rematch-sold-comps  MODE=${MODE}  ${MODE === "census" ? "READ ONLY" : APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  shard axis: (cardYear, sportClass, sha1(id) % parts) -- measured ${SHARD_TABLE.measuredAt}, ${f(SHARD_TABLE.totalRows)} rows in ${SHARD_TABLE.slots.length} slots, spread ${SHARD_TABLE.spread}`);
  console.log(`  this slot owns ${q.units.length} unit(s), ${f(expected)} rows measured at capture:`);
  for (const u of q.units) console.log(`    ${String(u.key).padEnd(28)} ${f(u.rows).padStart(11)}`);
  if (YEARS.length) console.log(`  YEARS filter: ${YEARS.join(",")}`);
  // THE FILTER NAMES ITSELF BEFORE A ROW IS READ. A run whose log does not
  // state its own scope cannot be audited after the fact -- the same reason
  // the apply class scope prints above.
  if (ROW_FILTER_ON) {
    console.log(`  IN-SLOT ROW FILTER (narrows the rows this slot CLASSIFIES; the shard axis is untouched):`);
    console.log(`    sports       ${SPORTS_FILTER.length ? SPORTS_FILTER.join(",") : "(any)"}   <- matched against the row's own sport`);
    console.log(`    setkey_like  ${SETKEY_LIKE || "(any)"}   <- prefix on the row's STORED setKey segment`);
  } else {
    console.log(`  IN-SLOT ROW FILTER: none -- every row this slot owns is classified.`);
  }
  // THE BANNER SAYS WHICH CLASSES ARE ARMED, BEFORE A ROW IS READ. A run whose
  // log does not name its own scope cannot be audited after the fact.
  if (MODE === "apply-improve") {
    console.log(`  APPLY CLASS SCOPE: scope=${JSON.stringify(APPLY_SCOPE_RAW)} -> ${[...ARMED].join(" + ")}`);
    for (const kind of APPLY_KINDS) {
      console.log(`    ${kind.padEnd(15)} ${ARMED.has(kind) ? "ARMED   -- candidates of this class may be written" : "DISARMED -- candidates of this class are counted and never written"}`);
    }
  } else {
    console.log(`  MODE=census counts every class; the apply class scope does not apply (and nothing is written).`);
  }

  // ── checklist backing, cached per slug ────────────────────────────────────
  // A match proves nothing unless checklist-backed. The catalog row's SOURCE
  // is the evidence: a checklist ingest, never a vendor row.
  //
  // A CURATED CHECKLIST SOURCE IS CHECKLIST-BACKED, AND `bcp` IS NOT A
  // SUBSTRING OF `bccp` (2026-09-04).
  //
  // THE DAMAGE. This regex was the driver's own second opinion about what
  // "checklist-backed" means, written before #1725 gave the allowlist a name.
  // Nine of the twenty-one sources the allowlist names do not match it:
  //
  //   bccp  cardboardconnection  cardboard-connection  baseball-almanac
  //   hobbymonitor  bbm-japan-official-pdf  pokemon-tcg-data
  //   drew-google-sheet  cardpedia-drew-ruling
  //
  // Each is a real scraped checklist -- `bccp` alone carries 19,620 catalog
  // rows in 2025 bowman, `hobbymonitor` 59,982 in 2025 topps-chrome -- and the
  // near miss is the worst kind: `bcp` IS in the pattern, and `bcp` is not a
  // substring of `bccp`, so the source that looks covered is the one that is
  // not. The visible cost is at base-eviction, where the destination gate
  // reports `no-checklist-backed-base-destination` for a base slug whose
  // checklist we hold and scraped: base sales stay stranded in a refractor
  // pool for want of a source name, which is one card and two pools.
  //
  // THE FIX IS A UNION, NOT A REPLACEMENT, AND THE DIRECTION IS WHY.
  //
  // `K.isStrictChecklistSource` is the ONE definition of a named checklist
  // source and every source it names is now accepted here. It is added to the
  // regex rather than substituted for it, because the two disagree in BOTH
  // directions and only one of those disagreements is this PR's ruling:
  //
  //   strict accepts, regex rejects   the nine stems above -- the defect.
  //   regex accepts, strict rejects   `derived-from-base-checklist-*` and
  //                                   `auto-seed-*`. Dropping those would
  //                                   TIGHTEN the ordinary IMPROVE gate across
  //                                   the whole 16.3M-row pool -- a different
  //                                   ruling, on a different population,
  //                                   that nobody has made.
  //
  // So this predicate only ever widens, and it widens by exactly the set of
  // sources the tree already calls checklists. `checklistBackedStrict` below
  // is untouched and stays the STRICTER gate SPECIALIZATION-STATED reads.
  const CHECKLIST_SOURCE_RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;
  const backedCache = new Map();
  const strictCache = new Map();
  const catRowCache = new Map();
  const productSportCache = new Map();
  /** The catalog row for a slug, cached, or null. One read serves both
   *  predicates -- the strict gate must not double the census's catalog RU. */
  const catRow = async (slug) => {
    if (!slug) return null;
    if (catRowCache.has(slug)) return catRowCache.get(slug);
    let out = null;
    try { out = (await retry(() => cat.item(slug, slug).read())).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    catRowCache.set(slug, out);
    return out;
  };
  const sourceText = (r) => `${String(r?.source ?? r?.sourceSystem ?? "")},${Array.isArray(r?.sources) ? r.sources.join(",") : ""}`;
  /** Every source name the row carries, in one list. Any ONE of them may hold
   *  the proof, so `sources[]` is read beside `source` and `sourceSystem` --
   *  the same shape `checklistBackedStrict` reads, so the two predicates
   *  cannot disagree about WHICH strings they were shown. */
  const namedSources = (r) => [r?.source, r?.sourceSystem, ...(Array.isArray(r?.sources) ? r.sources : [])];
  const checklistBacked = async (slug) => {
    if (!slug) return false;
    if (backedCache.has(slug)) return backedCache.get(slug);
    const resource = await catRow(slug);
    let backed = false;
    if (resource) {
      // The allowlist first -- it is the tree's ONE definition of a named
      // checklist source, and it is what carries the nine stems the pattern
      // below cannot see.
      backed = namedSources(resource).some((s) => K.isStrictChecklistSource(s))
        || CHECKLIST_SOURCE_RE.test(sourceText(resource))
        || resource.checklistBacked === true;
    }
    backedCache.set(slug, backed);
    return backed;
  };
  /** L3. Backed by a REAL SCRAPED checklist source -- one NAMED in
   *  STRICT_CHECKLIST_SOURCES. A row whose only evidence is
   *  `checklistBacked: true` with no named source is NOT strict backing: that
   *  flag says someone believed it, not who measured it. Any of the row's
   *  sources may carry the proof, so `sources[]` is checked alongside
   *  `source`. */
  /** CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew,
   *  2026-09-05). A row from a DEMOTED source is strict only where a second
   *  strict source names the same identity cell and agrees on the player.
   *
   *  A point read of the slug cannot answer that: the catalog holds ONE row per
   *  id (measured 2026-09-05 -- id === cardId, no twins share an address), so
   *  a demoted row's rivals live at other addresses in the same PRODUCT. The
   *  product scan `checklistCells` below is the read, and it is the same
   *  one-query-per-(year, setKey) shape `flagshipNumbers`, `checklistNames` and
   *  `checklistAutos` already use for exactly this reason: a per-row catalog
   *  query over 16.3M rows is not a census, it is an outage
   *  (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH). Every demoted row
   *  of the product then reads its own rivals out of the map for free, and a
   *  product with no demoted rows never triggers the query at all. */
  const checklistBackedStrict = async (slug) => {
    if (!slug) return false;
    if (strictCache.has(slug)) return strictCache.get(slug);
    const resource = await catRow(slug);
    let backed = false;
    if (resource) {
      const named = [resource.source, resource.sourceSystem, ...(Array.isArray(resource.sources) ? resource.sources : [])];
      backed = named.some((s) => K.isStrictChecklistSource(s));
      // The demotion, applied only where a named source actually demands it --
      // so the 45-odd other sources cost nothing and no existing verdict moves.
      if (backed && named.some((s) => CORROBORATION.requiresCorroboration(s))) {
        // hiq:<sport>:<year>:<setKey>:<number>:<parallel>:<auto>[:...] -- the
        // sport is segment 1, and it is the slug's OWN answer about which
        // product this row belongs to, which is exactly the right one here:
        // corroboration must come from the checklist of the product the row is
        // addressed to, never from another sport that reuses the setKey.
        const parts = String(slug).split(":");
        const rivals = parts.length >= 7
          ? await checklistCells(parts[2], parts[3], deps.normalizeSportStrict(parts[1]))
          : null;
        backed = K.isStrictChecklistRow(resource, rivals ?? []);
      }
    }
    strictCache.set(slug, backed);
    return backed;
  };
  /** Every UNGRADED catalog row of ONE (year, setKey) that may serve as a
   *  SECOND source -- the rival set a demoted row is corroborated against.
   *  One query per product, cached, and never issued for a product that holds
   *  no demoted rows. Graded children are excluded by the predicate itself: a
   *  row minted from its parent cannot confirm that parent one tier up. */
  const checklistCellsCache = new Map();
  const checklistCells = async (year, setKey, sport) => {
    // Corroboration from another sport's checklist is not corroboration.
    if (!sport) return [];
    const key = `${year}|${setKey}|${sport}`;
    if (checklistCellsCache.has(key)) return checklistCellsCache.get(key);
    let out = [];
    try {
      const { resources } = await retry(() => cat.items.query({
        query: `SELECT c.id, c.source, c.playerName, c.gradeTier, c.sport FROM c WHERE c.setKey = @sk AND ${yearMatch("c")}`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll());
      out = (resources ?? []).filter((r) => CORROBORATION.isCorroboratingSource(r) && rowIsSport(r, sport));
    } catch { out = []; }
    checklistCellsCache.set(key, out);
    return out;
  };
  /** L5. Does the STORED flagship's own checklist list this cardNumber?
   *  `null` when the question cannot be answered, which the classifier treats
   *  as a refusal. ONE query per (year, setKey), cached: a per-row query over
   *  16.3M rows is not a census, it is an outage.
   *  CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH. */
  /** CF-THE-SLUG'S-YEAR-IS-THE-IDENTITY-YEAR (Drew, 2026-09-04). Every
   *  product-level catalog read below used to filter `c.cardYear = @y` alone.
   *  `cardYear` is a MIRROR of `year`, not the identity: the identity year is
   *  the one in the slug. deriveCatalogEntry dual-writes both
   *  (CF-YEAR-CARDYEAR-DUAL-WRITE), but the 59 hand-rolled catalog writers do
   *  not, and ingest-checklist-csv-to-catalog -- the lane behind EVERY
   *  sportscardchecklist row -- wrote `year` only. So the strictest checklists
   *  we own were invisible to the leg that asks "is this checklist-backed":
   *
   *    topps-traded-tiffany 1987   total 39 | strict-checklist 0 | has 70T: 0
   *
   *  while the catalog held 132 strictly-sourced rows for that product,
   *  hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto among them. The
   *  22 Tiffany-titled Maddux #70T rows stayed CONFLICT on a lookup miss, not
   *  on a disagreement. Reading BOTH names is the fix at this end; the ingest
   *  child now dual-writes so the field is never absent again.
   *
   *  An OR of two equality predicates is still index-served on both terms. */
  const yearMatch = (alias) => `(${alias}.cardYear = @y OR ${alias}.year = @y)`;

  /**
   * CF-A-SETKEY-IS-NOT-A-PRODUCT-UNTIL-A-SPORT-NAMES-IT (this PR).
   *
   * THE DEFECT. Every checklist lookup below keys on (setKey, cardYear) and
   * NOTHING ELSE. `topps-chrome`, `panini-prizm`, `panini-select`,
   * `topps-finest`, `topps` and `bowman-chrome` are all shipped in several
   * sports in the same year, and each sport is a SEPARATE product with a
   * SEPARATE checklist that numbers its cards 1..N in its own space. Keyed
   * without a sport, "the flagship's checklist" is the UNION of every sport's,
   * so the question L5 asks -- does the stored flagship list this number? --
   * has been answered by other sports' checklists.
   *
   * MEASURED read-only 2026-09-06 over the eleven shared families: 162 of 253
   * (setKey, year) cells carrying strict checklist rows hold MORE THAN ONE
   * SPORT, and hundreds of card numbers per cell are shared between them.
   *   topps-chrome|2025  baseball 1,092 numbers (527 shared) | football 2,285
   *                      (538) | basketball 1,887 (455) | tennis 720 (300)
   *   panini-prizm|2022  baseball 955 (345) | football 849 (383) |
   *                      basketball 724 (358)
   * The 2022 soccer World Cup cell that opened this PR is one instance of a
   * general defect, not a soccer special case.
   *
   * THE FILTER IS IN MEMORY, NOT IN THE QUERY, and that is deliberate. These
   * caches exist because a per-row catalog query over 16.3M rows is an outage
   * rather than a census (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH).
   * Adding `c.sport = @sp` to the SQL would key the cache by sport too and
   * issue one query per (product, year, sport) instead of per (product, year),
   * multiplying reads on the hottest path here for a filter that is a string
   * compare over rows already in hand. The rows are fetched once per product
   * and each sport reads its own slice for free.
   *
   * A ROW WITH NO READABLE SPORT GETS NO ANSWER. `null` from
   * `normalizeSportStrict` means the row does not say which product it belongs
   * to, and a lookup that cannot name its product must not borrow another
   * one's checklist. The callers below turn that into the refusal each already
   * has for an unanswerable question -- `null` for L5, an empty map elsewhere
   * -- because absent beats wrong, which is the rule every one of these gates
   * is already written to.
   *
   * THE SPORT COMES FROM THE STORED ROW, WHICH IS SOMETIMES THE THING UNDER
   * REPAIR. That is the right input anyway: L5 asks about the STORED
   * flagship -- the product the row currently claims to belong to -- so the
   * stored sport is precisely the one that names it. A row whose sport is
   * wrong is answered against the wrong product's checklist either way; what
   * this stops is answering it against ALL products' checklists at once, which
   * is wrong for every row rather than only the mis-tagged ones.
   */
  const sportOf = (identity) => deps.normalizeSportStrict(identity?.sport ?? null);
  // The predicate itself lives in the pure lib (K.catalogRowAnswersForSport) so
  // it is pinned on the shipped rule rather than on a test's copy of it; these
  // closures only supply the normalizer, which is a dist/ import this module
  // holds and that one must not.
  const rowIsSport = (r, sport) => K.catalogRowAnswersForSport(r, sport, deps.normalizeSportStrict);
  const flagshipNumbersCache = new Map();
  const flagshipNumbers = async (year, setKey, sport) => {
    // No readable sport, no product, no answer. See sportOf above.
    if (!sport) return null;
    const key = `${year}|${setKey}|${sport}`;
    if (flagshipNumbersCache.has(key)) return flagshipNumbersCache.get(key);
    let out = null;
    try {
      const { resources } = await retry(() => cat.items.query({
        query: `SELECT c.cardNumber, c.source, c.sport FROM c WHERE c.setKey = @sk AND ${yearMatch("c")}`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll());
      // A flagship with NO real checklist rows IN THIS SPORT cannot answer the
      // question -- "not listed", "nothing to list from" and "that is another
      // sport's checklist" are three different facts and only the first is
      // evidence. Null is the refusal.
      const real = (resources ?? []).filter((r) => K.isStrictChecklistSource(r?.source) && rowIsSport(r, sport));
      out = real.length ? new Set(real.map((r) => String(r.cardNumber ?? "").toUpperCase())) : null;
    } catch { out = null; }
    flagshipNumbersCache.set(key, out);
    return out;
  };
  /** CF-A-PLAYER-NAME-IS-NOT-A-FINISH (2026-09-04). The CHECKLIST's playerName
   *  per cardNumber for ONE (year, setKey), cached -- the trusted half of the
   *  base-eviction guard-3 suppression.
   *
   *  ONE QUERY PER PRODUCT, for the reason `flagshipNumbers` above states: a
   *  per-row catalog query over 16.3M rows is not a census, it is an outage
   *  (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH). Every row of the
   *  product then reads its own name out of the map for free.
   *
   *  ONLY A STRICT CHECKLIST SOURCE MAY ANSWER. A vendor row's player field is
   *  the same field, from the same kind of parse, that the pool's own 25.7%
   *  corruption comes from (#1734) -- citing one as the trusted name would be
   *  citing the defect as its own cure. A product with no strictly-sourced rows
   *  yields an empty map, every lookup returns null, and the guard falls back
   *  to the row's own name only if that reads as a person. Absent beats wrong.
   */
  const checklistNamesCache = new Map();
  const checklistNames = async (year, setKey, sport) => {
    // A name read from another sport's checklist is a DIFFERENT PLAYER at the
    // same number, which is the worst possible answer for a guard whose whole
    // job is to say who the card depicts. No sport, no map.
    if (!sport) return new Map();
    const key = `${year}|${setKey}|${sport}`;
    if (checklistNamesCache.has(key)) return checklistNamesCache.get(key);
    let out = new Map();
    try {
      const { resources } = await retry(() => cat.items.query({
        query: `SELECT c.cardNumber, c.playerName, c.source, c.sport FROM c WHERE c.setKey = @sk AND ${yearMatch("c")} AND c.playerName > ''`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll());
      for (const r of resources ?? []) {
        if (!K.isStrictChecklistSource(r?.source) || !rowIsSport(r, sport)) continue;
        const num = String(r?.cardNumber ?? "").toUpperCase();
        const name = String(r?.playerName ?? "").trim();
        if (!num || !name || out.has(num)) continue;
        out.set(num, name);
      }
    } catch { out = new Map(); }
    checklistNamesCache.set(key, out);
    return out;
  };
  /** CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE (2026-09-04). The CHECKLIST's isAuto
   *  per cardNumber for ONE (year, setKey), cached -- leg S3 of
   *  SELLER-NAME-AUTO, and the only thing that may authorize taking an
   *  autograph flag OFF a stored row.
   *
   *  ONE QUERY PER PRODUCT, for the reason `flagshipNumbers` and
   *  `checklistNames` above both state: a per-row catalog query over 16.3M
   *  rows is not a census, it is an outage
   *  (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH). Every row of the
   *  product then reads its own answer out of the map for free.
   *
   *  ONLY A STRICT CHECKLIST SOURCE MAY ANSWER, exactly as L3 demands. A
   *  vendor row's isAuto is the SAME FIELD, from the same title parse, that
   *  this PR exists to repair -- citing one would be citing the defect as its
   *  own cure. A product with no strictly-sourced rows yields an empty map,
   *  every lookup returns null, and null is a REFUSAL: absent beats wrong. */
  const checklistAutoCache = new Map();
  const checklistAutos = async (year, setKey, sport) => {
    // Whether #150 is an autograph is a fact about ONE product's checklist.
    // No sport, no map -- and an empty map is already this gate's refusal.
    if (!sport) return new Map();
    const key = `${year}|${setKey}|${sport}`;
    if (checklistAutoCache.has(key)) return checklistAutoCache.get(key);
    let out = new Map();
    try {
      const { resources } = await retry(() => cat.items.query({
        query: `SELECT c.cardNumber, c.isAuto, c.source, c.sport FROM c WHERE c.setKey = @sk AND ${yearMatch("c")}`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll());
      for (const r of resources ?? []) {
        if (!K.isStrictChecklistSource(r?.source) || !rowIsSport(r, sport)) continue;
        const num = String(r?.cardNumber ?? "").toUpperCase();
        // A checklist row with NO isAuto field states nothing. Blank means
        // unknown, never "Base" (CF-EVERY-INGEST-USES-THE-ONE-CHECKLIST-FORMAT).
        if (!num || r?.isAuto === null || r?.isAuto === undefined || out.has(num)) continue;
        out.set(num, r.isAuto === true);
      }
    } catch { out = new Map(); }
    checklistAutoCache.set(key, out);
    return out;
  };
  /** S3 as a tri-state, read off the STORED identity -- the row being repaired,
   *  not a re-derivation of it:
   *    true   a strictly-sourced checklist row says this card is NOT an auto
   *    false  ...says it IS one (the shop sold a real autograph)
   *    null   unanswered -- no row, or none strictly sourced. A refusal. */
  const checklistSaysNotAutoFor = async (identity) => {
    const y = identity?.cardYear, sk = identity?.setKey, num = identity?.cardNumber;
    if (y === null || y === undefined || !sk || !num) return null;
    const m = await checklistAutos(y, sk, sportOf(identity));
    const hit = m.get(String(num).toUpperCase());
    return hit === undefined ? null : hit === false;
  };
  /** This row's checklist name, or null. Read off the DERIVED identity, which
   *  is the reading the eviction destination is computed from. */
  const checklistPlayerNameFor = async (identity) => {
    const y = identity?.cardYear, sk = identity?.setKey, num = identity?.cardNumber;
    if (y === null || y === undefined || !sk || !num) return null;
    const m = await checklistNames(y, sk, sportOf(identity));
    return m.get(String(num).toUpperCase()) ?? null;
  };
  /** CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew, 2026-09-04).
   *  Every subsetName the catalog holds at ONE rung -- the whole identity
   *  minus the subset. Two or more means this product numbers this card under
   *  more than one subset and the plain id answers for two different cards.
   *
   *  ONE QUERY PER (year, setKey), cached, for the same reason flagshipNumbers
   *  is: a per-row query over 16.3M rows is not a census, it is an outage
   *  (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH). The product's
   *  clash map is built once and every row of that product reads it for free.
   *
   *  Measured 2026-09-04: 17 clash sets exist across 4 products in the whole
   *  catalog, so this returns empty for effectively every row and the subset
   *  rule stays silent -- which is the design, not an accident of the data. */
  const clashMapCache = new Map();
  const clashMap = async (year, setKey, sport) => {
    // A subset clash is two subsets of ONE product numbering one card. Two
    // sports numbering their own cards the same is not a clash at all, and
    // counting it as one would make the subset rule fire on cards that do not
    // clash with anything.
    if (!sport) return new Map();
    const key = `${year}|${setKey}|${sport}`;
    if (clashMapCache.has(key)) return clashMapCache.get(key);
    let out = new Map();
    try {
      const { resources } = await retry(() => cat.items.query({
        // A range predicate on subsetName is index-served; IS_DEFINED is a
        // scan. Blank is unknown and can neither create nor join a clash, so
        // excluding it here is the rule, not an optimisation.
        query: `SELECT c.cardNumber, c.parallelSlug, c.isAuto, c.printRun, c.subsetName, c.sport FROM c WHERE c.setKey = @sk AND ${yearMatch("c")} AND c.subsetName > ''`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll());
      for (const r of resources ?? []) {
        if (!rowIsSport(r, sport)) continue;
        const sub = String(r?.subsetName ?? "").trim();
        if (!sub) continue;
        // ONE key builder for both sides. The catalog spells the parallel
        // `parallelSlug` and a sale row spells it `parallel`; a key built from
        // whichever field was to hand would miss every clash silently.
        const rk = SUBSET.rungKey(r);
        if (!out.has(rk)) out.set(rk, new Set());
        out.get(rk).add(sub);
      }
      // Keep only the rungs that actually clash, so the per-row read is a hit
      // test against a map that is usually empty.
      for (const [k, v] of [...out]) if (v.size < 2) out.delete(k);
    } catch { out = new Map(); }
    clashMapCache.set(key, out);
    return out;
  };
  /** The clashing subsets at THIS row's rung, or [] -- which is the state of
   *  effectively every row and means the subset rule says nothing. */
  const clashSubsetsFor = async (stored) => {
    const year = stored?.cardYear, setKey = String(stored?.setKey ?? "").toLowerCase();
    if (!year || !setKey) return [];
    const m = await clashMap(year, setKey, sportOf(stored));
    if (!m.size) return [];
    const hit = m.get(SUBSET.rungKey(stored));
    return hit ? [...hit] : [];
  };
  const flagshipListsCardNumber = async (stored) => {
    const year = stored?.cardYear, setKey = String(stored?.setKey ?? "").toLowerCase();
    const num = String(stored?.cardNumber ?? "").toUpperCase();
    if (!year || !setKey || !num) return null;
    // THE SPORT NAMES THE PRODUCT. Without it this asked whether ANY sport's
    // checklist at this (setKey, year) lists the number, and answered yes off
    // a different sport's card -- see CF-A-SETKEY-IS-NOT-A-PRODUCT-UNTIL-A-
    // SPORT-NAMES-IT above. `null` (unreadable sport, or no strict rows in
    // this sport) stays the refusal it already was.
    const nums = await flagshipNumbers(year, setKey, sportOf(stored));
    return nums ? nums.has(num) : null;
  };
  /** SPECIALIZATION-STATED's two catalog facts, computed ONLY for a row whose
   *  setKey actually moved along the ladder. Every other row -- the
   *  overwhelming majority of 16.3M -- pays nothing: the ladder test is pure
   *  string work on two keys already in hand, and a row that fails it can
   *  never qualify however the catalog answers. Without this gate the census
   *  would issue two extra catalog reads per row and stop being a census. */
  const specInputs = async (row, stored, der) => {
    const none = { derivedBackedStrict: false, storedFlagshipListsCardNumber: null, competitionStated: false };
    if (!der?.ok) return none;
    if (!K.isSpecializationOf(der.identity?.setKey, stored?.setKey)) return none;
    return {
      derivedBackedStrict: await checklistBackedStrict(der.slug),
      storedFlagshipListsCardNumber: await flagshipListsCardNumber(stored),
      // CF-THE-PARSER-IS-THE-EVIDENCE (this PR). The classifier's L2 leg asks
      // the title to state every word that distinguishes the derived key from
      // the stored one, and a ruled soccer competition key is a canonical NAME
      // whose alias is what the market actually writes -- "World Cup Qatar"
      // never says "fifa". The PARSER already matched that alias to reach this
      // derived key; this hands the classifier that fact rather than asking it
      // to hold a second copy of the 66 regexes.
      //
      // Read from the STORED key, because that is the family the table refines,
      // and confirmed against the DERIVED key, so a title naming a different
      // competition can never be cited as evidence for this one. Pure string
      // work over a table already in memory: no catalog read, no cost.
      competitionStated: deps.titleStatesSoccerCompetition
        ? deps.titleStatesSoccerCompetition(stored?.setKey, der.identity?.setKey, row?.title) : false,
    };
  };

  /**
   * YEAR-FROM-TITLE-VINTAGE's one catalog fact, GATED THE SAME WAY.
   *
   * The destination is the derived identity at the TITLE'S year, and it is
   * checked only for a row that could possibly qualify: a modern slug year, a
   * vintage title year, a vintage-capable setKey, no retro marker. Every other
   * row -- essentially all of 16.3M -- pays nothing but pure string work, for
   * the reason `specInputs` above states: a census that issues a catalog read
   * per row is not a census.
   */
  const vintageInputs = async (row, stored, der) => {
    if (!der?.ok) return { vintageDestBacked: null };
    const slugYear = K.slugYearSegment(row?.cardId) ?? stored?.cardYear ?? null;
    const titleYear = K.firstStatedYear(row?.title);
    if (!(slugYear >= 2015) || titleYear === null || titleYear >= 1990) return { vintageDestBacked: null };
    const setKey = String(stored?.setKey ?? "").toLowerCase();
    if (!K.VINTAGE_CAPABLE_SETKEYS.has(setKey)) return { vintageDestBacked: null };
    if (K.RETRO_SETKEY_RE.test(setKey) || K.RETRO_TITLE_RE.test(String(row?.title ?? ""))) return { vintageDestBacked: null };
    // The destination is the DERIVED slug -- the deriver already reads the
    // title's year, so `der.slug` IS the identity at the right year. Asking
    // the catalog about it is the CF-CATALOG-MATCH-IS-SELF-CONFIRMING gate:
    // unbacked is a PARK, never a move (#1890's fifth ruling).
    return { vintageDestBacked: await checklistBacked(der.slug) };
  };

  /**
   * SPORT-FROM-PRODUCT's two facts.
   *
   * `productSport` is read from the PRODUCT'S OWN CHECKLIST -- the sport
   * segment of the checklist-backed catalog rows for this (year, setKey) --
   * never from the player and never from the title's team words. That is the
   * ruling stated as a lookup: a 2025 Topps Baseball First Pitch card is a
   * baseball card because the BASEBALL checklist lists it.
   *
   * Gated on a real sport disagreement, so a row whose sport already agrees
   * (virtually all of them) costs nothing.
   */
  const productSportFor = async (stored) => {
    const year = stored?.cardYear, setKey = String(stored?.setKey ?? "").toLowerCase();
    if (!year || !setKey) return null;
    const key = `psport:${year}:${setKey}`;
    if (productSportCache.has(key)) return productSportCache.get(key);
    let answer = null;
    try {
      const { resources } = await retry(() => cat.items.query({
        query: "SELECT TOP 40 c.sport FROM c WHERE c.cardYear = @y AND c.setKey = @k AND IS_DEFINED(c.sport)",
        parameters: [{ name: "@y", value: Number(year) }, { name: "@k", value: setKey }],
      }, { maxItemCount: 40 }).fetchNext());
      const seen = new Set((resources ?? []).map((r) => String(r.sport ?? "").toLowerCase()).filter(Boolean));
      // A PRODUCT THAT ANSWERS WITH TWO SPORTS HAS NOT ANSWERED. The checklist
      // itself is then saying the product is multi-sport, which is the same
      // verdict MULTI_SPORT_SETKEYS reaches by name -- and this catches the
      // ones the list does not know about yet.
      answer = seen.size === 1 ? [...seen][0] : null;
    } catch { answer = null; }
    productSportCache.set(key, answer);
    return answer;
  };
  const sportInputs = async (row, stored, der) => {
    const none = { productSport: null, sportDestBacked: null };
    if (!der?.ok) return none;
    const storedSport = String(stored?.sport ?? "").toLowerCase();
    const derivedSport = String(der.identity?.sport ?? "").toLowerCase();
    if (!derivedSport || storedSport === derivedSport) return none;
    const setKey = String(stored?.setKey ?? "").toLowerCase();
    if (K.MULTI_SPORT_SETKEYS.has(setKey)) return none;
    const ps = await productSportFor(stored);
    if (!ps || ps !== derivedSport) return { productSport: ps, sportDestBacked: null };
    return { productSport: ps, sportDestBacked: await checklistBacked(der.slug) };
  };

  /**
   * R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT's one catalog fact (Drew, 2026-09-13).
   *
   * Gated on pure string work first, exactly like `specInputs`/`vintageInputs`
   * above: `productParentOf` is a synchronous table read (no I/O), so the
   * ONLY cost this function can ever add is the one `checklistBacked` call,
   * and only for a row whose derived key really is a productSetKeys.ts
   * product whose declared parent is the stored key.
   */
  const r26Inputs = async (row, stored, der) => {
    const none = { derivedIsNamedProduct: false, derivedBackedR26: false };
    if (!der?.ok) return none;
    const storedKey = String(stored?.setKey ?? "").toLowerCase();
    const derivedKey = String(der.identity?.setKey ?? "").toLowerCase();
    if (!storedKey || !derivedKey || storedKey === derivedKey) return none;
    if (!psk.isProductSetKey(derivedKey)) return none;
    if (psk.productParentOf(derivedKey) !== storedKey) return none;
    return { derivedIsNamedProduct: true, derivedBackedR26: await checklistBacked(der.slug) };
  };

  /**
   * R27-POKEMON-SET-CODE's facts (Drew, 2026-09-13; CF-THE-SET-CODE-IS-THE-KEY).
   *
   * Gated on the sport and a Set membership test first -- both pure and
   * synchronous -- so only a genuine Pokemon-code candidate pays for the
   * catalog read. `storedIsRivalPokemonSetCode` answers straight off the SAME
   * table: the ruling's "stale default" excludes a second real code, and this
   * is the one fact that tells the two apart without a catalog read either.
   *
   * THE LANGUAGE FLAG. `languageResolves` reads the row's OWN stored
   * `language` field -- never the title, and never a guess -- because the
   * ruling's whole point is that a bare code says nothing about which market
   * a colliding row belongs to; only a fact the row itself carries may answer
   * for it. A row with no language field stays unresolved, which is the safe
   * default the ruling asks for (`ambiguous-code-language-unresolved`).
   */
  const r27Inputs = async (row, stored, der) => {
    const none = {
      derivedIsPokemonSetCode: false, storedIsRivalPokemonSetCode: false,
      pokemonCodeIsAmbiguous: false, pokemonLanguageResolves: null, derivedBackedR27: false,
    };
    if (!der?.ok) return none;
    if (String(stored?.sport ?? der.identity?.sport ?? "").toLowerCase() !== "pokemon") return none;
    const derivedKey = String(der.identity?.setKey ?? "").toLowerCase();
    if (!derivedKey || !POKEMON_CODE_SET.has(derivedKey)) return none;
    const storedKey = String(stored?.setKey ?? "").toLowerCase();
    const isAmbiguous = POKEMON_AMBIGUOUS_CODES.has(derivedKey);
    let languageResolves = null;
    if (isAmbiguous) {
      // The row's own language flag -- `language`/`cardLanguage`, whichever
      // the ingest wrote -- read directly, no catalog call. `en`/`english`
      // resolves an EN code, `ja`/`jp`/`japanese` resolves neither (the
      // colliding code is EN-keyed by construction; see AMBIGUOUS_MARKET_
      // CODES's own doc -- a JAPANESE flag on a colliding code names the
      // JAPANESE product, which this table does not carry under this code at
      // all, so the row is a rival reading, not a match, and stays refused
      // rather than resolved).
      const lang = String(stored?.language ?? stored?.cardLanguage ?? row?.language ?? "").trim().toLowerCase();
      if (lang === "en" || lang === "english") languageResolves = true;
      else if (lang) languageResolves = false;
    }
    const storedIsRivalPokemonSetCode = !!storedKey && storedKey !== derivedKey && POKEMON_CODE_SET.has(storedKey);
    if (storedIsRivalPokemonSetCode) {
      return {
        derivedIsPokemonSetCode: true, storedIsRivalPokemonSetCode: true,
        pokemonCodeIsAmbiguous: isAmbiguous, pokemonLanguageResolves: languageResolves, derivedBackedR27: false,
      };
    }
    return {
      derivedIsPokemonSetCode: true, storedIsRivalPokemonSetCode: false,
      pokemonCodeIsAmbiguous: isAmbiguous, pokemonLanguageResolves: languageResolves,
      derivedBackedR27: await checklistBacked(der.slug),
    };
  };

  /**
   * R28-FINISH-IS-A-PARALLEL's facts (Drew, 2026-09-13). See
   * FINISH_IS_A_PARALLEL's doc in the classifier for the whole argument; this
   * mirrors its own guard order so the driver never asks the checklist about
   * a shape the classifier would have refused anyway.
   *
   * Gated the same way as every input function above: the suffix test, the
   * DISTINCT-product guard and the finish-vocabulary test are all pure
   * synchronous table/string work, so `checklistListsParallel` -- the one
   * call with real cost -- runs only for a row that survived all three.
   */
  const r28Inputs = async (row, stored, der) => {
    const none = { checklistListsFinishAsParallel: false, derivedBackedR28: false };
    if (!der?.ok) return none;
    const storedKey = String(stored?.setKey ?? "").toLowerCase();
    const derivedKey = String(der.identity?.setKey ?? "").toLowerCase();
    if (!derivedKey || !storedKey.startsWith(`${derivedKey}-`) || storedKey === derivedKey) return none;
    const finishWord = storedKey.slice(derivedKey.length + 1);
    if (!finishWord) return none;
    // THE 2026-09-03 DISTINCT-PRODUCT GUARD, asked here too so the driver
    // never spends a checklist read on a shape the classifier refuses anyway
    // -- see FINISH_IS_A_PARALLEL's doc for why `topps-chrome-platinum` is
    // the measured reason this guard exists.
    if (K.DISTINCT_PRODUCT_SETKEYS.includes(storedKey)) return none;
    if (K.ruledCollapsePair(storedKey, derivedKey)) return none;
    const isFinishVocab = K.FINISH_COLOR_TOKENS.includes(finishWord)
      || K.VOCAB.CORE_FINISH_TOKENS.includes(finishWord)
      || K.VOCAB.FINISH_FAMILY_TOKENS.includes(finishWord);
    if (!isFinishVocab) return none;
    const year = stored?.cardYear ?? der.identity?.cardYear ?? null;
    const listsIt = year ? K.VOCAB.checklistListsParallel(finishWord, year, derivedKey) : false;
    return {
      checklistListsFinishAsParallel: listsIt,
      derivedBackedR28: await checklistBacked(der.slug),
    };
  };

  // ── page the shard ────────────────────────────────────────────────────────
  const counts = { [K.AGREE]: 0, [K.IMPROVE]: 0, [K.CONFLICT]: 0, [K.UNDERIVABLE]: 0 };
  const byTier = new Map(), defects = new Map(), reasons = new Map(), samples = new Map(), subclasses = new Map();
  // SPLIT-IDENTITY tallies, kept beside the class counts rather than inside
  // them: a row is split OR NOT independently of which class it landed in.
  const splitByClass = new Map(), splitSegments = new Map(), splitSamples = [];
  // SLUG-SHAPE DEFECTS: two report-only subclasses (2026-09-04), tallied the
  // same way as the split signal -- a row carries them independently of the
  // class it lands in, so they are counted ALONGSIDE the class totals and must
  // never be summed with them. See SLUG_SHAPE_DEFECTS in the classifier for
  // why each one stops at a count.
  const slugShapeCounts = new Map(), slugShapeByClass = new Map(), slugShapeSamples = new Map();
  // The three ruled scopes of 2026-09-06, each reporting its own shape.
  const gftByGrader = new Map(), gftByGrade = new Map(), gftBySport = new Map(), gftSamples = [];
  const yfvByDecade = new Map(), yfvBySetKey = new Map(), yfvBySport = new Map(), yfvSamples = [];
  const sfpByPair = new Map(), sfpBySetKey = new Map(), sfpSamples = [];
  // THE THREE RULED SCOPES OF 2026-09-13 (R26/R27/R28) -- same shape as the
  // trio above: a count says how many, these say WHAT.
  const r26ByPair = new Map(), r26Samples = [];
  const r27ByPair = new Map(), r27Samples = [];
  const r28ByPair = new Map(), r28Samples = [];
  let splitTotal = 0;
  const stats = { seen: 0, otherSlot: 0, filtered: 0, prefiltered: 0, intended: 0, written: 0, skipped: 0, failed: 0, duplicatesLeft: 0, alreadyGone: 0, notReached: 0 };
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

  /**
   * THE SAMPLE IS A RESERVOIR PER cardId, NOT THE FIRST N ROWS (finding 7).
   *
   * Cosmos returns a shard in partition order, so "the first 30" was "the
   * first two or three cards" -- slot 27's sample was 23 of 30 lines from a
   * single card, and an auditor reading it learned about one pool. A per-card
   * reservoir spends the 500 lines across distinct cardIds instead: each card
   * contributes at most SAMPLE_PER_CARD_CAP lines, and once a class is full,
   * a NEW card still displaces a line from the most over-represented card
   * seen so far. So a shard with 500+ distinct cards yields ~500 distinct
   * cards, and one with few cards degrades to an even spread over what exists.
   *
   * `sampleCards` tracks, per class, how many lines each cardId holds.
   */
  const sampleCards = new Map();   // klass -> Map(cardId -> line count)
  /**
   * THE NAMED AGGREGATE, so a resume can save and reload it as ONE object
   * instead of the cursor helpers having to know each counter's shape by
   * hand. Every entry here is either a `Map<string, number>` (bumped
   * counters), a `Map<string, Map<string, number>>` (the per-class sample
   * reservoirs' per-card tallies), an array (capped sample lines) or a plain
   * number -- `censusAggregateToJSON`/`FromJSON` below switch on which.
   */
  const AGGREGATE_FIELDS = {
    counts: "object", stats: "object", splitTotal: "number",
    byTier: "map", defects: "map", reasons: "map", subclasses: "map",
    splitByClass: "map", splitSegments: "map",
    slugShapeCounts: "map", slugShapeByClass: "map",
    gftByGrader: "map", gftByGrade: "map", gftBySport: "map",
    yfvByDecade: "map", yfvBySetKey: "map", yfvBySport: "map",
    sfpByPair: "map", sfpBySetKey: "map",
    samples: "mapOfArrays", sampleCards: "mapOfMaps",
    slugShapeSamples: "mapOfArrays",
    splitSamples: "array", gftSamples: "array", yfvSamples: "array", sfpSamples: "array",
  };
  const aggregateRefs = {
    counts, stats, get splitTotal() { return splitTotal; }, set splitTotal(v) { splitTotal = v; },
    byTier, defects, reasons, subclasses, splitByClass, splitSegments,
    slugShapeCounts, slugShapeByClass, gftByGrader, gftByGrade, gftBySport,
    yfvByDecade, yfvBySetKey, yfvBySport, sfpByPair, sfpBySetKey,
    samples, sampleCards, slugShapeSamples,
    splitSamples, gftSamples, yfvSamples, sfpSamples,
  };
  /** Serialize the whole in-memory aggregate to a plain JSON-safe object. */
  const censusAggregateToJSON = () => {
    const out = {};
    for (const [name, kind] of Object.entries(AGGREGATE_FIELDS)) {
      const v = aggregateRefs[name];
      if (kind === "map") out[name] = Object.fromEntries(v);
      else if (kind === "mapOfArrays") out[name] = Object.fromEntries([...v].map(([k, arr]) => [k, arr]));
      else if (kind === "mapOfMaps") out[name] = Object.fromEntries([...v].map(([k, m]) => [k, Object.fromEntries(m)]));
      else out[name] = v; // "object" | "number" | "array" -- already plain
    }
    return out;
  };
  /** Merge a PRIOR pass's saved aggregate into the live in-memory one, BEFORE
   *  this pass classifies a single row of its remaining units. Counters add;
   *  arrays concatenate then re-cap at the same limit the live sampler uses,
   *  so a resumed sample stays within its documented cap. This is called at
   *  most once, at the top of a resumed pass -- the live counters are empty
   *  at that point, so "merge" and "load" are the same operation here. */
  const mergeCensusAggregate = (prior) => {
    if (!prior || typeof prior !== "object") return;
    for (const [name, kind] of Object.entries(AGGREGATE_FIELDS)) {
      const saved = prior[name];
      if (saved === undefined || saved === null) continue;
      if (kind === "map") { for (const [k, n] of Object.entries(saved)) bump(aggregateRefs[name], k, Number(n) || 0); }
      else if (kind === "mapOfArrays") {
        const m = aggregateRefs[name];
        for (const [k, arr] of Object.entries(saved)) {
          const cap = name === "samples" ? SAMPLE_CAP : 20;
          const existing = m.get(k) ?? [];
          m.set(k, [...existing, ...(Array.isArray(arr) ? arr : [])].slice(0, Math.max(existing.length, cap)));
        }
      } else if (kind === "mapOfMaps") {
        const m = aggregateRefs[name];
        for (const [k, inner] of Object.entries(saved)) {
          const cur = m.get(k) ?? new Map();
          for (const [ck, cn] of Object.entries(inner)) cur.set(ck, (cur.get(ck) ?? 0) + (Number(cn) || 0));
          m.set(k, cur);
        }
      } else if (kind === "array") {
        aggregateRefs[name].push(...(Array.isArray(saved) ? saved : []).slice(0, 30));
      } else if (name === "counts") {
        for (const k of Object.keys(counts)) counts[k] += Number(saved[k]) || 0;
      } else if (name === "stats") {
        for (const k of Object.keys(stats)) stats[k] += Number(saved[k]) || 0;
      } else if (name === "splitTotal") {
        splitTotal += Number(saved) || 0;
      }
    }
  };
  const sample = (klass, cardId, line) => {
    if (!samples.has(klass)) { samples.set(klass, []); sampleCards.set(klass, new Map()); }
    const arr = samples.get(klass);
    const perCard = sampleCards.get(klass);
    const key = String(cardId ?? "");
    const mine = perCard.get(key) ?? 0;
    if (mine >= SAMPLE_PER_CARD_CAP) return;          // this card has had its share
    if (arr.length < SAMPLE_CAP) {
      arr.push({ cardId: key, line });
      perCard.set(key, mine + 1);
      return;
    }
    // Full. A card not yet represented displaces a line from whichever card
    // holds the most -- that is what keeps the tail of the shard reachable
    // instead of the sample being decided by the first page.
    if (mine > 0) return;
    let worstCard = null, worstN = 1;
    for (const [c, n] of perCard) if (n > worstN) { worstCard = c; worstN = n; }
    if (!worstCard) return;                            // already one line per card
    const idx = arr.findIndex((e) => e.cardId === worstCard);
    if (idx < 0) return;
    arr[idx] = { cardId: key, line };
    perCard.set(worstCard, worstN - 1);
    perCard.set(key, 1);
  };
  /** The census JSON and the banner both want plain lines. */
  const sampleLines = (klass) => (samples.get(klass) ?? []).map((e) => e.line);
  /** How many DISTINCT cards a class's sample actually spans -- the number
   *  that says whether finding 7 is fixed, printed in the banner and carried
   *  in the census JSON so the audit gate can assert on it. */
  const sampleCardCount = (klass) => (sampleCards.get(klass) ?? new Map()).size;

  const improvable = [];
  /** Writable candidates the class scope held back, per class. Counted so the
   *  reconcile can show what a scoped run declined to write. */
  const disarmed = Object.create(null);
  /** The parser's lot detector, defensive: a parser throw must not take out a
   *  census pass over 16.3M rows, and the classifier's own range/pick half of
   *  GUARD 5 still fires without it. */
  const safeIsLot = (t) => { try { return deps.isMultiCardLot ? !!deps.isMultiCardLot(t) : false; } catch { return false; } };
  let stopReason = null;

  // ── THE CENSUS CURSOR: SKIP DONE UNITS, MERGE THEIR SAVED COUNTS ──────────
  //
  // MODE=census only -- see censusCursorId's header comment for why. An apply
  // is not resumable the same way (its queue is built from a census-fresh
  // read and re-checked row by row at write time), and this cursor never
  // touches it: `unitsForCensus` below is exactly `q.units` unless a PRIOR
  // pass's saved cursor says some of them are already classified and counted.
  // getOrCreateControlContainer (not a bare `.container()` reference) so the
  // FIRST slot to ever touch `rematch_control` provisions it instead of every
  // read/write 404ing against a container the SDK never checked for -- see
  // that function's header comment for the incident this replaces.
  let control = null;
  if (MODE === "census") {
    try { control = await getOrCreateControlContainer(conn); }
    catch (e) { console.warn(`  !! could not open/create the ${REMATCH_CONTROL_CONTAINER} container (${String(e?.message ?? e).slice(0, 140)}) -- this census will run without a durable cursor.`); }
  }
  const priorCursor = MODE === "census" ? await loadCensusCursor(control, SLOT) : null;
  const doneUnitKeys = new Set(priorCursor?.unitsDone ?? []);
  // THE PAGE CHECKPOINT (2026-09-12, #2058 follow-up). A unit is 500k-1M+
  // rows and this shard's measured rate (~150-200 rows/s in-slot) classifies
  // roughly 1-1.4M rows per 120-minute link -- so a slot whose FIRST unit
  // alone is ~485k-1.1M rows can spend its entire budget inside that one
  // unit and never reach the unit-done line at all. `unitsDone` alone is
  // therefore not a fine enough grain: every run 34686318652/34686403508/
  // 34686374165/34688675098 checkpointed "0 of 2 unit(s)" while burning the
  // full 118+ minutes, and the next dispatch reads that as "nothing done"
  // and re-pages unit 0 from its first row again -- forever, for any slot
  // whose per-unit row count exceeds one link's throughput.
  //
  // `partialUnit` is the sub-unit grain: which unit is IN PROGRESS, the
  // Cosmos query iterator's own `continuationToken` for it (the SDK's exact
  // resume point for a plain `WHERE` query with no ORDER BY -- see
  // slotQuery's header, this query is never cross-partition-sorted, so a
  // token issued by one process is valid input to `items.query` on a brand
  // new one), and the aggregate this pass had accumulated as of that token.
  // It is saved every PAGE_CHECKPOINT_PAGES pages or PAGE_CHECKPOINT_MS,
  // whichever comes first, so a budget stop mid-unit still leaves a resume
  // point at most one checkpoint interval behind the kill, not at unit 0.
  const priorPartialUnit = priorCursor?.partialUnit ?? null;
  if (priorCursor) {
    // `mergeCensusAggregate` adds the saved `stats` (seen, otherSlot,
    // filtered, prefiltered, ...) into the live counters below, so `stats.seen`
    // after this call already IS the carried-forward classified count --
    // `priorCursor.classified` is a redundant witness of the same number,
    // read here only for the narration line, never assigned over the merge.
    mergeCensusAggregate(priorCursor.aggregate);
    const partialNote = priorPartialUnit
      ? ` A page checkpoint inside unit ${priorPartialUnit.key} carries this pass straight to its saved continuation token.`
      : "";
    console.log(`  CENSUS CURSOR: resuming slot ${SLOT} -- ${doneUnitKeys.size} of ${q.units.length} unit(s) already classified in a prior pass (${f(stats.seen)} rows carried forward, cursor said ${f(Number(priorCursor.classified) || 0)}). Signature matched: same shard table, scope and filters.${partialNote}`);
  } else if (MODE === "census") {
    console.log(`  CENSUS CURSOR: no usable prior checkpoint for slot ${SLOT} -- starting from unit 0.`);
  }
  /** How often the in-flight unit's continuation token is checkpointed.
   *  Pages are 500 rows (maxItemCount above); at the measured ~150-200
   *  in-slot rows/s, 40 pages is ~2,000-2,700 rows -- comfortably under a
   *  minute even at the slow end, so PAGE_CHECKPOINT_MS below (the tighter
   *  of the two) is what actually governs in practice. Both are configurable
   *  for tests. */
  const PAGE_CHECKPOINT_PAGES = Math.max(1, Number(process.env.CENSUS_PAGE_CHECKPOINT_PAGES || 40));
  const PAGE_CHECKPOINT_MS = Math.max(1000, Number(process.env.CENSUS_PAGE_CHECKPOINT_MS || 5 * 60 * 1000));
  // MODE=apply-improve keeps the ORIGINAL single-query shape -- one query
  // object over every unit combined, walked once. Splitting it per unit like
  // the census below would reissue the whole combined query once PER UNIT
  // (N-fold read amplification) and let `rowInSlot` admit the same row once
  // per unit it is not excluded by, double-classifying it. Only a census's
  // OWN pass needs to be resumable across a relaunch; an apply's queue is
  // rebuilt from a census-fresh read every dispatch and re-checked per row at
  // write time (see the re-read block below), so there is nothing here for a
  // cursor to resume -- unfinished work is simply not queued and is caught by
  // the next census + apply cycle.
  const unitsThisPass = MODE === "census"
    ? q.units.filter((u) => !doneUnitKeys.has(String(u.key)))
    : [{ key: "__apply-improve-whole-slot__", __wholeSlotQuery: true }];
  // A unit's own row count is what "reached its whole shard" is measured
  // against in `stopAccounting` -- rows already classified in a prior pass
  // still count toward `expected`, via `stats.seen` carried forward above.

  // The in-progress unit's latest known resume point, kept in memory across
  // the whole `page:` loop (not just one unit's iteration) so the FINAL
  // checkpoint after the loop -- reached on a budget stop, a LIMIT stop, or
  // a save failure -- always has this pass's best available token, not only
  // whatever the periodic in-loop save last managed to persist. Cleared the
  // instant a unit finishes (see `doneUnitKeys.add` below): a unit marked
  // done must never also carry a stale in-progress token into the cursor.
  let pendingPartialUnit = null;

  page: for (const unit of unitsThisPass) {
    if (MODE === "census" && budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    // `unit` already survived slotQuery's own YEARS filter once, when `q.units`
    // was built above -- re-applying the identical filter to a one-unit array
    // is idempotent and can never come back null for a unit already in q.units.
    const unitQuery = MODE === "census" ? slotQuery([unit], YEARS) : q;
    // RESUME MID-UNIT: a saved page checkpoint for THIS EXACT unit hands its
    // continuationToken straight to `items.query`, so this pass's first
    // `fetchNext()` returns the page AFTER the one the prior pass last
    // classified -- not unit 0's first page again. `priorPartialUnit` is
    // read at most once (a prior pass can only ever have been stopped
    // inside ONE unit), but the read itself is naturally one-shot here since
    // `unitsThisPass` visits each unit at most once per process.
    const resumeToken = (MODE === "census" && priorPartialUnit && String(priorPartialUnit.key) === String(unit.key))
      ? priorPartialUnit.continuationToken
      : undefined;
    const it = MODE === "census"
      ? pool.items.query(unitQuery, { maxItemCount: 500, continuationToken: resumeToken })
      : pool.items.query(unitQuery, { maxItemCount: 500 });
    let pagesSinceCheckpoint = 0;
    let lastCheckpointAt = Date.now();
    while (it.hasMoreResults()) {
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    const page = await retry(() => it.fetchNext());
    const { resources } = page;
    for (const row of resources ?? []) {
      if (!rowInSlot(row, q.units)) { stats.otherSlot++; continue; }
      // THE IN-SLOT ROW FILTER, applied after slot membership and before any
      // derivation: a row this dispatch was not asked to look at costs no
      // parser call and no catalog read. See SPORTS_FILTER above.
      if (!rowPassesFilter(row, deps)) { stats.filtered++; continue; }
      // THE SCOPED-APPLY PREFILTER, applied after slot membership and the
      // in-slot filter and before ANY derivation or catalog read. A row that
      // cannot be the one class this apply is armed for costs nothing but the
      // two field tests behind it. Counted separately from `filtered` and
      // `otherSlot`: "another slot owns it", "this dispatch declined to look
      // at it" and "it cannot be the class we are writing" are three different
      // facts and the banner prints all three.
      if (APPLY_PREFILTER && !APPLY_PREFILTER({ row, stored: storedIdentity(row, deps) })) {
        stats.prefiltered++;
        continue;
      }
      if (LIMIT && stats.seen >= LIMIT) { stopReason = stopReason ?? `stopped at the LIMIT of ${f(LIMIT)} rows`; break page; }
      stats.seen++;
      const stored = storedIdentity(row, deps);
      const der = deriveIdentity(row, deps);
      const backed = der.ok ? await checklistBacked(der.slug) : false;
      // The base destination is only ever LOOKED UP for a row that could
      // possibly be an eviction -- its slug must already name a parallel.
      // Without this, every one of the shard's rows costs a second catalog
      // read for a question that was answered by its own slug.
      const beCandidate = der.ok && K.slugNamesParallel(row.cardId);
      const baseBacked = beCandidate ? await checklistBacked(der.baseSlug) : false;
      // The checklist name is looked up on the SAME condition as the base
      // destination: only a row whose own slug names a parallel can be an
      // eviction, and only an eviction reads this. A row that is not a
      // candidate costs no catalog read for a question it never asks.
      const beName = beCandidate ? await checklistPlayerNameFor(der.identity) : null;
      const spec = await specInputs(row, stored, der);
      const res = K.classifyRow({
        row, stored, derived: der.ok ? der.identity : null, checklistBacked: backed, derivationReasons: der.reasons,
        storedSlug: row.cardId, baseDestSlug: der.baseSlug ?? null, baseDestBacked: baseBacked,
        checklistPlayerName: beName,
        parserSaysLot: safeIsLot(row.title),
        autoByCardNumber: der.autoByCardNumber === true,
        // S3, and ONLY for a row that is actually a candidate: stored isAuto
        // is true and the title's only autograph witness is a shop name. A row
        // that is not a candidate costs no catalog read for a question it
        // never asks -- the same discipline `beName` above follows.
        checklistSaysNotAuto: (stored?.isAuto === true
          && K.autographWitnessIsSellerNameOnly(row.title))
          ? await checklistSaysNotAutoFor(stored)
          : null,
        ...spec,
        // CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). A fact about the
        // ROW, not a verdict about the derivation: does its own title state a
        // card number? It is the one thing that lets a stored player-<name>
        // pseudo-number count as blank, so a re-derivation onto a real number
        // classifies IMPROVE instead of changed:cardNumber. Without it a
        // genuinely unnumbered card is compared as the real answer it is.
        titleStatesNumber: K.titleStatesCardNumber(row.title),
        // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE: the catalog's
        // answer, never the title's. Empty for effectively every row.
        clashSubsets: await clashSubsetsFor(stored),
        // THE THREE RULED SCOPES OF 2026-09-06. Supplied at BOTH call sites
        // for the reason `spec` above states: a gate that disagrees with
        // itself between the census and the apply is a gate nobody can
        // audit. Each helper is cost-gated on a pure string test first, so
        // a row that cannot qualify issues no catalog read at all.
        ...(await vintageInputs(row, stored, der)),
        ...(await sportInputs(row, stored, der)),
        // THE THREE RULED SCOPES OF 2026-09-13 (R26/R27/R28). Same discipline
        // as the trio above: supplied at BOTH call sites, each helper
        // cost-gated on pure synchronous work first.
        ...(await r26Inputs(row, stored, der)),
        ...(await r27Inputs(row, stored, der)),
        ...(await r28Inputs(row, stored, der)),
      });
      counts[res.klass]++;
      // THE SPLIT-IDENTITY SIGNAL, tallied ACROSS classes (Drew 2026-09-02).
      // The row's own two identity fields disagree, which the exact pool
      // reader turns into one sale priced into two cards. It is orthogonal to
      // the derivation class -- most split rows classify AGREE -- so it is
      // counted per class as well as in total, or the AGREE-shaped majority
      // would never appear in this banner at all.
      if (res.splitIdentity) {
        splitTotal++;
        bump(splitByClass, `${res.klass}/${res.splitClass}`);
        for (const seg of res.splitSegments ?? []) bump(splitSegments, seg);
        if ((splitSamples.length) < SAMPLE_CAP) {
          splitSamples.push(`${row.id}  [${res.klass}/${res.tier}]  ${row.cardId}  ||  ${row.hobbyiqCardId}${res.splitSegments?.length ? `  [${res.splitSegments.join(",")}]` : ""}`);
        }
      }
      for (const d of res.slugShapeDefects ?? []) {
        bump(slugShapeCounts, d);
        bump(slugShapeByClass, `${d}/${res.klass}`);
        if (!slugShapeSamples.has(d)) slugShapeSamples.set(d, []);
        const arr = slugShapeSamples.get(d);
        if (arr.length < 20) arr.push(`${row.id}  ${row.cardId}  [${res.klass}/${res.tier}]  printRun=${JSON.stringify(row.printRun ?? null)}  "${String(row.title ?? "").slice(0, 60)}"`);
      }
      if (res.subclass) bump(subclasses, `${res.klass}/${res.subclass}/${res.tier}`);
      // THE THREE RULED SCOPES REPORT THEIR OWN SHAPE, NOT JUST THEIR COUNT.
      // A count says how many; these say WHAT -- which grader, which grade,
      // which decade, which sport pair -- which is what a report-first
      // dispatch is read for before anything is armed.
      if (res.subclass === K.GRADE_FROM_TITLE) {
        const e = res.gradeFromTitleEvidence ?? {};
        bump(gftByGrader, String(e.gradeCompany ?? "?"));
        bump(gftByGrade, `${e.gradeCompany ?? "?"} ${e.gradeValue ?? "?"}`);
        bump(gftBySport, String(row.sport ?? "?"));
        if (gftSamples.length < 30) gftSamples.push(`${String(`${e.gradeCompany} ${e.gradeValue}`).padEnd(9)} [${String(row.sport ?? "?").padEnd(10)}] ${row.cardId}  "${String(row.title ?? "").slice(0, 96)}"`);
      } else if (res.subclass === K.YEAR_FROM_TITLE_VINTAGE) {
        const e = res.vintageYearEvidence ?? {};
        bump(yfvByDecade, String(e.decade ?? "?"));
        bump(yfvBySetKey, String(e.setKey ?? "?"));
        bump(yfvBySport, String(row.sport ?? "?"));
        if (yfvSamples.length < 30) yfvSamples.push(`${e.slugYear} -> ${e.titleYear} (${e.decade})  [${String(row.sport ?? "?").padEnd(10)}] ${row.cardId}  "${String(row.title ?? "").slice(0, 88)}"`);
      } else if (res.subclass === K.SPORT_FROM_PRODUCT) {
        const e = res.sportFromProductEvidence ?? {};
        bump(sfpByPair, String(e.pair ?? "?"));
        bump(sfpBySetKey, String(e.setKey ?? "?"));
        if (sfpSamples.length < 30) sfpSamples.push(`${String(e.pair).padEnd(24)} ${row.cardId}  "${String(row.title ?? "").slice(0, 92)}"`);
      } else if (res.subclass === K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT) {
        const e = res.flagshipSwallowedNamedProductEvidence ?? {};
        bump(r26ByPair, `${e.storedSetKey ?? "?"}->${e.derivedSetKey ?? "?"}`);
        if (r26Samples.length < 30) r26Samples.push(`${String(`${e.storedSetKey}->${e.derivedSetKey}`).padEnd(36)} ${row.cardId}  "${String(row.title ?? "").slice(0, 88)}"`);
      } else if (res.subclass === K.POKEMON_SET_CODE) {
        const e = res.pokemonSetCodeEvidence ?? {};
        bump(r27ByPair, String(e.pair ?? "?"));
        if (r27Samples.length < 30) r27Samples.push(`${String(e.pair).padEnd(24)} ${row.cardId}  "${String(row.title ?? "").slice(0, 92)}"`);
      } else if (res.subclass === K.FINISH_IS_A_PARALLEL) {
        const e = res.finishIsAParallelEvidence ?? {};
        bump(r28ByPair, String(e.pair ?? "?"));
        if (r28Samples.length < 30) r28Samples.push(`${String(e.pair).padEnd(36)} ${row.cardId}  "${String(row.title ?? "").slice(0, 88)}"`);
      }
      bump(byTier, `${res.klass}/${res.tier}`);
      for (const a of K.defectAxes(res)) bump(defects, `${res.klass}  ${a}`);
      for (const r of res.reasons) bump(reasons, `${res.klass}  ${r}`);
      const sampleKey = res.subclass ? `${res.klass}/${res.subclass}` : res.klass;
      // The reservoir decides admission itself (per-card caps and displacement),
      // so it is called for EVERY row rather than only while the class is short
      // -- a length check here is what made the sample the first page.
      // THE EVIDENCE LINE MUST CARRY THE EVIDENCE (GUARD 7, 2026-09-04).
      //
      // The title was cut at 68 characters, and an audit is a reading of the
      // TITLE against the two identities -- so the cut removed exactly the
      // tokens the verdict turns on. Quoted from the slot-19 evidence, with
      // the old cut marked:
      //
      //   "2022 Bowman's Best - Top Prospects James Wood #TP-7 Blue Refractor /|150"
      //   "1987 TOPPS TIFFANY #648 BARRY LARKIN RC HOF REDS NM-MT OR BETTER SET|-BREAK"
      //
      // The print run and the set-break idiom both fall off the end, and both
      // decide a class: `/150` is what separates a numbered parallel from a
      // base card, and "Set-Break" is what separates one card from a lot. An
      // auditor reading these lines cannot see what the classifier saw.
      //
      // 160 matches `baseEvictionEvidence`'s own `titleQuoted` cap, so the two
      // places an auditor reads a title agree, and it is the width the eBay
      // title limit makes near-lossless in practice.
      sample(sampleKey, row.cardId, `${row.id}  [${res.tier}]  "${String(row.title ?? "").slice(0, 160)}"  ${K.renderIdentity(stored)}  ->  ${K.renderIdentity(res.subclass === K.BASE_EVICTION ? der.baseIdentity : der.ok ? der.identity : null)}`);
      // THE SCOPE IS A REFUSAL AT QUEUE TIME, NOT A FILTER ON A REPORT. A
      // candidate of a disarmed class is never queued, so it can never be
      // written -- and it is COUNTED, so the census still says how many the
      // scope held back. `writableUnderScope` is the only place `writable`
      // and the scope are combined, so a caller cannot arm a class by reading
      // `writable` and forgetting the scope.
      if (MODE === "apply-improve" && res.writable) {
        const kind = K.applyKindOf(res);
        if (kind && !ARMED.has(kind)) {
          disarmed[kind] = (disarmed[kind] ?? 0) + 1;
          bump(reasons, `apply  not-armed-by-scope:${kind}`);
        } else if (K.writableUnderScope(res, ARMED)) {
          // THE QUEUE IS BUILT ON THE APPLY KIND, NOT ON THE CLASS. The three
          // 2026-09-06 scopes all carry `klass === IMPROVE`, so a test on the
          // class would file them as ordinary improves and write them to
          // `der.slug` -- which for GRADE-FROM-TITLE is the row's OWN address
          // (a no-op that reports as a write) and for the other two is right
          // only by accident. `applyKindOf` is the one place the kind is
          // decided, and it is the one thing this branch reads.
          if (kind === K.GRADE_FROM_TITLE) {
            // A FIELD BACKFILL HAS NO DESTINATION. The slug is the row's own,
            // and what travels is the two grade fields the classifier read.
            improvable.push({
              kind, row, stored, slug: row.cardId, identity: stored,
              gradeFields: {
                gradeCompany: res.gradeFromTitleEvidence?.gradeCompany ?? null,
                gradeValue: res.gradeFromTitleEvidence?.gradeValue ?? null,
              },
            });
          } else if (kind === K.YEAR_FROM_TITLE_VINTAGE || kind === K.SPORT_FROM_PRODUCT
            || kind === K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT || kind === K.POKEMON_SET_CODE
            || kind === K.FINISH_IS_A_PARALLEL) {
            // THE THREE RULED SCOPES OF 2026-09-13, same shape as the trio
            // above: each moves setKey (R28 also moves parallel) TO the
            // derived identity, so the destination is `der.slug`/`der.identity`
            // exactly as YEAR-FROM-TITLE-VINTAGE and SPORT-FROM-PRODUCT are.
            improvable.push({ kind, row, stored, slug: der.slug, identity: der.identity });
          } else if (kind === K.IMPROVE) {
            improvable.push({ kind: K.IMPROVE, row, stored, slug: der.slug, identity: der.identity });
          } else if (kind === K.BASE_EVICTION) {
            improvable.push({ kind: K.BASE_EVICTION, row, stored, slug: der.baseSlug, identity: der.baseIdentity });
          }
        }
      }
    }
    // ── MID-UNIT PAGE CHECKPOINT ──────────────────────────────────────────
    //
    // A unit only reaches `doneUnitKeys.add` below once EVERY page of it has
    // been read -- which for slot 0's 484,940-row first unit at ~150-200
    // in-slot rows/s is 40-55 minutes on its own, and several measured units
    // exceed a whole 120-minute link. Waiting for the unit boundary to
    // checkpoint is exactly the defect: `page.continuationToken` (present on
    // every FeedResponse from a query with no ORDER BY, which this one never
    // has -- see slotQuery's header) is the SDK's own exact resume point, so
    // it is saved here, well inside the unit, the same way a completed unit
    // is saved at the loop's outer level. Gated on `hasMoreResults()` still
    // being true: a token from the FINAL page of a unit is meaningless (the
    // unit's own "done" checkpoint below supersedes it) and some SDK
    // versions return an empty/stale token there.
    if (MODE === "census" && it.hasMoreResults() && page.continuationToken) {
      // The in-memory resume point is updated on EVERY page, budget-write or
      // not: it is what the final checkpoint (after the `page:` loop) falls
      // back to if a budget or LIMIT stop lands between two periodic Cosmos
      // saves, so it must always be this pass's truly latest token, not only
      // its last successfully PERSISTED one.
      pendingPartialUnit = { key: String(unit.key), continuationToken: page.continuationToken };
      pagesSinceCheckpoint++;
      const dueByPages = pagesSinceCheckpoint >= PAGE_CHECKPOINT_PAGES;
      const dueByTime = (Date.now() - lastCheckpointAt) >= PAGE_CHECKPOINT_MS;
      if (dueByPages || dueByTime) {
        const saved = await saveCensusCursor(control, SLOT, {
          unitsDone: [...doneUnitKeys],
          aggregate: censusAggregateToJSON(),
          classified: stats.seen,
          partialUnit: pendingPartialUnit,
        });
        if (saved) {
          pagesSinceCheckpoint = 0;
          lastCheckpointAt = Date.now();
        }
        // A failed periodic save is NOT reported here (no console.warn, no
        // exit-code change): it must not abort a pass that is still making
        // in-memory progress, and the pass keeps trying on the NEXT interval
        // -- Cosmos throttling is often transient. What is load-bearing is
        // the LAST save of the pass, at or after the `page:` loop exits,
        // which is unconditionally re-attempted below and IS what turns a
        // still-failing save into the loud CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE
        // exit, exactly as a unit-boundary failure already does.
      }
    }
    // Re-check the budget after a checkpoint save's own wall-clock cost --
    // but ONLY if there is more of this unit left to read. A unit whose
    // just-processed page WAS its last (`hasMoreResults()` now false) is
    // finished, full stop, regardless of how little budget remains: ending
    // the `while` here via `hasMoreResults()` itself (not this check) is
    // what lets the loop fall through to `doneUnitKeys.add` below as a
    // clean completion. Applying this check unconditionally would misfile a
    // unit that finished with the budget merely LOW as a mid-unit stop,
    // discarding its "done" status for no reason -- exactly the bug an
    // earlier draft of this fix introduced.
    if (MODE === "census" && it.hasMoreResults() && budgetLeft() < 90000) {
      stopReason = stopReason ?? `stopped at the ${RUN_MINUTES}-minute budget`;
      break;
    }
    } // end `while (it.hasMoreResults())` for this unit
    if (MODE === "census") {
      if (stopReason) {
        // Stopped MID-UNIT (or at its very start): this unit is NOT marked
        // done. The checkpoint below therefore resumes at THIS unit again,
        // not the one after it -- a partially classified unit is reported by
        // its own re-run, never by a resumed pass that skipped it as if it
        // were whole. `page` breaks the OUTER loop too, so no further unit is
        // even attempted once the budget is gone. `pendingPartialUnit` (this
        // pass's latest token for the unit it stopped inside, updated on
        // every page above) is what the checkpoint below saves, so the
        // relaunch resumes AT MOST one page-checkpoint-interval behind where
        // this pass actually stopped -- never at unit 0.
        break page;
      }
      doneUnitKeys.add(String(unit.key));
      // The unit that just finished is no longer "in progress" -- any
      // pending partial-unit token for it must not survive into the cursor
      // the outer checkpoint writes after this loop, or a resume would seek
      // a token for a unit `doneUnitKeys` already marks complete.
      pendingPartialUnit = null;
    }
  }

  // ── CHECKPOINT: PERSIST THE CURSOR BEFORE THE BANNER, WHILE THE MERGED ────
  // AGGREGATE IS STILL THE ONE THIS PASS JUST BUILT (census only).
  //
  // Written on EVERY census pass, not only a budget stop: a pass that
  // finishes its whole shard in one go still needs its cursor CLEARED (never
  // left behind for a later independent dispatch of the same slot to
  // misread as "resume from here"), and a pass that stops partway needs it
  // SAVED. Both are one call, gated on whether every unit is now done.
  if (MODE === "census") {
    // `pendingPartialUnit` is non-null here ONLY when the `page:` loop broke
    // out of a unit mid-stream (a budget stop, a LIMIT stop, or a still-
    // failing periodic save) -- every unit that finished cleanly nulled it
    // out the moment it was marked done, above. `allDone` therefore cannot
    // be true at the same time a partial unit is pending: a unit either
    // finished (counted in `doneUnitKeys`, token discarded) or it did not
    // (token pending, unit absent from `doneUnitKeys`).
    const allDone = doneUnitKeys.size >= q.units.length;
    if (allDone) {
      await clearCensusCursor(control, SLOT);
      console.log(`  CENSUS CURSOR: slot ${SLOT} finished within budget -- every unit classified, cursor cleared.`);
    } else {
      const saved = await saveCensusCursor(control, SLOT, {
        unitsDone: [...doneUnitKeys],
        aggregate: censusAggregateToJSON(),
        classified: stats.seen,
        partialUnit: pendingPartialUnit,
      });
      if (saved) {
        const pageNote = pendingPartialUnit
          ? ` -- unit ${pendingPartialUnit.key} is IN PROGRESS and resumes from its own last page, not from its first row`
          : "";
        console.log(`  CENSUS CURSOR: checkpointed ${doneUnitKeys.size} of ${q.units.length} unit(s) for slot ${SLOT} -- the relaunch continues from the next unit${pageNote}.`);
      } else {
        // CF-A-FAILED-CHECKPOINT-IS-NOT-A-CHECKPOINT (run 34658848883 slot 3).
        // The save above already warned (console.warn, load-bearing). This
        // pass must not ALSO claim "checkpointed" -- there is no cursor for a
        // relaunch to resume from, so saying so would be a lie a human reading
        // the log would reasonably act on. It also must not let a bare
        // "stopped at the ... budget" line reach the log: relaunch-on-marker's
        // outcome (a) re-dispatches on that phrase ALONE, with no exit-code
        // check, and re-dispatching here reproduces the exact restart-from-
        // zero loop #2045 was written to end (the next pass finds no cursor
        // and starts at unit 0 again, same as this one did). Overriding
        // stopReason keeps stopAccounting's arithmetic (rows/s, shard
        // coverage) but drops it out of the budget-marker regex, so the
        // relaunch action falls through to its "finishLane with a NON-ZERO
        // code" arm instead: verdict reported, re-dispatch withheld, step red.
        console.warn(`  CENSUS CURSOR: NOT checkpointed for slot ${SLOT} -- the cursor save failed, so this pass's ${doneUnitKeys.size} of ${q.units.length} completed unit(s) will NOT be skipped by a relaunch. Re-dispatching this slot as-is would restart it from unit 0; do not re-dispatch until the cursor save is fixed.`);
        // MUST NOT contain the substring the relaunch action's unanchored
        // `grep -aqE "stopped at the .*budget"` matches ANYWHERE in the line
        // -- rewording only the prefix (e.g. "X, stopped at the N-minute
        // budget") still matches and still re-dispatches blindly. The
        // replacement below is deliberately budget-word-free.
        stopReason = "CURSOR SAVE FAILED -- this pass halted its checkpoint, not its budget clock";
        process.exitCode = CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE;
      }
    }
  }

  // ── census banner ─────────────────────────────────────────────────────────
  const total = stats.seen;
  const pct = (n) => total ? `${((n / total) * 100).toFixed(2)}%` : "-";
  console.log(`\nCENSUS  slot ${SLOT}/${SLOTS}  rows classified ${f(total)}${stats.otherSlot ? `  (${f(stats.otherSlot)} matched the query's year/sport predicate but belong to other slots' hash parts)` : ""}`);
  // SKIPPED-BY-FILTER AND CLASSIFIED ARE TWO NUMBERS, NEVER ONE. Without this
  // line a filtered run looks like an empty shard; with it, the reader can see
  // that the slot was full and this dispatch chose to look at part of it.
  if (ROW_FILTER_ON) {
    console.log(`  in-slot row filter: ${f(stats.filtered)} row(s) skipped by filter, ${f(stats.seen)} classified  (sports=${SPORTS_FILTER.join(",") || "any"} setkey_like=${SETKEY_LIKE || "any"})`);
  }
  // THE PREFILTER SAYS WHAT IT SKIPPED AND WHY, or a scoped apply reads as an
  // empty shard. A slot that classified 2,800 of its 350,000 rows did not fail
  // to see them: it proved, on the row itself, that they cannot be the class
  // it is armed to write. Printed whenever the prefilter is on -- including
  // when it skipped nothing -- so the reader never has to infer its presence.
  if (APPLY_PREFILTER) {
    const looked = stats.prefiltered + stats.seen;
    const share = looked ? `${((stats.seen / looked) * 100).toFixed(2)}%` : "-";
    console.log(`  scoped-apply prefilter: ${f(stats.prefiltered)} row(s) cannot be ${[...ARMED].join("+")} and were skipped before any derivation or catalog read`);
    console.log(`                          ${f(stats.seen)} of ${f(looked)} in-slot rows classified (${share}) -- the rest failed a necessary condition read off the row itself`);
  }
  for (const klass of [K.AGREE, K.IMPROVE, K.CONFLICT, K.UNDERIVABLE]) {
    const prot = byTier.get(`${klass}/${K.PROTECTED}`) ?? 0, auto = byTier.get(`${klass}/${K.AUTO}`) ?? 0;
    console.log(`  ${klass.padEnd(12)} ${f(counts[klass]).padStart(11)}  ${pct(counts[klass]).padStart(7)}   AUTO ${f(auto).padStart(10)}  PROTECTED ${f(prot).padStart(6)}`);
    // The subclass is a NARROWING of the class above it, so it is printed
    // indented under its parent and its count is INCLUDED in the parent's --
    // it is not a fifth row of the census and must not read as one.
    for (const [k, n] of [...subclasses].filter(([k]) => k.startsWith(`${klass}/`)).sort()) {
      const [, sub, tier] = k.split("/");
      console.log(`    of which ${sub.padEnd(16)} ${f(n).padStart(9)}  ${tier}${tier === K.AUTO ? "  <- writable under audit" : "  <- report only"}`);
    }
  }
  const beAuto = subclasses.get(`${K.CONFLICT}/${K.BASE_EVICTION}/${K.AUTO}`) ?? 0;
  const beProt = subclasses.get(`${K.CONFLICT}/${K.BASE_EVICTION}/${K.PROTECTED}`) ?? 0;
  if (beAuto || beProt) {
    console.log(`\n  BASE-EVICTION  ${f(beAuto + beProt)} rows: on a parallel slug, own parallel field blank/Base, title names no finish,`);
    console.log(`                 checklist-backed base destination exists. ${f(beAuto)} AUTO (writable under audit), ${f(beProt)} PROTECTED (never).`);
  }
  // ── THE THREE RULED SCOPES OF 2026-09-06 ──────────────────────────────────
  //
  // Each prints its counts BY THE THING THAT MATTERS FOR ITS RULING and a
  // 30-row sample with titles, because report-first means a human reads the
  // shape before anything is armed. A block prints only when the scope found
  // rows, so a slot that matched none stays silent instead of printing three
  // empty tables.
  const topOf = (m, n = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${f(v)}`).join(" | ");
  {
    const gftAuto = subclasses.get(`${K.IMPROVE}/${K.GRADE_FROM_TITLE}/${K.AUTO}`) ?? 0;
    const gftProt = subclasses.get(`${K.IMPROVE}/${K.GRADE_FROM_TITLE}/${K.PROTECTED}`) ?? 0;
    if (gftAuto || gftProt) {
      console.log(`\n  GRADE-FROM-TITLE  ${f(gftAuto + gftProt)} rows: grade fields EMPTY, title states a grader token + numeral.`);
      console.log(`                    A FIELD BACKFILL, NOT A RE-KEY -- the address never moves. filterByGrade reads a`);
      console.log(`                    field-empty row as RAW, so each of these is a graded sale priced into the raw pool.`);
      console.log(`                    ${f(gftAuto)} AUTO (writable under audit), ${f(gftProt)} PROTECTED (never).`);
      console.log(`                    by grader:  ${topOf(gftByGrader)}`);
      console.log(`                    by grade:   ${topOf(gftByGrade, 14)}`);
      console.log(`                    by sport:   ${topOf(gftBySport)}`);
      if (gftSamples.length) { console.log(`                    sample (${gftSamples.length}):`); for (const s of gftSamples) console.log(`                      ${s}`); }
    }
  }
  {
    const yAuto = subclasses.get(`${K.IMPROVE}/${K.YEAR_FROM_TITLE_VINTAGE}/${K.AUTO}`) ?? 0;
    const yProt = subclasses.get(`${K.IMPROVE}/${K.YEAR_FROM_TITLE_VINTAGE}/${K.PROTECTED}`) ?? 0;
    if (yAuto || yProt) {
      console.log(`\n  YEAR-FROM-TITLE-VINTAGE  ${f(yAuto + yProt)} rows: slug year >= 2015 is the SALE year; the title states a pre-1990`);
      console.log(`                           issue year, the setKey is vintage-capable, no retro marker, destination checklist-backed.`);
      console.log(`                           ${f(yAuto)} AUTO (writable under audit), ${f(yProt)} PROTECTED (never).`);
      console.log(`                           by decade:  ${topOf(yfvByDecade)}`);
      console.log(`                           by setKey:  ${topOf(yfvBySetKey)}`);
      console.log(`                           by sport:   ${topOf(yfvBySport)}`);
      if (yfvSamples.length) { console.log(`                           sample (${yfvSamples.length}):`); for (const s of yfvSamples) console.log(`                             ${s}`); }
    }
  }
  {
    const sAuto = subclasses.get(`${K.IMPROVE}/${K.SPORT_FROM_PRODUCT}/${K.AUTO}`) ?? 0;
    const sProt = subclasses.get(`${K.IMPROVE}/${K.SPORT_FROM_PRODUCT}/${K.PROTECTED}`) ?? 0;
    if (sAuto || sProt) {
      console.log(`\n  SPORT-FROM-PRODUCT  ${f(sAuto + sProt)} rows: a card's sport is the PRODUCT's sport, read from the product's own`);
      console.log(`                      checklist -- never from the player. Multi-sport products are refused BY NAME.`);
      console.log(`                      ${f(sAuto)} AUTO (writable under audit), ${f(sProt)} PROTECTED (never).`);
      console.log(`                      by sport pair: ${topOf(sfpByPair)}`);
      console.log(`                      by setKey:     ${topOf(sfpBySetKey)}`);
      if (sfpSamples.length) { console.log(`                      sample (${sfpSamples.length}):`); for (const s of sfpSamples) console.log(`                        ${s}`); }
    }
  }
  {
    const rAuto = subclasses.get(`${K.IMPROVE}/${K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT}/${K.AUTO}`) ?? 0;
    const rProt = subclasses.get(`${K.IMPROVE}/${K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT}/${K.PROTECTED}`) ?? 0;
    if (rAuto || rProt) {
      console.log(`\n  R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT  ${f(rAuto + rProt)} rows: a specialty release filed under its`);
      console.log(`                                        bare flagship key; derived key is a declared productSetKeys.ts`);
      console.log(`                                        child of the stored flagship, title states the product's own words.`);
      console.log(`                                        ${f(rAuto)} AUTO (writable under audit), ${f(rProt)} PROTECTED (never).`);
      console.log(`                                        by pair: ${topOf(r26ByPair)}`);
      if (r26Samples.length) { console.log(`                                        sample (${r26Samples.length}):`); for (const s of r26Samples) console.log(`                                          ${s}`); }
    }
  }
  {
    const rAuto = subclasses.get(`${K.IMPROVE}/${K.POKEMON_SET_CODE}/${K.AUTO}`) ?? 0;
    const rProt = subclasses.get(`${K.IMPROVE}/${K.POKEMON_SET_CODE}/${K.PROTECTED}`) ?? 0;
    if (rAuto || rProt) {
      console.log(`\n  R27-POKEMON-SET-CODE  ${f(rAuto + rProt)} rows: the set CODE is the key (pokemonSetCodes.ts); stored key`);
      console.log(`                        is a descriptive name / unknown / stale default. The 24 colliding EN/JA codes move`);
      console.log(`                        only when the row's own language flag resolves them; unresolved stays CONFLICT.`);
      console.log(`                        ${f(rAuto)} AUTO (writable under audit), ${f(rProt)} PROTECTED (never).`);
      console.log(`                        by pair: ${topOf(r27ByPair)}`);
      if (r27Samples.length) { console.log(`                        sample (${r27Samples.length}):`); for (const s of r27Samples) console.log(`                          ${s}`); }
    }
  }
  {
    const rAuto = subclasses.get(`${K.IMPROVE}/${K.FINISH_IS_A_PARALLEL}/${K.AUTO}`) ?? 0;
    const rProt = subclasses.get(`${K.IMPROVE}/${K.FINISH_IS_A_PARALLEL}/${K.PROTECTED}`) ?? 0;
    if (rAuto || rProt) {
      console.log(`\n  R28-FINISH-IS-A-PARALLEL  ${f(rAuto + rProt)} rows: stored setKey is <product>-<finish>; the finish moves`);
      console.log(`                           to the parallel field. REFUSED on any DISTINCT_PRODUCT_SETKEYS / ruled collapse`);
      console.log(`                           pair BEFORE the checklist is asked (topps-chrome-platinum is the measured trap).`);
      console.log(`                           ${f(rAuto)} AUTO (writable under audit), ${f(rProt)} PROTECTED (never).`);
      console.log(`                           by pair: ${topOf(r28ByPair)}`);
      if (r28Samples.length) { console.log(`                           sample (${r28Samples.length}):`); for (const s of r28Samples) console.log(`                             ${s}`); }
    }
  }
  // SPLIT-IDENTITY: reported as its own block, not as a class. A split row
  // has already been counted under whichever derivation class it landed in;
  // this says how many of those rows ALSO contradict themselves.
  if (splitTotal) {
    console.log(`\n  SPLIT-IDENTITY  ${f(splitTotal)} rows (${pct(splitTotal)}) carry two identity fields naming DIFFERENT cards.`);
    console.log(`                  The exact pool reader ORs cardId and hobbyiqCardId, so each is priced into TWO pools.`);
    console.log(`                  Vendor-partition rows (cardId = a vendor product id) are exempt and NOT counted here (#1650).`);
    console.log(`                  by derivation class: ${[...splitByClass].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${f(n)}`).join(" | ")}`);
    if (splitSegments.size) console.log(`                  differing segments: ${[...splitSegments].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${f(n)}`).join(" | ")}`);
    for (const line of splitSamples) console.log(`      ${line}`);
    console.log(`                  The apply path lands BOTH fields, so an audited apply repairs the split with the re-key.`);
  }
  // SLUG-SHAPE DEFECTS: reported, never acted on. Each row here has ALREADY
  // been counted in its derivation class -- this says how many of them carry a
  // key whose SHAPE is wrong, which is a different question from whether the
  // identity that key encodes is.
  if (slugShapeCounts.size) {
    console.log(`\n  SLUG-SHAPE DEFECTS  (REPORT ONLY -- counted, never a refusal and never a write)`);
    for (const [d, n] of [...slugShapeCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${d}  ${f(n)} rows (${pct(n)})`);
      const byC = [...slugShapeByClass].filter(([k]) => k.startsWith(`${d}/`)).sort((a, b) => b[1] - a[1]);
      if (byC.length) console.log(`      by class: ${byC.map(([k, c]) => `${k.split("/").slice(1).join("/")} ${f(c)}`).join(" | ")}`);
      for (const line of slugShapeSamples.get(d) ?? []) console.log(`        ${line}`);
    }
  }
  console.log(`\n  top defect axes per class:`);
  for (const klass of [K.IMPROVE, K.CONFLICT]) {
    const rows = [...defects].filter(([k]) => k.startsWith(`${klass}  `)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`    ${klass}: ${rows.map(([k, n]) => `${k.split("  ")[1]} ${f(n)}`).join(" | ") || "-"}`);
  }
  console.log(`  top reasons:`);
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${f(n).padStart(10)}  ${k}`);
  console.log(`\n  provenance: ${[...byTier].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${f(n)}`).join(" | ")}`);
  console.log(`  PROTECTED + CONFLICT + UNDERIVABLE are REPORT ONLY FOREVER -- they go to Drew, never to a fleet.`);
  for (const klass of [K.IMPROVE, `${K.CONFLICT}/${K.BASE_EVICTION}`, K.CONFLICT, K.UNDERIVABLE, K.AGREE]) {
    const s = sampleLines(klass);
    if (!s.length) continue;
    const of = klass.includes("/") ? f(beAuto + beProt) : f(counts[klass]);
    // The DISTINCT-CARD count is the number that says the sample is a sample.
    // Slot 27's old 30 lines spanned 3 cards; an auditor has to be able to see
    // that from the banner without re-deriving it.
    console.log(`\n  ${klass} evidence (${s.length} of ${of}, spanning ${f(sampleCardCount(klass))} distinct cards; cap ${f(SAMPLE_CAP)} @ ${SAMPLE_PER_CARD_CAP}/card):`);
    for (const line of s) console.log(`    ${line}`);
  }

  const census = {
    job: "rematch-sold-comps", mode: MODE, slot: SLOT, slots: SLOTS,
    axis: "(cardYear, sportClass, sha1(id) % parts)", measuredAt: SHARD_TABLE.measuredAt,
    units: q.units, expectedRows: expected, classified: total, otherSlot: stats.otherSlot,
    // The filter is part of the census's identity: two censuses of the same
    // slot are only comparable when they were taken through the same filter.
    rowFilter: ROW_FILTER_ON ? { sports: SPORTS_FILTER, setkeyLike: SETKEY_LIKE || null, skipped: stats.filtered } : null,
    // THE PREFILTER IS PART OF THE CENSUS'S IDENTITY TOO. A scoped apply's
    // census counted only the rows that could be its class, so its class
    // totals are NOT comparable with an unfiltered census of the same slot --
    // and an artifact that does not say so invites exactly that comparison.
    // Null when every in-slot row was classified.
    applyPrefilter: APPLY_PREFILTER
      ? { armed: [...ARMED], skipped: stats.prefiltered, classified: total }
      : null,
    counts, byTier: Object.fromEntries(byTier), defects: Object.fromEntries(defects),
    // Subclass counts are INCLUDED in `counts` -- BASE-EVICTION is a narrowing
    // of CONFLICT, so an auditor summing both would double-count.
    subclasses: Object.fromEntries(subclasses),
    reasons: Object.fromEntries(reasons),
    // THE SAMPLE THE AUDIT GATE READS. 500 lines per class, spread across
    // distinct cardIds by a per-card reservoir (finding 7) -- `sampleSpread`
    // carries the distinct-card count per class so the gate can assert the
    // sample is a sample rather than one pool repeated.
    samples: Object.fromEntries([...samples.keys()].map((k) => [k, sampleLines(k)])),
    sampleSpread: Object.fromEntries([...samples.keys()].map((k) => [k, { lines: sampleLines(k).length, distinctCards: sampleCardCount(k) }])),
    sampleCap: SAMPLE_CAP, samplePerCardCap: SAMPLE_PER_CARD_CAP,
    // The vocabulary this census was classified under. A census quoted in an
    // audit has to name the vocabulary that produced it, or a re-run under a
    // different corpus is indistinguishable from the same measurement.
    finishVocabulary: K.VOCAB.vocabularyStats(),
    // Orthogonal to `counts` -- a split row is ALSO counted in its derivation
    // class, so these must never be summed with the four class totals.
    splitIdentity: {
      total: splitTotal,
      byClass: Object.fromEntries(splitByClass),
      segments: Object.fromEntries(splitSegments),
      samples: splitSamples,
    },
    // Orthogonal to `counts` in exactly the way splitIdentity is -- a row with
    // a malformed slug is ALSO counted in its derivation class. Report only.
    slugShapeDefects: {
      total: [...slugShapeCounts.values()].reduce((a, b) => a + b, 0),
      byDefect: Object.fromEntries(slugShapeCounts),
      byDefectAndClass: Object.fromEntries(slugShapeByClass),
      samples: Object.fromEntries([...slugShapeSamples]),
    },
    stoppedAtBudget: !!stopReason, generatedAt: new Date().toISOString(),
  };
  const outFile = path.join(CENSUS_OUT.endsWith(".json") ? path.dirname(CENSUS_OUT) : CENSUS_OUT, `census-slot-${SLOT}.json`);
  let wroteFile = false;
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(census, null, 1)); wroteFile = true; console.log(`\n  shard census JSON -> ${outFile}`); }
  catch (e) { console.log(`\n  (could not write ${outFile}: ${String(e?.message ?? e)})`); }
  if (!wroteFile) console.log(`CENSUS_JSON ${JSON.stringify(census)}`);

  // ── census stops here. There is no write path in this mode. ───────────────
  if (MODE === "census") {
    console.log(`\nREAD ONLY -- the census writes nothing to the pool.`);
    if (stopReason) console.log(`\n${stopAccounting({ stopReason, stats, expected, startedAt: started })}`);
    return;
  }

  // ── apply-improve ─────────────────────────────────────────────────────────
  const byKind = APPLY_KINDS.map((k) => `${k} ${f(improvable.filter((c) => c.kind === k).length)}`).join(" + ");
  console.log(`\nAPPLY-IMPROVE  ${APPLY ? "APPLYING" : "REPORT ONLY -- nothing written"}  candidates ${f(improvable.length)} (${byKind})  concurrency ${CONCURRENCY}`);
  console.log(`  class scope    scope=${JSON.stringify(APPLY_SCOPE_RAW)} -> ${[...ARMED].join(" + ")}`);
  for (const kind of APPLY_KINDS) {
    const held = disarmed[kind] ?? 0;
    if (!ARMED.has(kind)) console.log(`    ${kind.padEnd(15)} DISARMED -- ${f(held)} writable candidate(s) NOT queued and NOT written`);
  }
  console.log(`  every candidate is re-checked at write time: the pool moves between the census and this pass,`);
  console.log(`  and a candidate that re-checks as the OTHER kind is skipped, not written on the old verdict.`);
  stats.intended = improvable.length;
  const applied = [];
  /** Per-class tallies, so the reconcile balances PER CLASS and not only in
   *  total -- a scoped apply has to be able to prove it wrote nothing of the
   *  class it disarmed. */
  const perClass = {};
  for (const kind of APPLY_KINDS) perClass[kind] = { intended: 0, written: 0, skipped: 0, failed: 0, notReached: 0 };
  for (const c of improvable) perClass[c.kind].intended++;
  /**
   * THE WRITE LEDGER -- pool -> the ids this run actually moved (2026-09-04).
   *
   * The canary gate exits 5 on "this shard is damage", but it had no way to
   * ask whether the shard touched the pool it was failing. Two shards that
   * reconciled `intended 0 = written 0` were failed on anchor moves in pools
   * belonging to OTHER slots: the CardHedge daily ingest had landed new sales
   * between the before and the after, and the check read another writer's
   * normal work as its own shard's damage.
   *
   * A verdict has to be ATTRIBUTED, and attribution needs evidence the gate
   * can read. So the apply emits, per POOL, the ids it wrote -- both the pool
   * a row LEFT (`from`) and the pool it LANDED IN (`to`), because a re-key
   * changes two pools and either can hold a canary. An empty ledger is the
   * positive statement "this shard moved nothing anywhere", which is exactly
   * what these two runs needed to say and could not.
   */
  const ledger = new Map();
  const ledgerNote = (slug, id, side) => {
    if (!slug) return;
    let e = ledger.get(slug);
    if (!e) { e = { from: [], to: [] }; ledger.set(slug, e); }
    if (e[side].length < LEDGER_IDS_PER_POOL) e[side].push(id);
    e[`${side}Count`] = (e[`${side}Count`] ?? 0) + 1;
  };
  let idx = 0;
  const worker = async () => {
    while (idx < improvable.length) {
      const my = idx++;
      if (budgetLeft() < 90000) {
        stopReason = stopReason ?? `stopped at the ${RUN_MINUTES}-minute budget`;
        // CF-A-CONCURRENT-STOP-COUNTS-ITS-OWN-CLAIM-ONLY (run 34360565942,
        // 2026-09-09). This used to add `improvable.length - my` -- the WHOLE
        // remaining tail from this worker's own claim point -- but `idx` is a
        // shared counter and every one of the CONCURRENCY workers claims a
        // DISJOINT `my` before checking the budget, so at a budget stop near
        // t=0 all 16 workers see the clock expired on their own first claim
        // and each added its own overlapping tail: sum_{my=0..15}(2179-my) =
        // 34,744 "not reached" against 2,179 intended -- the exact drift this
        // run's reconcile caught. Each worker owns exactly the ONE row `my`
        // it claimed; the loop keeps draining `idx` (cheaply, no Cosmos read)
        // so every remaining index is still claimed and counted by SOME
        // worker exactly once, with no read, no write and no overlap.
        stats.notReached++;
        perClass[improvable[my].kind].notReached++;
        continue;
      }
      const cand = improvable[my];
      // RE-READ: the row may have been re-keyed, enriched or deleted since the
      // census page. The class is decided again on what is there NOW.
      let fresh = null;
      try { fresh = (await retry(() => pool.item(cand.row.id, cand.row.cardId).read())).resource ?? null; }
      catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) { stats.failed++; perClass[cand.kind].failed++; continue; } }
      if (!fresh) { stats.skipped++; perClass[cand.kind].skipped++; bump(reasons, "apply  row-gone-since-census"); continue; }
      const stored = storedIdentity(fresh, deps);
      const der = deriveIdentity(fresh, deps);
      const backed = der.ok ? await checklistBacked(der.slug) : false;
      const beCand = der.ok && K.slugNamesParallel(fresh.cardId);
      const baseBacked = beCand ? await checklistBacked(der.baseSlug) : false;
      // Supplied at write time for the reason `spec` below is: a gate that
      // disagrees with itself between the census and the apply is a gate
      // nobody can audit. Omitting it here would make every name-released row
      // silently decline to write while the census reported it writable.
      const beName = beCand ? await checklistPlayerNameFor(der.identity) : null;
      // THE WRITE-TIME RE-CHECK GETS THE SAME INPUTS AS THE CENSUS.
      // `classifyRow` refuses SPECIALIZATION-STATED without them, so omitting
      // them here would not be a leak -- it would be the opposite, every
      // qualifying row silently declining to write while the census reported
      // it writable. A gate that disagrees with itself between the two passes
      // is a gate nobody can audit.
      const spec = await specInputs(fresh, stored, der);
      const res = K.classifyRow({
        row: fresh, stored, derived: der.ok ? der.identity : null, checklistBacked: backed, derivationReasons: der.reasons,
        storedSlug: fresh.cardId, baseDestSlug: der.baseSlug ?? null, baseDestBacked: baseBacked, checklistPlayerName: beName,
        parserSaysLot: safeIsLot(fresh.title),
        autoByCardNumber: der.autoByCardNumber === true,
        ...spec,
        // Re-read from the FRESH row at write time, exactly as the class is.
        titleStatesNumber: K.titleStatesCardNumber(fresh.title),
        // S3 at write time, for the reason the comment above gives for
        // `spec`: without it the apply pass could not reproduce the census
        // verdict, every qualifying row would come back AGREE, and the
        // class-match check below would skip the whole population while the
        // census reported it writable. Read off the FRESH row.
        checklistSaysNotAuto: (stored?.isAuto === true
          && K.autographWitnessIsSellerNameOnly(fresh.title))
          ? await checklistSaysNotAutoFor(stored)
          : null,
        // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE. Supplied here
        // for the reason the comment above gives for `spec`: omitting it would
        // let the apply pass write a row the census refused, because the
        // classifier cannot see a clash it is not told about. The clash map is
        // per (year, setKey) and cached, so the re-check costs nothing new.
        clashSubsets: await clashSubsetsFor(stored),
        // THE THREE RULED SCOPES OF 2026-09-06. Supplied at BOTH call sites
        // for the reason `spec` above states: a gate that disagrees with
        // itself between the census and the apply is a gate nobody can
        // audit. Each helper is cost-gated on a pure string test first, so
        // a row that cannot qualify issues no catalog read at all.
        ...(await vintageInputs(fresh, stored, der)),
        ...(await sportInputs(fresh, stored, der)),
        // THE THREE RULED SCOPES OF 2026-09-13 (R26/R27/R28), at write time --
        // same reason as `spec` above: a gate that disagrees with itself
        // between the census and the apply is a gate nobody can audit.
        ...(await r26Inputs(fresh, stored, der)),
        ...(await r27Inputs(fresh, stored, der)),
        ...(await r28Inputs(fresh, stored, der)),
      });
      // The class is decided again on what is there NOW, and it must come back
      // as the SAME kind the census queued. A row the census saw as an eviction
      // that now reads IMPROVE (or the reverse) is a row the pool changed under
      // us -- it is skipped, not written on the strength of the old verdict.
      // THE SCOPE IS RE-CHECKED AT WRITE TIME TOO, exactly as the class is.
      // The queue was built under the scope, so this cannot normally fire --
      // and that is the point: a guard that is only applied where it is
      // convenient is a guard that a later edit can walk around.
      const nowKind = K.applyKindOf(res);
      if (!K.writableUnderScope(res, ARMED) || nowKind !== cand.kind) {
        stats.skipped++; perClass[cand.kind].skipped++;
        bump(reasons, `apply  no-longer-writable:${res.klass}${res.subclass ? `/${res.subclass}` : ""}/${res.tier}`);
        continue;
      }
      // ── THE FIELD BACKFILL: A WRITE THAT IS NOT A RE-KEY ─────────────────
      //
      // GRADE-FROM-TITLE stamps two FIELDS at the row's existing address. It
      // must not go through `relocateSoldComp`: that function's whole job is
      // to move a row between partitions, and there is no move here. The row
      // keeps its id, its cardId, its partition and its pool membership; what
      // changes is that `filterByGrade` stops reading it as raw.
      //
      // It reconciles through the SAME per-class counters as every other kind
      // -- `everyWriteJobReconciles` does not care what shape the write is,
      // only that intended = written + skipped + failed + not reached -- and
      // it notes the pool ONCE in the ledger, on both sides, because the
      // canary's question ("did this shard touch this pool?") is answered YES
      // for a field write too: the pool's RAW membership changed even though
      // its row membership did not.
      if (cand.kind === K.GRADE_FROM_TITLE) {
        const g = res.gradeFromTitleEvidence ?? {};
        if (!g.gradeCompany || !(g.gradeValue > 0)) {
          stats.skipped++; perClass[cand.kind].skipped++;
          bump(reasons, "apply  refused:grade-evidence-incomplete");
          continue;
        }
        // A ROW THAT ALREADY CARRIES A GRADE IS NEVER RE-STAMPED. The
        // classifier's G1 says the same thing, and this is the belt to that
        // brace: between the census and now another writer may have stamped
        // it, and overwriting would be a grade CHANGE -- a rival reading this
        // lane has no authority to settle.
        if (fresh.gradeCompany || (fresh.gradeValue !== null && fresh.gradeValue !== undefined && fresh.gradeValue !== "")) {
          stats.skipped++; perClass[cand.kind].skipped++;
          bump(reasons, "apply  refused:grade-already-present-since-census");
          continue;
        }
        if (!APPLY) {
          stats.written++; perClass[cand.kind].written++;
          ledgerNote(fresh.cardId, fresh.id, "from"); ledgerNote(fresh.cardId, fresh.id, "to");
          bump(reasons, `apply  would-write:${cand.kind}`);
          if (applied.length < 20) applied.push(`  WOULD STAMP ${fresh.id}  ${fresh.cardId}   raw -> ${g.gradeCompany} ${g.gradeValue}   (fields only, no re-key)`);
          continue;
        }
        try {
          await retry(() => patchSoldCompFields(pool, fresh.id, fresh.cardId, {
            gradeCompany: g.gradeCompany,
            gradeValue: g.gradeValue,
            gradeStampedAt: new Date().toISOString(),
            gradeStampedReason: `GREAT REMATCH (2026-09-06): GRADE-FROM-TITLE -- title states "${g.gradeCompany} ${g.gradeValue}" and the row's grade fields were empty; address unchanged`,
          }));
          // VERIFY BY READ, ON THE ROW ITSELF. The #1850 read-back contract:
          // a write is not done because the call returned, it is done because
          // the value is there when you look.
          const back = (await retry(() => pool.item(fresh.id, fresh.cardId).read())).resource ?? null;
          if (!back || String(back.gradeCompany ?? "").toUpperCase() !== g.gradeCompany || Number(back.gradeValue) !== Number(g.gradeValue)) {
            stats.failed++; perClass[cand.kind].failed++;
            bump(reasons, "apply  failed:grade-stamp-not-visible-on-read-back");
            continue;
          }
          stats.written++; perClass[cand.kind].written++;
          ledgerNote(fresh.cardId, fresh.id, "from"); ledgerNote(fresh.cardId, fresh.id, "to");
          bump(reasons, `apply  wrote:${cand.kind}`);
          if (applied.length < 20) applied.push(`  STAMPED ${fresh.id}  ${fresh.cardId}   raw -> ${g.gradeCompany} ${g.gradeValue}   (fields only, no re-key)`);
        } catch (e) {
          stats.failed++; perClass[cand.kind].failed++;
          console.log(`  FAILED grade stamp ${fresh.id}: ${String(e?.message ?? e).slice(0, 110)}`);
        }
        continue;
      }

      const target = cand.kind === K.BASE_EVICTION ? der.baseSlug : der.slug;
      const identity = cand.kind === K.BASE_EVICTION ? der.baseIdentity : der.identity;
      if (target === fresh.cardId) { stats.skipped++; perClass[cand.kind].skipped++; bump(reasons, "apply  already-at-target"); continue; }

      const keep = stripSystem(fresh);
      keep.cardId = target;
      keep.hobbyiqCardId = target;
      keep.setName = identity.setNameRaw || keep.setName;
      keep.cardNumber = identity.cardNumber || keep.cardNumber;
      keep.parallel = identity.parallel;
      keep.isAuto = identity.isAuto;
      if (cand.kind === K.BASE_EVICTION) {
        // A STORED PRINT RUN IS NEVER DELETED (audit finding 2). This used to
        // be `delete keep.printRun` -- an eviction destroyed a stored field on
        // its way past, and the audit's sample carried a /1 (Immaculate
        // Pujols) and Carroll /499 among the rows it would have erased.
        //
        // The classifier now VETOES the eviction outright when the row stores
        // a print run (storedPrintRunNamesALimitedParallel), so reaching this
        // branch with one set means the classifier and the writer disagree.
        // Refuse rather than write: a fleet never resolves that by guessing,
        // and the row is reported instead.
        if (keep.printRun !== null && keep.printRun !== undefined && keep.printRun !== "") {
          stats.skipped++; perClass[cand.kind].skipped++;
          bump(reasons, `apply  refused:eviction-would-delete-stored-printrun:/${keep.printRun}`);
          continue;
        }
      } else if (identity.printRun !== null && identity.printRun !== undefined) {
        keep.printRun = identity.printRun;
      }
      keep.sport = identity.sport;
      keep.cardYear = identity.cardYear;
      // A row that changes partition must carry the hash of its NEW cardId or
      // the store's pre-write dedup can never see it.
      keep.contentHash = contentHashOf(keep);
      keep.rekeyedFrom = [{ id: fresh.id, cardId: fresh.cardId, hobbyiqCardId: fresh.hobbyiqCardId ?? null, title: fresh.title ?? null }];
      keep.rekeyedAt = new Date().toISOString();
      if (cand.kind === K.BASE_EVICTION) {
        // The three evidence fields travel WITH the row, quoted. A reason that
        // only names the subclass is not auditable after the fact -- Drew must
        // be able to read, from the row alone, exactly what was seen.
        const e = res.evidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-02): CONFLICT/BASE-EVICTION -- slug parallel "${e.storedSlugParallel}" unsupported: stored parallel field ${JSON.stringify(e.storedParallelField)}, title "${e.titleQuoted}" names no finish, checklist-backed base destination ${e.baseDestSlug}`;
        keep.baseEvictionEvidence = e;
      } else if (cand.kind === K.YEAR_FROM_TITLE_VINTAGE) {
        // The evidence travels WITH the row, quoted, for the reason the
        // eviction's does: a reason that only names the subclass is not
        // auditable after the fact. Drew must be able to read, from the row
        // alone, which year moved and what the title said.
        const e = res.vintageYearEvidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-06): YEAR-FROM-TITLE-VINTAGE -- the slug year ${e.slugYear} is the SALE year; the title "${e.titleQuoted}" states ${e.titleYear}, setKey ${e.setKey} is vintage-capable, no retro marker, destination checklist-backed`;
        keep.vintageYearEvidence = e;
      } else if (cand.kind === K.SPORT_FROM_PRODUCT) {
        const e = res.sportFromProductEvidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-06): SPORT-FROM-PRODUCT -- a card's sport is the PRODUCT's sport; ${e.pair} on setKey ${e.setKey}, product sport read from its own checklist, destination checklist-backed. Title "${e.titleQuoted}"`;
        keep.sportFromProductEvidence = e;
      } else if (cand.kind === K.FLAGSHIP_SWALLOWED_NAMED_PRODUCT) {
        const e = res.flagshipSwallowedNamedProductEvidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-13): R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT -- a specialty release filed under its flagship; ${e.storedSetKey}->${e.derivedSetKey}, title states "${(e.distinguishingWords ?? []).join("+")}", destination checklist-backed. Title "${e.titleQuoted}"`;
        keep.flagshipSwallowedNamedProductEvidence = e;
      } else if (cand.kind === K.POKEMON_SET_CODE) {
        const e = res.pokemonSetCodeEvidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-13): R27-POKEMON-SET-CODE -- the set code is the key; ${e.pair}, destination checklist-backed${e.isAmbiguousCode ? `, ambiguous code resolved by language` : ""}`;
        keep.pokemonSetCodeEvidence = e;
      } else if (cand.kind === K.FINISH_IS_A_PARALLEL) {
        const e = res.finishIsAParallelEvidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-13): R28-FINISH-IS-A-PARALLEL -- a finish word minted as a setKey; ${e.pair}, checklist lists it as a parallel of the derived product, destination checklist-backed`;
        keep.finishIsAParallelEvidence = e;
      } else {
        keep.rekeyedReason = `GREAT REMATCH (2026-09-01): IMPROVE, checklist-backed, filled ${res.axes.filled.join(",")}`;
      }

      const r = await relocateSoldComp(pool, { keep, drop: [{ id: fresh.id, cardId: fresh.cardId }], retry, verifyFields: ["cardId", "hobbyiqCardId", "rekeyedAt"], dryRun: !APPLY });
      const why = cand.kind === K.BASE_EVICTION ? `BASE-EVICTION (slug said "${res.evidence?.storedSlugParallel}", row and title say nothing)` : `IMPROVE filled ${res.axes.filled.join(",")}`;
      if (!APPLY) { stats.written++; perClass[cand.kind].written++; ledgerNote(fresh.cardId, fresh.id, "from"); ledgerNote(target, fresh.id, "to"); bump(reasons, `apply  would-write:${cand.kind}`); if (applied.length < 20) applied.push(`  WOULD RE-KEY ${fresh.id}  ${fresh.cardId}  ->  ${target}   ${why}`); continue; }
      if (!r.ok && r.stage !== "done") { stats.failed++; perClass[cand.kind].failed++; console.log(`  FAILED at ${r.stage} ${fresh.id}: ${String(r.error).slice(0, 110)}`); continue; }
      if (r.duplicatesLeft.length) { stats.failed++; perClass[cand.kind].failed++; stats.duplicatesLeft += r.duplicatesLeft.length; for (const dd of r.duplicatesLeft) console.log(`  DUPLICATE LEFT ${dd.id}@${dd.cardId}: ${String(dd.error).slice(0, 80)}`); continue; }
      stats.written++; perClass[cand.kind].written++; stats.alreadyGone += r.alreadyGone.length;
      // The ledger records BOTH pools a re-key changes: the one the row left
      // and the one it landed in. Either may hold a canary.
      ledgerNote(fresh.cardId, fresh.id, "from");
      ledgerNote(target, fresh.id, "to");
      bump(reasons, `apply  wrote:${cand.kind}`);
      if (applied.length < 20) applied.push(`  RE-KEYED ${fresh.id}  ${fresh.cardId}  ->  ${target}   ${why}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(improvable.length, 1)) }, worker));

  if (applied.length) { console.log("  examples:"); for (const a of applied) console.log(a); }
  console.log(`\n  ${APPLY ? "re-keyed" : "would re-key"}   ${f(stats.written)}`);
  console.log(`  skipped        ${f(stats.skipped)}   <- re-checked at write time and no longer writable`);
  console.log(`  failed         ${f(stats.failed)}${stats.duplicatesLeft ? `   (${f(stats.duplicatesLeft)} duplicates left in the pool -- reported, never a lost sale)` : ""}`);
  console.log(`  not reached    ${f(stats.notReached)}`);
  for (const [k, n] of [...reasons].filter(([k]) => k.startsWith("apply  ")).sort((a, b) => b[1] - a[1])) console.log(`    ${f(n).padStart(8)}  ${k.slice(7)}`);
  console.log(`\n  intended ${f(stats.intended)} = written ${f(stats.written)} + skipped ${f(stats.skipped)} + failed ${f(stats.failed)} + not reached ${f(stats.notReached)}`);
  // THE RECONCILE BALANCES PER CLASS, NOT ONLY IN TOTAL (audit gate item 8).
  // A scoped apply has to be able to PROVE it wrote nothing of the class it
  // disarmed, and a single total cannot say that -- one class's writes can
  // hide inside another's. Each armed class balances on its own, each
  // disarmed class must show intended 0 / written 0, and a disarmed class
  // with a nonzero write is a scope failure that exits nonzero.
  console.log(`\n  PER CLASS (scope=${JSON.stringify(APPLY_SCOPE_RAW)} -> ${[...ARMED].join(" + ")}):`);
  let classDrift = 0;
  for (const kind of APPLY_KINDS) {
    const c = perClass[kind];
    const armed = ARMED.has(kind);
    const acc = c.written + c.skipped + c.failed + c.notReached;
    console.log(`    ${kind.padEnd(15)} ${armed ? "ARMED   " : "DISARMED"}  intended ${f(c.intended).padStart(9)} = written ${f(c.written).padStart(9)} + skipped ${f(c.skipped).padStart(8)} + failed ${f(c.failed).padStart(6)} + not reached ${f(c.notReached).padStart(8)}${armed ? "" : `   (held back ${f(disarmed[kind] ?? 0)} writable candidate(s))`}`);
    if (acc !== c.intended) { console.error(`!! ${kind} reconciliation drift: ${acc} accounted vs ${c.intended} intended.`); classDrift++; }
    if (!armed && (c.intended || c.written)) {
      console.error(`!! SCOPE FAILURE: ${kind} is DISARMED and yet ${f(c.intended)} candidate(s) were queued and ${f(c.written)} written. Exit 6.`);
      process.exitCode = 6;
    }
  }
  const recon = stats.written + stats.skipped + stats.failed + stats.notReached;
  if (recon !== stats.intended) { console.error(`!! reconciliation drift: ${recon} accounted vs ${stats.intended} intended (${recon - stats.intended}). Exit 4.`); process.exitCode = 4; }
  if (classDrift && !process.exitCode) process.exitCode = 4;
  // ── THE WRITE LEDGER GOES TO DISK AND TO THE LOG ────────────────────────
  //
  // The canary gate runs in the SAME JOB on the same runner, so it reads this
  // file directly; the workflow also uploads it as an artifact so a halt can
  // be re-read without re-running anything. It is written on every apply-mode
  // pass including a dry run, and an apply that wrote nothing still writes the
  // file -- "touched 0 pools" is the whole point.
  {
    const pools = {};
    for (const [slug, e] of ledger) pools[slug] = { fromCount: e.fromCount ?? 0, toCount: e.toCount ?? 0, from: e.from, to: e.to };
    const doc = {
      job: "rematch-sold-comps",
      mode: MODE, apply: APPLY, scope: APPLY_SCOPE_RAW,
      slot: SLOT, slots: SLOTS,
      runId: process.env.GITHUB_RUN_ID ?? null,
      finishedAt: new Date().toISOString(),
      written: stats.written,
      poolsTouched: ledger.size,
      pools,
    };
    try {
      fs.mkdirSync(path.dirname(WRITE_LEDGER_OUT), { recursive: true });
      fs.writeFileSync(WRITE_LEDGER_OUT, JSON.stringify(doc, null, 1));
      console.log(`\n  WRITE LEDGER  ${f(ledger.size)} pool(s) touched, ${f(stats.written)} row(s) ${APPLY ? "written" : "would be written"}  ->  ${WRITE_LEDGER_OUT}`);
    } catch (e) {
      console.error(`!! could not write the ledger to ${WRITE_LEDGER_OUT}: ${String(e?.message ?? e)}`);
    }
    if (!ledger.size) console.log(`    no pool was touched by this shard -- a canary anchor that moved did so under another writer.`);
    for (const [slug, e] of [...ledger].sort((a, b) => (b[1].fromCount ?? 0) + (b[1].toCount ?? 0) - ((a[1].fromCount ?? 0) + (a[1].toCount ?? 0))).slice(0, 25)) {
      console.log(`    ${slug}   out ${f(e.fromCount ?? 0)}  in ${f(e.toCount ?? 0)}`);
    }
    await writeSettleMarkers(ledger, doc, conn);
  }
  if (APPLY) reportWrites({ job: "rematch-sold-comps", intended: stats.intended, written: stats.written, skipped: stats.skipped, failed: stats.failed });
  if (stopReason) console.log(`\n${stopAccounting({ stopReason, stats, expected, startedAt: started })}`);
}

/**
 * CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04). Publish the
 * settle signal the pricing engine reads.
 *
 * Called once, when a slice COMPLETES, from the same block that writes the
 * ledger to disk -- so the two records cannot disagree about which pools this
 * slice touched. One marker per pool the slice moved rows into or out of,
 * keyed `identity::<slug>` to match `poolMigrationGate.identityMarkerId`.
 *
 * DRY RUN WRITES NOTHING. A dry run's ledger records what WOULD have been
 * written; publishing "settled" for a migration that never happened would
 * release a price the gate is holding for good reason.
 *
 * FAILURE IS NON-FATAL and deliberately so. The gate falls back to its age
 * window when a marker is absent, so a failed marker write costs at most a few
 * hours of extra caution on the affected identities. It must never fail the
 * rematch itself -- the re-key is the job; this is telemetry for a consumer.
 */
async function writeSettleMarkers(ledger, ledgerDoc, conn) {
  if (!SETTLE_MARKERS) return;
  if (!APPLY) {
    console.log(`    SETTLE MARKERS  skipped -- dry run moved no rows, so no pool has settled.`);
    return;
  }
  if (!ledger.size) return;
  const settledAt = new Date().toISOString();
  let written = 0, failed = 0;
  try {
    // getOrCreateControlContainer, not a bare `.container()` reference -- see
    // that function's header comment. A settle marker write is still
    // non-fatal (the gate's age window covers an absent marker), but it
    // should not 404 forever against a container nobody ever provisioned.
    const control = await getOrCreateControlContainer(conn);
    for (const [slug, e] of ledger) {
      const id = `identity::${slug}`;
      try {
        await control.items.upsert({
          id,
          kind: "identity",
          key: slug,
          settledAt,
          runId: ledgerDoc.runId ?? null,
          rowsWritten: (e.fromCount ?? 0) + (e.toCount ?? 0),
          slot: SLOT,
          slots: SLOTS,
        });
        written++;
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(`    !! settle marker ${id}: ${String(err?.message ?? err).slice(0, 110)}`);
      }
    }
    console.log(`    SETTLE MARKERS  ${f(written)} written, ${f(failed)} failed  ->  ${REMATCH_CONTROL_CONTAINER}`);
  } catch (err) {
    // getOrCreateControlContainer provisions the container itself, so a
    // failure reaching here is a genuine Cosmos problem (throttling,
    // permissions, an outage) rather than "the container doesn't exist yet" --
    // still non-fatal, since the engine's age window covers an absent marker.
    console.error(`    !! settle markers could not be written (${String(err?.message ?? err).slice(0, 140)}) -- the engine's age window still gates these pools.`);
  }
}

/** The backend root, so the revert branch can reach dist/ for the one service
 *  it needs (writeReconciliation) without building the full `deps` bundle the
 *  census path assembles -- a revert parses no titles and derives no slugs. */
function requireDist() { return path.resolve(__dirname, ".."); }

/** One Cosmos database handle, with the retry policy every pass here uses. */
function cosmos(conn) {
  return new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
}

/**
 * CF-A-LAZY-REFERENCE-IS-NOT-A-CONTAINER (2026-09-12).
 *
 * THE DEFECT THIS FIXES. `db.container(REMATCH_CONTROL_CONTAINER)` -- the
 * pattern this file, `poolMigrationGate.ts` and `buyerIqDealScanner.service.ts`
 * all used -- returns a CLIENT-SIDE HANDLE unconditionally; the SDK never
 * checks the container exists until the first request against it. The
 * `rematch_control` container was never actually provisioned in the `hobbyiq`
 * database (confirmed read-only via `az cosmosdb sql container show` /
 * `container list` on 2026-09-12: it is absent from the database's container
 * list), so every read and write through that handle 404s with "Resource Not
 * Found". Every one of those call sites caught the error and treated it as
 * soft/non-fatal (a settle marker miss costs a few hours of extra caution; a
 * heartbeat miss falls back to the trace path), so the 404 was silently
 * swallowed everywhere -- until the census cursor made a successful write
 * LOAD-BEARING: a cursor that never saves can never be resumed from, which is
 * the exact runaway #2045 was written to end (run 34658848883 slot 3: the
 * cursor write 404s, the relaunch restarts the whole shard from unit 0, and
 * a 32-slot fleet the size of the large shards never converges).
 *
 * THE FIX. `containers.createIfNotExists` -- the same call
 * `buyerIqDealScanner.service.ts`'s OTHER container (`buyeriq_deals_sent`)
 * already uses -- creates the container on first use and is a no-op thereafter.
 * Partition key `/id`: every existing reader/writer of this container already
 * assumes that shape (`container.item(docId, docId)` in
 * `poolMigrationGate.ts`'s `read()`, `writeSettleMarkers` and
 * `censusCursorId`/`loadCensusCursor`/`saveCensusCursor`/`clearCensusCursor`
 * below all address a doc by `(id, id)`), so this does not change the shape
 * anything already reads or writes -- it only makes the container the SDK
 * finally checks for actually exist first.
 *
 * Only the census cursor path is wired through this (the load-bearing one);
 * `writeSettleMarkers` is switched too, since it is the other in-process
 * writer of the same container and the failure mode is identical.
 */
async function getOrCreateControlContainer(conn) {
  const { container } = await cosmos(conn).containers.createIfNotExists({
    id: REMATCH_CONTROL_CONTAINER,
    partitionKey: { paths: ["/id"] },
  });
  return container;
}

/**
 * THE CENSUS CURSOR -- a per-slot checkpoint that survives the runner's own
 * self-relaunch (2026-09-11).
 *
 * THE DEFECT THIS REPLACES. The relaunch dispatch for rematch-sold-comps
 * forwards slot/slots/years/limit/scope/sports/setkey_like VERBATIM and
 * nothing else -- there is no field to carry a resume position, and
 * backfill-runner.yml is the one file this fix may not touch (a new dispatch
 * input needs a workflow change, and #1974's finder pin already asserts the
 * fleet driver dispatches ONLY the seven inputs that exist today). So a slot
 * has to find its OWN way back to where it stopped, with nothing the runner
 * passes it -- which means the checkpoint has to live somewhere both the
 * dying run and its own relaunch can reach: Cosmos, in the SAME control
 * container SETTLE MARKERS already write to (`rematch_control`), keyed by
 * slot so two slots' cursors can never collide.
 *
 * THE DAMAGE, MEASURED 2026-09-08/09. Slot 0 (523,940 rows measured at
 * capture, ~231,480 classified per 140-minute pass) is one of 18 of 32 slots
 * that never finish inside one budget. Every relaunch re-read the WHOLE slot
 * from unit zero, so the pass count reset every ~2h10m forever -- 26 runners
 * held ~20 hours before a human cancelled 28 runs. A census that restarts is
 * not merely slow: it never converges, because there is no unit the next pass
 * starts later than the last one did.
 *
 * THE UNIT GRAIN WAS NOT FINE ENOUGH (2026-09-12 follow-up, #2058). The first
 * version of this cursor checkpointed only `unitsDone` -- one unit at a time,
 * never a row offset within a unit. That is correct but not sufficient: a
 * slot whose FIRST unit alone exceeds one link's throughput never reaches the
 * unit boundary at all. Measured on the real fleet the same day this
 * comment was updated -- runs 34686318652 (slot 0), 34686403508 (slot 8),
 * 34686374165 (slot 7) and 34688675098 (slot 0 again) all printed
 * `checkpointed 0 of 2 unit(s)` after burning the full ~118.5-120 minute
 * budget classifying 1.0-1.4M rows at 144-203 in-slot rows/s, because slot
 * 0's own first unit is 484,940 rows and even the FASTEST measured rate
 * (203 rows/s) clears only ~1.44M rows in 118 minutes -- barely past ONE
 * unit, never two. Every relaunch re-read that same first unit from row
 * zero, forever: `unitsDone` was durable, but nothing durable ever landed in
 * it for these slots.
 *
 * THE PAGE IS THE FINER GRAIN. Within a unit, `slotQuery` issues a plain
 * `SELECT * FROM c WHERE (...)` with no `ORDER BY` (see its header) --
 * exactly the query shape whose Cosmos continuation token IS safe to persist
 * and replay against a brand-new query object on a brand-new process; the
 * SDK's cross-partition token replay guarantee is specifically voided by an
 * ORDER BY over multiple partitions, which this query never has. So a
 * SECOND, finer checkpoint saves `partialUnit: { key, continuationToken }`
 * for the unit currently in flight, every `CENSUS_PAGE_CHECKPOINT_PAGES`
 * pages (default 40, ~20,000 rows) or `CENSUS_PAGE_CHECKPOINT_MS` (default
 * 5 minutes), whichever comes first. A relaunch that finds a `partialUnit`
 * whose `key` matches the next unit it would otherwise start cold hands that
 * token straight to `items.query`'s options, so its first `fetchNext()`
 * returns the page immediately after the one the dying pass last classified
 * -- at most one checkpoint interval of rows re-read, never a whole unit.
 * `unitsDone` is UNCHANGED as the coarse grain for units that DO finish
 * inside a link (most of the 14 of 32 slots that already converged); the
 * page checkpoint only matters for the units that do not.
 *
 * WHAT IS PERSISTED. `unitsDone` (the completed units' `key`s), `partialUnit`
 * (`null`, or the in-flight unit's key + continuation token), plus the
 * MERGED partial aggregate every reader in this file already builds in
 * memory -- counts, byTier, defects, reasons, samples, subclasses, and the
 * rest -- serialised through `censusAggregateToJSON`/`censusAggregateFromJSON`
 * below so a resumed pass adds its own units' rows to the SAME totals rather
 * than starting a new set that a human then has to add by hand. `classified`
 * is carried too, so the final artifact's `classified` reaches `expectedRows`
 * once every unit is done, not just the last pass's slice of it. Because the
 * aggregate snapshot saved alongside a page checkpoint already reflects every
 * row up to and including that exact page, and the saved token is the SDK's
 * own boundary for "everything before here, never again" a resumed pass adds
 * to those totals starting from the very next page -- no page is ever read,
 * and therefore counted, twice, and none is skipped.
 *
 * WHAT INVALIDATES A CURSOR. The shard table's `measuredAt` and this run's
 * `scope`/`rowFilter` signature -- unchanged by the page checkpoint, since a
 * continuation token is only ever replayed against a query built from the
 * SAME predicate (`unitPredicate` over the SAME unit) that produced it in the
 * first place; a signature mismatch invalidates the WHOLE cursor, page token
 * included. A cursor written against an OLDER shard table or a DIFFERENT
 * scope is not this run's own progress -- resuming from it would silently
 * merge two different questions' answers into one count. An invalidated
 * cursor is dropped, not repaired: the pass starts clean and says so in the
 * banner, rather than guessing which of its old units (or pages) are still
 * valid.
 */
const CENSUS_CURSOR_KIND = "rematch-census-cursor";

/** The one document id a slot's cursor lives at. Slot-scoped so two slots
 *  dispatched at once can never read or clobber each other's progress. */
function censusCursorId(slot) { return `census-cursor::slot-${slot}`; }

/** A signature that MUST match between the pass that wrote a cursor and the
 *  pass that would resume from it. Anything that changes what a unit's rows
 *  are being classified AGAINST invalidates the cursor -- a stale resume
 *  would merge answers to two different questions into one count. */
function censusCursorSignature() {
  return {
    measuredAt: SHARD_TABLE.measuredAt,
    scope: APPLY_SCOPE_RAW,
    sports: SPORTS_FILTER.slice().sort(),
    setkeyLike: SETKEY_LIKE,
    years: YEARS.slice().sort((a, b) => a - b),
  };
}

function signaturesMatch(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read this slot's cursor, or null when there is none or it does not match
 *  THIS pass's signature (see censusCursorSignature above). A refused read
 *  (missing container on a first-ever run, a throttle) is treated the same
 *  as "no cursor" -- a census must be able to start cold, and a resume is an
 *  optimization, never a dependency. */
async function loadCensusCursor(control, slot) {
  if (!control) return null;
  try {
    const { resource } = await control.item(censusCursorId(slot), censusCursorId(slot)).read();
    if (!resource || resource.kind !== CENSUS_CURSOR_KIND) return null;
    if (!signaturesMatch(resource.signature, censusCursorSignature())) return null;
    return resource;
  } catch (e) {
    if (e?.code === 404 || e?.statusCode === 404) return null;
    console.error(`  !! could not read census cursor for slot ${slot} (${String(e?.message ?? e).slice(0, 140)}) -- starting this pass from unit 0.`);
    return null;
  }
}

/**
 * Persist this slot's checkpoint: the units finished so far and the merged
 * aggregate they produced.
 *
 * FAILURE IS NO LONGER NON-FATAL TO THE PASS'S VERDICT (2026-09-12, run
 * 34658848883 slot 3). It used to be treated the same as a read miss --
 * logged and shrugged off -- on the theory that "the next pass will restart
 * this shard from unit 0" is merely slow. It is not: a census cursor that
 * can never save can never be resumed from, so every relaunch restarts from
 * unit 0 FOREVER, which is the exact runaway #2045 exists to end. So a failed
 * save must be LOUD (console.warn -- plain console.log/stdout is dropped by
 * the #1982 WARN floor) and the CALLER must not print "checkpointed" or let
 * the ordinary "stopped at the ... budget" phrase reach the log unqualified:
 * that phrase alone makes relaunch-on-marker's outcome (a) fire an
 * unconditional re-dispatch (it greps the log for the phrase and does not
 * consult the exit code at all), and re-dispatching a slot whose cursor did
 * not save reproduces the restart-from-zero loop rather than escaping it.
 * See the call site below for how the caller turns this `false` into a
 * distinct non-zero exit and a non-budget stop line.
 */
async function saveCensusCursor(control, slot, { unitsDone, aggregate, classified, partialUnit = null }) {
  if (!control) return false;
  const doc = {
    id: censusCursorId(slot), kind: CENSUS_CURSOR_KIND, slot, slots: SLOTS,
    signature: censusCursorSignature(),
    unitsDone, classified, aggregate,
    // THE PAGE CHECKPOINT (2026-09-12). `null` when nothing is mid-flight
    // (a save right after a unit boundary, or the very first save of a
    // pass): NOT an object with a null token, so `loadCensusCursor`'s reader
    // can tell "no unit in progress" apart from "in progress, resume from
    // the unit's own start" without a second field. `{ key, continuationToken }`
    // otherwise -- `key` matches one of `q.units[].key` on the resuming
    // pass, and `continuationToken` is opaque, handed straight back to
    // `items.query`'s options unexamined.
    partialUnit: partialUnit ? { key: String(partialUnit.key), continuationToken: partialUnit.continuationToken } : null,
    updatedAt: new Date().toISOString(),
  };
  try {
    await control.items.upsert(doc);
    return true;
  } catch (e) {
    console.warn(`  !! could not save census cursor for slot ${slot} (${String(e?.message ?? e).slice(0, 140)}) -- the next pass would restart this shard from unit 0, so this pass does NOT report a checkpoint.`);
    return false;
  }
}

/** Delete a finished slot's cursor. A completed cursor left behind would be
 *  read by the NEXT independent dispatch of this slot (a re-run, an audit
 *  re-check) as "resume from here" when there is nothing left to resume --
 *  every unit is already done. Non-fatal: a leftover cursor is caught by the
 *  signature check the next time the shard table or scope changes, so this
 *  is tidiness, not correctness. */
async function clearCensusCursor(control, slot) {
  if (!control) return;
  try { await control.item(censusCursorId(slot), censusCursorId(slot)).delete(); }
  catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) { /* leftover cursor; signature check catches it later */ } }
}

/**
 * THE REVERT PASS -- MODE=apply-improve SCOPE=revert-eviction.
 *
 * Reads the rows this script's own base-eviction wave WROTE, re-reads each
 * one's title against G6, and moves the ones G6 now refuses back to the slug
 * the row itself recorded on the way out.
 *
 * WHAT IT SELECTS. `IS_DEFINED(c.baseEvictionEvidence)` -- the marker only the
 * eviction branch of the apply loop ever writes. A row without it was not
 * moved by an eviction and is untouchable here whatever its shape, so the
 * revert can never reach a row this script did not itself write.
 *
 * WHAT IT MOVES IT TO. `rekeyedFrom[0].cardId`, and nothing else. No parser,
 * no catalog, no derivation: the origin slug is recorded ON the row, so the
 * revert is exact rather than a second guess at an identity. A row whose
 * marker is malformed -- no rekeyedFrom, no cardId in it, or an origin equal
 * to where the row already sits -- is SKIPPED and named, never repaired by
 * inference.
 *
 * WHICH ONES. The ones whose CURRENT title fails G6, through the same
 * `storedParallelStatedInTitle` the eviction path consults, evaluated against
 * the ORIGIN slug -- that is the identity the eviction took away, so that is
 * the identity the title has to be tested against. A row G6 is happy with was
 * a correct eviction and stays where the wave put it. Measured on the live
 * pool 2026-09-04: 12 of 1,456.
 *
 * WHAT IT LEAVES BEHIND. The marker is never deleted. `baseEvictionEvidence`
 * is renamed to `revertedEvictionEvidence` and an audit trail is added --
 * `evictionRevertedAt`, `evictionRevertedReason` and `revertedFrom` (the base
 * slug the row is being taken off) -- so a row that has been out and back
 * carries the whole round trip in its own document. Erasing the evidence would
 * make a reverted row indistinguishable from one the wave never touched, and
 * the next census would have no way to know it had already been ruled on.
 *
 * PROTECTED ROWS ARE PROTECTED IN BOTH DIRECTIONS. A row that has acquired a
 * user source or a ruling marker since the eviction is reported, never moved:
 * "put it back" is still a write, and a write onto a user's own row is exactly
 * what the PROTECTED tier exists to refuse.
 *
 * Report-first: without BACKFILL_APPLY it prints every row it would move, with
 * the exact from/to slugs, and touches nothing. The reconciliation is the same
 * identity every other pass here balances on -- intended = written + skipped +
 * failed -- and the write goes through the same relocateSoldComp, so the sale
 * arrives at the origin slug and is verified by read before the base row is
 * deleted.
 */
async function revertEvictions({ pool, retry: retry_, reportWrites }) {
  const q = {
    query: "SELECT * FROM c WHERE IS_DEFINED(c.baseEvictionEvidence)"
      + (LIMIT ? " OFFSET 0 LIMIT @lim" : ""),
    parameters: LIMIT ? [{ name: "@lim", value: LIMIT }] : [],
  };
  console.log(`\nREVERT-EVICTION  ${APPLY ? "APPLYING" : "REPORT ONLY -- nothing written"}  concurrency ${CONCURRENCY}`);
  console.log(`  selects rows carrying baseEvictionEvidence -- the marker only this script's eviction branch writes.`);
  console.log(`  moves the ones G6 refuses back to rekeyedFrom[0].cardId (both cardId AND hobbyiqCardId).`);
  console.log(`  the marker is never deleted: it is renamed revertedEvictionEvidence and an audit trail is added.`);
  if (LIMIT) console.log(`  LIMIT=${f(LIMIT)} -- reading at most that many marked rows.`);
  // THE BANNER SAYS WHICH SLICE THIS RUN OWNS, BEFORE A ROW IS READ.
  //
  // SLOTS defaults to 32 for the census, and a revert dispatched without
  // `slots` would then silently read 1/32 of the marked rows and report a
  // clean reconciliation over a thirty-second of the population -- a green run
  // that did a thirty-second of the job. So the slice is stated, and stated as
  // a warning when it is a slice at all: the marked population is ~1,456 rows,
  // which one run handles whole.
  if (SLOTS > 1) {
    console.log(`  !! SLOT ${SLOT}/${SLOTS} -- this run owns only sha1(id) %% ${SLOTS} == ${SLOT} of the marked rows.`);
    console.log(`     The marked population is small enough for ONE run: dispatch with slots=1 to take all of it.`);
  } else {
    console.log(`  slots=1 -- this run owns every marked row.`);
  }

  // THE SLOT IS A SHARD OF THE MARKED POPULATION, NOT OF THE POOL. The measured
  // shard table is a packing of 16.3M rows by year and sport, and the marked
  // population is 1,456 rows that do not respect it -- an eviction moved them
  // to a base slug whose year is the row's own, so slotting them by that table
  // would give one slot everything. sha1(id) % SLOTS is uniform by
  // construction over whatever the marked set turns out to be, and SLOTS=1
  // (the default for a run that does not shard) puts all of it in slot 0.
  const mine = (row) => SLOTS <= 1 || hashPartOf(row.id, SLOTS) === SLOT;

  const seen = { read: 0, otherSlot: 0 };
  const candidates = [];
  const skips = new Map();
  const bumpSkip = (k) => skips.set(k, (skips.get(k) ?? 0) + 1);
  const it = pool.items.query(q, { maxItemCount: 200 });
  while (it.hasMoreResults()) {
    if (budgetLeft() < 90000) { console.log(`  stopped reading at the ${RUN_MINUTES}-minute budget`); break; }
    const { resources } = await retry_(() => it.fetchNext());
    for (const row of resources ?? []) {
      if (!mine(row)) { seen.otherSlot++; continue; }
      seen.read++;
      const v = revertVerdict(row);
      if (!v.revert) { bumpSkip(v.reason); continue; }
      candidates.push({ row, origin: v.origin, g6: v.g6 });
    }
  }
  console.log(`\n  marked rows read   ${f(seen.read)}${seen.otherSlot ? `   (${f(seen.otherSlot)} in other slots)` : ""}`);
  console.log(`  G6 refuses         ${f(candidates.length)}   <- these are the damaged evictions`);
  if (skips.size) {
    console.log(`  left alone:`);
    for (const [k, n] of [...skips].sort((a, b) => b[1] - a[1])) console.log(`    ${f(n).padStart(8)}  ${k}`);
  }
  if (candidates.length) {
    console.log(`\n  every row this pass would move, in full:`);
    for (const c of candidates) {
      console.log(`    ${c.row.id}`);
      console.log(`      from  ${c.row.cardId}`);
      console.log(`      to    ${c.origin}`);
      console.log(`      G6    ${c.g6.phrase} (from the ${c.g6.from}) stated in "${String(c.row.title ?? "").slice(0, 90)}"`);
    }
  }

  const stats = { intended: candidates.length, written: 0, skipped: 0, failed: 0, notReached: 0, duplicatesLeft: 0 };
  const outcomes = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < candidates.length) {
      const my = idx++;
      // CF-A-CONCURRENT-STOP-COUNTS-ITS-OWN-CLAIM-ONLY (run 34360565942,
      // 2026-09-09; same defect class as the apply-improve loop above). Each
      // of the CONCURRENCY workers claims a disjoint `my` from the shared
      // `idx` before checking the budget, so a stop near t=0 must not add
      // `candidates.length - my` per worker -- that sums overlapping tails
      // across every worker. Each worker counts only the ONE row it claimed
      // and keeps draining `idx` (no Cosmos read) so the rest are still
      // claimed and counted exactly once.
      if (budgetLeft() < 90000) { stats.notReached++; continue; }
      const c = candidates[my];
      // RE-READ. The pool moves; the verdict is taken again on what is there
      // NOW, exactly as the eviction path re-checks its own class at write
      // time. A row somebody has since moved, ruled on or deleted is skipped.
      let fresh = null;
      try { fresh = (await retry_(() => pool.item(c.row.id, c.row.cardId).read())).resource ?? null; }
      catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) { stats.failed++; outcomes.set("read-failed", (outcomes.get("read-failed") ?? 0) + 1); continue; } }
      if (!fresh) { stats.skipped++; outcomes.set("row-gone-since-read", (outcomes.get("row-gone-since-read") ?? 0) + 1); continue; }
      const v = revertVerdict(fresh);
      if (!v.revert) { stats.skipped++; outcomes.set(`no-longer-revertable:${v.reason}`, (outcomes.get(`no-longer-revertable:${v.reason}`) ?? 0) + 1); continue; }

      const keep = stripSystem(fresh);
      const from = fresh.cardId;
      keep.cardId = v.origin;
      keep.hobbyiqCardId = v.origin;
      // THE PARALLEL FIELD IS NOT REPAIRED HERE. The eviction did not change
      // it -- guard 2 required it blank to begin with -- so writing one now
      // would be this pass inventing an identity, which is the one thing a
      // revert must not do. The row goes back to the slug it came from and the
      // next census reads it fresh.
      keep.contentHash = contentHashOf(keep);
      // THE AUDIT TRAIL. The marker is renamed rather than deleted, so a row
      // that has been out and back says so in its own document and no later
      // census can mistake it for one the wave never touched.
      keep.revertedEvictionEvidence = fresh.baseEvictionEvidence ?? null;
      delete keep.baseEvictionEvidence;
      keep.revertedFrom = [{ id: fresh.id, cardId: from, hobbyiqCardId: fresh.hobbyiqCardId ?? null, title: fresh.title ?? null }];
      keep.evictionRevertedAt = new Date().toISOString();
      keep.evictionRevertedReason =
        `GREAT REMATCH (2026-09-04): BASE-EVICTION REVERTED -- G6 refuses it. `
        + `The title states the stored identity's own parallel "${v.g6.phrase}" (from the ${v.g6.from}) in full, `
        + `so the row and its slug AGREE and there was nothing to evict. `
        + `Moved back to the recorded origin ${v.origin} from ${from}.`;

      const r = await relocateSoldComp(pool, {
        keep, drop: [{ id: fresh.id, cardId: from }], retry: retry_,
        verifyFields: ["cardId", "hobbyiqCardId", "evictionRevertedAt"], dryRun: !APPLY,
      });
      if (!APPLY) { stats.written++; outcomes.set("would-revert", (outcomes.get("would-revert") ?? 0) + 1); continue; }
      if (!r.ok && r.stage !== "done") { stats.failed++; console.log(`  FAILED at ${r.stage} ${fresh.id}: ${String(r.error).slice(0, 110)}`); continue; }
      if (r.duplicatesLeft.length) { stats.failed++; stats.duplicatesLeft += r.duplicatesLeft.length; for (const dd of r.duplicatesLeft) console.log(`  DUPLICATE LEFT ${dd.id}@${dd.cardId}: ${String(dd.error).slice(0, 80)}`); continue; }
      stats.written++; outcomes.set("reverted", (outcomes.get("reverted") ?? 0) + 1);
      console.log(`  REVERTED ${fresh.id}  ${from}  ->  ${v.origin}   (G6: ${v.g6.phrase})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(candidates.length, 1)) }, worker));

  console.log(`\n  ${APPLY ? "reverted" : "would revert"}   ${f(stats.written)}`);
  console.log(`  skipped        ${f(stats.skipped)}   <- re-checked at write time and no longer revertable`);
  console.log(`  failed         ${f(stats.failed)}${stats.duplicatesLeft ? `   (${f(stats.duplicatesLeft)} duplicates left in the pool -- reported, never a lost sale)` : ""}`);
  console.log(`  not reached    ${f(stats.notReached)}`);
  for (const [k, n] of [...outcomes].sort((a, b) => b[1] - a[1])) console.log(`    ${f(n).padStart(8)}  ${k}`);
  console.log(`\n  intended ${f(stats.intended)} = written ${f(stats.written)} + skipped ${f(stats.skipped)} + failed ${f(stats.failed)} + not reached ${f(stats.notReached)}`);
  const recon = stats.written + stats.skipped + stats.failed + stats.notReached;
  if (recon !== stats.intended) {
    console.error(`!! reconciliation drift: ${recon} accounted vs ${stats.intended} intended (${recon - stats.intended}). Exit 4.`);
    process.exitCode = 4;
  }
  if (APPLY) reportWrites({ job: "rematch-sold-comps:revert-eviction", intended: stats.intended, written: stats.written, skipped: stats.skipped, failed: stats.failed });
  return stats;
}

/**
 * Should THIS marked row be moved back, and where to?
 *
 * Returns { revert, reason, origin, g6 }. Pure over one document, so a test
 * drives it with a plain object and no Cosmos at all -- which is what lets the
 * selection rule be pinned separately from the write.
 *
 * The G6 test is run against the ORIGIN slug, not the row's current one: the
 * current slug is the BASE slug the eviction produced, and asking whether the
 * title states THAT parallel would always be no. The question is whether the
 * title states the parallel the eviction took away.
 */
function revertVerdict(row) {
  const no = (reason) => ({ revert: false, reason, origin: null, g6: null });
  if (!row || !row.baseEvictionEvidence) return no("no-eviction-marker");
  // PROTECTED IS PROTECTED IN BOTH DIRECTIONS. Putting a row back is still a
  // write, and a row that has since become a user's own is not this pass's to
  // move -- it is reported and left exactly where it sits.
  // `provenanceTier` returns { tier, reasons } -- comparing the OBJECT to the
  // constant is always false, and a guard that is always false is no guard.
  if (K.provenanceTier(row).tier === K.PROTECTED) return no("protected-since-the-eviction");
  const from = Array.isArray(row.rekeyedFrom) ? row.rekeyedFrom[0] : null;
  const origin = from && from.cardId ? String(from.cardId) : "";
  if (!origin) return no("marker-carries-no-origin-slug");
  if (origin === String(row.cardId)) return no("already-at-the-origin-slug");
  const setKey = String(row.cardId ?? "").split(":")[3] ?? "";
  const g6 = K.storedParallelStatedInTitle({
    title: row.title, storedSlug: origin,
    // The eviction required the stored parallel FIELD to be blank, and it did
    // not change it -- so the slug is the only half of the origin identity
    // that still names the parallel, and it is read from the origin slug.
    stored: { parallel: row.baseEvictionEvidence?.storedParallelField ?? row.parallel ?? null },
    setKey,
  });
  if (!g6) return no("G6-agrees-with-the-eviction");
  return { revert: true, reason: "G6-refuses-the-eviction", origin, g6 };
}

module.exports = {
  unitsForSlot, unitPredicate, slotQuery, rowInSlot, storedIdentity, deriveIdentity,
  hashPartOf, SPORT_CLASSES, SHARD_TABLE, APPLY_SCOPE_RAW,
  // THE IN-SLOT ROW FILTER, exported so its selection rule is pinned on the
  // SHIPPED function rather than on a test's re-implementation of it.
  rowPassesFilter, slugSetKeySegment, SPORTS_FILTER, SETKEY_LIKE, ROW_FILTER_ON,
  // The revert pass. `revertVerdict` is pure over one document, so the
  // SELECTION rule can be pinned with plain objects and no Cosmos at all;
  // `revertEvictions` is driven against the stubbed container the other apply
  // tests use, so the WRITE is pinned on the committed script rather than on a
  // test's re-implementation of it.
  revertVerdict, revertEvictions,
  // THE CENSUS CURSOR (2026-09-11): exported so its checkpoint/resume/
  // invalidation rules are pinned on the SHIPPED functions, not a test's
  // re-implementation of them. `censusCursorId` and `censusCursorSignature`
  // are pure; `loadCensusCursor`/`saveCensusCursor`/`clearCensusCursor` are
  // driven against a stubbed `control` container the same way the other apply
  // tests drive `pool`.
  censusCursorId, censusCursorSignature, signaturesMatch,
  loadCensusCursor, saveCensusCursor, clearCensusCursor, CENSUS_CURSOR_KIND,
  // 2026-09-12 (run 34658848883 slot 3): the container-provisioning fix and
  // its exit-code contract, exported so both are pinned on the SHIPPED
  // functions/constants rather than a test's re-implementation of them.
  getOrCreateControlContainer, CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE,
};

if (require.main === module) // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
//
// CF-A-RECONCILE-VERDICT-MUST-REACH-THE-EXIT-CODE (run 34360565942, 2026-09-
// 09). This used to be a hardcoded `finishLane(0, ...)`: the reconcile below
// (`intended = written + skipped + failed + not reached`) correctly detects
// drift and sets `process.exitCode = 4` (or 6 for a scope failure), but a
// hardcoded 0 here threw that verdict away before `finishLane` ever saw it --
// the step printed "WORK VANISHED / UNACCOUNTED 2,179 (100%)" and STILL
// exited 0. `process.exitCode` is the one channel the reconcile has to reach
// this call, so it is read here rather than assumed clean.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || {}))
  .catch(async (e) => {
    // CF-AN-EMPTY-LOG-IS-NOT-A-BUDGET-KILL (2026-09-07). The runner reads
    // /tmp/backfill.log, which `tee` fills from STDOUT ONLY -- so a crash
    // reported to stderr alone left the runner's log without the one thing an
    // operator needs. Mirror it. finishLane(3) still writes its own exit line,
    // so the KILLED branch sees a genuine finish witness rather than a kill.
    const msg = `FATAL: ${e?.stack || e?.message}`;
    console.error(msg);
    console.log(msg);
    await finishLane(3);
  });
