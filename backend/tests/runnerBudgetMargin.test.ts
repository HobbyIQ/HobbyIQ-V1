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
 *
 * As of the #1944 ratchet's wave 4 this array is expected to be EMPTY, and the
 * assertion below says so outright. It is no longer compared against an
 * allowlist, because the allowlist reached zero and was deleted.
 */
const unbudgetedWriters: string[] = [];

/** ── THE RATCHET REACHED ZERO, SO IT IS NOW A HARD RULE ────────────────────
 *
 * THERE IS NO LIST HERE ANY MORE. That is the change, and it is the whole
 * point: for four waves this file carried a frozen, shrink-only allowlist of
 * dispatchable write lanes that ran with no clock, and the rule below was
 * "no NEW one". The rule below is now "not ONE", with nothing to be added to.
 *
 * 59 -> 44 -> 29 -> 14 -> 0, in four waves. Every name left for the same
 * reason relocate-catalog-rows-by-list did: it now budgets.
 *
 *   WAVE 1 (59 -> 44) took the lanes in BLAST-RADIUS ORDER --
 *     portfolio: conform-holdings-to-catalog, reap-orphan-price-trails,
 *       backfill-holding-ebay-ids, backfill-canonicalize-chrome-slugs
 *     sold_comps + card_catalog: repair-refractor-mislabel,
 *       merge-bare-colour-parallels, retire-impossible-grade-rows,
 *       retire-flattened-attestations
 *     card_catalog: dedupe-catalog-partition-shadows,
 *       backfillCatalogCardYearFromSlug, normalize-catalog-format
 *     sold_comps: relocate-pool-rows-by-list, recover-chrome-collapse-damage,
 *       revert-d30-base-onto-one-of-one, reslug-tcg-out-of-sports-namespace
 *
 *   WAVE 2 (44 -> 29) took the last `portfolio` writer -- reprice-user-holdings,
 *     the SANCTIONED reprice path -- then the two-container lanes, then
 *     card_catalog, then sold_comps.
 *
 *   WAVE 3 (29 -> 14) took the fifteen plain sold_comps field and slug writers,
 *     the flag stampers, and two statistic lanes.
 *
 *   WAVE 4 (14 -> 0) took what was left, and it was the tail for a reason:
 *     the two remaining slug rewrites (reslug-cross-product-mis-slug,
 *       reslug-suspicious-setkeys)
 *     the two confidence scorers (score-all-sold-comps, rescore-anomalies)
 *     the verify_queue grade patcher (backfill-verify-queue-grades)
 *     the CH bulk importer (bulk-import-ch-daily-to-sold-comps)
 *     the staging drainer (drain-staging-backlog)
 *     the two checklist minters (ingest-product-checklist,
 *       ingest-2026-bowman-auto-checklist)
 *     the CH catalog additions ingester (backfill-ch-catalog-additions)
 *     the market-signals statistic lane (refresh-market-signals)
 *     and the three eBay lanes that were deliberately MOVED onto the runner
 *       from the API process (run-ebay-order-poll, -purchase-sync,
 *       -finances-enrichment), so de-listing them was never available as a
 *       shortcut.
 *
 * ── FOUR THINGS WAVE 4 FOUND THAT NO EARLIER WAVE HAD SEEN ────────────────
 *
 * 1. TWO LANES SWALLOWED A FATAL INTO A GREEN RUN. rescore-anomalies and
 *    score-all-sold-comps both ended
 *
 *      main().catch(e => { console.error(e);
 *                          console.log("RELAUNCH_NEEDED=true");
 *                          process.exit(0); })
 *
 *    -- a crash printed a re-dispatch request and exited ZERO. The step went
 *    green, the job went green, and the only evidence was a stack trace nobody
 *    was told to look for. No gate could have caught it: there was nothing in
 *    the log that said anything had gone wrong.
 *
 * 2. ONE LANE'S MARKER HAS NEVER BEEN GREPPED BY ANYTHING.
 *    bulk-import-ch-daily-to-sold-comps carried a REAL time budget --
 *    ch-fanout-to-sold-comps.yml sets BULK_TIME_BUDGET_MIN=300 under a
 *    340-minute job, added after three consecutive nights of cancellation in
 *    2026-08 -- and printed its stop as `TIME BUDGET REACHED (300m)`. The
 *    marker every relaunch in the runner greps is `stopped at the .*budget`
 *    (CF-RELAUNCH-ONLY-ON-BUDGET, #1361). So the lane named exactly which date
 *    window to resume from, and not one step in this repository ever read it.
 *    And on the RUNNER it was worse: that budget defaults to 0 and the guard
 *    read `TIME_BUDGET_MIN > 0`, so every dropdown dispatch ran an
 *    eight-year-capable walk with no clock at all.
 *
 * 3. A NEW SHAPE: THE LANE THAT DOES NOT OWN ITS LOOP. run-ebay-purchase-sync,
 *    run-ebay-finances-enrichment and backfill-ch-catalog-additions each hand
 *    their entire job to ONE service call that loops internally and returns a
 *    summary. There is no seam at which a per-unit outOfClock() could be
 *    placed, and racing the call would ABANDON it -- the #1809 wedge exactly.
 *    Their clock is therefore a PRE-FLIGHT GATE: if it cannot seat a whole
 *    sweep it refuses to start one, exits 5 having written nothing, and prints
 *    the marker so the relaunch gives the next run a full clock. All three are
 *    resumable (per-user cursors, feeFetchedAt candidacy, a stored
 *    checkpoint), so a refusal costs the dispatch and nothing else. This pin
 *    cannot tell that shape from a lane with no pre-check at all -- both
 *    declare a reserve and check it -- which is why the reasoning lives in
 *    each script's own THE CLOCK block where the next reader will find it.
 *
 * 4. THE SHARPEST STATISTIC LANE YET. refresh-market-signals computes every
 *    number it publishes as a ratio over a whole 60-day fetch held in memory,
 *    and its query carries NO ORDER BY. So a partial fetch is not a sample --
 *    it is whichever physical partitions were served first. A dimension key
 *    whose sales live in the unread partitions publishes as a -100% volume
 *    COLLAPSE, and upsertMomentumSignal OVERWRITES on
 *    (dimension, key, windowDays), so the wrong signal replaces the right one
 *    rather than sitting beside it. It refuses after a scan-phase stop.
 *
 * ── WHAT REPLACES THE LIST ────────────────────────────────────────────────
 *
 * `unbudgetedWriters` is still collected, and the assertion below simply
 * requires it to be EMPTY. A new dispatchable write lane that ships without a
 * budget now fails by name on arrival, and there is no allowlist to park it
 * on. That is the property the ratchet existed to reach: it was a ramp, not a
 * destination, and a ramp that never arrives is an exemption list wearing a
 * different word.
 *
 * IF YOU ARE HERE BECAUSE CI IS RED AND NAMED YOUR SCRIPT: the fix is
 * budget() from scripts/lib/runner-budget.cjs with a source-literal
 * RUN_MINUTES, an outOfClock() PRE-check before each unit (never at the loop
 * top), a reserve sized to your lane's largest unit, the marker as a source
 * literal, and finishLane() on every exit path. Re-adding a name here is not
 * one of the options, because there is no longer anywhere to add it. */

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

  it("NO dispatchable write lane may run without a budget — the ratchet is a hard rule now", () => {
    // ── WHY THIS IS NO LONGER A RATCHET ────────────────────────────────────
    //
    // Measured when the first version of this assertion was written: 59
    // whitelisted write lanes declared no budget. Demanding zero THAT DAY
    // would have failed the suite on 59 lanes nobody in that change had
    // measured, and a pin that is red on arrival is a pin somebody deletes —
    // which would have cost the rule entirely. So the debt was written down,
    // frozen, and allowed only to shrink: 59, then 44, then 29, then 14.
    //
    // It is now zero, so the allowlist is GONE rather than empty. An empty
    // list is an invitation; no list is a rule. Every one of the 59 was
    // MEASURED on its way out — its unit identified, its reserve sized to that
    // unit's worst case, its marker and reconcile driven by the per-lane
    // assertions below — which was always the only way a name could leave.
    //
    // MUTATION CHECK: delete any one lane's budget() call and this test names
    // that script. There is no second arm to satisfy and nothing to strike.
    expect(
      unbudgetedWriters,
      `these dispatchable WRITE lanes declare no budget at all, so they run until the `
        + `runner kills them at the ${CEILING}-minute ceiling — no marker, no reconcile, `
        + `no finishLane, and #1906's killed branch withholds the re-dispatch: `
        + `${unbudgetedWriters.join(", ")}. Give each one budget() from `
        + `scripts/lib/runner-budget.cjs, an outOfClock() pre-check per unit, the `
        + `marker as a source literal, and finishLane(). The old `
        + `KNOWN_UNBUDGETED_WRITE_LANES allowlist reached zero and was deleted — there `
        + `is nowhere to park a new one.`,
    ).toEqual([]);

    // A guard against the whole thing passing vacuously. `unbudgetedWriters`
    // being empty is only meaningful if the detector that fills it still
    // matches real lanes, so assert that the census SAW write lanes at all —
    // budgeted ones, which is now the entire population.
    const writers = LANES.filter((l) => writesWhenApplied(l.src)).map((l) => l.script);
    expect(
      writers.length,
      "writesWhenApplied() matched no budgeted lane either, so this file is asserting "
        + "nothing at all — the detector, not the debt, is what changed",
    ).toBeGreaterThan(20);
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
    // The grep moved into .github/actions/relaunch-on-marker on 2026-09-07:
    // seventy-two copies of the relaunch shell had grown backfill-runner.yml
    // past GitHub's 512 KB limit, where dispatches are accepted and no job is
    // ever created. Both files are searched, so the pattern is still pinned
    // wherever it lives — and a lane that keeps its own copy is still checked.
    const haystack = RUNNER + read(
      ".github", "actions", "relaunch-on-marker", "action.yml",
    );
    const greps = haystack.match(/grep -aqE "stopped at the [^"]*"/g) ?? [];
    expect(greps.length, "the marker-gated relaunch must exist").toBeGreaterThan(0);
    for (const g of greps) expect(g).toMatch(/stopped at the \.\*budget/);
  });
});
