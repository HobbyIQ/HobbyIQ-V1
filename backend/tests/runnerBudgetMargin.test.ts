// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS — every budgeted lane, pinned.
//
// #1799 pinned ONE lane (retire-self-derived-identities) after run
// 33960686247 reconciled clean at 12:43:23 and was killed at 12:58:10 by
//
//   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
//
// The 887 seconds in between were an unbounded post-loop verify. The data was
// fine; the job was red; the operator read a working lane as a broken one.
//
// That pin was per-script and hard-coded to one file. This one is the census
// generalised: it enumerates EVERY script the backfill runner's dropdown can
// dispatch, keeps the ones that declare a time budget, and computes each
// lane's worst-case wall clock against the workflow's real `timeout-minutes`.
//
//   worst case = RUN_MINUTES + RESERVE_MS + VERIFY_MS + startup
//
// A lane with no unit reserve fails BY NAME. A lane with an unbounded
// post-loop aggregate and no verify cap fails BY NAME. A lane whose budget
// leaves under 15 minutes of margin fails BY NAME. The failure message names
// the script so the fix is obvious without reading this file.
//
// MUTATION-SENSITIVE BY CONSTRUCTION:
//   - raise any lane's RUN_MINUTES back to 140  -> margin < 15 -> red
//   - delete a lane's verify cap                -> unbounded-verify case -> red
//   - delete a lane's unit reserve              -> reserve case -> red
//   - shrink the workflow's timeout-minutes     -> every lane's margin drops
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const RUNNER = read(".github", "workflows", "backfill-runner.yml");

/** The step that actually runs the script. Its `timeout-minutes` is the
 *  ceiling every lane's budget has to live under — read from the workflow,
 *  never hard-coded here, so shrinking it turns this suite red. */
function stepCeilingMinutes(): number {
  const step = RUNNER.split(/^      - name: /m).find((s) => /^Run backfill \(/.test(s));
  expect(step, "the 'Run backfill' step must exist in backfill-runner.yml").toBeTruthy();
  const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(step as string);
  expect(m, "the 'Run backfill' step must declare timeout-minutes").toBeTruthy();
  return Number((m as RegExpExecArray)[1]);
}

/** Every script name the dropdown can dispatch. The whitelist IS the surface:
 *  a script nobody can dispatch cannot time a step out. */
function whitelistedScripts(): string[] {
  const blk = RUNNER.slice(RUNNER.indexOf("      script:"));
  const m = /options:\n((?:\s*(?:-|#).*\n)+)/.exec(blk);
  expect(m, "the script input must declare its options list").toBeTruthy();
  return (m as RegExpExecArray)[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

/** Measured startup: connection + the scope enumeration before the loop's t0.
 *  Run 33960686247: step start 10:27:57 -> loop t0 10:28:16. Rounded up. */
const STARTUP_MINUTES = 1;

/** The margin the rule requires between a lane's worst case and the ceiling. */
const REQUIRED_MARGIN_MINUTES = 15;

type Lane = {
  script: string;
  file: string;
  src: string;
  runMinutes: number;
  reserveMs: number | null;
  verifyMs: number | null;
  /** UNBOUNDED cross-partition aggregates — the shape that hung #1799.
   *
   *  NOT every `COUNT(1)` qualifies, and the distinction is the whole point.
   *  An aggregate filtered to ONE row's identity — `c.hobbyiqCardId = @s`,
   *  `STARTSWITH(c.id, @p)` inside the work loop — is an index-served point
   *  lookup costing milliseconds, and lanes run thousands of them by design.
   *  What killed run 33960686247 was the other kind: an aggregate over a
   *  whole sport or a whole container, run AFTER the loop, whose cost scales
   *  with the corpus rather than with the work just done. Only that kind is
   *  required to sit under a cap, because only that kind can outlive the
   *  step. Counting the cheap ones too would push every lane into a cap it
   *  does not need, and a pin that cries wolf gets deleted. */
  unboundedVerify: number;
  /** A bare `Date.now() - t0 > BUDGET` check, i.e. the loop-top defect. */
  bareCheck: boolean;
};

/** Every spelling of the budget in use across the whitelist. A lane that
 *  invents a new one is not silently skipped — `unparsed` below fails. */
const BUDGET_PATTERNS: RegExp[] = [
  /const RUN_MS = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\) \* 60_?000/,
  /const RUN_MINUTES = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\)/,
  /const RUN_MINUTES = Number\(arg\("[a-z-]+", *(?:process\.)?env\(?"?RUN_MINUTES"?,? *"?(\d+)"?\)?\)\)/,
  /const RUN_MINUTES = Number\(arg\("[a-z-]+", *process\.env\.RUN_MINUTES \?\? "(\d+)"\)\)/,
  /const RUN_MINUTES = Math\.max\(\d+, Number\(arg\("[a-z-]+", "(\d+)"\)\)\)/,
  /const BUDGET_MS = Number\(process\.env\.[A-Z_]+ \|\| (\d+) \* 60 \* 1000\)/,
  /runMinutes\((\d+)\)/,
  /minutes: (\d+)[,\s]/,
];

/** ms literal from a `const NAME = Number(process.env.X || <expr>)` default,
 *  where <expr> is a product of integer literals (`10 * 60 * 1000`). */
function msDefault(src: string, name: string): number | null {
  const re = new RegExp(
    `${name}\\s*=\\s*Number\\(process\\.env\\.[A-Z_]+ \\|\\| ([0-9]+(?:\\s*\\*\\s*[0-9]+)*)\\)`,
  );
  const m = re.exec(src);
  if (m) return m[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
  // The shared helper's call site: `budget({ ..., reserveMs: 90 * 1000 })`.
  const kw = name.replace(/_MS$/, "").toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
  const m2 = new RegExp(`${kw}Ms:\\s*([0-9]+(?:\\s*\\*\\s*[0-9]+)*)`).exec(src);
  if (m2) return m2[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
  return null;
}

/**
 * Count the aggregates whose cost scales with the CORPUS rather than with one
 * row — the shape that can still be running when the runner kills the step.
 *
 * An aggregate is bounded when every predicate it carries pins it to a single
 * identity: an equality or prefix on an id/slug field, bound to a parameter.
 * Anything else — a bare `${PRED}`, a CONTAINS/LOWER scan, a whole-sport
 * equality, a DISTINCT over a set — is unbounded for this purpose and has to
 * live under the cap.
 */
function countUnboundedVerifies(src: string): number {
  // POSITION IS THE DISTINCTION, not just cost. An expensive scan BEFORE the
  // loop — a scope guard that refuses a wrong dispatch, an estimate mode that
  // is the whole job — spends budget the loop then does not get, which the
  // reserve and the margin already cover. It cannot strand a reconciliation,
  // because there is nothing yet to reconcile.
  //
  // What killed run 33960686247 is the scan AFTER the loop: the counts have
  // printed, the reconcile has balanced, the writes are durable — and then an
  // unbounded aggregate holds the step open until the runner kills it, taking
  // the exit code and the operator's confidence down with it. Only a scan
  // positioned after the work has that failure mode, so only that one is
  // required to sit under a cap.
  let n = 0;
  for (const m of src.matchAll(/SELECT VALUE COUNT\([\s\S]{0,400}?(?=["`'])/g)) {
    const q = m[0];
    // Pinned to one row's identity: an index-served point lookup costing
    // milliseconds. Lanes run thousands of these inside the loop by design.
    const pinned =
      /\b(?:c\.hobbyiqCardId|c\.cardId|c\.id|c\.sourceExternalId)\s*(?:=|!=)\s*@/.test(q) ||
      /STARTSWITH\(\s*c\.(?:id|cardId|hobbyiqCardId)\s*,\s*@/.test(q);
    const widened = /CONTAINS\(|LOWER\(|DISTINCT|\$\{PRED\}|IS_DEFINED/.test(q);
    if (pinned && !widened) continue;
    if (!afterTheWork(src, m.index ?? 0)) continue;
    n++;
  }
  return n;
}

/** True when an offset sits after the point where the lane has already
 *  reported — i.e. after a reconcile/banner/AFTER line, which is exactly the
 *  window in which a hang costs a clean run its exit code. */
function afterTheWork(src: string, at: number): boolean {
  // Anchors are CALL sites, never declarations. `function reconcile(...)` is
  // usually declared near the top of a lane and called at the very bottom;
  // anchoring on the declaration would mark every in-loop helper below it as
  // post-loop and fail lanes whose scans are cheap point lookups (observed on
  // repair-bcp-misfiled-parallels: scans at 405/414, reconcile CALL at 608).
  const reported = [
    /reconciled: intended/,
    /(?<!function )\breconcile\(`/,
    /banner\(stopReason\)/,
    /\bAFTER\s+\$\{/,
    /VERIFY BY READ/,
  ];
  for (const re of reported) {
    const m = re.exec(src);
    if (m && m.index < at) return true;
  }
  return false;
}

const unparsed: string[] = [];

/** ── THE HOLE THIS CENSUS USED TO HAVE ──────────────────────────────────────
 *
 * A lane matching neither RUN_MINUTES nor BUDGET_MS was `continue`d below, so
 * a lane with NO BUDGET AT ALL was not a failing lane — it was an INVISIBLE
 * one. Every per-lane assertion in this file only ever ran against lanes that
 * had already declared a budget, which is precisely the population that does
 * not need to be told to declare one.
 *
 * relocate-catalog-rows-by-list sat in that hole. It is on the dropdown, it
 * DELETES catalog rows, and it looped over its whole list with no clock —
 * until run 34079952456 hit the 150-minute ceiling mid-list, printing no
 * marker, no reconcile and no finishLane line. This census had nothing to say
 * about it, because it never saw it.
 *
 * So the skip is now RECORDED, not silent, and a WRITING lane in that bucket
 * fails by name. The read-only ones — censuses and audits that a `mode` input
 * pins to report — are left alone deliberately: they cannot leave half-written
 * state behind, and a pin that demands ceremony of them gets deleted.
 */
const unbudgetedWriters: string[] = [];

/** The debt, frozen as measured on 2026-09-07 and SHRUNK the same week -- the
 *  dispatchable write lanes still running with no clock of their own. This list
 *  may LOSE names (a lane that gains a budget must be struck from it) and may
 *  never GAIN one. It is not an approval: every entry here is a lane that will
 *  be KILLED rather than stopped if it is ever dispatched over more work than
 *  one 150-minute step holds.
 *
 *  59 -> 44 -> 29 -> 14, in four waves. Every struck name is absent for the
 *  same reason relocate-catalog-rows-by-list is: it now budgets, so putting any
 *  of them back would make this suite red.
 *
 *  WAVE 1 (59 -> 44) took the lanes in BLAST-RADIUS ORDER:
 *    portfolio: conform-holdings-to-catalog, reap-orphan-price-trails,
 *      backfill-holding-ebay-ids, backfill-canonicalize-chrome-slugs
 *    sold_comps + card_catalog: repair-refractor-mislabel,
 *      merge-bare-colour-parallels, retire-impossible-grade-rows,
 *      retire-flattened-attestations
 *    card_catalog: dedupe-catalog-partition-shadows,
 *      backfillCatalogCardYearFromSlug, normalize-catalog-format
 *    sold_comps: relocate-pool-rows-by-list, recover-chrome-collapse-damage,
 *      revert-d30-base-onto-one-of-one, reslug-tcg-out-of-sports-namespace
 *
 *  WAVE 2 (44 -> 29) took the next fifteen IN OWED ORDER, i.e. straight off the
 *  top of this list as wave 1 left it, so the ranking was read rather than
 *  re-derived:
 *    portfolio: reprice-user-holdings -- the SANCTIONED reprice path and the
 *      last remaining writer of that container
 *    two-container: backfill-catalog-driven-canonicalize,
 *      backfill-stage2-title-parser
 *    card_catalog: auto-label-catalog-variants,
 *      backfill-searchtokens-all-sports, dedupe-catalog-by-hobbyiq,
 *      fix-catalog-parallel-as-player, normalize-catalog-schema
 *    sold_comps: auto-quarantine-contaminated-pools,
 *      backfill-autostyle-from-title, backfill-bowman-mega-box-reslug,
 *      backfill-cardsight-title-identity, backfill-cardsight-unverified-flag,
 *      backfill-composite-fields, backfill-composite-v3
 *
 *  FIVE OF WAVE 2 WERE NOT UNCLOCKED -- THEY WERE CLOCKED WRONG, which this
 *  census could not see and is worth recording so the next reader does not
 *  mistake the absence of RUN_MINUTES for the absence of a cap.
 *  auto-label-catalog-variants, backfill-searchtokens-all-sports,
 *  dedupe-catalog-by-hobbyiq, fix-catalog-parallel-as-player and
 *  normalize-catalog-schema each carried a LOCAL `BACKFILL_MAX_MINUTES` +
 *  `timeExpired()` cap, checked at the loop TOP with no unit reserve, and
 *  signalled continuation with `RELAUNCH_NEEDED=true|false` instead of the
 *  marker. That protocol is sound only while a lane cannot be killed: a killed
 *  step prints no line at all, so `RN` parses EMPTY and the runner's
 *  RELAUNCH_NEEDED step falls through to a `::warning::` that does NOT fail the
 *  job -- #1906's "a killed run is not a finished run" defect living in a
 *  second protocol, where relaunchNeverCallsAKilledRunFinished.test.ts was not
 *  looking for it (that pin's population is the MARKER-keyed steps, and its
 *  docblock explicitly excludes RELAUNCH_NEEDED lanes on the grounds that they
 *  read a positive signal of work remaining -- true, and beside the point once
 *  the lane can be killed mid-sweep). All five now take the shared clock and
 *  the marker, which puts them inside that pin's population.
 *
 *  WAVE 3 (29 -> 14) took the next fifteen IN OWED ORDER, i.e. straight off the
 *  top of this list as wave 2 left it, so the ranking was again read rather
 *  than re-derived. All fifteen write `sold_comps`, which is what the top of
 *  the list held:
 *    field backfills: backfill-grade-from-ch-daily, backfill-grade-from-title,
 *      backfill-printrun-from-title, backfill-sub-channel-vocabulary
 *    slug rewrites: backfill-insert-setkey, backfill-isauto-cross-sport,
 *      backfill-isauto-from-cardnumber, backfill-parallel-enrichment
 *    flag stampers: backfill-stage3-price-sanity,
 *      promote-sold-comps-trust-tier, reaudit-cardsight-unverified
 *    statistics: baseline-pool-snapshot, refresh-calibration-multipliers
 *    other containers: migrate-cardsight-to-staging (cardsight_staging),
 *      nightly-reingest-top-ch-cards (measures only -- see below)
 *
 *  TWO OF WAVE 3 WERE CLOCKED WRONG RATHER THAN UNCLOCKED, the same class wave
 *  2 found five of. reaudit-cardsight-unverified and
 *  nightly-reingest-top-ch-cards each carried a local `BACKFILL_MAX_MINUTES` +
 *  `timeExpired()` cap, checked at the loop TOP with no unit reserve, and
 *  signalled continuation with `RELAUNCH_NEEDED=true|false` instead of the
 *  marker -- a protocol whose third arm is a `::warning::` that does NOT fail
 *  the job, so a KILLED step (which prints no line at all) parses EMPTY and the
 *  run goes green with its work half done.
 *
 *  AND nightly-reingest-top-ch-cards WAS WORSE THAN THAT: it printed
 *  `RELAUNCH_NEEDED=` and NO STEP IN THE RUNNER EVER READ IT. It is not on the
 *  catalog-expansion gate and never was, so for as long as it has been
 *  dispatched its continuation signal has gone to the log and nowhere else --
 *  a 25-minute cap that stopped a top-1000 walk it cannot finish in one pass,
 *  said so, and was not acted on. Both now take the shared clock and the
 *  marker, which puts them inside relaunchNeverCallsAKilledRunFinished's
 *  population.
 *
 *  FOUR OF WAVE 3 REFUSE THEIR WRITE PHASE after a scan-phase stop --
 *  backfill-stage3-price-sanity, promote-sold-comps-trust-tier,
 *  baseline-pool-snapshot and refresh-calibration-multipliers. Each computes
 *  its plan from a STATISTIC over a whole-container or whole-window scan (a
 *  per-slug median, a percentile set, a median of per-identity price ratios),
 *  and a statistic over PART of a pool is a DIFFERENT number rather than a
 *  smaller one. Their row floors do not save them: a partial pool can clear
 *  MIN_POOL_SIZE / MIN_SAMPLES / identityN >= 3 and still misstate the value.
 *  refresh-calibration-multipliers is the sharpest of the four -- its output is
 *  the multiplier the pricing engine applies, with a `confidence` label derived
 *  from the same partial count, so a wrong fit can be stamped "verified".
 *
 *  THE ORDER THE REMAINING 14 ARE OWED IN is the order they are written below:
 *  portfolio first, then the two-container lanes, then card_catalog, then
 *  sold_comps, then the lanes whose writes land outside the three pricing
 *  containers. Within a tier they are alphabetical, so the next builder takes
 *  the top of the list rather than re-deriving the ranking. No `portfolio`
 *  writer remains: wave 2 took the last one, and no plain `sold_comps` field
 *  or slug writer remains either: wave 3 took those.
 *
 *  NONE of these 14 is local-only. Every one is reachable from the runner's
 *  `script` dropdown, and the eBay lanes (run-ebay-order-poll, -purchase-sync,
 *  -finances-enrichment) were deliberately MOVED onto the runner from the API
 *  process, so de-listing them is not available as a shortcut -- they have to
 *  be budgeted where they are. */
const KNOWN_UNBUDGETED_WRITE_LANES = [
  "refresh-market-signals", "rescore-anomalies", "reslug-cross-product-mis-slug",
  "reslug-suspicious-setkeys", "score-all-sold-comps", "backfill-ch-catalog-additions",
  "backfill-verify-queue-grades", "bulk-import-ch-daily-to-sold-comps", "drain-staging-backlog",
  "ingest-2026-bowman-auto-checklist", "ingest-product-checklist", "run-ebay-finances-enrichment",
  "run-ebay-order-poll", "run-ebay-purchase-sync",
];

/** A lane that can WRITE. The signal is the runner's own gate (`BACKFILL_APPLY`
 *  / `APPLY`), which every write lane reads to decide whether to persist, and
 *  which a report-only census does not have. */
const writesWhenApplied = (src: string) =>
  /process\.env\.BACKFILL_APPLY|process\.env\.APPLY\b/.test(src);

function loadLanes(): Lane[] {
  const lanes: Lane[] = [];
  for (const script of whitelistedScripts()) {
    const file = path.join("backend", "scripts", `${script}.cjs`);
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const src = read(file);
    if (!/RUN_MINUTES|BUDGET_MS/.test(src)) {
      if (writesWhenApplied(src)) unbudgetedWriters.push(script);
      continue;
    }

    let runMinutes: number | null = null;
    for (const re of BUDGET_PATTERNS) {
      const m = re.exec(src);
      if (m) { runMinutes = Number(m[1]); break; }
    }
    if (runMinutes === null) { unparsed.push(script); continue; }

    lanes.push({
      script, file, src, runMinutes,
      // A lane whose reserve is a FRACTION of its budget (census-unknown-setkey
      // sizes it as RUN_MINUTES * 6000, floored) states the floor as a literal
      // so the worst case stays computable without evaluating the expression.
      reserveMs:
        msDefault(src, "RESERVE_MS")
        ?? msDefault(src, "PRODUCT_RESERVE_MS")
        ?? msDefault(src, "RESERVE_FLOOR_MS"),
      verifyMs: msDefault(src, "VERIFY_MS"),
      unboundedVerify: countUnboundedVerifies(src),
      bareCheck: /Date\.now\(\)\s*-\s*\w+\s*>=?\s*(?:RUN_MS|BUDGET_MS)\s*[)\;]/.test(src),
    });
  }
  return lanes;
}

const CEILING = stepCeilingMinutes();
const LANES = loadLanes();

describe("every budgeted runner lane stops under the action ceiling", () => {
  it("the ceiling is read from the workflow, and it is the 150 the kill hit", () => {
    expect(CEILING).toBe(150);
  });

  it("the census found the budgeted lanes it is supposed to govern", () => {
    // A guard against the loader silently matching nothing and the whole
    // suite passing vacuously (feedback_retired_correction_verify_output_not_existence).
    expect(LANES.length).toBeGreaterThanOrEqual(60);
  });

  it("no NEW dispatchable write lane may ship without a budget — the list only shrinks", () => {
    // ── WHY A RATCHET AND NOT A FLAT ZERO ──────────────────────────────────
    //
    // Measured when this assertion was written: 59 whitelisted write lanes
    // declared no budget. Demanding zero that day would have failed the suite
    // on 59 lanes nobody in that change had measured, and a pin that is red on
    // arrival is a pin somebody deletes — which would cost the rule entirely.
    //
    // The ratchet is doing its job: 59 the day it was frozen, 44 after wave 1,
    // 29 after wave 2, 14 after wave 3. Every name that left was MEASURED —
    // each one's unit identified, its reserve sized to that unit's worst case,
    // its marker and reconcile driven by the per-lane assertions below — which
    // is the only way a name may leave.
    //
    // So the debt is WRITTEN DOWN and frozen. Removing a lane from this list is
    // the only edit that keeps the suite green: adding a name fails below, and
    // shipping a NEW unbudgeted write lane fails below too. That makes the
    // backlog visible and monotonically shrinking instead of invisible and
    // growing, which is exactly the property the old silent `continue` denied.
    //
    // relocate-catalog-rows-by-list is DELIBERATELY ABSENT: run 34079952456 is
    // what forced this assertion, and the lane it killed now budgets. Putting
    // it back would make this suite red.
    const unbudgeted = new Set(unbudgetedWriters);
    const stillOwed = KNOWN_UNBUDGETED_WRITE_LANES.filter((s) => unbudgeted.has(s));
    const newlyUnbudgeted = unbudgetedWriters.filter(
      (s) => !KNOWN_UNBUDGETED_WRITE_LANES.includes(s),
    );

    expect(
      newlyUnbudgeted,
      `these dispatchable WRITE lanes declare no budget at all, so they run until the `
        + `runner kills them at the ${CEILING}-minute ceiling — no marker, no reconcile, `
        + `no finishLane, and #1906's killed branch withholds the re-dispatch: `
        + `${newlyUnbudgeted.join(", ")}. Give each one budget() from `
        + `scripts/lib/runner-budget.cjs, an outOfClock() pre-check per unit, the `
        + `marker as a source literal, and finishLane().`,
    ).toEqual([]);

    // The ratchet's other tooth: a lane that HAS been fixed must be struck from
    // the list, or the list stops describing the debt it exists to bound.
    const fixed = KNOWN_UNBUDGETED_WRITE_LANES.filter((s) => !unbudgeted.has(s));
    expect(
      fixed,
      `these lanes now declare a budget and must be removed from `
        + `KNOWN_UNBUDGETED_WRITE_LANES: ${fixed.join(", ")}`,
    ).toEqual([]);

    // A guard against the whole thing passing vacuously if `writesWhenApplied`
    // ever stops matching anything.
    expect(stillOwed.length).toBeGreaterThan(0);
  });

  it("every budgeted lane's RUN_MINUTES is parseable — a new spelling is not a free pass", () => {
    expect(
      unparsed,
      `these lanes declare a budget this pin cannot read, so their margin is uncomputable: ${unparsed.join(", ")}`,
    ).toEqual([]);
  });

  // ── THE MARGIN, PER LANE, BY NAME ────────────────────────────────────────
  for (const lane of LANES) {
    describe(lane.script, () => {
      it("declares a unit reserve, so the budget stops BEFORE a unit, not after one", () => {
        expect(
          lane.reserveMs,
          `${lane.script} has no RESERVE_MS: its budget check admits one more unit of `
            + `unbounded size after expiry. Size a reserve to the lane's largest unit `
            + `and check it BEFORE each unit.`,
        ).not.toBeNull();
        expect(lane.reserveMs as number).toBeGreaterThan(0);
      });

      it("checks the clock before each unit, never with a bare over-budget test", () => {
        expect(
          lane.bareCheck,
          `${lane.script} still tests \`Date.now() - t0 > BUDGET\`. That is the loop-top `
            + `defect: it admits one whole extra unit past expiry.`,
        ).toBe(false);
      });

      it("bounds its post-loop verify, or reads nothing after the loop", () => {
        if (lane.unboundedVerify === 0) return; // nothing unbounded to cap
        expect(
          lane.verifyMs,
          `${lane.script} runs ${lane.unboundedVerify} UNBOUNDED cross-partition COUNT() aggregate(s) with `
            + `no VERIFY_MS cap. That is the exact shape that ran 887s and got run `
            + `33960686247 killed at the ceiling AFTER it had reconciled clean.`,
        ).not.toBeNull();
        expect(lane.verifyMs as number).toBeGreaterThan(0);
        expect(lane.src, `${lane.script} must report an unread count, never print it as zero`)
          .toMatch(/UNCONFIRMED \(verify cap\)/);
        expect(lane.src).toMatch(/UNREAD, not zero/);
      });

      it(`worst case leaves >= ${REQUIRED_MARGIN_MINUTES} minutes under the ${CEILING}m ceiling`, () => {
        const reserve = (lane.reserveMs ?? 0) / 60000;
        const verify = (lane.verifyMs ?? 0) / 60000;
        const worstCase = lane.runMinutes + reserve + verify + STARTUP_MINUTES;
        const margin = CEILING - worstCase;
        expect(
          margin,
          `${lane.script}: RUN_MINUTES=${lane.runMinutes} + ${reserve}m reserve + ${verify}m `
            + `verify + ${STARTUP_MINUTES}m startup = ${worstCase}m against a ${CEILING}m `
            + `ceiling leaves ${margin}m — need >= ${REQUIRED_MARGIN_MINUTES}.`,
        ).toBeGreaterThanOrEqual(REQUIRED_MARGIN_MINUTES);
      });
    });
  }

  it("the 140-minute default that leaves 10 minutes of margin is gone from every lane", () => {
    // The regression is the VALUE, so the pin is on the value. 140 + any
    // reserve + any verify does not fit under 150.
    const still140 = LANES.filter((l) => l.runMinutes >= 140).map((l) => l.script);
    expect(
      still140,
      `these lanes still budget >= 140 minutes under a ${CEILING}-minute ceiling: ${still140.join(", ")}`,
    ).toEqual([]);
  });
});

// ── THE BANNERS OPERATORS GATE ON ──────────────────────────────────────────
//
// CF-RELAUNCH-ONLY-ON-BUDGET (#1361): the workflow's self-relaunch steps grep
// the script's own stdout for a budget marker. The whole point of an earlier
// stop is that the lane RELAUNCHES and continues; a reworded marker silently
// ends the fan-out after one slice, which is a quieter version of the same
// bug. Changing a budget must never change the marker.
describe("the budget marker every relaunch greps for still prints verbatim", () => {
  const marker = /stopped at the .*budget/;

  for (const lane of LANES.filter((l) => /stopped at the/.test(l.src))) {
    it(`${lane.script} prints a marker the runner's grep matches`, () => {
      const lines = lane.src.split("\n").filter((l) => /stopped at the/.test(l));
      expect(lines.some((l) => marker.test(l)), `${lane.script}'s marker must match ${marker}`).toBe(true);
    });
  }

  it("the relaunch steps still grep for the marker they have always grepped for", () => {
    const greps = RUNNER.match(/grep -aqE "stopped at the [^"]*"/g) ?? [];
    expect(greps.length, "the marker-gated relaunch steps must exist").toBeGreaterThan(0);
    for (const g of greps) expect(g).toMatch(/stopped at the \.\*budget/);
  });
});
